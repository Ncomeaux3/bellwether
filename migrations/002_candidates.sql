CREATE TABLE candidates (
  id INTEGER PRIMARY KEY,
  url TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  verdict TEXT NOT NULL,               -- 'pass' | 'fail' | 'error'
  reason TEXT NOT NULL,
  price_matches INTEGER NOT NULL DEFAULT 0,
  tier_headings INTEGER NOT NULL DEFAULT 0,
  proposed_canary TEXT,
  http_status INTEGER,
  screened_at TEXT NOT NULL
);
