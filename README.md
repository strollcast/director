# Strollcast Director

Website and API for Strollcast. For project overview, see [github.com/strollcast](https://github.com/strollcast).

## Structure

```
director/
├── site/     # Astro SSR website (Cloudflare Pages)
├── api/      # Cloudflare Worker API (podcast generation)
└── designs/  # Design assets
```

## Development

### Site

```bash
cd site
npm install
npm run dev     # http://localhost:4321
```

### API

```bash
cd api
npm install
npx wrangler dev
```

## Deployment

Both site and worker deploy automatically on push to `main` via GitHub Actions. Deploy runs after CI passes.

### Required Secrets

**GitHub Actions:**
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `AUTH_SECRET`

**Cloudflare Worker** (set via `wrangler secret put`):
- `ANTHROPIC_API_KEY`
- `ELEVENLABS_API_KEY`
- `INWORLD_API_KEY`
- `API_KEY`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

## License

MIT
