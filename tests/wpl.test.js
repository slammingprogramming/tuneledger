'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { parseWpl, importWpl } = require('../server/lib/wpl');
const { openDb } = require('../server/db');

// Real example media/playlists, never checked into the repo (see README) -
// optional local-only sanity checks that skip cleanly when absent.
const TEST_FILES_DIR = path.join(__dirname, '..', '..', 'test files');
const REAL_WPL = path.join(TEST_FILES_DIR, 'Fresh tracks -- yet to be rated.wpl');
const STATIC_WPL_FIXTURE = path.join(__dirname, '..', 'fixtures', 'static_playlist.wpl');
const skip = fs.existsSync(TEST_FILES_DIR) ? false : 'test files/ not present (optional, local-only fixture)';

function freshDb() {
  return openDb(':memory:');
}

test('wpl: a real-world smart/dynamic playlist has no static media list', { skip }, () => {
  const xml = fs.readFileSync(REAL_WPL, 'utf8');
  const parsed = parseWpl(xml);
  assert.equal(parsed.isSmart, true);
  assert.equal(parsed.mediaRefs.length, 0);
  assert.match(parsed.smartPlaylistDescription, /Unrated/);
});

test('wpl: a smart playlist with multiple <querySet> groups (an OR of rule groups) describes both, not a generic fallback', () => {
  // Real-world shape seen in "Favorites -- 4 and 5 star rated.wpl": two
  // <querySet> siblings, which fast-xml-parser represents as an array
  // instead of a single object once there's more than one.
  const xml = `<?wpl version="1.0"?><smil><head><title>Favorites</title></head><body><seq>
    <smartPlaylist version="1.0.0.0"><querySet>
      <sourceFilter id="{x}" name="Music from my Media Library">
        <fragment name="Effective Rating"><argument name="condition">Is At Least</argument><argument name="value">4 stars</argument></fragment>
      </sourceFilter>
    </querySet><querySet>
      <sourceFilter id="{x}" name="Music from my Media Library">
        <fragment name="User Rating"><argument name="condition">Is At Least</argument><argument name="value">4 stars</argument></fragment>
      </sourceFilter>
    </querySet></smartPlaylist>
  </seq></body></smil>`;
  const parsed = parseWpl(xml);
  assert.equal(parsed.isSmart, true);
  assert.notEqual(parsed.smartPlaylistDescription, 'dynamic query-based playlist');
  assert.match(parsed.smartPlaylistDescription, /Effective Rating/);
  assert.match(parsed.smartPlaylistDescription, /User Rating/);
  assert.match(parsed.smartPlaylistDescription, / OR /);
});

test('wpl: a static playlist lists its <media src> references in order', () => {
  const xml = fs.readFileSync(STATIC_WPL_FIXTURE, 'utf8');
  const parsed = parseWpl(xml);
  assert.equal(parsed.isSmart, false);
  assert.deepEqual(parsed.mediaRefs, ['song-one.mp3', 'subdir\\song-two.mp3', 'does-not-exist.mp3', 'notes.txt']);
});

test('wpl: importWpl on a smart playlist returns immediately with isSmart:true and touches nothing', { skip }, async () => {
  const db = freshDb();
  const result = await importWpl(db, { wplPath: REAL_WPL, useMusicBrainz: false });
  assert.equal(result.isSmart, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM imports').get().c, 0);
});

test('wpl: importWpl on a static playlist resolves relative paths (including backslash-separated), reports missing files, skips non-media, and identifies present files', { skip }, async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wpl-test-'));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));

  const realFilesDir = TEST_FILES_DIR;
  await fsp.mkdir(path.join(tmpDir, 'subdir'), { recursive: true });
  await fsp.copyFile(path.join(realFilesDir, "01 - Let's Stay Together.mp3"), path.join(tmpDir, 'song-one.mp3'));
  await fsp.copyFile(path.join(realFilesDir, '05 Desperado.wma'), path.join(tmpDir, 'subdir', 'song-two.wma'));
  await fsp.writeFile(path.join(tmpDir, 'notes.txt'), 'not media');

  const wplContent = `<?wpl version="1.0"?>
<smil><head><title>Test</title></head><body><seq>
<media src="song-one.mp3"/>
<media src="subdir\\song-two.wma"/>
<media src="does-not-exist.mp3"/>
<media src="notes.txt"/>
</seq></body></smil>`;
  const wplPath = path.join(tmpDir, 'playlist.wpl');
  await fsp.writeFile(wplPath, wplContent);

  const db = freshDb();
  const jobId = db
    .prepare("INSERT INTO scan_jobs (source_type, root_path, status) VALUES ('wpl', ?, 'running')")
    .run(wplPath).lastInsertRowid;
  const neverConfirms = { searchRecording: async () => ({ candidate: null, confident: false, error: null }) };

  const result = await importWpl(db, { wplPath, dryRun: true, mbClient: neverConfirms, useMusicBrainz: true, scanJobId: jobId });

  assert.equal(result.totalRefs, 4);
  assert.equal(result.identifiedCount, 2);
  assert.equal(result.missingCount, 1);
  assert.equal(result.skippedCount, 1);

  const tracks = db.prepare('SELECT title, status FROM canonical_tracks ORDER BY title').all();
  assert.deepEqual(
    tracks.map((t) => t.title),
    ['Desperado', "Let's Stay Together"]
  );
  assert.ok(tracks.every((t) => t.status === 'downloaded'));

  // Nothing should have been moved off disk in dry-run mode.
  assert.ok(fs.existsSync(path.join(tmpDir, 'song-one.mp3')));
});

test('wpl: markDownloaded:false links referenced files without completing queue items', { skip }, async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wpl-mark-test-'));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));

  const realFilesDir = TEST_FILES_DIR;
  await fsp.copyFile(path.join(realFilesDir, "01 - Let's Stay Together.mp3"), path.join(tmpDir, 'song-one.mp3'));

  const wplPath = path.join(tmpDir, 'playlist.wpl');
  await fsp.writeFile(
    wplPath,
    `<?wpl version="1.0"?><smil><head><title>Test</title></head><body><seq><media src="song-one.mp3"/></seq></body></smil>`
  );

  const db = freshDb();
  const jobId = db
    .prepare("INSERT INTO scan_jobs (source_type, root_path, status) VALUES ('wpl', ?, 'running')")
    .run(wplPath).lastInsertRowid;
  const neverConfirms = { searchRecording: async () => ({ candidate: null, confident: false, error: null }) };

  await importWpl(db, { wplPath, dryRun: true, mbClient: neverConfirms, useMusicBrainz: true, markDownloaded: false, scanJobId: jobId });

  const track = db.prepare("SELECT status FROM canonical_tracks WHERE title = ?").get("Let's Stay Together");
  assert.equal(track.status, 'not_started');
});
