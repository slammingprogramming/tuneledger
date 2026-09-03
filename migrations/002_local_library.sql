-- Local library scanning + WPL playlist import support.
-- Reuses the existing raw_rows -> normalized_entries -> canonical_tracks
-- pipeline: a scanned file or WPL <media> reference becomes a synthetic
-- "row" the same way a Spotify CSV line does, so the same dedupe engine
-- reconciles local files against everything already in the queue.

PRAGMA foreign_keys = ON;

ALTER TABLE imports ADD COLUMN source_type TEXT NOT NULL DEFAULT 'spotify_csv';
-- spotify_csv | local_scan | wpl
ALTER TABLE imports ADD COLUMN root_path TEXT;

ALTER TABLE normalized_entries ADD COLUMN file_path TEXT;
ALTER TABLE normalized_entries ADD COLUMN media_kind TEXT; -- audio | video
ALTER TABLE normalized_entries ADD COLUMN musicbrainz_recording_id TEXT;
ALTER TABLE normalized_entries ADD COLUMN identify_method TEXT;
-- tags_mb | tags_only | filename_mb | filename_only
ALTER TABLE normalized_entries ADD COLUMN identify_confidence REAL;

CREATE INDEX IF NOT EXISTS idx_norm_mbid ON normalized_entries(musicbrainz_recording_id);
CREATE INDEX IF NOT EXISTS idx_norm_file_path ON normalized_entries(file_path);

-- One row per directory scan or WPL import "job" - these can run long
-- (MusicBrainz is rate-limited to ~1 req/sec) so they execute as a
-- background job the UI polls rather than blocking an HTTP request.
CREATE TABLE IF NOT EXISTS scan_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL, -- local_scan | wpl
  root_path TEXT NOT NULL,
  review_folder TEXT,
  status TEXT NOT NULL DEFAULT 'running', -- running | completed | failed | cancelled
  dry_run INTEGER NOT NULL DEFAULT 1,
  use_musicbrainz INTEGER NOT NULL DEFAULT 1,
  total_files INTEGER NOT NULL DEFAULT 0,
  processed_files INTEGER NOT NULL DEFAULT 0,
  identified_count INTEGER NOT NULL DEFAULT 0,
  review_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  current_file TEXT,
  error TEXT,
  import_id INTEGER REFERENCES imports(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);

-- Every file the scanner decided needed a human (couldn't be identified),
-- and - once applied - where it was moved to. Kept even in dry_run mode so
-- the UI can show "here's what WOULD move" before anything touches disk.
CREATE TABLE IF NOT EXISTS file_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_job_id INTEGER REFERENCES scan_jobs(id) ON DELETE SET NULL,
  original_path TEXT NOT NULL,
  new_path TEXT NOT NULL,
  reason TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0,
  moved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_file_moves_job ON file_moves(scan_job_id);
