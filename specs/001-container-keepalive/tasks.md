# Tasks: Long-Running Container Keepalive

**Input**: Design documents from `/specs/001-container-keepalive/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Not explicitly requested in spec. Manual integration testing per quickstart.md.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **API Worker**: `api/src/` (TypeScript)
- **Container**: `api/container/` (Go)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: No new project structure needed; this feature modifies existing files only.

- [x] T001 Review existing FFmpegContainer class in api/src/index.ts to understand current implementation
- [x] T002 Review existing Go HTTP server in api/container/main.go to understand current endpoints

**Checkpoint**: Understanding of existing code complete

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core data structures that all user stories depend on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T003 Add ContainerStatus struct to api/container/main.go with fields: state, job_id, started_at, segments_total, segments_downloaded, last_error, last_heartbeat
- [x] T004 Add global containerStatus variable and mutex for thread-safe access in api/container/main.go
- [x] T005 Add HeartbeatRequest and HeartbeatResponse types to api/container/main.go
- [x] T006 Add StatusResponse type to api/container/main.go (matches ContainerStatus for JSON serialization)

**Checkpoint**: Foundation ready - user story implementation can now begin

---

## Phase 3: User Story 1 - Complete Long Audio Processing (Priority: P1) 🎯 MVP

**Goal**: Container stays alive during 10-40 minute FFmpeg jobs by sending heartbeats to renew activity timeout.

**Independent Test**: Submit a job with 100+ audio segments totaling 40 minutes. Verify the final MP3 is produced without container termination.

### Implementation for User Story 1

- [x] T007 [US1] Add heartbeat handler method to FFmpegContainer class in api/src/index.ts that calls this.renewActivityTimeout()
- [x] T008 [US1] Register /heartbeat route in FFmpegContainer fetch handler in api/src/index.ts
- [x] T009 [US1] Add sendHeartbeat function in api/container/main.go that POSTs to container's own /heartbeat endpoint
- [x] T010 [US1] Add startHeartbeat goroutine function in api/container/main.go that sends heartbeat every 2 minutes via ticker
- [x] T011 [US1] Add stopHeartbeat function in api/container/main.go using channel to signal goroutine termination
- [x] T012 [US1] Modify handleConcat in api/container/main.go to update containerStatus.state to "processing" on job start
- [x] T013 [US1] Modify handleConcat in api/container/main.go to call startHeartbeat after setting processing state
- [x] T014 [US1] Modify handleConcat in api/container/main.go to update segments_downloaded count during download loop
- [x] T015 [US1] Modify handleConcat in api/container/main.go to call stopHeartbeat and reset state to "idle" on success
- [x] T016 [US1] Modify handleConcat in api/container/main.go to call stopHeartbeat and set state to "error" on failure
- [x] T017 [US1] Add 60-minute context deadline to handleConcat in api/container/main.go to prevent zombie containers
- [x] T018 [US1] Add logging for heartbeat sent/acknowledged in api/container/main.go

**Checkpoint**: At this point, User Story 1 should be fully functional - containers survive long jobs

---

## Phase 4: User Story 2 - Visibility into Processing Status (Priority: P2)

**Goal**: Operators can query container state to see if it's idle, processing, or in error.

**Independent Test**: Start a long job, query /status, verify response shows "processing" with job details.

### Implementation for User Story 2

- [x] T019 [US2] Add handleStatus function in api/container/main.go that returns containerStatus as JSON
- [x] T020 [US2] Register /status route in main() function in api/container/main.go
- [x] T021 [US2] Add started_at timestamp update when job starts in handleConcat in api/container/main.go
- [x] T022 [US2] Add last_heartbeat timestamp update in sendHeartbeat function in api/container/main.go
- [x] T023 [US2] Add last_error update when errors occur in handleConcat in api/container/main.go

**Checkpoint**: At this point, operators can query container status during processing

---

## Phase 5: User Story 3 - Graceful Shutdown During Processing (Priority: P3)

**Goal**: Container handles SIGTERM gracefully, canceling FFmpeg and cleaning up temp files.

**Independent Test**: Start a long job, send SIGTERM to container, verify logs show graceful shutdown and temp cleanup.

### Implementation for User Story 3

- [x] T024 [US3] Add signal handling for SIGTERM in main() function in api/container/main.go using signal.Notify
- [x] T025 [US3] Add shutdown context that cancels on SIGTERM in api/container/main.go
- [x] T026 [US3] Pass context to exec.CommandContext for FFmpeg in handleConcat in api/container/main.go
- [x] T027 [US3] Add cleanup of temp directory on SIGTERM in api/container/main.go
- [x] T028 [US3] Add logging for graceful shutdown events in api/container/main.go

**Checkpoint**: Container handles shutdown gracefully during active processing

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final validation and documentation

- [x] T029 Update CLAUDE.md with heartbeat mechanism documentation
- [ ] T030 Deploy to Cloudflare and run quickstart.md validation with a long job
- [ ] T031 Verify wrangler logs show heartbeat messages during processing
- [ ] T032 Test container survives beyond 5-minute sleepAfter during active job

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3-5)**: All depend on Foundational phase completion
  - US1 can start immediately after Foundational
  - US2 can start after US1 (uses containerStatus populated by US1)
  - US3 can start after US1 (modifies handleConcat from US1)
- **Polish (Phase 6)**: Depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - No dependencies on other stories
- **User Story 2 (P2)**: Can start after US1 - Uses containerStatus updates from US1
- **User Story 3 (P3)**: Can start after US1 - Modifies handleConcat behavior from US1

### Within Each User Story

- Models/types before implementation
- Core logic before integration
- Logging after functionality works

### Parallel Opportunities

- T001 and T002 can run in parallel (both are read-only review)
- T003, T004, T005, T006 can run in parallel (different struct definitions)
- Within US1: T007 and T008 can run in parallel (TS file), T009-T011 can run in parallel with T007-T008 (Go file)

---

## Parallel Example: Foundational Phase

```bash
# Launch all type definitions together:
Task: "Add ContainerStatus struct in api/container/main.go"
Task: "Add HeartbeatRequest and HeartbeatResponse types in api/container/main.go"
Task: "Add StatusResponse type in api/container/main.go"
```

## Parallel Example: User Story 1

```bash
# TypeScript and Go work can proceed in parallel:
Task: "Add heartbeat handler to FFmpegContainer in api/src/index.ts"
Task: "Add sendHeartbeat function in api/container/main.go"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (review existing code)
2. Complete Phase 2: Foundational (add data structures)
3. Complete Phase 3: User Story 1 (heartbeat mechanism)
4. **STOP and VALIDATE**: Deploy and test with a 10+ minute job
5. Deploy MVP - long jobs now survive

### Incremental Delivery

1. Complete Setup + Foundational → Types ready
2. Add User Story 1 → Test with long job → Deploy (MVP!)
3. Add User Story 2 → Test /status endpoint → Deploy
4. Add User Story 3 → Test SIGTERM handling → Deploy
5. Each story adds value without breaking previous stories

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- All changes are to existing files (api/src/index.ts, api/container/main.go)
- No new dependencies required
- Heartbeat interval (2 min) must be less than sleepAfter (5 min)
- 60-minute max timeout prevents zombie containers (FR-004)
- Commit after each task or logical group
