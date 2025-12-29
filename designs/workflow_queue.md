# Podcast Generation Workflow with Cloudflare Queues

## Overview

End-to-end workflow for generating podcast episodes from arXiv papers:
1. Receive arXiv link via API
2. Create metadata and add to work queue
3. Generate transcript using Claude API
4. Generate audio using ElevenLabs API
5. Update D1 database with episode

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          API Worker                                  │
│  POST /jobs {arxiv_url}                                             │
│    → Fetch arXiv metadata                                           │
│    → Create job in D1 (status: pending)                             │
│    → Send message to Queue                                          │
│    → Return job_id                                                  │
│                                                                     │
│  GET /jobs/:id                                                      │
│    → Return job status and details                                  │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Cloudflare Queue                                │
│  "strollcast-jobs"                                                  │
│    → Messages: {job_id, arxiv_id, stage}                            │
│    → Automatic retries on failure                                   │
│    → Dead-letter queue for failed jobs                              │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Queue Consumer (Same Worker)                    │
│  Triggered by queue message                                         │
│                                                                     │
│  Stage: "generate_transcript"                                       │
│    → Update job status: "generating_transcript"                     │
│    → Fetch paper from ar5iv (HTML) with abstract fallback           │
│    → Call Claude API to generate podcast script                     │
│    → Save script to R2: strollcast-output/active/{job_id}/script.md │
│    → Send next message: {job_id, stage: "generate_audio"}           │
│                                                                     │
│  Stage: "generate_audio"                                            │
│    → Update job status: "generating_audio"                          │
│    → Read script from R2                                            │
│    → Parse script into speaker segments                             │
│    → Generate audio via ElevenLabs API (with R2 caching)            │
│    → Concatenate MP3 segments                                       │
│    → Generate VTT transcript                                        │
│    → Upload to R2: episodes/{episode_id}/                           │
│    → Update D1 episodes table                                       │
│    → Update job status: "completed"                                 │
└─────────────────────────────────────────────────────────────────────┘
```

## Data Flow

### 1. Job Submission

```
Client → POST /jobs {"arxiv_url": "https://arxiv.org/abs/2309.06180"}
       ← {"job_id": "abc123", "status": "pending"}
```

### 2. Queue Processing

```
Queue Message (stage 1): {job_id: "abc123", stage: "generate_transcript"}
    → Fetch ar5iv HTML or use abstract fallback
    → Claude API: generate podcast script
    → R2: strollcast-output/active/abc123/script.md
    → Queue Message (stage 2): {job_id: "abc123", stage: "generate_audio"}

Queue Message (stage 2): {job_id: "abc123", stage: "generate_audio"}
    → R2 Read: script.md
    → ElevenLabs API: generate audio per segment (with caching)
    → Concatenate MP3 files
    → R2: strollcast-output/episodes/pagedattention-2023/
    → D1: INSERT INTO episodes
    → D1: UPDATE jobs SET status = 'completed'
```

### 3. Output Structure

```
strollcast-output/
├── active/                          # Work in progress
│   └── {job_id}/
│       └── script.md
├── cache/                           # Audio segment cache
│   └── segments/
│       └── {hash}_{preview}.mp3
└── episodes/                        # Completed episodes
    └── {episode_id}/
        ├── {episode_id}.mp3
        └── {episode_id}.vtt
```

## D1 Schema

### Jobs Table

```sql
CREATE TABLE jobs (
    id TEXT PRIMARY KEY,           -- UUID
    arxiv_id TEXT NOT NULL,
    arxiv_url TEXT NOT NULL,
    status TEXT NOT NULL,          -- pending, generating_transcript, generating_audio, completed, failed
    error_message TEXT,

    -- Extracted metadata from arXiv
    title TEXT,
    authors TEXT,
    year INTEGER,
    abstract TEXT,

    -- Generated content references
    episode_id TEXT,               -- Links to episodes table when complete
    script_url TEXT,               -- R2 URL for script.md

    -- Timestamps
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
);

CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_arxiv_id ON jobs(arxiv_id);
```

### Job Status Flow

```
pending → generating_transcript → generating_audio → completed
               ↓                        ↓
             failed                   failed
```

## API Endpoints

### POST /jobs

Create a new podcast generation job.

**Request:**
```json
{
    "arxiv_url": "https://arxiv.org/abs/2309.06180"
}
```

**Response:**
```json
{
    "job_id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "pending",
    "arxiv_id": "2309.06180",
    "title": "Efficient Memory Management for Large Language Model Serving with PagedAttention",
    "authors": "Kwon et al.",
    "year": 2023
}
```

### GET /jobs/:id

Get job status and details.

**Response:**
```json
{
    "job_id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "completed",
    "arxiv_id": "2309.06180",
    "title": "Efficient Memory Management for Large Language Model Serving...",
    "authors": "Kwon et al.",
    "year": 2023,
    "episode_id": "pagedattention-2023",
    "created_at": "2024-12-28T10:00:00Z",
    "completed_at": "2024-12-28T10:15:00Z"
}
```

### GET /jobs

List recent jobs.

**Response:**
```json
{
    "jobs": [
        {"job_id": "...", "status": "completed", ...},
        {"job_id": "...", "status": "generating_audio", ...}
    ]
}
```

## Cloudflare Queue Configuration

### Queue: strollcast-jobs

- **Max retries:** 3
- **Retry delay:** Exponential backoff
- **Dead-letter queue:** strollcast-jobs-dlq
- **Max batch size:** 1 (process one job at a time)
- **Max batch timeout:** 30s

### Message Format

```json
{
    "job_id": "550e8400-e29b-41d4-a716-446655440000",
    "stage": "generate_transcript",
    "attempt": 1
}
```

## Worker Implementation

### transcript.ts

Generates podcast script from arXiv paper using Claude API.

```typescript
export async function generateTranscript(
  arxivId: string,
  anthropicApiKey: string
): Promise<TranscriptResult> {
  // Fetch paper content (ar5iv HTML or abstract fallback)
  const paper = await fetchArxivMetadata(arxivId);
  const { content, source } = await fetchPaperContent(arxivId, paper.abstract);

  // Generate script via Claude API
  const script = await generateScriptWithClaude(paper, content, anthropicApiKey);

  return { script, contentSource: source, metadata: paper };
}
```

### audio.ts

Generates podcast audio from script using ElevenLabs API.

```typescript
export async function generateEpisode(
  scriptContent: string,
  episodeName: string,
  elevenLabsApiKey: string,
  r2Bucket: R2Bucket
): Promise<GenerateEpisodeResult> {
  // Parse script into segments
  const segments = parseScript(scriptContent);

  // Generate audio for each segment (with R2 caching)
  // Uses continuity parameters for consistent voice

  // Concatenate MP3 files
  // Generate WebVTT transcript

  return { audioData, vttContent, durationSeconds, ... };
}
```

## Secrets Required

### Worker Secrets

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ELEVENLABS_API_KEY
```

## Error Handling

1. **arXiv fetch failure:** Mark job as failed, store error message
2. **Claude API failure:** Retry up to 3 times, then fail
3. **ElevenLabs failure:** Retry up to 3 times, then fail
4. **R2 upload failure:** Retry, idempotent operation
5. **D1 update failure:** Retry, use UPSERT for idempotency

## Audio Caching

Audio segments are cached in R2 to avoid regenerating identical content:

- **Cache key:** Hash of text + voice ID + model ID + version
- **Location:** `cache/segments/{hash}_{preview}.mp3`
- **Benefit:** Subsequent regenerations reuse cached segments

## Future Enhancements

1. **Webhook notifications:** Notify external systems on job completion
2. **Priority queue:** Fast-track certain papers
3. **Batch processing:** Process multiple papers in parallel
4. **Cost tracking:** Track API costs per job
5. **Preview mode:** Generate transcript only, human review before audio
