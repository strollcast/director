#!/usr/bin/env python3
"""
Generate a Strollcast podcast script from an arXiv paper.

Usage:
    python generate_from_paper.py <arxiv_id_or_url> [--output <path>]

Examples:
    python generate_from_paper.py 2311.12022
    python generate_from_paper.py https://arxiv.org/abs/2311.12022
    python generate_from_paper.py 2311.12022 --output ../public/smith-2023-cool-paper/script.md

Environment variables:
    ANTHROPIC_API_KEY - Required for Claude API access

Content extraction priority:
    1. ar5iv HTML (cleanest, if available)
    2. PDF extraction via pymupdf (fallback)
    3. Abstract only (last resort)
"""

import argparse
import io
import os
import re
import sys
import tempfile
from html.parser import HTMLParser
from pathlib import Path

try:
    import anthropic
    import httpx
except ImportError:
    print("Missing dependencies. Install with:")
    print("  pixi install")
    sys.exit(1)

# Optional PDF extraction
try:
    import pymupdf
    HAS_PYMUPDF = True
except ImportError:
    HAS_PYMUPDF = False


PROMPT_TEMPLATE = Path(__file__).parent.parent / "prompts" / "generate_script.md"


def extract_arxiv_id(input_str: str) -> str:
    """Extract arXiv ID from URL or raw ID."""
    # Handle URLs like https://arxiv.org/abs/2311.12022 or https://arxiv.org/pdf/2311.12022.pdf
    patterns = [
        r"arxiv\.org/abs/(\d+\.\d+)",
        r"arxiv\.org/pdf/(\d+\.\d+)",
        r"^(\d+\.\d+)$",  # Raw ID like 2311.12022
        r"^(\d+\.\d+v\d+)$",  # With version like 2311.12022v2
    ]

    for pattern in patterns:
        match = re.search(pattern, input_str)
        if match:
            return match.group(1).split("v")[0]  # Remove version suffix

    raise ValueError(f"Could not extract arXiv ID from: {input_str}")


def fetch_arxiv_metadata(arxiv_id: str) -> dict:
    """Fetch paper metadata from arXiv API."""
    url = f"https://export.arxiv.org/api/query?id_list={arxiv_id}"

    response = httpx.get(url, timeout=30)
    response.raise_for_status()

    # Parse XML response (simple regex extraction to avoid lxml dependency)
    xml = response.text

    # Extract the entry block first (contains the actual paper data)
    entry_match = re.search(r"<entry>(.*?)</entry>", xml, re.DOTALL)
    if not entry_match:
        raise ValueError(f"Could not find paper with arXiv ID: {arxiv_id}")
    entry = entry_match.group(1)

    def extract_tag(tag: str, text: str = entry) -> str:
        match = re.search(f"<{tag}[^>]*>(.*?)</{tag}>", text, re.DOTALL)
        return match.group(1).strip() if match else ""

    def extract_all(tag: str, text: str = entry) -> list:
        return re.findall(f"<{tag}[^>]*>(.*?)</{tag}>", text, re.DOTALL)

    title = extract_tag("title")
    abstract = extract_tag("summary")

    # Extract author names
    authors = []
    for author_block in extract_all("author"):
        name_match = re.search(r"<name>(.*?)</name>", author_block)
        if name_match:
            authors.append(name_match.group(1).strip())

    # Extract published date
    published = extract_tag("published")[:10]  # YYYY-MM-DD

    if not title:
        raise ValueError(f"Could not parse title for arXiv ID: {arxiv_id}")

    return {
        "arxiv_id": arxiv_id,
        "title": title,
        "authors": authors,
        "abstract": abstract,
        "published": published,
        "pdf_url": f"https://arxiv.org/pdf/{arxiv_id}.pdf",
    }


class HTMLTextExtractor(HTMLParser):
    """Extract text content from HTML, preserving structure."""

    def __init__(self):
        super().__init__()
        self.text_parts = []
        self.current_section = ""
        self.in_heading = False
        self.skip_tags = {"script", "style", "nav", "header", "footer", "aside"}
        self.skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.skip_tags:
            self.skip_depth += 1
        if tag in {"h1", "h2", "h3", "h4"}:
            self.in_heading = True
            self.text_parts.append("\n\n## ")
        elif tag == "p":
            self.text_parts.append("\n\n")
        elif tag == "li":
            self.text_parts.append("\n- ")
        elif tag == "br":
            self.text_parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.skip_tags:
            self.skip_depth = max(0, self.skip_depth - 1)
        if tag in {"h1", "h2", "h3", "h4"}:
            self.in_heading = False
            self.text_parts.append("\n")

    def handle_data(self, data):
        if self.skip_depth == 0:
            text = data.strip()
            if text:
                self.text_parts.append(text + " ")

    def get_text(self) -> str:
        text = "".join(self.text_parts)
        # Clean up excessive whitespace
        text = re.sub(r"\n{3,}", "\n\n", text)
        text = re.sub(r" +", " ", text)
        return text.strip()


def fetch_ar5iv_content(arxiv_id: str) -> str | None:
    """
    Fetch paper content from ar5iv (HTML version of arXiv papers).

    Returns None if ar5iv version is not available or has errors.
    """
    url = f"https://ar5iv.labs.arxiv.org/html/{arxiv_id}"

    try:
        response = httpx.get(url, timeout=30, follow_redirects=True)

        # Check for error page
        if response.status_code != 200:
            return None

        html = response.text

        # Check if it's an error page or conversion failed
        if "Conversion failed" in html or "not found" in html.lower():
            return None

        # Extract main content (article body)
        # ar5iv uses <article> or <div class="ltx_page_content">
        article_match = re.search(
            r'<article[^>]*>(.*?)</article>',
            html,
            re.DOTALL | re.IGNORECASE
        )
        if article_match:
            html = article_match.group(1)
        else:
            # Try ltx_page_content
            content_match = re.search(
                r'<div[^>]*class="[^"]*ltx_page_content[^"]*"[^>]*>(.*?)</div>\s*</div>\s*</body>',
                html,
                re.DOTALL | re.IGNORECASE
            )
            if content_match:
                html = content_match.group(1)

        # Parse HTML to text
        parser = HTMLTextExtractor()
        parser.feed(html)
        text = parser.get_text()

        # Check if we got meaningful content
        if len(text) < 500:
            return None

        return text

    except Exception as e:
        print(f"  ar5iv fetch failed: {e}")
        return None


def fetch_pdf_content(arxiv_id: str) -> str | None:
    """
    Fetch and extract text from arXiv PDF.

    Returns None if PDF extraction fails or pymupdf is not installed.
    """
    if not HAS_PYMUPDF:
        return None

    url = f"https://arxiv.org/pdf/{arxiv_id}.pdf"

    try:
        print("  Downloading PDF...")
        response = httpx.get(url, timeout=60, follow_redirects=True)
        response.raise_for_status()

        # Open PDF from bytes
        print("  Extracting text from PDF...")
        doc = pymupdf.open(stream=response.content, filetype="pdf")

        text_parts = []
        for page_num, page in enumerate(doc):
            text = page.get_text()
            if text.strip():
                text_parts.append(f"\n--- Page {page_num + 1} ---\n")
                text_parts.append(text)

        doc.close()

        full_text = "".join(text_parts)

        # Check if we got meaningful content
        if len(full_text) < 500:
            return None

        # Truncate if too long (Claude has context limits)
        max_chars = 100000  # ~25k tokens
        if len(full_text) > max_chars:
            full_text = full_text[:max_chars] + "\n\n[... content truncated ...]"

        return full_text

    except Exception as e:
        print(f"  PDF extraction failed: {e}")
        return None


def fetch_paper_content(arxiv_id: str, abstract: str) -> tuple[str, str]:
    """
    Fetch paper content with fallback strategy.

    Returns:
        Tuple of (content, source) where source is 'ar5iv', 'pdf', or 'abstract'
    """
    # Try ar5iv first (cleanest HTML)
    print("Fetching paper content...")
    print("  Trying ar5iv...")
    content = fetch_ar5iv_content(arxiv_id)
    if content:
        print("  ✓ Got content from ar5iv")
        return content, "ar5iv"

    # Fall back to PDF extraction
    if HAS_PYMUPDF:
        print("  Trying PDF extraction...")
        content = fetch_pdf_content(arxiv_id)
        if content:
            print("  ✓ Got content from PDF")
            return content, "pdf"
    else:
        print("  Skipping PDF (pymupdf not installed)")

    # Last resort: abstract only
    print("  ⚠ Using abstract only (limited content)")
    fallback = f"""
[Note: Full paper content could not be extracted. Generating script based on abstract
and the model's knowledge of the paper. The script may need more editing.]

Abstract:
{abstract}

Please generate the podcast script based on:
1. The abstract above
2. Your training knowledge about this paper and related work
3. General understanding of the topic area

Focus on explaining the key concepts clearly for a podcast audience.
"""
    return fallback, "abstract"


def generate_script(paper: dict, paper_content: str) -> str:
    """Generate podcast script using Claude API."""
    # Load prompt template
    if PROMPT_TEMPLATE.exists():
        template = PROMPT_TEMPLATE.read_text()
    else:
        raise FileNotFoundError(f"Prompt template not found: {PROMPT_TEMPLATE}")

    # Fill in placeholders
    prompt = template.replace("{{PAPER_TITLE}}", paper["title"])
    prompt = prompt.replace("{{AUTHORS}}", ", ".join(paper["authors"]))
    prompt = prompt.replace("{{ABSTRACT}}", paper["abstract"])
    prompt = prompt.replace("{{PAPER_CONTENT}}", paper_content)

    # Call Claude API
    client = anthropic.Anthropic()

    print("Generating script with Claude...")

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=8192,
        messages=[
            {"role": "user", "content": prompt}
        ]
    )

    return response.content[0].text


def derive_episode_folder(paper: dict) -> str:
    """Derive episode folder name from paper metadata."""
    # Get first author's last name
    first_author = paper["authors"][0] if paper["authors"] else "unknown"
    last_name = first_author.split()[-1].lower()

    # Get year from published date
    year = paper["published"][:4]

    # Create short name from title (first few significant words)
    title_words = paper["title"].lower().split()
    stop_words = {"a", "an", "the", "of", "for", "in", "on", "to", "and", "with"}
    significant = [w for w in title_words if w not in stop_words][:3]
    short_name = "-".join(re.sub(r"[^a-z0-9]", "", w) for w in significant)

    return f"{last_name}-{year}-{short_name}"


def main():
    parser = argparse.ArgumentParser(
        description="Generate Strollcast podcast script from arXiv paper"
    )
    parser.add_argument(
        "paper",
        help="arXiv ID or URL (e.g., 2311.12022 or https://arxiv.org/abs/2311.12022)"
    )
    parser.add_argument(
        "--output", "-o",
        help="Output path for script.md (default: prints to stdout)"
    )
    parser.add_argument(
        "--content", "-c",
        help="Path to file with additional paper content (sections, key text)"
    )
    args = parser.parse_args()

    # Check API key
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("Error: ANTHROPIC_API_KEY environment variable not set")
        sys.exit(1)

    # Extract arXiv ID
    try:
        arxiv_id = extract_arxiv_id(args.paper)
        print(f"arXiv ID: {arxiv_id}")
    except ValueError as e:
        print(f"Error: {e}")
        sys.exit(1)

    # Fetch metadata
    print("Fetching paper metadata from arXiv...")
    try:
        paper = fetch_arxiv_metadata(arxiv_id)
    except Exception as e:
        print(f"Error fetching metadata: {e}")
        sys.exit(1)

    print(f"Title: {paper['title']}")
    print(f"Authors: {', '.join(paper['authors'][:3])}{'...' if len(paper['authors']) > 3 else ''}")
    print(f"Published: {paper['published']}")

    # Get paper content
    if args.content:
        paper_content = Path(args.content).read_text()
        content_source = "file"
    else:
        paper_content, content_source = fetch_paper_content(arxiv_id, paper["abstract"])

    # Generate script
    try:
        script = generate_script(paper, paper_content)
    except Exception as e:
        print(f"Error generating script: {e}")
        sys.exit(1)

    # Output
    folder = derive_episode_folder(paper)

    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(script)
        print(f"\nScript saved to: {output_path}")
    else:
        print(f"\nSuggested episode folder: {folder}")
        print("\n" + "=" * 60)
        print(script)

    print("\n" + "=" * 60)
    print(f"Content source: {content_source}")
    print(f"Suggested folder: {folder}")
    print("\nNext steps:")
    print("1. Review and edit the script")
    print(f"2. Save to: director/public/{folder}/script.md")
    print(f"3. Generate audio:")
    print(f"   cd director/modal")
    print(f"   modal run -m src.generator --script-path ../public/{folder}/script.md --episode-name {folder}")


if __name__ == "__main__":
    main()
