# Implementation Plan: Long-Running Container Keepalive

**Branch**: `001-container-keepalive` | **Date**: 2026-01-17 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-container-keepalive/spec.md`

## Summary

Implement a heartbeat mechanism between the Go FFmpeg container and the TypeScript Worker's Durable Object layer to keep containers alive during long-running audio processing (10-40 minutes). The solution uses Cloudflare's `renewActivityTimeout()` API triggered by periodic HTTP requests from the container to the Worker, plus a status endpoint for operational visibility.

## Technical Context

**Language/Version**: TypeScript (Worker/Durable Object), Go 1.21+ (Container)
**Primary Dependencies**: `@cloudflare/containers` (Worker), standard library (Go)
**Storage**: Cloudflare R2 (audio files), D1 (job metadata)
**Testing**: Manual integration testing (Cloudflare Containers lack local emulation)
**Target Platform**: Cloudflare Workers + Containers (global edge)
**Project Type**: API (Cloudflare Worker with Container sidecar)
**Performance Goals**: Support jobs up to 60 minutes without timeout
**Constraints**: Must not keep Workers alive unnecessarily (cost); heartbeat interval < sleepAfter
**Scale/Scope**: 5 max concurrent container instances, ~100 episodes/month

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| II. Cloudflare-Native | ✅ Pass | Uses only Cloudflare Containers, Workers, R2 |
| III. Automated Pipeline | ✅ Pass | Enhances reliability of existing automation |
| V. Simplicity | ✅ Pass | Minimal changes: 1 new endpoint, 1 heartbeat loop |

**No violations requiring justification.**

## Project Structure

### Documentation (this feature)

```text
specs/001-container-keepalive/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── heartbeat-api.md # Heartbeat endpoint contract
└── tasks.md             # Phase 2 output (NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
api/
├── src/
│   └── index.ts         # FFmpegContainer class (modify)
└── container/
    └── main.go          # HTTP server (modify: add heartbeat sender, status endpoint)
```

**Structure Decision**: Existing structure. Modifications to two files only:
- `api/src/index.ts`: Add `renewActivityTimeout()` call in heartbeat handler
- `api/container/main.go`: Add heartbeat goroutine and `/status` endpoint

## Complexity Tracking

> No violations—section not applicable.
