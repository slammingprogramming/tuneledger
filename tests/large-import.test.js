'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { openDb } = require('../server/db');
const { importCsv } = require('../server/lib/importer');
const { runDedupe } = require('../server/lib/dedupe');
const queries = require('../server/lib/queries');

function freshDb() {
  return openDb(':memory:');
}

function buildLargeCsv(rows, artists) {
  const header = 'Track URI,Track Name,Album Name,Artist Name(s),Release Date,Duration (ms),Popularity,Explicit,Added By,Added At,Genres,Record Label\n';
  const lines = [header];
  const perArtist = Math.floor(rows / artists);
  let uid = 0;
  for (let a = 0; a < artists; a++) {
    const artistName = `Synthetic Artist ${a}`;
    for (let t = 0; t < perArtist; t++) {
      uid += 1;
      const trackName = `Track ${t} of Artist ${a}`;
      const album = `Album ${Math.floor(t / 10)} by Artist ${a}`;
      lines.push(
        `spotify:track:gen${uid},${trackName},${album},${artistName},2020-01-01,200000,50,false,,2021-01-01T00:00:00Z,pop,Label\n`
      );
    }
  }
  const filePath = path.join(os.tmpdir(), `large-import-${rows}-${artists}.csv`);
  fs.writeFileSync(filePath, lines.join(''));
  return filePath;
}

test('large-import: 5000 rows across 500 artists imports and dedupes correctly within a reasonable time', () => {
  const csvPath = buildLargeCsv(5000, 500);
  const db = freshDb();
  const t0 = Date.now();
  const importResult = importCsv(db, csvPath, { filename: 'large.csv' });
  const stats = runDedupe(db);
  const elapsed = Date.now() - t0;

  assert.equal(importResult.rowCount, 5000);
  assert.equal(importResult.okCount, 5000);
  assert.equal(stats.newCanonical, 5000, 'every synthetic track is unique, so all should become canonical tracks');
  const overall = queries.overallStats(db);
  assert.equal(overall.uniqueTracks, 5000);
  assert.equal(overall.artists, 500);

  // Generous bound - this is meant to catch an accidental O(n^2) full-table
  // scan regression, not to be a tight perf benchmark.
  assert.ok(elapsed < 20000, `import+dedupe of 5000 rows took ${elapsed}ms, expected < 20000ms`);
});

test('large-import: re-importing the same large CSV stays idempotent', () => {
  const csvPath = buildLargeCsv(1000, 100);
  const db = freshDb();
  importCsv(db, csvPath, { filename: 'large2.csv' });
  runDedupe(db);
  importCsv(db, csvPath, { filename: 'large2.csv (again)' });
  const stats = runDedupe(db);
  assert.equal(stats.newCanonical, 0);
  const overall = queries.overallStats(db);
  assert.equal(overall.uniqueTracks, 1000);
});

test('large-import: single artist with many albums/tracks does not blow up matching cost', () => {
  const header = 'Track URI,Track Name,Album Name,Artist Name(s),Release Date,Duration (ms),Popularity,Explicit,Added By,Added At,Genres,Record Label\n';
  const lines = [header];
  for (let i = 0; i < 400; i++) {
    lines.push(`spotify:track:solo${i},Solo Track ${i},Solo Album ${Math.floor(i / 10)},Prolific Artist,2020-01-01,200000,50,false,,2021-01-01T00:00:00Z,pop,Label\n`);
  }
  const csvPath = path.join(os.tmpdir(), 'single-artist-400.csv');
  fs.writeFileSync(csvPath, lines.join(''));
  const db = freshDb();
  const t0 = Date.now();
  importCsv(db, csvPath, { filename: 'single-artist-400.csv' });
  runDedupe(db);
  const elapsed = Date.now() - t0;
  const overall = queries.overallStats(db);
  assert.equal(overall.uniqueTracks, 400);
  assert.ok(elapsed < 10000, `400-track single-artist import took ${elapsed}ms`);
});
