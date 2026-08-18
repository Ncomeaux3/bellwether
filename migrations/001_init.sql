CREATE TABLE competitors (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  homepage TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  competitor_id INTEGER NOT NULL REFERENCES competitors(id),
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  canary_string TEXT NOT NULL,
  cadence_hours INTEGER NOT NULL DEFAULT 24,
  active INTEGER NOT NULL DEFAULT 1,
  degraded_reason TEXT,
  UNIQUE (competitor_id, kind, url)
);

CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  observed_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  http_status INTEGER,
  error TEXT,
  raw_content TEXT,
  raw_hash TEXT,
  normalized_hash TEXT,
  provenance TEXT NOT NULL
);
CREATE INDEX idx_snap_source_time ON snapshots(source_id, observed_at);
CREATE INDEX idx_snap_raw_hash ON snapshots(source_id, raw_hash);

CREATE TABLE extractions (
  id INTEGER PRIMARY KEY,
  normalized_hash TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  data_json TEXT NOT NULL,
  extraction_confidence TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  grounded INTEGER NOT NULL DEFAULT 1,
  is_backfill INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_micros INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (normalized_hash, prompt_version)
);

CREATE TABLE changes (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  from_snapshot_id INTEGER NOT NULL,
  to_snapshot_id INTEGER NOT NULL,
  change_type TEXT NOT NULL,
  json_path TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  materiality INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'candidate',
  observed_at TEXT NOT NULL,
  UNIQUE (source_id, from_snapshot_id, to_snapshot_id, json_path)
);

CREATE TABLE analyses (
  id INTEGER PRIMARY KEY,
  change_id INTEGER NOT NULL REFERENCES changes(id),
  implication TEXT NOT NULL,
  so_what TEXT NOT NULL,
  confidence TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (change_id, prompt_version)
);

CREATE TABLE digests (
  id INTEGER PRIMARY KEY,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  body_md TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  cost_micros INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (period_start, prompt_version)
);

CREATE TABLE backfill_queue (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  wayback_ts TEXT NOT NULL,
  target_url TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (source_id, wayback_ts)
);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  state TEXT NOT NULL DEFAULT 'running',
  ok INTEGER,
  stats_json TEXT,
  error TEXT
);
CREATE INDEX idx_runs_kind_state ON runs(kind, state, started_at);
