# Strollcast

Listen to research papers while you stroll.

Strollcast transforms dense academic papers into engaging audio podcasts. Each episode features a conversational format with two hosts breaking down complex concepts into accessible explanations—perfect for walks, commutes, or any time you're on the move.

## iOS App

Listen on the go with the native iOS app: [StrollcastApp](https://github.com/strollcast/StrollcastApp)

## Episodes

- **PyTorch FSDP: Experiences on Scaling Fully Sharded Data Parallel** (Zhao et al., 2023) - 24 min
- **ZeRO: Memory Optimizations Toward Training Trillion Parameter Models** (Rajbhandari et al., 2020) - 17 min

## Development

This is an [Astro](https://astro.build) static site.

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Build for production
npm run build
```

## Generating Podcasts

The `python/` folder contains the podcast generation script with two TTS backends:

### Preview with macOS TTS (free, fast)

Use `--preview` to quickly evaluate podcast length with built-in macOS voices:

```bash
cd python
pixi run python generate.py ../public/<episode-folder> --preview
```

This creates a `<episode>-preview.m4a` file for evaluation.

### Production with ElevenLabs (high quality)

For production-quality audio:

```bash
export ELEVENLABS_API_KEY="your-api-key"
cd python
pixi run python generate.py ../public/<episode-folder>
```

ElevenLabs responses are cached locally to save API quota on re-runs.

Requires `ffmpeg` for audio processing.

## Deployment

The site auto-deploys to GitHub Pages on push to `main` via GitHub Actions.

## License

MIT
