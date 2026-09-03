'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { openDb } = require('../server/db');
const { importCsv } = require('../server/lib/importer');
const { runDedupe } = require('../server/lib/dedupe');
const mutations = require('../server/lib/mutations');
const queries = require('../server/lib/queries');

function freshDb() {
  return openDb(':memory:');
}
function fixture(name) {
  return path.join(__dirname, '..', 'fixtures', name);
}

test('multi-import: importing a second CSV adds only genuinely new tracks and detects overlap', () => {
  const db = freshDb();
  importCsv(db, fixture('basic.csv'), { filename: 'basic.csv' });
  runDedupe(db);
  const beforeStats = queries.overallStats(db);

  importCsv(db, fixture('second_import.csv'), { filename: 'second_import.csv' });
  const stats2 = runDedupe(db);
  const afterStats = queries.overallStats(db);

  // second_import.csv has 2 overlapping tracks (aaa1, aaa5) + 2 new (Radiohead).
  assert.equal(stats2.newCanonical, 2, 'only the 2 genuinely new Radiohead tracks should create new canonical tracks');
  assert.equal(afterStats.uniqueTracks, beforeStats.uniqueTracks + 2);

  const radiohead = db.prepare("SELECT * FROM artists WHERE name = 'Radiohead'").get();
  assert.ok(radiohead, 'new artist should be created');
});

test('multi-import: downloaded status from the first import survives a second import of overlapping tracks', () => {
  const db = freshDb();
  importCsv(db, fixture('basic.csv'), { filename: 'basic.csv' });
  runDedupe(db);

  const comeTogether = db.prepare("SELECT * FROM canonical_tracks WHERE title = 'Come Together'").get();
  mutations.setStatus(db, comeTogether.id, 'downloaded');

  // Re-import a CSV that includes the same track (aaa1) again.
  importCsv(db, fixture('second_import.csv'), { filename: 'second_import.csv' });
  runDedupe(db);

  const stillDownloaded = db.prepare('SELECT status FROM canonical_tracks WHERE id = ?').get(comeTogether.id);
  assert.equal(stillDownloaded.status, 'downloaded', 'existing download status must never be lost on re-import');
});

test('multi-import: importing the same CSV a third time still adds nothing new', () => {
  const db = freshDb();
  importCsv(db, fixture('basic.csv'), { filename: 'basic.csv' });
  runDedupe(db);
  importCsv(db, fixture('basic.csv'), { filename: 'basic.csv again' });
  runDedupe(db);
  const before = queries.overallStats(db).uniqueTracks;
  importCsv(db, fixture('basic.csv'), { filename: 'basic.csv yet again' });
  const stats = runDedupe(db);
  const after = queries.overallStats(db).uniqueTracks;
  assert.equal(stats.newCanonical, 0);
  assert.equal(before, after);
});
