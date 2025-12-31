# Strollcast

Strollcast transforms ML research papers into audio podcasts. The project consists of:
- **site/** - Astro SSR website (Cloudflare Pages)
- **api/** - Cloudflare Worker API for podcast generation

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

### ElevenLabs (production)
- **Eric:** `l7PKZGTaZgsdjGbTQRfS` - Male voice, not Eric on ElevenLabs
- **Maya:** `21m00Tcm4TlvDq8ikWAM` - Rachel, clear female voice

### macOS TTS (preview)
- **Eric:** Daniel (British male)
- **Maya:** Samantha (American female)

## Project Structure

```
director/
├── site/                    # Astro SSR website
│   ├── src/
│   │   ├── layouts/         # Layout components
│   │   └── pages/           # Page routes
│   │       ├── index.astro  # Homepage with episodes
│   │       ├── login.astro  # OAuth login page
│   │       └── how-to.astro # Documentation
│   ├── public/              # Static assets
│   ├── auth.config.ts       # Auth.js configuration
│   └── astro.config.mjs     # Astro config with Cloudflare adapter
├── api/                     # Cloudflare Worker API
│   ├── src/
│   │   ├── index.ts         # API routes and queue handler
│   │   ├── transcript.ts    # Claude-based transcript generation
│   │   └── audio.ts         # ElevenLabs audio generation
│   └── migrations/          # D1 database migrations
└── .github/workflows/       # CI/CD
    └── deploy.yml           # Deploys both site and worker on push
```

## Tech Stack

- **Frontend:** Astro 5 with SSR, Auth.js (GitHub OAuth)
- **Hosting:** Cloudflare Pages (site), Cloudflare Workers (API)
- **Database:** Cloudflare D1
- **Storage:** Cloudflare R2 (audio files, caching)
- **Queue:** Cloudflare Queues (job processing)
- **AI:** Anthropic Claude (transcripts), ElevenLabs (TTS)

## Development

```bash
# Site development
cd site
npm install
npm run dev

# API development
cd api
npm install
npx wrangler dev
```

## Deployment

Both site and worker deploy automatically on push to main via GitHub Actions.

### Required GitHub Secrets

```
CLOUDFLARE_API_TOKEN    # API token with Pages and Workers permissions
CLOUDFLARE_ACCOUNT_ID   # Your Cloudflare account ID
AUTH_SECRET             # Generate with: openssl rand -base64 32
```

### Required Cloudflare Pages Environment Variables

Set in Cloudflare Dashboard > Pages > Settings > Environment variables:
- `AUTH_SECRET` - Same as GitHub secret
- `AUTH_TRUST_HOST` - Set to `true`
- `GITHUB_CLIENT_ID` - From GitHub OAuth app
- `GITHUB_CLIENT_SECRET` - From GitHub OAuth app

### Required Worker Secrets

```bash
cd api
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ELEVENLABS_API_KEY
npx wrangler secret put API_KEY
```

## Adding New Episodes

Submit a job via the authenticated API:

```bash
curl -X POST https://api.strollcast.com/jobs \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer <API_KEY>" \
    -d '{"arxiv_url": "https://arxiv.org/abs/..."}'
```

This queues the job which:
1. Fetches paper from ar5iv (HTML) or uses abstract fallback
2. Generates transcript via Claude API
3. Generates audio via ElevenLabs API
4. Uploads to R2: `episodes/{id}/{id}.mp3`
5. Updates D1 database

## Audio URLs

Episodes are served from: `https://released.strollcast.com/episodes/{episode_id}/{episode_id}.mp3`
