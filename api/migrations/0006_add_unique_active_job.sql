-- Migration: Add unique constraint on active jobs to prevent duplicates
-- Created: 2024-12-28

-- Partial unique index: only one active job per arxiv_id
-- Jobs with status 'failed' or 'completed' are excluded
CREATE UNIQUE INDEX idx_jobs_arxiv_active
ON jobs(arxiv_id)
WHERE status NOT IN ('failed', 'completed');
