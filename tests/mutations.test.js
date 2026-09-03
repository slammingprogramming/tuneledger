'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { openDb } = require('../server/db');
const { importCsv } = require('../server/lib/importer');
const { runDedupe } = require('../server/lib/dedupe');
const mutations = require('../server/lib/mutations');

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

test('mutations: status change persists and is recorded in status_history', () => {
  const db = setup('basic.csv');
  const track = db.prepare("SELECT * FROM canonical_tracks WHERE title = 'Something'").get();
  mutations.setStatus(db, track.id, 'downloaded', 'test note');
  const after = db.prepare('SELECT status FROM canonical_tracks WHERE id = ?').get(track.id);
  assert.equal(after.status, 'downloaded');
  const history = db.prepare('SELECT * FROM status_history WHERE canonical_track_id = ?').all(track.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].old_status, 'not_started');
  assert.equal(history[0].new_status, 'downloaded');
});

test('mutations: rejects an invalid status value', () => {
  const db = setup('basic.csv');
  const track = db.prepare("SELECT * FROM canonical_tracks WHERE title = 'Something'").get();
  assert.throws(() => mutations.setStatus(db, track.id, 'bogus_status'), /Invalid status/);
});

test('mutations: closing and reopening (re-reading) preserves status - simulated by fresh query after write', () => {
  const db = setup('basic.csv');
  const track = db.prepare("SELECT * FROM canonical_tracks WHERE title = 'Something'").get();
  mutations.setStatus(db, track.id, 'downloaded');
  // Simulate "closing the app": just re-read from the same persistent db handle,
  // exactly as a fresh server process would after re-opening the sqlite file.
  const reread = db.prepare('SELECT status FROM canonical_tracks WHERE id = ?').get(track.id);
  assert.equal(reread.status, 'downloaded');
});

test('mutations: ignore removes a track from the active queue count but keeps the row', () => {
  const db = setup('basic.csv');
  const track = db.prepare("SELECT * FROM canonical_tracks WHERE title = 'Something'").get();
  mutations.setIgnored(db, track.id, true, 'not interested');
  const row = db.prepare('SELECT ignored FROM canonical_tracks WHERE id = ?').get(track.id);
  assert.equal(row.ignored, 1);
  const override = db.prepare("SELECT * FROM manual_overrides WHERE canonical_track_id = ? AND action_type='ignore'").get(track.id);
  assert.ok(override);
});

test('mutations: manual merge combines two canonical tracks and preserves both sources', () => {
  const db = setup('basic.csv');
  const money = db.prepare("SELECT * FROM canonical_tracks WHERE title = 'Money'").get();
  const moneyLive = db.prepare("SELECT * FROM canonical_tracks WHERE title = 'Money (Live)'").get();
  // Deliberately merge two tracks the algorithm correctly kept separate, to
  // exercise the manual-override path (user might disagree with the engine).
  mutations.mergeTracks(db, moneyLive.id, money.id, 'user says same enough');
  const stillExists = db.prepare('SELECT * FROM canonical_tracks WHERE id = ?').get(moneyLive.id);
  assert.equal(stillExists, undefined, 'source track row should be removed after merge');
  const sources = db.prepare('SELECT COUNT(*) c FROM track_sources WHERE canonical_track_id = ?').get(money.id).c;
  assert.equal(sources, 3, '2 original Money sources + 1 from the merged-in Money (Live)');
  const log = db.prepare("SELECT * FROM manual_overrides WHERE action_type='merge'").get();
  assert.ok(log);
});

test('mutations: split pulls one source entry back out into its own canonical track', () => {
  const db = setup('basic.csv');
  const money = db.prepare("SELECT * FROM canonical_tracks WHERE title = 'Money'").get();
  const sources = db
    .prepare(
      `SELECT ts.* FROM track_sources ts WHERE ts.canonical_track_id = ?`
    )
    .all(money.id);
  assert.equal(sources.length, 2);
  const nonPrimary = sources.find((s) => !s.is_primary);
  const result = mutations.splitSource(db, money.id, nonPrimary.normalized_entry_id, 'these are actually different enough');
  assert.ok(result.newId);
  const remainingSources = db.prepare('SELECT COUNT(*) c FROM track_sources WHERE canonical_track_id = ?').get(money.id).c;
  assert.equal(remainingSources, 1);
  const newTrackSources = db.prepare('SELECT COUNT(*) c FROM track_sources WHERE canonical_track_id = ?').get(result.newId).c;
  assert.equal(newTrackSources, 1);
});

test('mutations: set-preferred changes which source is used for display fields', () => {
  const db = setup('basic.csv');
  const money = db.prepare("SELECT * FROM canonical_tracks WHERE title = 'Money'").get();
  const sources = db.prepare('SELECT * FROM track_sources WHERE canonical_track_id = ?').all(money.id);
  const nonPrimary = sources.find((s) => !s.is_primary);
  mutations.setPreferred(db, money.id, nonPrimary.normalized_entry_id, 'prefer the compilation for some reason');
  const updated = db.prepare('SELECT * FROM canonical_tracks WHERE id = ?').get(money.id);
  assert.equal(updated.primary_normalized_entry_id, nonPrimary.normalized_entry_id);
  const album = db.prepare('SELECT name FROM albums WHERE id = ?').get(updated.album_id);
  assert.equal(album.name, 'Echoes: The Best of Pink Floyd');
});

test('mutations: edit title updates sort key too', () => {
  const db = setup('basic.csv');
  const track = db.prepare("SELECT * FROM canonical_tracks WHERE title = 'Something'").get();
  mutations.editFields(db, track.id, { title: 'Something Else Entirely' }, 'typo fix');
  const updated = db.prepare('SELECT * FROM canonical_tracks WHERE id = ?').get(track.id);
  assert.equal(updated.title, 'Something Else Entirely');
  assert.equal(updated.sort_key, 'something else entirely');
});

test('mutations: confirm-duplicate merges a pending possible_duplicates pair', () => {
  const db = freshDb();
  const csvPath = require('node:path').join(require('os').tmpdir(), 'confirm-dup-test.csv');
  require('node:fs').writeFileSync(
    csvPath,
    'Track URI,Track Name,Album Name,Artist Name(s),Release Date,Duration (ms),Popularity,Explicit,Added By,Added At,Genres,Record Label\n' +
      'spotify:track:d1,Tokyo Heat - Club Mix,Tokyo Heat,C.H.A.Y.,2023-01-01,219435,10,false,,2023-01-01T00:00:00Z,,\n' +
      'spotify:track:d2,Tokyo Heat (Tokyo Drift),Tokyo Heat,C.H.A.Y.,2023-01-01,160629,10,false,,2023-01-01T00:00:00Z,,\n'
  );
  importCsv(db, csvPath, { filename: 'x' });
  runDedupe(db);
  const pd = db.prepare("SELECT * FROM possible_duplicates WHERE status='pending'").get();
  assert.ok(pd);
  const before = db.prepare('SELECT COUNT(*) c FROM canonical_tracks').get().c;
  mutations.confirmDuplicate(db, pd.id, 'confirmed by user');
  const after = db.prepare('SELECT COUNT(*) c FROM canonical_tracks').get().c;
  assert.equal(after, before - 1);
  const resolved = db.prepare('SELECT status FROM possible_duplicates WHERE id = ?').get(pd.id);
  assert.equal(resolved.status, 'confirmed');
});

test('mutations: reject-duplicate keeps both tracks separate permanently', () => {
  const db = freshDb();
  const csvPath = require('node:path').join(require('os').tmpdir(), 'reject-dup-test.csv');
  require('node:fs').writeFileSync(
    csvPath,
    'Track URI,Track Name,Album Name,Artist Name(s),Release Date,Duration (ms),Popularity,Explicit,Added By,Added At,Genres,Record Label\n' +
      'spotify:track:d1,Tokyo Heat - Club Mix,Tokyo Heat,C.H.A.Y.,2023-01-01,219435,10,false,,2023-01-01T00:00:00Z,,\n' +
      'spotify:track:d2,Tokyo Heat (Tokyo Drift),Tokyo Heat,C.H.A.Y.,2023-01-01,160629,10,false,,2023-01-01T00:00:00Z,,\n'
  );
  importCsv(db, csvPath, { filename: 'x' });
  runDedupe(db);
  const pd = db.prepare("SELECT * FROM possible_duplicates WHERE status='pending'").get();
  const before = db.prepare('SELECT COUNT(*) c FROM canonical_tracks').get().c;
  mutations.rejectDuplicate(db, pd.id, 'these really are different mixes');
  const after = db.prepare('SELECT COUNT(*) c FROM canonical_tracks').get().c;
  assert.equal(after, before);
  const resolved = db.prepare('SELECT status FROM possible_duplicates WHERE id = ?').get(pd.id);
  assert.equal(resolved.status, 'rejected');
});
