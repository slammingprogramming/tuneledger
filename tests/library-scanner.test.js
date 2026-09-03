'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { openDb } = require('../server/db');
const { importCsv } = require('../server/lib/importer');
const { runLibraryScan, insertIdentifiedFile } = require('../server/lib/library-scanner');
const { runDedupe } = require('../server/lib/dedupe');

// Real example media, never checked into the repo (see README) - optional
// local-only sanity checks that skip cleanly when absent.
const REAL_FILES_DIR = path.join(__dirname, '..', '..', 'test files');
const skip = fs.existsSync(REAL_FILES_DIR) ? false : 'test files/ not present (optional, local-only fixture)';
const neverConfirms = { searchRecording: async () => ({ candidate: null, confident: false, error: null }) };

function freshDb() {
  return openDb(':memory:');
}

async function makeScratchLibrary(t) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lib-scan-test-'));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  await fsp.mkdir(path.join(tmpDir, 'recurse test'), { recursive: true });
  await fsp.mkdir(path.join(tmpDir, 'deep', 'nested'), { recursive: true });
  await fsp.copyFile(path.join(REAL_FILES_DIR, "01 - Let's Stay Together.mp3"), path.join(tmpDir, "01 - Let's Stay Together.mp3"));
  await fsp.copyFile(path.join(REAL_FILES_DIR, '05 Desperado.wma'), path.join(tmpDir, '05 Desperado.wma'));
  await fsp.copyFile(path.join(REAL_FILES_DIR, '05 Desperado.wma'), path.join(tmpDir, 'deep', 'nested', 'Desperado (dupe copy).wma'));
  await fsp.copyFile(
    path.join(REAL_FILES_DIR, 'Alice In Chains - Man in the Box (Official Video).mp4'),
    path.join(tmpDir, 'recurse test', 'Alice In Chains - Man in the Box (Official Video).mp4')
  );
  await fsp.writeFile(path.join(tmpDir, 'garbage.mp3'), 'not really audio, just bytes');
  return tmpDir;
}

async function newScanJob(db, rootDir) {
  return db.prepare("INSERT INTO scan_jobs (source_type, root_path, status) VALUES ('local_scan', ?, 'running')").run(rootDir)
    .lastInsertRowid;
}

test('library-scanner: markDownloaded:false links files as sources without completing the queue item', { skip }, async (t) => {
  const tmpDir = await makeScratchLibrary(t);
  const db = freshDb();

  // Seed the queue the way a Spotify CSV import would, same as the cross-reference test.
  const csvPath = path.join(os.tmpdir(), `mark-downloaded-seed-${Date.now()}.csv`);
  fs.writeFileSync(
    csvPath,
    'Track URI,Track Name,Album Name,Artist Name(s),Release Date,Duration (ms),Popularity,Explicit,Added By,Added At,Genres,Record Label\n' +
      'spotify:track:seed2,Desperado,Their Greatest Hits (1971-1975),Eagles,1973-01-01,214180,50,false,,2020-01-01T00:00:00Z,rock,Asylum\n'
  );
  importCsv(db, csvPath, { filename: 'seed.csv' });
  runDedupe(db);

  const scanJobId = await newScanJob(db, tmpDir);
  await runLibraryScan(db, {
    rootDir: tmpDir,
    dryRun: true,
    mbClient: neverConfirms,
    useMusicBrainz: true,
    markDownloaded: false,
    scanJobId,
  });

  const desperado = db
    .prepare(
      `SELECT ct.id, ct.status, (SELECT COUNT(*) FROM track_sources ts WHERE ts.canonical_track_id = ct.id) AS sources
       FROM canonical_tracks ct WHERE ct.title = 'Desperado'`
    )
    .get();
  assert.equal(desperado.status, 'not_started', 'status must stay untouched when markDownloaded is false');
  // makeScratchLibrary plants 2 copies of the Desperado file (top-level + a
  // deeply nested duplicate), plus the seeded CSV row = 3 sources total.
  assert.equal(desperado.sources, 3, 'local files should still be linked as sources even though status is untouched');

  // Every other locally-found track (no prior queue entry) should also stay not_started.
  const others = db.prepare("SELECT status FROM canonical_tracks WHERE title != 'Desperado'").all();
  assert.ok(others.every((t) => t.status === 'not_started'));
});

test('library-scanner: recurses subdirectories and finds nested files', { skip }, async (t) => {
  const tmpDir = await makeScratchLibrary(t);
  const db = freshDb();
  const scanJobId = await newScanJob(db, tmpDir);
  const result = await runLibraryScan(db, { rootDir: tmpDir, dryRun: true, mbClient: neverConfirms, useMusicBrainz: true, scanJobId });
  assert.equal(result.totalFiles, 5, 'should find all 5 audio/video files including the deeply nested one');
});

test('library-scanner: identified files are inserted, cross-artist deduped, and auto-marked downloaded', { skip }, async (t) => {
  const tmpDir = await makeScratchLibrary(t);
  const db = freshDb();
  const scanJobId = await newScanJob(db, tmpDir);
  const result = await runLibraryScan(db, { rootDir: tmpDir, dryRun: true, mbClient: neverConfirms, useMusicBrainz: true, scanJobId });

  assert.equal(result.identifiedCount, 4, "3 unique songs + 1 duplicate Desperado copy that should merge, not double-count as a 5th canonical track");
  const tracks = db.prepare('SELECT title, status FROM canonical_tracks').all();
  assert.equal(tracks.length, 3, 'the nested duplicate Desperado file must merge into the existing canonical track, not create a 4th');
  assert.ok(tracks.every((t) => t.status === 'downloaded'), 'every locally-found track should be auto-marked downloaded');

  const desperado = db
    .prepare(
      `SELECT ct.id, COUNT(ts.id) AS sources FROM canonical_tracks ct
       JOIN track_sources ts ON ts.canonical_track_id = ct.id
       WHERE ct.title = 'Desperado' GROUP BY ct.id`
    )
    .get();
  assert.equal(desperado.sources, 2, 'both the top-level and deeply-nested copies should be recorded as sources of the same track');
});

test('library-scanner: an unidentifiable file is staged for review in dry-run, not moved', { skip }, async (t) => {
  const tmpDir = await makeScratchLibrary(t);
  const db = freshDb();
  const scanJobId = await newScanJob(db, tmpDir);
  const result = await runLibraryScan(db, { rootDir: tmpDir, dryRun: true, mbClient: neverConfirms, useMusicBrainz: true, scanJobId });

  assert.equal(result.reviewCount, 1);
  assert.ok(fs.existsSync(path.join(tmpDir, 'garbage.mp3')), 'dry run must not touch the filesystem');
  const move = db.prepare('SELECT * FROM file_moves WHERE scan_job_id = ?').get(scanJobId);
  assert.equal(move.applied, 0);
});

test('library-scanner: with dryRun:false, the unidentifiable file is actually moved into the review folder', { skip }, async (t) => {
  const tmpDir = await makeScratchLibrary(t);
  const db = freshDb();
  const scanJobId = await newScanJob(db, tmpDir);
  const result = await runLibraryScan(db, { rootDir: tmpDir, dryRun: false, mbClient: neverConfirms, useMusicBrainz: true, scanJobId });

  assert.equal(result.reviewCount, 1);
  assert.ok(!fs.existsSync(path.join(tmpDir, 'garbage.mp3')), 'file should have moved out of its original location');
  assert.ok(fs.existsSync(path.join(tmpDir, '_needs_review', 'garbage.mp3')), 'file should now be under the review folder');
});

test('library-scanner: re-scanning after a move excludes the review folder (no reprocessing loop)', { skip }, async (t) => {
  const tmpDir = await makeScratchLibrary(t);
  const db = freshDb();
  const job1 = await newScanJob(db, tmpDir);
  await runLibraryScan(db, { rootDir: tmpDir, dryRun: false, mbClient: neverConfirms, useMusicBrainz: true, scanJobId: job1 });

  const job2 = await newScanJob(db, tmpDir);
  const result2 = await runLibraryScan(db, { rootDir: tmpDir, dryRun: true, mbClient: neverConfirms, useMusicBrainz: true, scanJobId: job2 });
  assert.equal(result2.totalFiles, 4, 'the file already sitting in _needs_review must not be counted/reprocessed');
});

test('library-scanner: re-importing a directory scan is idempotent (running twice adds nothing new)', { skip }, async (t) => {
  const tmpDir = await makeScratchLibrary(t);
  const db = freshDb();
  const job1 = await newScanJob(db, tmpDir);
  await runLibraryScan(db, { rootDir: tmpDir, dryRun: true, mbClient: neverConfirms, useMusicBrainz: true, scanJobId: job1 });
  const before = db.prepare('SELECT COUNT(*) c FROM canonical_tracks').get().c;

  const job2 = await newScanJob(db, tmpDir);
  await runLibraryScan(db, { rootDir: tmpDir, dryRun: true, mbClient: neverConfirms, useMusicBrainz: true, scanJobId: job2 });
  const after = db.prepare('SELECT COUNT(*) c FROM canonical_tracks').get().c;

  assert.equal(before, after, 're-scanning the same directory must not duplicate queue entries');
});

test('library-scanner: a local file matching an existing Spotify-imported track marks it downloaded (cross-reference)', { skip }, async (t) => {
  const tmpDir = await makeScratchLibrary(t);
  const db = freshDb();

  // Seed the queue the way a Spotify CSV import would: same song, not yet downloaded.
  const csvPath = path.join(os.tmpdir(), `cross-ref-seed-${Date.now()}.csv`);
  fs.writeFileSync(
    csvPath,
    'Track URI,Track Name,Album Name,Artist Name(s),Release Date,Duration (ms),Popularity,Explicit,Added By,Added At,Genres,Record Label\n' +
      'spotify:track:seed1,Desperado,Their Greatest Hits (1971-1975),Eagles,1973-01-01,214180,50,false,,2020-01-01T00:00:00Z,rock,Asylum\n'
  );
  importCsv(db, csvPath, { filename: 'seed.csv' });
  runDedupe(db);
  const before = db.prepare("SELECT status FROM canonical_tracks WHERE title = 'Desperado'").get();
  assert.equal(before.status, 'not_started');

  const scanJobId = await newScanJob(db, tmpDir);
  await runLibraryScan(db, { rootDir: tmpDir, dryRun: true, mbClient: neverConfirms, useMusicBrainz: true, scanJobId });

  const after = db.prepare("SELECT status FROM canonical_tracks WHERE title = 'Desperado'").get();
  assert.equal(after.status, 'downloaded', 'finding the file locally should flip the existing queue item to downloaded');
  const count = db.prepare("SELECT COUNT(*) c FROM canonical_tracks WHERE title = 'Desperado'").get().c;
  assert.equal(count, 1, 'must not create a second Desperado track - it should merge into the one from the CSV import');
});

test('dedupe: two entries sharing the same musicbrainz_recording_id merge via the mbid stage', () => {
  const db = freshDb();
  const importId = db
    .prepare("INSERT INTO imports (filename, source_type, row_count, ok_count, error_count) VALUES ('x', 'local_scan', 0, 0, 0)")
    .run().lastInsertRowid;

  const base = {
    artist: 'Test Artist',
    album: 'Test Album',
    trackNumber: null,
    discNumber: null,
    durationMs: 200000,
    releaseDate: '2020',
    genres: null,
    recordLabel: null,
    versionType: 'original',
    versionDetail: null,
    identifyMethod: 'tags_mb',
    identifyConfidence: 0.9,
    mediaKind: 'audio',
  };
  insertIdentifiedFile(db, importId, {
    ...base,
    title: 'Some Song (Alternate Title Spelling)',
    filePath: '/music/a.mp3',
    musicbrainzRecordingId: 'shared-mbid-xyz',
  });
  insertIdentifiedFile(db, importId, {
    ...base,
    title: 'Some Song',
    filePath: '/music/b.mp3',
    musicbrainzRecordingId: 'shared-mbid-xyz',
  });

  const stats = runDedupe(db, { importId });
  assert.equal(stats.newCanonical, 1);
  assert.equal(stats.mergedExact, 1, 'the second entry should merge via the mbid stage despite the differing title text');

  const track = db
    .prepare(
      `SELECT ct.id, (SELECT COUNT(*) FROM track_sources ts WHERE ts.canonical_track_id = ct.id) AS sources
       FROM canonical_tracks ct`
    )
    .get();
  assert.equal(track.sources, 2);

  const stageUsed = db.prepare("SELECT match_stage FROM track_sources WHERE canonical_track_id = ? ORDER BY id DESC LIMIT 1").get(track.id);
  assert.equal(stageUsed.match_stage, 'mbid');
});
