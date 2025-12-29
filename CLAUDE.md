# Strollcast

This is an Astro-based static website that hosts audio podcasts explaining ML research papers.

## Podcast Format

- **Podcast name:** Strollcast (not "Gradient Descent" or other names)
- **Hosts:** Eric and Maya (AI-generated voices, no last names)
- **Host introduction:** Always clarify they are virtual/AI hosts (e.g., "We're your AI hosts, here to make research accessible while you're on the move")
- **Quizzes:** Always include 2 quizzes at the end of each episode to test listener understanding
- **Sign-off:** Use a different sign-off for each episode. Options:
  - "Until next time, keep strolling" / "And may your gradients never explode"
  - "Until next time, keep strolling" / "And may your loss always converge"
  - "Until next time, keep strolling" / "And may your tensors never misalign"
  - "Until next time, keep strolling" / "And may your batch sizes be ever in your favor"
  - "Until next time, keep strolling" / "And may your learning rate be just right"

## Voice Configuration

### macOS TTS (preview)
- **Eric:** Daniel (British male)
- **Maya:** Samantha (American female)

### ElevenLabs (production)
- **Eric:** `gP8LZQ3GGokV0MP5JYjg` - Male voice
- **Maya:** `21m00Tcm4TlvDq8ikWAM` - Rachel, clear female voice

## Project Structure

- `src/layouts/Layout.astro` - Main layout with dark theme and navigation
- `src/pages/index.astro` - Homepage (fetches episodes from api.strollcast.com)
- `src/pages/how-to.astro` - Technical documentation page
- `public/<author>-<year>-<paper>/` - Episode folders containing:
  - `script.md` - Podcast transcript (uses **ERIC:** and **MAYA:** for speaker tags)
  - `sources.json` - Source references linking script content to paper sections
- `api/` - Cloudflare Worker for API, transcript generation (Claude), and audio generation (ElevenLabs)

## Source Annotations

Link podcast content to original paper sections using inline attributes:

```markdown
**ERIC:** SGMV stands for Segmented Gather Matrix-Vector multiplication. {{page: 4, section: 3.1, excerpt: "We design a new CUDA kernel called SGMV..."}}

**MAYA:** It groups requests by their LoRA adapter. {{"page": 5, "section": "3.2", "excerpt": "SGMV parallelizes the feature-weight multiplication..." }}
```

The `{{page:...}}` annotations are automatically stripped before TTS generation.

## Python Tools

- `python/generate.py` - ElevenLabs TTS script
- `python/pixi.toml` - Pixi package manager configuration

## Adding New Episodes

1. Create folder in `public/` named `<author>-<year>-<short-name>`
2. Add `script.md` with the podcast transcript
3. Add `metadata.json` with episode metadata:
   ```json
   {
       "id": "short-name-year",
       "title": "Paper Title",
       "authors": "Author et al.",
       "year": 2023,
       "description": "Brief description of the paper",
       "paper_url": "https://arxiv.org/abs/...",
       "topics": ["Topic1", "Topic2", "Topic3"]
   }
   ```
4. Submit job via API to generate audio:
   ```bash
   curl -X POST https://api.strollcast.com/jobs \
       -H "Content-Type: application/json" \
       -d '{"arxiv_url": "https://arxiv.org/abs/..."}'
   ```
   This queues the job which generates transcript (Claude), audio (ElevenLabs), uploads to R2, and updates D1.

## Tech Stack

- Astro (static site generator)
- GitHub Pages (hosting)
- Cloudflare Workers (API and podcast generation)
- Cloudflare Queues (job processing)
- Cloudflare D1 (database)
- Cloudflare R2 (audio storage and caching)
- Anthropic Claude (transcript generation)
- ElevenLabs (text-to-speech)
- macOS TTS (local preview)

## Commands

```bash
npm run dev      # Start dev server
npm run build    # Production build
npm run preview  # Preview production build
```
