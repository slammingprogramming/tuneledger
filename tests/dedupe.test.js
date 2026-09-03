'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { openDb } = require('../server/db');
const { importCsv } = require('../server/lib/importer');
const { runDedupe } = require('../server/lib/dedupe');

function freshDb() {
  return openDb(':memory:');
}
function fixture(name) {
  return path.join(__dirname, '..', 'fixtures', name);
}

function setup(file) {
  const db = freshDb();
  importCsv(db, fixture(file), { filename: file });
  runDedupe(db);
  return db;
}

function canonicalByTitle(db, title) {
  return db
    .prepare(
      `SELECT ct.*, (SELECT COUNT(*) FROM track_sources ts WHERE ts.canonical_track_id = ct.id) AS sourceCount
       FROM canonical_tracks ct WHERE ct.title = ?`
    )
    .all(title);
}

test('dedupe: exact duplicate CSV row does not create a second canonical track', () => {
  const db = setup('basic.csv');
  // aaa1 appears twice verbatim in basic.csv (identical Track URI both times).
  const rows = canonicalByTitle(db, 'Come Together');
  assert.equal(rows.length, 1, 'the compilation appearance and the literal duplicate row should both fold into one canonical track');
  assert.equal(rows[0].sourceCount, 3, '2 rows with URI aaa1 (one literal dup) + 1 compilation row (aaa3) = 3 sources');
});

test('dedupe: same song on a compilation album merges into the studio-album version', () => {
  const db = setup('basic.csv');
  const moneyRows = canonicalByTitle(db, 'Money');
  assert.equal(moneyRows.length, 1);
  assert.equal(moneyRows[0].sourceCount, 2, 'Dark Side of the Moon + Echoes compilation');
  // Preferred (primary) source should be the studio album, not the compilation.
  const album = db.prepare('SELECT name FROM albums WHERE id = ?').get(moneyRows[0].album_id);
  assert.equal(album.name, 'The Dark Side of the Moon');
});

test('dedupe: live version is kept as a distinct canonical track, not merged with the studio version', () => {
  const db = setup('basic.csv');
  const liveRows = canonicalByTitle(db, 'Money (Live)');
  assert.equal(liveRows.length, 1);
  assert.equal(liveRows[0].version_type, 'live');
  const studioRows = canonicalByTitle(db, 'Money');
  assert.notEqual(liveRows[0].id, studioRows[0].id);
});

test('dedupe: "Come Together - Live" stays separate from the studio "Come Together"', () => {
  const db = setup('basic.csv');
  const studio = canonicalByTitle(db, 'Come Together');
  const live = canonicalByTitle(db, 'Come Together - Live');
  assert.equal(studio.length, 1);
  assert.equal(live.length, 1);
  assert.notEqual(studio[0].id, live[0].id);
  assert.equal(live[0].version_type, 'live');
});

test('dedupe: a remaster is NOT silently auto-merged with the original (different version_type)', () => {
  const db = setup('basic.csv');
  const original = canonicalByTitle(db, 'Yesterday');
  const remaster = canonicalByTitle(db, 'Yesterday - Remastered 2009');
  assert.equal(original.length, 1);
  assert.equal(remaster.length, 1);
  assert.notEqual(original[0].id, remaster[0].id);
  assert.equal(remaster[0].version_type, 'remaster');
});

test('dedupe: duration mismatch prevents a false merge even with an identical stripped stem', () => {
  const db = freshDb();
  // Two rows, same artist, titles that strip to the same stem via different
  // annotation styles, but very different durations (a real "different mix").
  db.exec(`DELETE FROM imports`); // no-op, keeps intent explicit
  const csvPath = require('node:path').join(require('os').tmpdir(), 'dedupe-duration-test.csv');
  require('node:fs').writeFileSync(
    csvPath,
    'Track URI,Track Name,Album Name,Artist Name(s),Release Date,Duration (ms),Popularity,Explicit,Added By,Added At,Genres,Record Label\n' +
      'spotify:track:d1,Tokyo Heat - Club Mix,Tokyo Heat,C.H.A.Y.,2023-01-01,219435,10,false,,2023-01-01T00:00:00Z,,\n' +
      'spotify:track:d2,Tokyo Heat (Tokyo Drift),Tokyo Heat,C.H.A.Y.,2023-01-01,160629,10,false,,2023-01-01T00:00:00Z,,\n'
  );
  importCsv(db, csvPath, { filename: 'dedupe-duration-test.csv' });
  const stats = runDedupe(db);
  assert.equal(stats.newCanonical, 2, 'both rows should seed their own canonical track');
  assert.equal(stats.mergedFuzzy, 0, 'must not auto-merge across a ~1 minute duration gap');
  assert.equal(stats.flaggedForReview, 1, 'should still surface the ambiguity for human review');
  const pending = db.prepare("SELECT * FROM possible_duplicates WHERE status='pending'").all();
  assert.equal(pending.length, 1);
});

test('dedupe: reimporting the exact same CSV creates zero new canonical tracks (idempotent)', () => {
  const db = setup('basic.csv');
  const before = db.prepare('SELECT COUNT(*) c FROM canonical_tracks').get().c;
  importCsv(db, fixture('basic.csv'), { filename: 'basic.csv (again)' });
  const stats = runDedupe(db);
  const after = db.prepare('SELECT COUNT(*) c FROM canonical_tracks').get().c;
  assert.equal(stats.newCanonical, 0);
  assert.equal(before, after);
});
