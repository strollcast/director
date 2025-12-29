# D1 Database Migrations

This folder contains SQL migrations for the Strollcast D1 database.

## Running Migrations

### Prerequisites

1. Set your Cloudflare API token:
   ```bash
   export CLOUDFLARE_API_TOKEN=<your-token>
   ```
   Or create an `.env` file in the `api/` directory.

2. Ensure `wrangler.toml` has the correct `database_id`.

### Apply Migrations (Production)

```bash
cd api
npx wrangler d1 migrations apply strollcast --remote
```

### Apply Migrations (Local Development)

```bash
cd api
npx wrangler d1 migrations apply strollcast --local
```

### List Applied Migrations

```bash
npx wrangler d1 migrations list strollcast --remote
```

## Migration Files

| Migration | Description |
|-----------|-------------|
| `0001_create_episodes.sql` | Create episodes table |
| `0002_seed_episodes.sql` | Seed initial episodes data |
| `0003_add_topics.sql` | Add topics column to episodes |
| `0004_add_transcript_urls.sql` | Add transcript URLs to episodes |
| `0005_create_jobs_table.sql` | Create jobs table for workflow queue |

## Creating New Migrations

1. Create a new file with the next sequence number:
   ```
   NNNN_description.sql
   ```

2. Write your SQL statements.

3. Test locally first:
   ```bash
   npx wrangler d1 migrations apply strollcast --local
   ```

4. Apply to production:
   ```bash
   npx wrangler d1 migrations apply strollcast --remote
   ```

## Schema Overview

### episodes
Stores podcast episode metadata.

### jobs
Stores podcast generation jobs for the workflow queue.

```sql
-- Job status flow:
-- pending → generating_transcript → generating_audio → completed
--                  ↓                        ↓
--                failed                   failed
```

## Workflow Queue

The jobs table is used with Cloudflare Queues for end-to-end podcast generation:

1. **POST /jobs** - Create job, fetch arXiv metadata, send to queue
2. **Queue Stage 1** - Generate transcript (Claude API in Worker)
3. **Queue Stage 2** - Generate audio (ElevenLabs API in Worker)
4. **GET /jobs/:id** - Check job status

### Required Setup

1. Create Cloudflare Queues:
   ```bash
   npx wrangler queues create strollcast-jobs
   npx wrangler queues create strollcast-jobs-dlq
   ```

2. Set Worker secrets:
   ```bash
   cd api
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put ELEVENLABS_API_KEY
   ```

3. Deploy worker:
   ```bash
   cd api
   npx wrangler deploy
   ```
