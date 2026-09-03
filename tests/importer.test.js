'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('../server/db');
const { importCsv } = require('../server/lib/importer');

function freshDb() {
  return openDb(':memory:');
}
function fixture(name) {
  return path.join(__dirname, '..', 'fixtures', name);
}

const REAL_CSV = path.join(__dirname, '..', '..', 'spotify liked songs rj.csv');
const skipRealCsv = fs.existsSync(REAL_CSV)
  ? false
  : 'real Spotify export not present at repo root (optional, local-only fixture)';

test('importer: parses basic.csv and preserves every row', () => {
  const db = freshDb();
  const result = importCsv(db, fixture('basic.csv'), { filename: 'basic.csv' });
  assert.equal(result.rowCount, 14);
  const rawCount = db.prepare('SELECT COUNT(*) c FROM raw_rows').get().c;
  assert.equal(rawCount, 14, 'every row must be preserved in raw_rows, including the literal duplicate row');
});

test('importer: handles missing track/artist names without discarding the row', () => {
  const db = freshDb();
  const result = importCsv(db, fixture('malformed.csv'), { filename: 'malformed.csv' });
  // 6 data rows in the fixture, all preserved as raw rows regardless of validity
  assert.equal(result.rowCount, 6);
  const rawCount = db.prepare('SELECT COUNT(*) c FROM raw_rows').get().c;
  assert.equal(rawCount, 6);
  assert.ok(result.skippedNoTitle >= 2, 'rows missing a track name should be flagged, not silently kept as normal');
  // The row with a missing track name should still be inspectable via raw_rows.
  const missingTitleRaw = db
    .prepare("SELECT * FROM raw_rows WHERE parse_status != 'ok'")
    .all();
  assert.ok(missingTitleRaw.length > 0);
  // But rows that DO have a title (even with missing artist) get a normalized_entries row.
  const noArtistEntry = db
    .prepare("SELECT * FROM normalized_entries WHERE track_raw = 'No Artist Track'")
    .get();
  assert.ok(noArtistEntry, 'a row with a title but missing artist should still produce a normalized entry');
});

test('importer: column-count mismatches are flagged as warnings, not thrown', () => {
  const db = freshDb();
  const result = importCsv(db, fixture('malformed.csv'), { filename: 'malformed.csv' });
  const warningRows = result.warnings;
  assert.ok(warningRows.some((w) => /column count mismatch/i.test(w.message)));
});

test('importer: handles unicode (Japanese, emoji, diacritics) correctly end-to-end', () => {
  const db = freshDb();
  importCsv(db, fixture('unicode.csv'), { filename: 'unicode.csv' });
  const rows = db.prepare('SELECT * FROM normalized_entries ORDER BY id').all();
  assert.equal(rows.length, 4);
  assert.equal(rows[0].track_raw, 'ロマンス');
  assert.equal(rows[0].artist_display, '初音ミク');
  assert.equal(rows[1].track_raw, 'Café del Mar');
  assert.equal(rows[2].track_raw, '☆Sparkle☆');
  assert.match(rows[2].album_raw, /💿/);
});

test('importer: detects Spotify track ID from URI when no explicit ID column exists', () => {
  const db = freshDb();
  importCsv(db, fixture('basic.csv'), { filename: 'basic.csv' });
  const row = db.prepare("SELECT * FROM normalized_entries WHERE spotify_track_uri = 'spotify:track:aaa1'").get();
  assert.equal(row.spotify_track_id, 'aaa1');
});

test('importer: multi-artist field is split correctly', () => {
  const db = freshDb();
  importCsv(db, fixture('basic.csv'), { filename: 'basic.csv' });
  const row = db.prepare("SELECT * FROM normalized_entries WHERE track_raw = 'Come Together'").get();
  const artists = JSON.parse(row.artist_names_json);
  assert.deepEqual(artists, ['The Beatles']);
});

test('importer: real Spotify "Liked Songs" export CSV column detection', { skip: skipRealCsv }, () => {
  const db = freshDb();
  const result = importCsv(db, REAL_CSV, { filename: 'spotify liked songs rj.csv' });
  assert.equal(result.rowCount, 1603);
  assert.equal(result.columnMap.trackName, 'Track Name');
  assert.equal(result.columnMap.artistNames, 'Artist Name(s)');
  assert.equal(result.columnMap.albumName, 'Album Name');
  assert.equal(result.columnMap.trackNumber, null, 'this export has no Track Number column');
  assert.equal(result.columnMap.discNumber, null, 'this export has no Disc Number column');
  assert.ok(result.extraHeaders.includes('Danceability'), 'audio-feature columns should be recognized as extra/unmapped');
  assert.equal(result.skippedNoTitle, 3, 'the 3 known blank-title rows in the fixture');
});
