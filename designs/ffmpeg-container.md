# FFmpeg Container for MP3 Concatenation

## Problem

Direct MP3 byte concatenation produces files with incorrect duration metadata. Media players display wrong duration, and seeking doesn't work properly.

## Solution

Use a Cloudflare Container running FFmpeg to properly concatenate MP3 files with correct headers and duration metadata.

## Architecture

```
Worker                              Container
  │                                     │
  ├─ Generate TTS segments ────────────►│
  ├─ Cache segments in R2 ─────────────►│
  │                                     │
  ├─ Generate presigned URLs            │
  │   - Read URLs for cached segments   │
  │   - Write URL for output file       │
  │                                     │
  ├─ POST /concat ─────────────────────►│
  │   {segments[], output_url, metadata}│
  │                                     │
  │                                     ├─ Download all segments
  │                                     ├─ Create FFmpeg concat list
  │                                     ├─ Run FFmpeg with libmp3lame
  │                                     ├─ Upload result via PUT
  │                                     │
  │◄─ {success, duration_seconds} ──────┤
  │                                     │
  └─ Update database with duration      │
```

## Container API

### `POST /concat`

Concatenates MP3 segments and uploads the result.

**Request:**
```json
{
  "segments": [
    "https://...r2.../segments/abc.mp3?X-Amz-Signature=...",
    "https://...r2.../segments/def.mp3?X-Amz-Signature=..."
  ],
  "output_url": "https://...r2.../episodes/id/id.mp3?X-Amz-Signature=...",
  "metadata": {
    "title": "Episode Title",
    "artist": "Strollcast",
    "album": "Strollcast",
    "genre": "Podcast"
  }
}
```

**Response:**
```json
{
  "success": true,
  "duration_seconds": 842.5,
  "file_size": 13456789
}
```

### `GET /health`

Health check endpoint.

**Response:**
```json
{
  "status": "ok"
}
```

## Container Implementation

### Dockerfile

```dockerfile
FROM golang:1.22-alpine AS builder
WORKDIR /build
COPY go.mod main.go .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o server .

FROM alpine:3.20
RUN apk add --no-cache ffmpeg
COPY --from=builder /build/server /server
EXPOSE 8080
CMD ["/server"]
```

### FFmpeg Command

```bash
ffmpeg -f concat -safe 0 -i list.txt \
  -c:a libmp3lame -b:a 128k -ar 44100 \
  -metadata title="..." \
  -metadata artist="..." \
  -metadata album="..." \
  -metadata genre="..." \
  -y output.mp3
```

### Container Size

- Alpine base: ~5 MB
- FFmpeg: ~50 MB
- Go binary: ~5 MB
- **Total: ~60 MB**

## Worker Integration

```typescript
// R2 credentials for presigned URLs
const r2Credentials: R2Credentials = {
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  accountId: env.CF_ACCOUNT_ID,
};

// Generate presigned URLs for cached segments
const segmentUrls = await Promise.all(
  segmentCacheKeys.map((key) =>
    generatePresignedUrl(r2Credentials, "strollcast-cache", `segments/${key}.mp3`, "GET")
  )
);

// Generate presigned URL for output
const outputUrl = await generatePresignedUrl(
  r2Credentials, "strollcast-output", outputKey, "PUT"
);

// Call container
const containerId = env.FFMPEG_CONTAINER.idFromName("audio-processor");
const container = env.FFMPEG_CONTAINER.get(containerId);

const response = await container.fetch("http://container/concat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    segments: segmentUrls,
    output_url: outputUrl,
    metadata: { title, artist: "Strollcast", album: "Strollcast", genre: "Podcast" }
  }),
});

const result = await response.json();
// result.duration_seconds is accurate from ffprobe
```

## Configuration

### wrangler.toml

```toml
[[containers]]
class_name = "FFmpegContainer"
image = "./container/Dockerfile"
max_instances = 5

[[durable_objects.bindings]]
class_name = "FFmpegContainer"
name = "FFMPEG_CONTAINER"

[[migrations]]
new_sqlite_classes = ["FFmpegContainer"]
tag = "v1"

[vars]
CF_ACCOUNT_ID = "your-account-id"
```

### Required Secrets

```bash
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

Create R2 API tokens at: Cloudflare Dashboard > R2 > Manage R2 API Tokens

## Design Decisions

### Why Presigned URLs?

- Container has no R2 credentials (simpler, more secure)
- Worker generates time-limited URLs (1 hour expiry)
- Container just needs HTTP GET/PUT capability

### Why Keep Existing Segment Cache?

- Segments are already cached in `strollcast-cache` bucket
- No changes to TTS generation or caching logic
- Container reads from existing cache locations

### Why Go for the HTTP Server?

- Single static binary (~5MB)
- No runtime dependencies
- Easy to build in multi-stage Dockerfile
- Good HTTP and JSON handling

## Cloudflare Containers Notes

- Public beta as of June 2025
- Runs on Firecracker microVMs with KVM isolation
- Cold start: ~few seconds
- Instance sizes: dev (256 MiB), basic (1 GiB), standard (4 GiB)
- Billed in 10ms slices, scales to zero
- Communication via Durable Objects pattern

## Files

```
api/
├── container/
│   ├── Dockerfile      # Multi-stage Alpine + FFmpeg
│   ├── main.go         # Go HTTP server
│   └── go.mod          # Go module
├── src/
│   ├── audio.ts        # Updated with container integration
│   └── index.ts        # Updated Env interface
├── wrangler.toml       # Container and secrets config
└── package.json        # aws4fetch dependency
```
