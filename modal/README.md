# Strollcast Modal App

Serverless podcast generation using Modal + Cloudflare R2.

## Setup

### 1. Install Modal CLI

```bash
pip install modal
modal setup  # Authenticate with Modal
```

### 2. Create Modal Secrets

Create three secrets in the Modal dashboard (https://modal.com/secrets):

**elevenlabs:**
```
ELEVENLABS_API_KEY=<your-api-key>
```

**cloudflare-r2:**
```
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=<your-access-key>
R2_SECRET_ACCESS_KEY=<your-secret>
R2_PUBLIC_DOMAIN=<optional-custom-domain>
```

**cloudflare-d1:**
```
CLOUDFLARE_API_TOKEN=<your-api-token>
```

### 3. Deploy the App

```bash
cd director/modal
modal deploy -m src.app
```

## Usage

### Generate an Episode

1. Create a `metadata.json` file in the episode folder:

```json
{
    "id": "pytorch-fsdp-2023",
    "title": "PyTorch FSDP: Experiences on Scaling Fully Sharded Data Parallel",
    "authors": "Zhao et al.",
    "year": 2023,
    "description": "Meta's production experiences building fully sharded data parallel training into PyTorch.",
    "paper_url": "https://arxiv.org/abs/2304.11277",
    "topics": ["Distributed Training", "Memory Optimization", "PyTorch"]
}
```

2. Run the generator:

```bash
# From the modal/ directory
modal run -m src.generator \
    --script-path ../public/zhao-2023-pytorch-fsdp/script.md \
    --metadata-path ../public/zhao-2023-pytorch-fsdp/metadata.json
```

This generates audio, uploads to R2, and updates the D1 database.

Use `--skip-db` to generate audio without updating the database.

### Run via Python

```python
import modal

app = modal.App.from_name("strollcast")
generate_episode = modal.Function.from_name("strollcast", "generate_episode")

result = generate_episode.remote(
    script_content="**ERIC:** Hello world...",
    episode_name="test-episode"
)
print(result)
```

## Architecture

```
src/
├── __init__.py      # Package exports
├── app.py           # Modal App, image, secrets, constants
├── audio.py         # ffmpeg processing (normalize, concat, VTT)
├── database.py      # D1 database client for episode metadata
├── storage.py       # R2 client (cache + output buckets)
└── generator.py     # Episode generation functions
```

## Functions

| Function | Description | Timeout |
|----------|-------------|---------|
| `generate_segment` | Single TTS segment with caching | 60s |
| `generate_episode` | Full episode orchestration | 15min |

## Cache Flow

```
generate_segment()
    │
    ├── Check R2 cache (strollcast-cache/segments/{hash}.mp3)
    │   └── If hit: return cached audio
    │
    ├── Call ElevenLabs API
    ├── Normalize to -16 LUFS
    ├── Save to R2 cache
    └── Return normalized audio
```
