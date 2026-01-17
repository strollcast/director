# Data Model: Long-Running Container Keepalive

**Date**: 2026-01-17
**Feature**: 001-container-keepalive

## Overview

This feature adds transient state tracking within the Go container. No persistent storage changes are required—existing D1/R2 schemas remain unchanged.

## Entities

### ContainerStatus (In-Memory, Go)

Represents the current state of the FFmpeg container.

| Field | Type | Description |
|-------|------|-------------|
| state | string | Current state: `idle`, `processing`, `error` |
| job_id | string | Episode ID of current job (empty if idle) |
| started_at | time.Time | When processing started (zero if idle) |
| segments_total | int | Total segments to process |
| segments_downloaded | int | Segments downloaded so far |
| last_error | string | Most recent error message (empty if none) |
| last_heartbeat | time.Time | When last heartbeat was sent |

**State Transitions**:
```
idle ──(POST /concat)──> processing
processing ──(success)──> idle
processing ──(error)──> error
error ──(POST /concat)──> processing
```

**Lifecycle**: Created on container start, reset between jobs. Lost on container shutdown (transient by design).

### HeartbeatRequest (HTTP)

Sent from container to Durable Object every 2 minutes during processing.

| Field | Type | Description |
|-------|------|-------------|
| job_id | string | Episode ID being processed |
| state | string | Current processing state |
| progress | float | Processing progress 0.0-1.0 (optional) |

### HeartbeatResponse (HTTP)

Returned by Durable Object to container.

| Field | Type | Description |
|-------|------|-------------|
| acknowledged | bool | Whether heartbeat was received |
| timeout_extended | bool | Whether activity timeout was renewed |

## Existing Entities (Unchanged)

### ConcatRequest

Existing request body for `/concat` endpoint—no changes required.

### ConcatResponse

Existing response body for `/concat` endpoint—no changes required.

## Validation Rules

1. **state**: Must be one of `idle`, `processing`, `error`
2. **job_id**: Required when state is `processing`
3. **segments_total**: Must be >= segments_downloaded
4. **started_at**: Must be in the past when state is `processing`
5. **heartbeat interval**: Must be less than sleepAfter (2 min < 5 min)

## Notes

- No database migrations required
- No R2 schema changes required
- All new data structures are transient and in-memory
