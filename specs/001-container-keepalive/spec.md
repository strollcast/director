# Feature Specification: Long-Running Container Keepalive

**Feature Branch**: `001-container-keepalive`
**Created**: 2026-01-17
**Status**: Draft
**Input**: User description: "There is a disconnect between the ffmpeg processing in the container and the api layer that drives it. The ffmpeg process can run for an undeterminate amount of time, likely in the range of 10min-40min. The configuration is such that sleep after kills the container after the last activity, but it seems that the only activity is the initial http request to start the processing. We need to find a way to make sure that: 1. processing is still going in the container. 2. we let cloudflare know what container is alive."

## Problem Statement

The FFmpeg container processes audio concatenation jobs that can take 10-40 minutes to complete. The current `sleepAfter: "5m"` configuration tracks "activity" as incoming HTTP requests, but the only request is the initial POST to `/concat`. This means the container may be terminated mid-processing because no new requests arrive during the lengthy FFmpeg operation.

**Current Behavior**: Container receives one request → FFmpeg runs for 10-40min → Container killed after 5min inactivity → Job fails silently.

**Desired Behavior**: Container stays alive for the full duration of processing and signals completion or failure back to the orchestrating layer.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Complete Long Audio Processing (Priority: P1)

As a podcast producer, I want to submit an episode with many segments (potentially 40+ minutes of audio) and have it successfully concatenate without the container being killed mid-process.

**Why this priority**: This is the core problem—without this fix, long episodes fail unpredictably.

**Independent Test**: Submit a job with 100+ audio segments totaling 40 minutes. Verify the final MP3 is produced with correct duration and no silent gaps or truncation.

**Acceptance Scenarios**:

1. **Given** a job with 100 audio segments totaling 35 minutes of content, **When** the FFmpeg concatenation runs, **Then** the container remains active until processing completes and returns a valid MP3 file.

2. **Given** a job submitted during high-load periods, **When** multiple long-running jobs are queued, **Then** each container instance processes its job to completion without premature termination.

3. **Given** a job that takes 25 minutes to process, **When** the processing completes, **Then** the container returns the duration and file size and properly goes idle afterward.

---

### User Story 2 - Visibility into Processing Status (Priority: P2)

As an operator, I want to know whether a container is actively processing or stuck, so I can identify failed jobs before users report missing episodes.

**Why this priority**: Debugging silent failures is costly; visibility prevents wasted investigation time.

**Independent Test**: Start a long job, then query status. Verify the response indicates "processing" with progress information. After completion, verify status shows "complete" or "idle."

**Acceptance Scenarios**:

1. **Given** a container running FFmpeg, **When** an operator queries the container status, **Then** the response indicates the container is actively processing with a timestamp of last activity.

2. **Given** a container that completed processing, **When** an operator queries the container status, **Then** the response indicates "idle" or "complete" with the result of the last job.

3. **Given** a container where FFmpeg crashed, **When** an operator queries the container status, **Then** the response indicates "error" with relevant diagnostic information.

---

### User Story 3 - Graceful Shutdown During Processing (Priority: P3)

As an operator, I want long-running jobs to handle graceful shutdown signals, so that if a container must be stopped, partial work is not lost or left in an inconsistent state.

**Why this priority**: Edge case, but important for clean operations during deployments or scaling events.

**Independent Test**: Start a long job, send SIGTERM to the container, verify FFmpeg receives the signal and the container logs indicate graceful cleanup.

**Acceptance Scenarios**:

1. **Given** a container processing a job, **When** SIGTERM is received, **Then** the container logs the interruption and cleans up temporary files before exiting.

2. **Given** a container that was interrupted mid-job, **When** the job is retried, **Then** it restarts from the beginning without issues from partial state.

---

### Edge Cases

- What happens when FFmpeg hangs indefinitely (e.g., corrupted input file)?
  - System should have a maximum processing timeout (configurable upper bound) to prevent zombie containers.

- What happens when the container loses connectivity to R2 mid-upload?
  - The job should fail with a clear error rather than hanging, and the failure should be surfaced to the queue for retry.

- What happens when memory is exhausted during processing?
  - Container should fail gracefully with an OOM indicator rather than being silently killed.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST keep the container alive while FFmpeg is actively processing audio, regardless of the `sleepAfter` configuration.

- **FR-002**: System MUST provide a mechanism for the container to signal "still processing" to the orchestrating layer.

- **FR-003**: System MUST expose a status endpoint that reports whether the container is idle, processing, or in an error state.

- **FR-004**: System MUST enforce a maximum processing time limit to prevent containers from running indefinitely on stuck jobs.

- **FR-005**: System MUST handle SIGTERM gracefully during active processing, logging the interruption and cleaning up temporary files.

- **FR-006**: System MUST report job completion status (success with duration/size, or failure with error details) back to the caller.

### Assumptions

- The FFmpeg process itself is reliable and does not hang under normal conditions; the issue is purely the container lifecycle management.
- The current 5-minute `sleepAfter` is appropriate for idle containers; only active processing needs extended lifetime.
- Jobs are processed one at a time per container instance (current behavior).
- The maximum realistic processing time is 60 minutes; jobs exceeding this are considered stuck.

### Key Entities

- **Job**: A unit of work representing audio concatenation; has state (pending, processing, complete, failed), input segments, output location, and timing metadata.

- **Container Instance**: A running FFmpeg container with lifecycle state (starting, healthy, processing, idle, stopping) and activity timestamp.

- **Heartbeat**: A periodic signal from the container indicating it is still actively processing, used to extend the activity timeout.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Episodes with 40+ minutes of audio complete successfully 99% of the time (up from current unreliable behavior).

- **SC-002**: No containers are terminated mid-processing due to activity timeout when FFmpeg is actively running.

- **SC-003**: Operators can determine container processing status within 5 seconds of querying.

- **SC-004**: Stuck containers (processing > 60 minutes) are automatically terminated and the failure is logged for investigation.

- **SC-005**: Container shutdown during active processing logs a clear message indicating interruption, enabling post-mortem analysis.
