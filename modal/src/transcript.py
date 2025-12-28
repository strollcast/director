"""
Transcript generation for Strollcast.

Modal function to generate podcast scripts from arXiv papers using Claude.
"""

import os
import re
from html.parser import HTMLParser

import modal
from .app import app


# Prompt template for script generation
PROMPT_TEMPLATE = """# Strollcast Script Generation Prompt

You are a podcast script writer for **Strollcast**, a podcast that transforms ML research papers into engaging audio conversations. Generate a script for the following paper.

## Hosts

- **Eric** (male): Enthusiastic, good at explaining technical concepts with analogies
- **Maya** (female): Analytical, asks clarifying questions, provides context

Both hosts are AI-generated voices. They should introduce themselves as AI hosts in the introduction.

## Output Format

Generate a Markdown script with this exact structure:

```markdown
# [Paper Title]

## [Introduction]

**ERIC:** Welcome to Strollcast! I'm Eric.

**MAYA:** And I'm Maya. We're your AI hosts, here to make research accessible while you're on the move.

[Continue conversation...]

## [Section Name]

**ERIC:** [Dialogue...]

**MAYA:** [Dialogue...]

## [Conclusion]

**ERIC:** [Wrap up key takeaways...]

**MAYA:** Until next time, keep strolling.

**ERIC:** And may your gradients never explode.
```

## Source Annotations

Link podcast content to original paper sections using inline attributes:

```markdown
**ERIC:** SGMV stands for Segmented Gather Matrix-Vector multiplication. {{page: 4, section: 3.1, excerpt: "We design a new CUDA kernel called SGMV..."}}

**MAYA:** It groups requests by their LoRA adapter. {{"page": 5, "section": "3.2", "excerpt": "SGMV parallelizes the feature-weight multiplication..." }}
```

The `{{page:...}}` annotations are automatically stripped before TTS generation.

## Script Requirements

1. **Speaker tags**: Always use bold format `**ERIC:**` and `**MAYA:**`
2. **Section headers**: Use `## [Section Name]` format for major topic transitions
3. **Length**: Target 12-20 minutes of audio (~2,400-4,000 words)
4. **Tone**: Conversational but technically accurate. Like two knowledgeable friends discussing a paper.
5. **Structure**:
   - Introduction: What paper, why it matters, who wrote it
   - Background: Context needed to understand the contribution
   - Core contribution: The main technical ideas, explained clearly
   - Results: Key experimental findings
   - Implications: Why this matters, future directions
   - Quizzes: Two quizzes from the paper, ask the question, ask the listener to think about it then provide a brief explanation.
   - Conclusion: Key takeaways, sign-off

## Style Guidelines

- **Explain jargon**: When introducing technical terms, briefly define them
- **Use analogies**: Help listeners visualize abstract concepts
- **Natural dialogue**: Hosts should respond to each other, ask questions, build on points
- **Vary sentence length**: Mix short punchy statements with longer explanations
- **Signpost transitions**: "Let's move on to...", "Now here's where it gets interesting..."
- **Acknowledge complexity**: It's okay to say "This is a bit dense, but..."
- **Include numbers sparingly**: Round to memorable figures, compare to benchmarks

## What to Avoid

- Reading equations aloud (describe what they mean instead)
- Excessive hedging ("I think maybe possibly...")
- Marketing language ("groundbreaking", "revolutionary")
- Inside jokes or references listeners won't understand
- Overly long monologues (keep exchanges flowing)

---

## Paper to Cover

**Title**: {{PAPER_TITLE}}

**Authors**: {{AUTHORS}}

**Abstract**: {{ABSTRACT}}

**Key Sections to Cover**:
{{PAPER_CONTENT}}

---

Generate the complete podcast script now. Remember to:
1. Start with the standard Strollcast introduction
2. End with the standard sign-off ("Until next time, keep strolling" / "And may your gradients never explode")
3. Make it engaging for listeners who are walking, commuting, or doing chores
"""


class HTMLTextExtractor(HTMLParser):
    """Extract text content from HTML, preserving structure."""

    def __init__(self):
        super().__init__()
        self.text_parts = []
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
        text = re.sub(r"\n{3,}", "\n\n", text)
        text = re.sub(r" +", " ", text)
        return text.strip()


def fetch_arxiv_metadata(arxiv_id: str) -> dict:
    """Fetch paper metadata from arXiv API."""
    import httpx

    url = f"https://export.arxiv.org/api/query?id_list={arxiv_id}"
    response = httpx.get(url, timeout=30)
    response.raise_for_status()

    xml = response.text
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

    authors = []
    for author_block in extract_all("author"):
        name_match = re.search(r"<name>(.*?)</name>", author_block)
        if name_match:
            authors.append(name_match.group(1).strip())

    published = extract_tag("published")[:10]

    return {
        "arxiv_id": arxiv_id,
        "title": title,
        "authors": authors,
        "abstract": abstract,
        "published": published,
    }


def fetch_ar5iv_content(arxiv_id: str) -> str | None:
    """Fetch paper content from ar5iv (HTML version of arXiv papers)."""
    import httpx

    url = f"https://ar5iv.labs.arxiv.org/html/{arxiv_id}"

    try:
        response = httpx.get(url, timeout=30, follow_redirects=True)
        if response.status_code != 200:
            return None

        html = response.text
        if "Conversion failed" in html or "not found" in html.lower():
            return None

        article_match = re.search(
            r'<article[^>]*>(.*?)</article>',
            html,
            re.DOTALL | re.IGNORECASE
        )
        if article_match:
            html = article_match.group(1)
        else:
            content_match = re.search(
                r'<div[^>]*class="[^"]*ltx_page_content[^"]*"[^>]*>(.*?)</div>\s*</div>\s*</body>',
                html,
                re.DOTALL | re.IGNORECASE
            )
            if content_match:
                html = content_match.group(1)

        parser = HTMLTextExtractor()
        parser.feed(html)
        text = parser.get_text()

        if len(text) < 500:
            return None

        return text

    except Exception:
        return None


def fetch_pdf_content(arxiv_id: str) -> str | None:
    """Fetch and extract text from arXiv PDF."""
    import httpx
    import pymupdf

    url = f"https://arxiv.org/pdf/{arxiv_id}.pdf"

    try:
        response = httpx.get(url, timeout=60, follow_redirects=True)
        response.raise_for_status()

        doc = pymupdf.open(stream=response.content, filetype="pdf")

        text_parts = []
        for page_num, page in enumerate(doc):
            text = page.get_text()
            if text.strip():
                text_parts.append(f"\n--- Page {page_num + 1} ---\n")
                text_parts.append(text)

        doc.close()

        full_text = "".join(text_parts)

        if len(full_text) < 500:
            return None

        max_chars = 100000
        if len(full_text) > max_chars:
            full_text = full_text[:max_chars] + "\n\n[... content truncated ...]"

        return full_text

    except Exception:
        return None


def fetch_paper_content(arxiv_id: str, abstract: str) -> tuple[str, str]:
    """Fetch paper content with fallback strategy."""
    # Try ar5iv first
    content = fetch_ar5iv_content(arxiv_id)
    if content:
        return content, "ar5iv"

    # Fall back to PDF
    content = fetch_pdf_content(arxiv_id)
    if content:
        return content, "pdf"

    # Last resort: abstract only
    fallback = f"""
[Note: Full paper content could not be extracted. Generating script based on abstract
and the model's knowledge of the paper.]

Abstract:
{abstract}

Please generate the podcast script based on:
1. The abstract above
2. Your training knowledge about this paper and related work
3. General understanding of the topic area

Focus on explaining the key concepts clearly for a podcast audience.
"""
    return fallback, "abstract"


def generate_script_with_claude(paper: dict, paper_content: str) -> str:
    """Generate podcast script using Claude API."""
    import anthropic

    prompt = PROMPT_TEMPLATE
    prompt = prompt.replace("{{PAPER_TITLE}}", paper["title"])
    prompt = prompt.replace("{{AUTHORS}}", ", ".join(paper["authors"]))
    prompt = prompt.replace("{{ABSTRACT}}", paper["abstract"])
    prompt = prompt.replace("{{PAPER_CONTENT}}", paper_content)

    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=8192,
        messages=[{"role": "user", "content": prompt}]
    )

    return response.content[0].text


def _generate_transcript_impl(arxiv_id: str) -> dict:
    """
    Internal implementation for transcript generation.

    Args:
        arxiv_id: arXiv paper ID (e.g., "2309.06180")

    Returns:
        Dict with 'script' (markdown content) and 'metadata' (paper info)
    """
    # Fetch metadata
    paper = fetch_arxiv_metadata(arxiv_id)

    # Fetch content
    content, source = fetch_paper_content(arxiv_id, paper["abstract"])

    # Generate script
    script = generate_script_with_claude(paper, content)

    return {
        "script": script,
        "content_source": source,
        "metadata": {
            "arxiv_id": arxiv_id,
            "title": paper["title"],
            "authors": paper["authors"],
            "abstract": paper["abstract"],
            "published": paper["published"],
        }
    }


@app.function(timeout=300)  # 5 minutes
def generate_transcript(arxiv_id: str) -> dict:
    """Generate podcast script from arXiv paper (for Modal remote calls)."""
    return _generate_transcript_impl(arxiv_id)


@app.function(timeout=300)
@modal.web_endpoint(method="POST")
def generate_transcript_web(data: dict) -> dict:
    """Web endpoint for transcript generation (called from Cloudflare Worker)."""
    arxiv_id = data.get("arxiv_id")
    if not arxiv_id:
        return {"error": "arxiv_id is required"}
    return _generate_transcript_impl(arxiv_id)


@app.local_entrypoint()
def generate_transcript_cli(arxiv_id: str = None, output: str = None):
    """
    CLI entrypoint for transcript generation.

    Usage:
        modal run -m src.transcript --arxiv-id 2309.06180
        modal run -m src.transcript --arxiv-id 2309.06180 --output script.md
    """
    if not arxiv_id:
        print("Error: --arxiv-id is required")
        return

    print(f"Generating transcript for arXiv:{arxiv_id}...")

    result = generate_transcript.remote(arxiv_id)

    print(f"\nTitle: {result['metadata']['title']}")
    print(f"Authors: {', '.join(result['metadata']['authors'][:3])}")
    print(f"Content source: {result['content_source']}")

    if output:
        from pathlib import Path
        Path(output).write_text(result["script"])
        print(f"\nScript saved to: {output}")
    else:
        print("\n" + "=" * 60)
        print(result["script"])
