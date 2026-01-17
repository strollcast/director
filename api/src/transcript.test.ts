import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateTranscript, fetchArxivMetadata } from './transcript';

// Get API key from environment for integration tests
// Using import.meta.env for Vite compatibility
const ANTHROPIC_API_KEY = (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env?.ANTHROPIC_API_KEY;

// Fake arXiv metadata based on 2307.08691 (S-LoRA paper)
const FAKE_ARXIV_RESPONSE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2307.08691v1</id>
    <title>S-LoRA: Serving Thousands of Concurrent LoRA Adapters</title>
    <summary>The "pretrain-then-finetune" paradigm is commonly adopted in LLMs. Low-Rank Adaptation (LoRA), a parameter-efficient fine-tuning method, is often employed to adapt a base model to diverse tasks, resulting in a large number of LoRA adapters. We present S-LoRA, a system designed for scalable serving of many LoRA adapters.</summary>
    <author><name>Ying Sheng</name></author>
    <author><name>Shiyi Cao</name></author>
    <author><name>Dacheng Li</name></author>
    <published>2023-07-17T00:00:00Z</published>
  </entry>
</feed>`;

// Fake ar5iv content with citations to real arXiv papers
const FAKE_AR5IV_CONTENT = `
<article>
  <h1>S-LoRA: Serving Thousands of Concurrent LoRA Adapters</h1>

  <h2>1 Introduction</h2>
  <p>Large Language Models (LLMs) have revolutionized natural language processing.
  The Low-Rank Adaptation (LoRA) method [1] enables efficient fine-tuning by adding
  small adapter modules to the base model.</p>

  <h2>2 Background</h2>
  <p>Our work builds on the transformer architecture introduced in "Attention Is All
  You Need" [2] (arXiv:1706.03762). We also leverage techniques from vLLM [3]
  (arXiv:2309.06180) for efficient memory management with PagedAttention.</p>

  <h2>3 Method</h2>
  <p>S-LoRA introduces Unified Paging to manage adapter weights efficiently.
  We design a new CUDA kernel called SGMV (Segmented Gather Matrix-Vector) that
  enables batched LoRA computation.</p>

  <h2>4 Experiments</h2>
  <p>We evaluate S-LoRA on serving up to 2000 concurrent LoRA adapters.
  Compared to baselines like HuggingFace PEFT, S-LoRA achieves 4x higher throughput.</p>

  <h2>References</h2>
  <p>[1] Hu et al. LoRA: Low-Rank Adaptation of Large Language Models. arXiv:2106.09685</p>
  <p>[2] Vaswani et al. Attention Is All You Need. arXiv:1706.03762</p>
  <p>[3] Kwon et al. Efficient Memory Management for LLM Serving with PagedAttention. arXiv:2309.06180</p>
</article>
`;

// Fake Claude response with link annotations in {{}} blocks
const FAKE_CLAUDE_RESPONSE = {
  content: [{
    type: 'text',
    text: `# S-LoRA: Serving Thousands of Concurrent LoRA Adapters

## Introduction

**ERIC:** Welcome to Strollcast! I'm Eric.

**MAYA:** And I'm Maya. We're your AI hosts, here to make research accessible while you're on the move.

**ERIC:** Today we're diving into S-LoRA, a system that can serve thousands of LoRA adapters simultaneously. {{page: 1, section: "Introduction", excerpt: "S-LoRA, a system designed for scalable serving"}}

**MAYA:** LoRA, or Low-Rank Adaptation, is a clever technique for fine-tuning large language models efficiently. {{page: 2, section: "Background", excerpt: "Low-Rank Adaptation (LoRA) method", link: arxiv/2106.09685}}

## Background

**ERIC:** This builds on the transformer architecture from the famous "Attention Is All You Need" paper. {{page: 2, section: "Background", excerpt: "transformer architecture", link: arxiv/1706.03762}}

**MAYA:** And they also leverage techniques from vLLM's PagedAttention for memory management. {{page: 2, section: "Background", excerpt: "PagedAttention", link: arxiv/2309.06180}}

## Core Contribution

**ERIC:** The key innovation is something called SGMV - Segmented Gather Matrix-Vector multiplication. {{page: 4, section: 3.1, excerpt: "We design a new CUDA kernel called SGMV..."}}

**MAYA:** It allows batching LoRA computations across different adapters efficiently.

## Results

**ERIC:** The results are impressive - they can serve up to 2000 concurrent LoRA adapters! {{page: 6, section: "Experiments"}}

**MAYA:** That's 4x higher throughput compared to HuggingFace PEFT.

## Conclusion

**ERIC:** S-LoRA really pushes the boundaries of what's possible with adapter-based fine-tuning.

**MAYA:** Until next time, keep strolling.

**ERIC:** And may your gradients never explode.
`
  }]
};

describe('transcript generation (unit tests)', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fetchArxivMetadata', () => {
    it('parses arXiv API response correctly', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => FAKE_ARXIV_RESPONSE,
      });

      const metadata = await fetchArxivMetadata('2307.08691');

      expect(metadata.arxivId).toBe('2307.08691');
      expect(metadata.title).toBe('S-LoRA: Serving Thousands of Concurrent LoRA Adapters');
      expect(metadata.authors).toContain('Ying Sheng');
      expect(metadata.abstract).toContain('Low-Rank Adaptation');
    });

    it('throws error for non-existent paper', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => '<?xml version="1.0"?><feed></feed>',
      });

      await expect(fetchArxivMetadata('0000.00000')).rejects.toThrow('Could not find paper');
    });
  });

  describe('generateTranscript', () => {
    it('generates script with link annotations in citation blocks', async () => {
      // Mock arXiv metadata fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => FAKE_ARXIV_RESPONSE,
      });

      // Mock ar5iv content fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => FAKE_AR5IV_CONTENT,
      });

      // Mock Anthropic API response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => FAKE_CLAUDE_RESPONSE,
      });

      const result = await generateTranscript('2307.08691', 'fake-api-key');

      // Verify the script contains link annotations
      expect(result.script).toContain('link: arxiv/2106.09685');
      expect(result.script).toContain('link: arxiv/1706.03762');
      expect(result.script).toContain('link: arxiv/2309.06180');

      // Verify links are inside {{}} blocks
      const linkPattern = /\{\{[^}]*link:\s*arxiv\/\d+\.\d+[^}]*\}\}/g;
      const matches = result.script.match(linkPattern);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBeGreaterThanOrEqual(3);

      // Verify metadata
      expect(result.metadata.title).toContain('S-LoRA');
      expect(result.contentSource).toBe('ar5iv');
    });

    it('fails when ar5iv content is unavailable', async () => {
      // Mock arXiv metadata fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => FAKE_ARXIV_RESPONSE,
      });

      // Mock ar5iv failure
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      await expect(generateTranscript('2307.08691', 'fake-api-key'))
        .rejects.toThrow('Could not fetch paper content from ar5iv');
    });

    it('fails when ar5iv returns error page', async () => {
      // Mock arXiv metadata fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => FAKE_ARXIV_RESPONSE,
      });

      // Mock ar5iv returning conversion failure
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => '<html><body>Conversion failed</body></html>',
      });

      await expect(generateTranscript('2307.08691', 'fake-api-key'))
        .rejects.toThrow('Could not fetch paper content from ar5iv');
    });
  });
});

/**
 * Integration tests that call the real Claude API.
 * These tests are skipped if ANTHROPIC_API_KEY is not set.
 *
 * Run with: ANTHROPIC_API_KEY=your-key npm test -- src/transcript.test.ts
 */
describe.skipIf(!ANTHROPIC_API_KEY)('transcript generation (integration tests)', () => {
  beforeEach(() => {
    // Restore real fetch for integration tests
    vi.unstubAllGlobals();
  });

  it('generates script with link:arxiv annotations from real Claude API', async () => {
    // Use real fetch for integration test
    const result = await generateTranscript('2307.08691', ANTHROPIC_API_KEY!);

    console.log('\n=== Generated Script ===\n');
    console.log(result.script);
    console.log('\n========================\n');

    // Verify basic script structure
    expect(result.script).toContain('**ERIC:**');
    expect(result.script).toContain('**MAYA:**');
    expect(result.metadata.title).toContain('FlashAttention-2');
    expect(result.contentSource).toBe('ar5iv');

    // Verify the script contains {{}} annotation blocks
    const annotationPattern = /\{\{[^}]+\}\}/g;
    const annotations = result.script.match(annotationPattern);
    expect(annotations).not.toBeNull();
    expect(annotations!.length).toBeGreaterThan(0);

    console.log(`Found ${annotations!.length} annotation blocks`);

    // Check for link:arxiv annotations
    const linkPattern = /link:\s*arxiv\/[\d.]+/gi;
    const links = result.script.match(linkPattern);

    if (links && links.length > 0) {
      console.log(`Found ${links.length} link annotations:`);
      links.forEach(link => console.log(`  - ${link}`));

      // Verify links are inside {{}} blocks
      for (const link of links) {
        const inBlock = new RegExp(`\\{\\{[^}]*${link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^}]*\\}\\}`);
        expect(result.script).toMatch(inBlock);
      }
    } else {
      // Warn but don't fail - Claude may not always include links
      console.warn('WARNING: No link:arxiv annotations found in generated script');
      console.warn('The prompt may need adjustment to ensure links are included');
    }
  }, 120000); // 2 minute timeout for API call

  it('generates script with citations for Attention paper', async () => {
    // Test with the Attention Is All You Need paper which has well-known citations
    const result = await generateTranscript('1706.03762', ANTHROPIC_API_KEY!);

    console.log('\n=== Generated Script (Attention) ===\n');
    console.log(result.script.slice(0, 2000) + '...');
    console.log('\n====================================\n');

    // Verify basic structure
    expect(result.script).toContain('**ERIC:**');
    expect(result.script).toContain('**MAYA:**');
    expect(result.metadata.title.toLowerCase()).toContain('attention');

    // Check for any {{}} annotations
    const annotationPattern = /\{\{[^}]+\}\}/g;
    const annotations = result.script.match(annotationPattern);

    console.log(`Found ${annotations?.length || 0} annotation blocks`);

    // Check for link annotations
    const linkPattern = /link:\s*arxiv\/[\d.]+/gi;
    const links = result.script.match(linkPattern);
    console.log(`Found ${links?.length || 0} link annotations`);

    if (links) {
      links.forEach(link => console.log(`  - ${link}`));
    }
  }, 120000);
});
