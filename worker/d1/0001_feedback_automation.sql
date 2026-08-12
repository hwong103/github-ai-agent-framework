CREATE TABLE IF NOT EXISTS feedback_cases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 64),
  user_key TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 8000),
  pathname TEXT NOT NULL CHECK (length(pathname) BETWEEN 1 AND 512),
  screenshot_key TEXT,
  screenshot_media_type TEXT CHECK (
    screenshot_media_type IS NULL
    OR screenshot_media_type IN ('image/jpeg', 'image/png', 'image/webp')
  ),
  screenshot_size_bytes INTEGER CHECK (
    screenshot_size_bytes IS NULL
    OR screenshot_size_bytes BETWEEN 1 AND 16777216
  ),
  state TEXT NOT NULL DEFAULT 'submitted' CHECK (
    state IN ('submitted', 'queued', 'processing', 'needs_discussion', 'issue_created')
  ),
  category TEXT CHECK (category IS NULL OR category IN ('bug', 'feature', 'other')),
  triage_reason TEXT,
  assessment_json TEXT,
  assessment_model TEXT,
  policy_version TEXT,
  github_issue_number INTEGER,
  github_issue_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (project_id, user_key, client_request_id),
  UNIQUE (project_id, github_issue_number)
);

CREATE INDEX IF NOT EXISTS idx_feedback_cases_state_created
  ON feedback_cases(state, created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_cases_project_issue
  ON feedback_cases(project_id, github_issue_number);

CREATE TABLE IF NOT EXISTS feedback_jobs (
  id TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'triage' CHECK (kind = 'triage'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'processing', 'retry', 'completed', 'failed')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_token TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  FOREIGN KEY (feedback_id) REFERENCES feedback_cases(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_feedback_jobs_ready
  ON feedback_jobs(status, available_at);
CREATE INDEX IF NOT EXISTS idx_feedback_jobs_lease
  ON feedback_jobs(status, lease_expires_at);

CREATE TABLE IF NOT EXISTS feedback_outbox (
  id TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'enqueued', 'completed')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (feedback_id) REFERENCES feedback_cases(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_feedback_outbox_ready
  ON feedback_outbox(status, next_attempt_at);
