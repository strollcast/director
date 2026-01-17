/**
 * Transcript generation for Strollcast.
 *
 * Generates podcast scripts from arXiv papers using Claude API.
 * Runs directly in Cloudflare Worker without Modal dependency.
 */

// Prompt template for script generation
const PROMPT_TEMPLATE = `# Strollcast Script Generation Prompt

You are a podcast script writer for **Strollcast**, a podcast that transforms ML research papers into engaging audio conversations. Generate a script for the following paper.

## Hosts

- **Eric** (male): Enthusiastic, good at explaining technical concepts with analogies
- **Maya** (female): Analytical, asks clarifying questions, provides context

Both hosts are AI-generated voices. They should introduce themselves as AI hosts in the introduction.

## Output Format

Generate a Markdown script with this exact structure:

\`\`\`markdown
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
\`\`\`

## Source Annotations

Link podcast content to original paper sections using inline attributes in \`{{...}}\` blocks.

\`\`\`markdown
**ERIC:** SGMV stands for Segmented Gather Matrix-Vector multiplication. {{page: 4, section: 3.1, excerpt: "We design a new CUDA kernel called SGMV..."}}

**MAYA:** This builds on [LoRA](link:arxiv/2106.09685) for efficient fine-tuning. {{page: 2, section: "Background"}}

**ERIC:** The transformer architecture from [Attention Is All You Need](link:arxiv/1706.03762) is foundational here. {{page: 1}}
\`\`\`

The \`{{...}}\` annotations are automatically stripped before TTS generation.

**Citation Links**: When mentioning a referenced paper that exists on arXiv, create a markdown link with the paper name as link text and \`link:arxiv/XXXX.XXXXX\` as the URL. The arXiv ID comes from the paper's references section (format: XXXX.XXXXX or older format like hep-th/XXXXXXX). Include at least 3-5 citation links throughout the script for the most important referenced papers. Example: \`[FlashAttention](link:arxiv/2307.08691)\`.

## Script Requirements

1. **Speaker tags**: Always use bold format \`**ERIC:**\` and \`**MAYA:**\`
2. **Section headers**: Use \`## [Section Name]\` format for major topic transitions
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
`;

interface PaperMetadata {
  arxivId: string;
  title: string;
  authors: string[];
  abstract: string;
  published: string;
}

interface TranscriptResult {
  script: string;
  contentSource: "ar5iv";
  metadata: PaperMetadata;
}

/**
 * Extract text from HTML, preserving basic structure.
 * Simplified version that works without a full HTML parser.
 */
function extractTextFromHtml(html: string): string {
  // Remove script and style tags
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "");
  text = text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "");
  text = text.replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, "");

  // Convert headings to markdown
  text = text.replace(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi, "\n\n## $1\n");

  // Convert paragraphs
  text = text.replace(/<p[^>]*>/gi, "\n\n");
  text = text.replace(/<\/p>/gi, "");

  // Convert list items
  text = text.replace(/<li[^>]*>/gi, "\n- ");
  text = text.replace(/<\/li>/gi, "");

  // Convert breaks
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode HTML entities
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Clean up whitespace
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/ +/g, " ");

  return text.trim();
}

/**
 * Fetch paper metadata from arXiv API.
 */
export async function fetchArxivMetadata(arxivId: string): Promise<PaperMetadata> {
  const url = `https://export.arxiv.org/api/query?id_list=${arxivId}`;
  const response = await fetch(url);
  const xml = await response.text();

  const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/);
  if (!entryMatch) {
    throw new Error(`Could not find paper with arXiv ID: ${arxivId}`);
  }
  const entry = entryMatch[1];

  // Extract title
  const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
  const title = titleMatch
    ? titleMatch[1].replace(/\s+/g, " ").trim()
    : "Unknown Title";

  // Extract authors
  const authorMatches = [
    ...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g),
  ];
  const authors = authorMatches.map((m) => m[1].trim());

  // Extract abstract
  const abstractMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);
  const abstract = abstractMatch
    ? abstractMatch[1].replace(/\s+/g, " ").trim()
    : "";

  // Extract published date
  const publishedMatch = entry.match(/<published>([^<]+)/);
  const published = publishedMatch ? publishedMatch[1].slice(0, 10) : "";

  return {
    arxivId,
    title,
    authors,
    abstract,
    published,
  };
}

/**
 * Fetch paper content from ar5iv (HTML version of arXiv papers).
 */
async function fetchAr5ivContent(arxivId: string): Promise<string | null> {
  const url = `https://ar5iv.labs.arxiv.org/html/${arxivId}`;

  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Strollcast/1.0" },
    });

    if (!response.ok) {
      return null;
    }

    const html = await response.text();

    // Check for error page
    if (html.includes("Conversion failed") || html.toLowerCase().includes("not found")) {
      return null;
    }

    // Extract article content
    let content = html;
    const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    if (articleMatch) {
      content = articleMatch[1];
    } else {
      // Try ltx_page_content
      const contentMatch = html.match(
        /<div[^>]*class="[^"]*ltx_page_content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/body>/i
      );
      if (contentMatch) {
        content = contentMatch[1];
      }
    }

    const text = extractTextFromHtml(content);

    // Check if we got meaningful content
    if (text.length < 500) {
      return null;
    }

    // Truncate if too long
    const maxChars = 100000;
    if (text.length > maxChars) {
      return text.slice(0, maxChars) + "\n\n[... content truncated ...]";
    }

    return text;
  } catch {
    return null;
  }
}

/**
 * Fetch paper content from ar5iv.
 * Throws an error if the paper content cannot be fetched.
 */
async function fetchPaperContent(
  arxivId: string
): Promise<{ content: string; source: "ar5iv" }> {
  const ar5ivContent = await fetchAr5ivContent(arxivId);
  if (ar5ivContent) {
    return { content: ar5ivContent, source: "ar5iv" };
  }

  throw new Error(`Could not fetch paper content from ar5iv for arXiv ID: ${arxivId}`);
}

/**
 * Generate podcast script using Claude API.
 */
async function generateScriptWithClaude(
  paper: PaperMetadata,
  paperContent: string,
  anthropicApiKey: string
): Promise<string> {
  let prompt = PROMPT_TEMPLATE;
  prompt = prompt.replace("{{PAPER_TITLE}}", paper.title);
  prompt = prompt.replace("{{AUTHORS}}", paper.authors.join(", "));
  prompt = prompt.replace("{{ABSTRACT}}", paper.abstract);
  prompt = prompt.replace("{{PAPER_CONTENT}}", paperContent);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API error: ${response.status} ${text}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
  };

  const textContent = data.content.find((c) => c.type === "text");
  if (!textContent) {
    throw new Error("No text content in Anthropic response");
  }

  return textContent.text;
}

/**
 * Generate transcript from arXiv paper.
 * Main entry point for transcript generation.
 */
export async function generateTranscript(
  arxivId: string,
  anthropicApiKey: string
): Promise<TranscriptResult> {
  // Fetch metadata
  const paper = await fetchArxivMetadata(arxivId);

  // Fetch content
  const { content, source } = await fetchPaperContent(arxivId);

  // Generate script
  const script = await generateScriptWithClaude(paper, content, anthropicApiKey);

  return {
    script,
    contentSource: source,
    metadata: paper,
  };
}
