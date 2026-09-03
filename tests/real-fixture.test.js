'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('../server/db');
const { importCsv } = require('../server/lib/importer');
const { runDedupe } = require('../server/lib/dedupe');
const queries = require('../server/lib/queries');

const REAL_CSV = path.join(__dirname, '..', '..', 'spotify liked songs rj.csv');
// This fixture is a real person's personal Spotify export, never checked
// into the repo (see fixtures/ for the synthetic CSVs everyone else's tests
// run against). These tests are a bonus sanity check when that file happens
// to be present locally, not a hard requirement for `npm test` to pass.
const HAS_REAL_CSV = fs.existsSync(REAL_CSV);
const skip = HAS_REAL_CSV ? false : 'real Spotify export not present at repo root (optional, local-only fixture)';

function freshDb() {
  return openDb(':memory:');
}

test('real fixture: full pipeline against the actual provided Spotify export', { skip }, () => {
  const db = freshDb();
  const importResult = importCsv(db, REAL_CSV, { filename: 'spotify liked songs rj.csv' });
  assert.equal(importResult.rowCount, 1603);
  assert.equal(importResult.okCount, 1600);
  assert.equal(importResult.skippedNoTitle, 3);

  const dedupeStats = runDedupe(db);
  assert.equal(dedupeStats.processed, 1600);
  // Known from manual inspection of the fixture: 43 rows share an exact
  // (artist, normalized title, close duration) match with an earlier row.
  assert.equal(dedupeStats.mergedMeta, 43);
  assert.equal(dedupeStats.newCanonical, 1600 - 43);

  const stats = queries.overallStats(db);
  assert.equal(stats.uniqueTracks, 1557);
  assert.equal(stats.downloaded, 0);
  assert.equal(stats.remaining, 1557);

  // Spot-check a known duplicate: "Kickstart My Heart" appears twice in the
  // export (same album, two different Spotify releases) and must collapse
  // to a single queue item while remembering both source occurrences.
  const kickstart = db
    .prepare(
      `SELECT ct.*, (SELECT COUNT(*) FROM track_sources ts WHERE ts.canonical_track_id = ct.id) AS sourceCount
       FROM canonical_tracks ct WHERE ct.title = 'Kickstart My Heart'`
    )
    .all();
  assert.equal(kickstart.length, 1);
  assert.equal(kickstart[0].sourceCount, 2);

  // Spot-check that distinctly-versioned tracks were NOT collapsed:
  // "MONEY ON THE DASH", "MONEY ON THE DASH - SPED UP", and
  // "MONEY ON THE DASH - Diplo Remix" must all remain separate.
  const moneyVariants = db
    .prepare("SELECT title, version_type FROM canonical_tracks WHERE title LIKE 'MONEY ON THE DASH%'")
    .all();
  assert.equal(moneyVariants.length, 3);
});

test('real fixture: no false-positive fuzzy merges slip through on the real data', { skip }, () => {
  const db = freshDb();
  importCsv(db, REAL_CSV, { filename: 'x' });
  const stats = runDedupe(db);
  // On this fixture, everything that merges does so via exact metadata
  // match; nothing should need the fuzzy stage, and 2 ambiguous pairs
  // should be flagged for human review rather than guessed at.
  assert.equal(stats.mergedFuzzy, 0);
  assert.equal(stats.flaggedForReview, 2);
});
