# Strollcast Modal App

Serverless podcast generation using Modal + Cloudflare R2.

## Setup

### 1. Install Modal CLI

```bash
pip install modal
modal setup  # Authenticate with Modal
```

### 2. Create Modal Secrets

Create two secrets in the Modal dashboard (https://modal.com/secrets):

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

### 3. Deploy the App

```bash
cd director/modal
modal deploy -m src.app
```

## Usage

### Generate an Episode

```bash
# From the modal/ directory
modal run -m src.generator \
    --script-path ../public/zhao-2023-pytorch-fsdp/script.md \
    --episode-name zhao-2023-pytorch-fsdp
```

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
