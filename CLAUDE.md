# Strollcast

This is an Astro-based static website that hosts audio podcasts explaining ML research papers.

## Podcast Format

- **Podcast name:** Strollcast (not "Gradient Descent" or other names)
- **Hosts:** Eric and Maya (AI-generated voices, no last names)
- **Host introduction:** Always clarify they are virtual/AI hosts (e.g., "We're your AI hosts, here to make research accessible while you're on the move")
- **Sign-off:** "Until next time, keep strolling" / "And may your gradients never explode"

## Voice Configuration

ElevenLabs voice IDs:
- **Eric:** `gP8LZQ3GGokV0MP5JYjg` - Male voice
- **Maya:** `21m00Tcm4TlvDq8ikWAM` - Rachel, clear female voice

## Project Structure

- `src/layouts/Layout.astro` - Main layout with dark theme and navigation
- `src/pages/index.astro` - Homepage with episode list and audio players
- `src/pages/how-to.astro` - Technical documentation page
- `public/` - Static assets including episode folders
- `public/<author>-<year>-<paper>/` - Episode folders containing:
  - `podcast.m4a` - Audio file
  - `script.md` - Podcast transcript (uses **ERIC:** and **MAYA:** for speaker tags)
  - `README.md` - Episode metadata
- `python/` - Podcast generation tools
  - `generate.py` - ElevenLabs TTS script
  - `requirements.txt` - Python dependencies

## Adding New Episodes

1. Create folder in `public/` named `<author>-<year>-<short-name>`
2. Add `script.md` with the podcast transcript
3. Run `python python/generate.py public/<episode-folder>` to generate audio
4. Add `README.md` with episode metadata
5. Update `src/pages/index.astro` episodes array

## Tech Stack

- Astro (static site generator)
- GitHub Pages (hosting)
- ElevenLabs (text-to-speech)
- ffmpeg (audio processing)

## Commands

```bash
npm run dev      # Start dev server
npm run build    # Production build
npm run preview  # Preview production build
```
