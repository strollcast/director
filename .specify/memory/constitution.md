<!--
================================================================================
SYNC IMPACT REPORT
================================================================================
Version change: 0.0.0 → 1.0.0 (MAJOR - initial constitution)

Added sections:
- I. Content Quality First
- II. Cloudflare-Native Architecture
- III. Automated Pipeline
- IV. User Privacy
- V. Simplicity & Maintainability
- Development Workflow
- Quality Standards
- Governance

Templates requiring updates:
- ✅ .specify/templates/plan-template.md (no changes needed - generic)
- ✅ .specify/templates/spec-template.md (no changes needed - generic)
- ✅ .specify/templates/tasks-template.md (no changes needed - generic)

Follow-up TODOs: None
================================================================================
-->

# Strollcast Constitution

## Core Principles

### I. Content Quality First

Every episode MUST accurately represent the source research paper. The AI-generated
transcript is the foundation of the product—accuracy and educational value take
priority over production speed.

**Non-negotiables:**
- Hosts (Eric and Maya) MUST always be introduced as AI/virtual hosts
- Every episode MUST include 2 quiz questions at the end
- Speaker tags MUST use the format `**ERIC:**` and `**MAYA:**`
- Transcripts MUST cite the paper correctly (author, year, title, arXiv URL)
- Content MUST be accessible to listeners without requiring the paper open

**Rationale:** Users trust Strollcast to faithfully translate complex ML research.
Misrepresentation damages credibility and the research community.

### II. Cloudflare-Native Architecture

All infrastructure MUST use Cloudflare services (Pages, Workers, D1, R2, Queues).
This ensures consistent deployment, low latency, and simplified operations.

**Non-negotiables:**
- Site MUST deploy to Cloudflare Pages with SSR
- API MUST run on Cloudflare Workers
- Persistent data MUST use D1 (database) and R2 (objects/audio)
- Background jobs MUST use Cloudflare Queues
- No external hosting services (AWS, GCP, Vercel) for core infrastructure

**Rationale:** Single-vendor infrastructure reduces operational complexity,
enables edge-first performance, and keeps costs predictable.

### III. Automated Pipeline

Episode generation MUST be fully automated from arXiv URL to published audio.
Manual intervention indicates a pipeline bug, not a workflow step.

**Non-negotiables:**
- Submit arXiv URL → fetch paper → generate transcript → generate audio → publish
- Pipeline failures MUST be logged with actionable error messages
- Audio MUST be normalized to -16 LUFS (podcast standard)
- Generated audio segments MUST be cached in R2 (keyed by text+voice hash)
- Episode metadata MUST be exposed via `/episodes` API for mobile apps

**Rationale:** Manual steps don't scale. Every friction point in episode creation
reduces output velocity and introduces human error.

### IV. User Privacy

User data collection MUST be minimal and purposeful. Authentication exists for
access control, not surveillance.

**Non-negotiables:**
- GitHub OAuth for authentication (no custom credential storage)
- No tracking pixels or third-party analytics in the site
- API keys MUST be stored as Cloudflare secrets, never in code
- User listening history stays on-device (iOS app handles locally)
- No PII in logs beyond what's necessary for debugging

**Rationale:** Users consume educational content; they deserve privacy. Minimal
data collection also reduces compliance burden and attack surface.

### V. Simplicity & Maintainability

Prefer simple, readable solutions over clever abstractions. The codebase should
be understandable by a new contributor within one session.

**Non-negotiables:**
- No abstractions for single-use patterns
- Prefer standard library and platform APIs over third-party dependencies
- Configuration via environment variables and Cloudflare bindings
- One way to do things (not multiple equivalent paths)
- Delete unused code—don't comment it out or deprecate in place

**Rationale:** Strollcast is maintained by a small team. Complexity debt
compounds faster than technical debt.

## Development Workflow

**Branch Strategy:**
- `main` is production; all changes via PR
- Feature branches: `feature/short-description`
- Bugfix branches: `fix/short-description`

**Deployment:**
- Push to `main` triggers automatic deployment via GitHub Actions
- Site deploys to Cloudflare Pages
- API deploys to Cloudflare Workers
- No manual deployment steps

**Code Changes:**
- Changes MUST not break the automated pipeline
- New features SHOULD include updates to CLAUDE.md if they affect workflows
- API changes MUST maintain backward compatibility for mobile clients

## Quality Standards

**Before Merge:**
- Site builds without errors (`npm run build` in `site/`)
- API deploys without errors (`npx wrangler deploy --dry-run` in `api/`)
- New API endpoints documented in CLAUDE.md

**Audio Quality:**
- ElevenLabs voices: Eric (`l7PKZGTaZgsdjGbTQRfS`), Maya (`21m00Tcm4TlvDq8ikWAM`)
- Model: `eleven_turbo_v2_5`
- Normalization: -16 LUFS
- Format: MP3 for web/mobile delivery

## Governance

This constitution supersedes ad-hoc decisions. When in doubt, refer here first.

**Amendments:**
- Propose changes via PR to this file
- Changes require documented rationale
- Version increment follows semantic versioning:
  - MAJOR: Principle removal or fundamental redefinition
  - MINOR: New principle or significant expansion
  - PATCH: Clarifications and wording improvements

**Compliance:**
- PRs SHOULD reference relevant principles when making architectural decisions
- Constitution violations require explicit justification in PR description
- Periodic review: revisit principles quarterly or after major releases

**Version**: 1.0.0 | **Ratified**: 2026-01-17 | **Last Amended**: 2026-01-17
