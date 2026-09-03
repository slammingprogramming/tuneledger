-- Spotify Download Queue - initial schema
-- Layers: raw_rows (RAW) -> normalized_entries (NORMALIZED) -> canonical_tracks (CANONICAL / QUEUE)
-- track_sources links normalized_entries to the canonical_track they were merged into.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  label TEXT,
  imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  row_count INTEGER NOT NULL DEFAULT 0,
  ok_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  column_map TEXT,
  notes TEXT
);

-- RAW SOURCE DATA: verbatim copy of every row as delivered by the CSV. Never mutated.
CREATE TABLE IF NOT EXISTS raw_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  raw_json TEXT NOT NULL,
  parse_status TEXT NOT NULL DEFAULT 'ok', -- ok | error | warning
  parse_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_raw_rows_import ON raw_rows(import_id);

-- NORMALIZED DATA: one row per raw_row, cleaned/parsed/classified but still 1:1 with source.
CREATE TABLE IF NOT EXISTS normalized_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_row_id INTEGER NOT NULL UNIQUE REFERENCES raw_rows(id) ON DELETE CASCADE,
  import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,

  spotify_track_uri TEXT,
  spotify_track_id TEXT,

  artist_raw TEXT,
  artist_names_json TEXT,
  artist_display TEXT,
  artist_norm TEXT,

  album_raw TEXT,
  album_norm TEXT,

  track_raw TEXT,
  track_title_stem TEXT,
  track_norm TEXT,

  version_type TEXT NOT NULL DEFAULT 'original',
  version_detail TEXT,

  track_number INTEGER,
  disc_number INTEGER,
  duration_ms INTEGER,
  release_date TEXT,
  release_year INTEGER,
  explicit INTEGER,
  popularity INTEGER,
  genres TEXT,
  record_label TEXT,
  added_at TEXT,
  release_category TEXT NOT NULL DEFAULT 'unknown', -- album | single | compilation | deluxe | soundtrack | unknown

  extra_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_norm_import ON normalized_entries(import_id);
CREATE INDEX IF NOT EXISTS idx_norm_track_id ON normalized_entries(spotify_track_id);
CREATE INDEX IF NOT EXISTS idx_norm_artist_track_norm ON normalized_entries(artist_norm, track_norm);
CREATE INDEX IF NOT EXISTS idx_norm_artist_stem ON normalized_entries(artist_norm, track_title_stem);

CREATE TABLE IF NOT EXISTS artists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS albums (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_key TEXT NOT NULL,
  release_date TEXT,
  release_category TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(artist_id, sort_key)
);
CREATE INDEX IF NOT EXISTS idx_albums_artist ON albums(artist_id);

-- CANONICAL TRACKS = the download queue. One row per distinct recording we intend to download.
CREATE TABLE IF NOT EXISTS canonical_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  sort_key TEXT NOT NULL,
  version_type TEXT NOT NULL DEFAULT 'original',
  track_number INTEGER,
  disc_number INTEGER,
  duration_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'not_started', -- not_started | in_progress | downloaded | skipped | problem
  ignored INTEGER NOT NULL DEFAULT 0,
  primary_normalized_entry_id INTEGER REFERENCES normalized_entries(id),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ct_artist ON canonical_tracks(artist_id);
CREATE INDEX IF NOT EXISTS idx_ct_album ON canonical_tracks(album_id);
CREATE INDEX IF NOT EXISTS idx_ct_status ON canonical_tracks(status);
CREATE INDEX IF NOT EXISTS idx_ct_ignored ON canonical_tracks(ignored);

-- Links every normalized_entry to the canonical_track it was folded into (traceability of duplicates).
CREATE TABLE IF NOT EXISTS track_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_track_id INTEGER NOT NULL REFERENCES canonical_tracks(id) ON DELETE CASCADE,
  normalized_entry_id INTEGER NOT NULL UNIQUE REFERENCES normalized_entries(id) ON DELETE CASCADE,
  match_stage TEXT NOT NULL, -- exact_id | exact_meta | normalized_title | fuzzy | manual
  match_score REAL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ts_canonical ON track_sources(canonical_track_id);

CREATE TABLE IF NOT EXISTS status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_track_id INTEGER NOT NULL REFERENCES canonical_tracks(id) ON DELETE CASCADE,
  old_status TEXT,
  new_status TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_sh_track ON status_history(canonical_track_id);

CREATE TABLE IF NOT EXISTS manual_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_type TEXT NOT NULL, -- merge | split | set_preferred | edit_field | set_status | ignore | unignore | confirm_duplicate | reject_duplicate
  canonical_track_id INTEGER REFERENCES canonical_tracks(id) ON DELETE SET NULL,
  related_id INTEGER,
  field TEXT,
  old_value TEXT,
  new_value TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_mo_track ON manual_overrides(canonical_track_id);

-- Fuzzy-stage matches that were NOT auto-merged; awaiting user confirm/reject.
-- FKs use SET NULL (not CASCADE) so a resolved record survives as history
-- even after one side of the pair is later merged/deleted - only *pending*
-- rows are pruned when a track they reference disappears (see mutations.js).
CREATE TABLE IF NOT EXISTS possible_duplicates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_track_id_a INTEGER REFERENCES canonical_tracks(id) ON DELETE SET NULL,
  canonical_track_id_b INTEGER REFERENCES canonical_tracks(id) ON DELETE SET NULL,
  score REAL NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | rejected
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pd_status ON possible_duplicates(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pd_pair ON possible_duplicates(canonical_track_id_a, canonical_track_id_b);
