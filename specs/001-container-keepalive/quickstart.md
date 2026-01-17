# Quickstart: Long-Running Container Keepalive

**Date**: 2026-01-17
**Feature**: 001-container-keepalive

## Overview

This guide explains how to test and verify the container keepalive feature after implementation.

## Prerequisites

- Cloudflare account with Workers Paid plan
- `wrangler` CLI authenticated
- Access to `strollcast-api` worker
- R2 buckets configured (`strollcast-output`, `strollcast-cache`)

## Testing the Feature

### 1. Deploy the Updated Worker and Container

```bash
cd api
npx wrangler deploy
```

This deploys both the Worker (with updated FFmpegContainer class) and rebuilds the container image.

### 2. Submit a Test Job

Create a test job with many segments to ensure processing takes longer than 5 minutes:

```bash
curl -X POST https://api.strollcast.com/jobs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"arxiv_url": "https://arxiv.org/abs/2401.00001"}'
```

Note the returned job ID.

### 3. Monitor Container Status

While the job is processing, query the container status:

```bash
# Get the container instance (requires internal access or logs)
# The /status endpoint is container-internal, so use wrangler logs

npx wrangler tail strollcast-api --format pretty
```

Look for log lines indicating:
- `"FFmpeg container started"`
- `"Heartbeat sent for job: episode-xxx"`
- `"Activity timeout renewed"`

### 4. Verify Successful Completion

After processing completes (10-40 minutes for real content), verify:

1. **Episode exists in R2**:
   ```bash
   npx wrangler r2 object head strollcast-output episodes/<episode-id>/<episode-id>.mp3
   ```

2. **Episode in database**:
   ```bash
   npx wrangler d1 execute strollcast \
     --command "SELECT id, title, status FROM episodes WHERE id = '<episode-id>'"
   ```

3. **Audio plays correctly**: Download and listen to verify no truncation or silence.

## Verifying Heartbeat Behavior

### Expected Log Sequence

```
FFmpeg container started
[episode-123] Downloading 150 segments...
Heartbeat sent for job: episode-123 (progress: 0.10)
Activity timeout renewed
[episode-123] Done: download.
[episode-123] Running FFmpeg concatenation...
Heartbeat sent for job: episode-123 (progress: 0.50)
Activity timeout renewed
Heartbeat sent for job: episode-123 (progress: 0.50)
Activity timeout renewed
[episode-123] Done: FFmpeg concatenation...
Heartbeat stopped for job: episode-123
[episode-123] Successfully concatenated 150 segments
FFmpeg container going idle
```

### Failure Scenarios to Test

1. **Container survives 5-minute idle**: Start a 10-minute job, observe container doesn't die at 5 minutes.

2. **Heartbeat stops on completion**: After job completes, observe heartbeat goroutine exits.

3. **Status endpoint works**: If you have direct container access, query `/status` during processing.

## Troubleshooting

### Container dies mid-processing

Check logs for:
- Missing heartbeat logs → heartbeat goroutine not starting
- `renewActivityTimeout` errors → DO method failing
- No logs after 5 minutes → sleepAfter triggered despite heartbeat

### Job completes but audio is truncated

This is likely a different issue (FFmpeg processing, not keepalive). Check:
- FFmpeg stderr for errors
- Input segment count vs expected
- R2 upload success

### Heartbeat errors

If heartbeats fail but job continues:
- Transient network issue (job may still succeed)
- If persistent, container may die after sleepAfter

## Configuration Reference

| Parameter | Value | Location |
|-----------|-------|----------|
| sleepAfter | 5m | `api/src/index.ts` (unchanged) |
| Heartbeat interval | 2m | `api/container/main.go` |
| Max processing time | 60m | `api/container/main.go` |
| Max container instances | 5 | `api/wrangler.toml` |

## Rollback

If issues occur, rollback by deploying the previous version:

```bash
cd api
git checkout HEAD~1 -- src/index.ts container/main.go
npx wrangler deploy
```

This restores the original behavior (without heartbeat). Long jobs may fail until the fix is re-applied.
