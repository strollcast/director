# Research: Long-Running Container Keepalive

**Date**: 2026-01-17
**Feature**: 001-container-keepalive

## Research Questions

1. How does Cloudflare Containers track "activity" for sleepAfter?
2. What mechanisms exist to extend container lifetime during processing?
3. What are the patterns for heartbeat/keepalive in serverless containers?
4. How should the container communicate status back to the orchestrator?

---

## Finding 1: Cloudflare Container Activity Tracking

**Decision**: Activity is tracked by HTTP requests to the Durable Object, not the container directly.

**Rationale**: The `@cloudflare/containers` package wraps a Durable Object that manages container lifecycle. The `sleepAfter` timer resets when:
- HTTP requests are received by the Durable Object
- WebSocket messages are exchanged
- `renewActivityTimeout()` is explicitly called

**Sources**:
- [Cloudflare Containers Lifecycle](https://developers.cloudflare.com/containers/platform-details/architecture/)
- [@cloudflare/containers GitHub](https://github.com/cloudflare/containers)

**Implication**: A single POST to `/concat` only counts as one activity event. If FFmpeg runs for 30 minutes, the 5-minute sleepAfter will trigger ~25 minutes before completion.

---

## Finding 2: renewActivityTimeout() API

**Decision**: Use `renewActivityTimeout()` method on the Container class to extend lifetime.

**Rationale**: The `@cloudflare/containers` package provides:

```typescript
// In Container subclass
async renewActivityTimeout(): Promise<void>
```

This method manually extends the container's activity timeout without requiring a full HTTP request/response cycle. It should be called periodically during long-running operations.

**Alternative Considered**: Increase `sleepAfter` to 60+ minutes
- **Rejected**: This keeps containers alive unnecessarily for short jobs, increasing costs and resource usage.

**Alternative Considered**: Use `keepAlive: true` configuration
- **Rejected**: Requires explicit `destroy()` call; container never auto-terminates. Higher operational risk.

---

## Finding 3: Heartbeat Pattern Options

**Decision**: Container-initiated HTTP heartbeat to a Durable Object endpoint that calls `renewActivityTimeout()`.

**Pattern Comparison**:

| Pattern | Pros | Cons |
|---------|------|------|
| Container → DO heartbeat | Simple, container controls timing | Requires HTTP call overhead |
| DO polling container status | DO controls lifecycle | Keeps DO alive without work |
| Streaming response | Real-time progress | Complex, ties up connection |
| Increase sleepAfter only | Zero code changes | Wastes resources on short jobs |

**Rationale**: Container-initiated heartbeat is simplest and most aligned with existing architecture. The container knows when it's processing; it sends a heartbeat every 2-3 minutes to reset the 5-minute sleepAfter timer.

**Implementation Detail**:
- Container spawns a goroutine that sends heartbeats every 2 minutes
- Heartbeat is a lightweight HTTP POST to `http://container/heartbeat` (proxied to DO)
- DO handler calls `this.renewActivityTimeout()` and returns 200 OK
- Goroutine stops when main processing completes

---

## Finding 4: Status Reporting Pattern

**Decision**: Add `/status` endpoint to container that returns current processing state.

**Rationale**: Operators need visibility into whether a container is actively processing or stuck. A status endpoint provides:
- Current state: `idle`, `processing`, `error`
- Job ID (if processing)
- Start timestamp (if processing)
- Last error (if any)

**Format**:
```json
{
  "state": "processing",
  "job_id": "episode-123",
  "started_at": "2026-01-17T10:30:00Z",
  "segments_total": 150,
  "segments_downloaded": 75
}
```

**Alternative Considered**: Store status in D1 database
- **Rejected**: Adds unnecessary persistence for transient state; container is the source of truth.

---

## Finding 5: Graceful Shutdown Handling

**Decision**: Handle SIGTERM by canceling FFmpeg process and cleaning up temp files.

**Rationale**: Cloudflare Containers send SIGTERM followed by SIGKILL after 15 minutes. The Go container should:
1. Catch SIGTERM via `signal.Notify`
2. Cancel the FFmpeg process if running (via context cancellation)
3. Remove temp directory
4. Exit cleanly

**Note**: Jobs interrupted mid-processing will be retried by the queue (max_retries = 3). No partial state recovery is needed.

---

## Finding 6: Timeout Enforcement

**Decision**: Enforce 60-minute maximum processing time via context deadline in Go container.

**Rationale**: Spec requires FR-004 (maximum processing time to prevent zombie containers). Implemented via:
1. Go context with 60-minute deadline wrapping FFmpeg execution
2. If deadline exceeded, cancel FFmpeg and return error
3. Error propagates to queue, which may retry or DLQ

---

## Architecture Decision Record

### ADR-001: Heartbeat Mechanism

**Context**: FFmpeg processing takes 10-40 minutes; sleepAfter is 5 minutes.

**Decision**: Implement container-to-DO heartbeat every 2 minutes during processing.

**Consequences**:
- (+) Container stays alive for full processing duration
- (+) Minimal code changes (2 files)
- (+) No configuration changes to sleepAfter
- (-) Small HTTP overhead (~1 request every 2 minutes per active job)
- (-) Requires heartbeat goroutine management in Go

### ADR-002: Status Endpoint

**Context**: Operators need visibility into container state.

**Decision**: Add `/status` endpoint to Go container returning JSON state.

**Consequences**:
- (+) Simple query for debugging
- (+) No external dependencies
- (-) State is transient (lost on container restart)

---

## Resolved Unknowns

| Unknown | Resolution |
|---------|------------|
| How to extend container lifetime | `renewActivityTimeout()` via heartbeat |
| Heartbeat interval | 2 minutes (< 5 minute sleepAfter) |
| Status storage | In-memory in container, exposed via HTTP |
| Max processing time | 60 minutes via Go context deadline |
| Shutdown handling | SIGTERM → cancel FFmpeg → cleanup → exit |
