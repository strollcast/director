-- Migration: Create jobs table for podcast generation workflow
-- Created: 2024-12-28

CREATE TABLE jobs (
    id TEXT PRIMARY KEY,           -- UUID
    arxiv_id TEXT NOT NULL,
    arxiv_url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,

    -- Extracted metadata from arXiv
    title TEXT,
    authors TEXT,
    year INTEGER,
    abstract TEXT,

    -- Generated content references
    episode_id TEXT,               -- Links to episodes table when complete
    script_url TEXT,               -- R2 URL for script.md

    -- Timestamps
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
);

-- Indexes for common queries
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_arxiv_id ON jobs(arxiv_id);
CREATE INDEX idx_jobs_created_at ON jobs(created_at DESC);
