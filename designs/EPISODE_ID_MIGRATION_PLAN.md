# Episode ID Migration Plan

## Current State Analysis

### Current Episode ID Format
**Pattern:** `{title_slug}-{year}`
- Takes first word of title, lowercased
- Examples:
  - "punica-2023" (from "Punica: Multi-Tenant LoRA Serving")
  - "flashattention-2023" (from "FlashAttention-2: Faster Attention...")
  - "megatron-lm-2021" (from "Efficient Large-Scale Language Model Training on GPU Clusters Using Megatron-LM")

### New Episode ID Format
**Pattern:** `{lastname}-{year}-{title_first_20_chars}`
- Last name of first author, lowercased
- Year
- First 20 characters of title, lowercased, special chars → `_`
- Examples:
  - "chen-2023-punica_multi_tenant" (from "Punica: Multi-Tenant LoRA Serving" by Chen et al.)
  - "dao-2023-flashattention_2_fa" (from "FlashAttention-2" by Tri Dao)
  - "narayanan-2021-efficient_large_sca" (from "Megatron-LM" by Narayanan et al.)

### Database State

**D1 Database: `strollcast`**
- **episodes table:** 9 episodes with IDs like "punica-2023", "qlora-2023", etc.
- **jobs table:** Multiple job records with `episode_id` linking to episodes

**Episodes in D1:**
```
id                    | title                                                   | authors           | year
punica-2023          | Punica: Multi-Tenant LoRA Serving                      | Chen et al.       | 2023
qlora-2023           | QLoRA: Efficient Finetuning of Quantized LLMs         | Dettmers et al.   | 2023
pathways-2022        | Pathways: Asynchronous Distributed Dataflow for ML     | Barham et al.     | 2022
megatron-lm-2021     | Efficient Large-Scale Language Model Training...       | Narayanan et al.  | 2021
pytorch-fsdp-2023    | PyTorch FSDP: Experiences on Scaling...               | Zhao et al.       | 2023
zero-2020            | ZeRO: Memory Optimizations Toward Training...          | Rajbhandari et al.| 2020
flexgen-2023         | FlexGen: High-Throughput Generative Inference...      | Ying Sheng et al. | 2023
flashattention-2023  | FlashAttention-2: Faster Attention...                  | Tri Dao           | 2023
gated-2025           | Gated Attention for Large Language Models              | Qiu et al.        | 2025
```

### R2 Buckets

**strollcast-output:**
File structure: `episodes/{episode_id}/`
- `{episode_id}.mp3` or `{episode_id}.m4a` - Audio file
- `{episode_id}.vtt` - Transcript
- `script.md` - Script

**strollcast-cache:**
- TTS segment cache (keyed by text hash, not affected by episode ID change)

### Code Locations Using Episode IDs

#### 1. **Episode ID Generation Functions**
- `src/index.ts:941` - `generateEpisodeId(title, year)` - Used in job processing
- `src/episode-generator.ts:123` - `deriveEpisodeId(episodeName)` - Derives from name format

#### 2. **R2 Path Construction**
- `src/audio.ts` - `uploadEpisode()`, `uploadTranscript()` - Uses `episodes/{episodeId}/`
- `src/episode-generator.ts` - Presigned URL generation for output
- `src/index.ts` - Script path lookups, audio file checks

#### 3. **Database References**
- `episodes` table - Primary key `id`
- `jobs` table - Foreign key `episode_id` (nullable)
- Join queries in admin endpoints

#### 4. **API Endpoints**
- `GET /episodes/:id` - Fetch single episode
- `GET /admin/episodes` - List all with metadata
- `POST /admin/episodes/:id/regenerate-audio` - Regenerate audio
- `POST /admin/episodes/:id/delete-audio` - Delete audio files

## Migration Strategy

### Phase 1: Code Changes (No Data Migration)

#### 1.1 Update Episode ID Generation
**File: `src/index.ts`**

Replace `generateEpisodeId()`:
```typescript
function generateEpisodeId(title: string, year: number, authors: string): string {
  // Extract last name from first author
  const firstAuthor = authors.split(",")[0].split(" and ")[0].trim();
  const lastName = firstAuthor.split(" ").pop()?.toLowerCase() || "unknown";

  // Get first 20 chars of title, replace special chars with _
  const titleSlug = title
    .slice(0, 20)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, ""); // Remove leading/trailing underscores

  return `${lastName}-${year}-${titleSlug}`;
}
```

Update call sites:
- Line 743: `const episodeId = generateEpisodeId(job.title || "untitled", job.year || 2024, job.authors || "unknown");`
- Line 814: `const episodeId = generateEpisodeId(job.title || "untitled", job.year || 2024, job.authors || "unknown");`

#### 1.2 Update Episode Name Derivation
**File: `src/episode-generator.ts`**

Update `deriveEpisodeId()` to match new format:
```typescript
export function deriveEpisodeId(episodeName: string): string {
  // episodeName format: "lastname-year-title..."
  // No conversion needed anymore - just return as-is
  return episodeName;
}
```

Update episode name construction in `src/index.ts:857`:
```typescript
// OLD: const episodeName = `${lastName}-${job.year || 2024}-${episodeId.split("-")[0]}`;
// NEW: Use episodeId directly as episodeName
const episodeName = episodeId;
```

#### 1.3 Update Tests
**File: `src/episode-generator.test.ts`**

Update `deriveEpisodeId` tests to reflect new behavior:
```typescript
it('returns episode name as-is (no conversion needed)', () => {
  const episodeId = deriveEpisodeId('chen-2023-punica_multi_tenant');
  expect(episodeId).toBe('chen-2023-punica_multi_tenant');
});
```

Add new tests for `generateEpisodeId` in `src/index.ts` (or move to `episode-generator.ts`).

### Phase 2: Database Migration (CAREFUL!)

**Important:** This phase affects PRODUCTION data. Test thoroughly in local environment first.

#### 2.1 Create Migration Script

**File: `migrations/0008_update_episode_ids.sql`**

```sql
-- Migration: Update episode IDs to new format
-- WARNING: This will modify primary keys and file paths

-- Create temporary table with new IDs
CREATE TABLE episodes_new (
    id TEXT PRIMARY KEY,
    old_id TEXT NOT NULL,
    title TEXT NOT NULL,
    authors TEXT NOT NULL,
    year INTEGER NOT NULL,
    description TEXT,
    duration TEXT NOT NULL,
    duration_seconds INTEGER,
    audio_url TEXT NOT NULL,
    transcript_url TEXT,
    paper_url TEXT,
    topics TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    published INTEGER DEFAULT 0
);

-- Example mappings (you'll need to generate these for all episodes):
-- punica-2023 -> chen-2023-punica_multi_tenant
-- qlora-2023 -> dettmers-2023-qlora_efficient_fi
-- pathways-2022 -> barham-2022-pathways_asynchrono
-- etc.

-- Insert with new IDs (EXAMPLE - you'll need to script this for all episodes)
INSERT INTO episodes_new (id, old_id, title, authors, year, description, duration, duration_seconds, audio_url, transcript_url, paper_url, topics, created_at, updated_at, published)
SELECT
    'chen-2023-punica_multi_tenant' as id,
    id as old_id,
    title, authors, year, description, duration, duration_seconds,
    REPLACE(audio_url, 'episodes/punica-2023/', 'episodes/chen-2023-punica_multi_tenant/') as audio_url,
    REPLACE(transcript_url, 'episodes/punica-2023/', 'episodes/chen-2023-punica_multi_tenant/') as transcript_url,
    paper_url, topics, created_at, updated_at, published
FROM episodes
WHERE id = 'punica-2023';

-- ... repeat for all episodes

-- Update jobs table to reference new episode_ids
UPDATE jobs
SET episode_id = (SELECT id FROM episodes_new WHERE old_id = jobs.episode_id)
WHERE episode_id IS NOT NULL;

-- Drop old table and rename new one
DROP TABLE episodes;
ALTER TABLE episodes_new RENAME TO episodes;

-- Recreate indexes
CREATE INDEX idx_episodes_year ON episodes(year DESC);
CREATE INDEX idx_episodes_published ON episodes(published);
```

#### 2.2 Generate Migration Mappings

Create a script to generate mappings:
```typescript
// scripts/generate-episode-id-mappings.ts
import { generateEpisodeId } from '../src/index';

const episodes = [
  { id: 'punica-2023', title: 'Punica: Multi-Tenant LoRA Serving', authors: 'Chen et al.', year: 2023 },
  // ... all episodes from DB
];

episodes.forEach(ep => {
  const oldId = ep.id;
  const newId = generateEpisodeId(ep.title, ep.year, ep.authors);
  console.log(`${oldId} -> ${newId}`);
});
```

### Phase 3: R2 File Migration

**Important:** R2 file moves are NOT atomic. Plan for downtime or use symlinks/redirects.

#### 3.1 Copy R2 Files to New Paths

Create a worker script to copy files:
```typescript
// scripts/migrate-r2-files.ts
const mappings = [
  { old: 'punica-2023', new: 'chen-2023-punica_multi_tenant' },
  // ... all mappings
];

for (const { old, new: newId } of mappings) {
  // Copy audio file
  const oldAudioKey = `episodes/${old}/${old}.mp3`;
  const newAudioKey = `episodes/${newId}/${newId}.mp3`;
  const audioObj = await r2.get(oldAudioKey);
  if (audioObj) {
    await r2.put(newAudioKey, await audioObj.arrayBuffer());
  }

  // Copy VTT
  const oldVttKey = `episodes/${old}/${old}.vtt`;
  const newVttKey = `episodes/${newId}/${newId}.vtt`;
  const vttObj = await r2.get(oldVttKey);
  if (vttObj) {
    await r2.put(newVttKey, await vttObj.arrayBuffer());
  }

  // Copy script
  const oldScriptKey = `episodes/${old}/script.md`;
  const newScriptKey = `episodes/${newId}/script.md`;
  const scriptObj = await r2.get(oldScriptKey);
  if (scriptObj) {
    await r2.put(newScriptKey, await scriptObj.text());
  }
}
```

#### 3.2 Delete Old Files (AFTER verifying new ones work)

```typescript
// Only run after confirming new files work!
for (const { old } of mappings) {
  await r2.delete(`episodes/${old}/${old}.mp3`);
  await r2.delete(`episodes/${old}/${old}.vtt`);
  await r2.delete(`episodes/${old}/script.md`);
}
```

## Rollout Plan

### Step 1: Local Testing
1. ✅ Test new `generateEpisodeId()` function
2. ✅ Run all tests
3. ✅ Test episode generation end-to-end locally

### Step 2: Code Deployment (BACKWARD COMPATIBLE)
1. Deploy code changes
2. Verify new episodes generate with new ID format
3. Old episodes still work (no DB migration yet)

### Step 3: Database Migration (REQUIRES DOWNTIME)
1. **Backup D1 database** (use `wrangler d1 export`)
2. Put site in maintenance mode
3. Run migration SQL script
4. Verify jobs table episode_id references updated
5. Test API endpoints with new IDs

### Step 4: R2 File Migration
1. Run R2 copy script (can be done in parallel)
2. Verify new files accessible
3. Test playback from new URLs
4. Delete old files after 24-48hr verification period

### Step 5: Verification & Monitoring
1. Check all episodes load correctly
2. Test regenerate-audio functionality
3. Test delete-audio functionality
4. Monitor error rates in Wrangler logs

## Risks & Mitigation

### Risk 1: Broken Episode Links
**Mitigation:** Keep old files in R2 for 48 hours, set up redirects if needed

### Risk 2: Database Migration Failure
**Mitigation:** Full D1 backup before migration, test locally first

### Risk 3: ID Collisions
**Mitigation:** Check for duplicates before migration:
```sql
SELECT new_id, COUNT(*)
FROM episodes_new
GROUP BY new_id
HAVING COUNT(*) > 1;
```

### Risk 4: Jobs Table Orphaned References
**Mitigation:** Verify all episode_id values map correctly:
```sql
SELECT j.id, j.episode_id
FROM jobs j
LEFT JOIN episodes e ON j.episode_id = e.id
WHERE j.episode_id IS NOT NULL AND e.id IS NULL;
```

## Estimated Effort

- **Phase 1 (Code Changes):** 2-3 hours
- **Phase 2 (DB Migration Prep):** 2-3 hours (script generation, testing)
- **Phase 3 (R2 Migration Script):** 2-3 hours
- **Total Testing:** 3-4 hours
- **Production Migration:** 1-2 hours (includes downtime)

**Total:** ~12-15 hours

## Recommendation

Given the complexity and risk, I recommend:

1. **Start with code changes** (Phase 1) - Deploy to production ASAP so new episodes use new format
2. **Defer data migration** (Phases 2-3) until you have 20+ episodes and time for downtime
3. **Alternative:** Keep old episodes as-is, only new episodes use new format (simpler, no migration needed)

If you choose option 3, you just need Phase 1 code changes.
