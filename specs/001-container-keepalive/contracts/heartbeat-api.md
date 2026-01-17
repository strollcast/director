# API Contract: Heartbeat & Status Endpoints

**Date**: 2026-01-17
**Feature**: 001-container-keepalive

## Overview

Two new HTTP endpoints for container lifecycle management:
1. **POST /heartbeat** - Container signals it's still processing (container → DO)
2. **GET /status** - Query current container state (external → container)

---

## POST /heartbeat

**Purpose**: Extend container activity timeout during long-running FFmpeg processing.

**Flow**: Container (Go) → HTTP → Durable Object (TypeScript) → `renewActivityTimeout()`

### Request

```http
POST /heartbeat HTTP/1.1
Host: container:8080
Content-Type: application/json

{
  "job_id": "episode-123",
  "state": "processing",
  "progress": 0.45
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| job_id | string | Yes | Episode ID being processed |
| state | string | Yes | Current state: `processing` |
| progress | number | No | Processing progress 0.0-1.0 |

### Response

**Success (200 OK)**:
```json
{
  "acknowledged": true,
  "timeout_extended": true
}
```

**Error (500 Internal Server Error)**:
```json
{
  "acknowledged": false,
  "timeout_extended": false,
  "error": "Failed to extend timeout"
}
```

### Behavior

1. Durable Object receives heartbeat request
2. Calls `this.renewActivityTimeout()` to reset sleepAfter timer
3. Logs heartbeat for debugging
4. Returns acknowledgment

### Timing

- **Interval**: Every 2 minutes while processing
- **Timeout**: 5 seconds per heartbeat request
- **Retry**: None (next scheduled heartbeat will retry)

---

## GET /status

**Purpose**: Query current container processing state for operational visibility.

**Flow**: External (operator/monitoring) → HTTP → Container (Go)

### Request

```http
GET /status HTTP/1.1
Host: container:8080
```

No request body required.

### Response

**Idle State (200 OK)**:
```json
{
  "state": "idle",
  "job_id": "",
  "started_at": null,
  "segments_total": 0,
  "segments_downloaded": 0,
  "last_error": "",
  "last_heartbeat": null
}
```

**Processing State (200 OK)**:
```json
{
  "state": "processing",
  "job_id": "episode-123",
  "started_at": "2026-01-17T10:30:00Z",
  "segments_total": 150,
  "segments_downloaded": 75,
  "last_error": "",
  "last_heartbeat": "2026-01-17T10:32:00Z"
}
```

**Error State (200 OK)**:
```json
{
  "state": "error",
  "job_id": "episode-123",
  "started_at": "2026-01-17T10:30:00Z",
  "segments_total": 150,
  "segments_downloaded": 42,
  "last_error": "FFmpeg failed: exit code 1",
  "last_heartbeat": "2026-01-17T10:34:00Z"
}
```

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| state | string | `idle`, `processing`, or `error` |
| job_id | string | Episode ID (empty if idle) |
| started_at | string/null | ISO8601 timestamp when job started |
| segments_total | int | Total segments in current job |
| segments_downloaded | int | Segments downloaded so far |
| last_error | string | Most recent error message |
| last_heartbeat | string/null | ISO8601 timestamp of last heartbeat sent |

---

## Existing Endpoints (Unchanged)

### POST /concat

No changes to request/response format. Internal behavior changes:
- Spawns heartbeat goroutine on job start
- Stops heartbeat goroutine on job completion
- Updates ContainerStatus throughout processing

### GET /health

No changes. Returns `{"status": "ok"}` as before.

---

## Error Handling

| Scenario | HTTP Status | Response |
|----------|-------------|----------|
| Heartbeat during idle | 400 Bad Request | `{"error": "No active job"}` |
| Invalid JSON body | 400 Bad Request | `{"error": "Invalid request body"}` |
| renewActivityTimeout fails | 500 Internal Server Error | `{"error": "..."}` |
| Container not ready | 503 Service Unavailable | `{"error": "Container starting"}` |

---

## Security Considerations

- Endpoints are internal (container network only)
- No authentication required (container-to-DO trust)
- No sensitive data in requests/responses
- Rate limiting not required (fixed 2-minute interval)
