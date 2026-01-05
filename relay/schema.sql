-- Users are identified by user_id and protected by publish/read key hashes.
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  publish_hash TEXT NOT NULL,
  read_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Daily summaries (YYYY-MM-DD). We keep history so friends can show trends later.
CREATE TABLE IF NOT EXISTS summaries (
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_summaries_user_date ON summaries(user_id, date);

