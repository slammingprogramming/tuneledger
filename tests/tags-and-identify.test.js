'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { readTags } = require('../server/lib/tags');
const { identifyFile } = require('../server/lib/identify');

// These reference real example media files, never checked into the repo
// (copyrighted audio/video - see README). They're an optional, local-only
// sanity check: if you don't have a `test files/` folder of your own music
// sitting next to this repo, these tests skip cleanly rather than failing -
// `npm test` (and CI) never depends on them.
const TEST_FILES_DIR = path.join(__dirname, '..', '..', 'test files');
const LETS_STAY_TOGETHER = path.join(TEST_FILES_DIR, "01 - Let's Stay Together.mp3");
const DESPERADO = path.join(TEST_FILES_DIR, '05 Desperado.wma');
const WHATD_I_SAY = path.join(TEST_FILES_DIR, "12 What'd I Say - Ray Charles.mp3");
const ALICE_IN_CHAINS_MP4 = path.join(TEST_FILES_DIR, 'Alice In Chains - Man in the Box (Official Video).mp4');
const skip = fs.existsSync(TEST_FILES_DIR) ? false : 'test files/ not present (optional, local-only fixture)';

const neverConfirms = { searchRecording: async () => ({ candidate: null, confident: false, error: null }) };

test('tags: reads full, correct tags from a well-tagged mp3', { skip }, async () => {
  const t = await readTags(LETS_STAY_TOGETHER);
  assert.equal(t.hasUsableTags, true);
  assert.equal(t.artist, 'Al Green');
  assert.equal(t.title, "Let's Stay Together");
  assert.equal(t.trackNumber, 1);
  assert.ok(t.durationMs > 190000 && t.durationMs < 210000);
});

test('tags: rejects an implausible year from a corrupt WMA tag (real-world data seen: "2232")', { skip }, async () => {
  const t = await readTags(DESPERADO);
  assert.equal(t.artist, 'Eagles');
  assert.equal(t.title, 'Desperado');
  assert.equal(t.year, null, 'the corrupt year tag must not be trusted');
  assert.equal(t.releaseDate, null);
});

test('tags: strips an artist name that was redundantly baked into the title tag', { skip }, async () => {
  const t = await readTags(WHATD_I_SAY);
  assert.equal(t.artist, 'Ray Charles');
  assert.equal(t.title, "What'd I Say", 'the " - Ray Charles" suffix must be stripped since it duplicates the artist tag');
});

test('tags: a video file with no embedded tags reports hasUsableTags: false but still gets duration', { skip }, async () => {
  const t = await readTags(ALICE_IN_CHAINS_MP4);
  assert.equal(t.hasUsableTags, false);
  assert.ok(t.durationMs > 0);
});

test('identify: well-tagged file identifies via tags when MusicBrainz does not confirm', { skip }, async () => {
  const r = await identifyFile(LETS_STAY_TOGETHER, { mediaKind: 'audio', mbClient: neverConfirms, useMusicBrainz: true });
  assert.equal(r.ok, true);
  assert.equal(r.identifyMethod, 'tags_only');
  assert.equal(r.artist, 'Al Green');
});

test('identify: untagged video falls back to filename parsing as a last resort', { skip }, async () => {
  const r = await identifyFile(ALICE_IN_CHAINS_MP4, { mediaKind: 'video', mbClient: neverConfirms, useMusicBrainz: true });
  assert.equal(r.ok, true);
  assert.equal(r.identifyMethod, 'filename_only');
  assert.equal(r.artist, 'Alice In Chains');
  assert.equal(r.title, 'Man in the Box');
});

test('identify: with MusicBrainz disabled entirely, tags alone are still sufficient', { skip }, async () => {
  const r = await identifyFile(WHATD_I_SAY, { mediaKind: 'audio', mbClient: null, useMusicBrainz: false });
  assert.equal(r.ok, true);
  assert.equal(r.identifyMethod, 'tags_only');
  assert.equal(r.artist, 'Ray Charles');
});

test('identify: MusicBrainz confirming a tagged file upgrades to tags_mb with an MBID', { skip }, async () => {
  const confirms = {
    searchRecording: async () => ({
      confident: true,
      candidate: {
        musicbrainzRecordingId: 'fake-mbid-123',
        artist: 'Al Green',
        title: "Let's Stay Together",
        album: "Let's Stay Together",
        releaseDate: '1972',
        trackNumber: 1,
        discNumber: 1,
        durationMs: 199393,
        confidence: 0.95,
      },
    }),
  };
  const r = await identifyFile(LETS_STAY_TOGETHER, { mediaKind: 'audio', mbClient: confirms, useMusicBrainz: true });
  assert.equal(r.identifyMethod, 'tags_mb');
  assert.equal(r.musicbrainzRecordingId, 'fake-mbid-123');
});

test('identify: a file with no tags and an unparseable filename is unresolved (needs review)', { skip }, async () => {
  // Simulate via a fake path (readTags will fail to parse -> hasUsableTags:false;
  // filename "1999" is purely numeric -> not plausible).
  const r = await identifyFile(path.join(TEST_FILES_DIR, '1999.mp3'), {
    mediaKind: 'audio',
    mbClient: neverConfirms,
    useMusicBrainz: true,
  });
  assert.equal(r.ok, false);
});

test('identify: an artist tag with a missing title tag is filled in from the filename ("Everything.wma" real-world case)', { skip }, async () => {
  // Alanis Morissette/Everything - Single/Everything.wma: has an artist tag
  // but no title tag - a real gap seen in WMP-era WMA encodes.
  const file = path.join(TEST_FILES_DIR, 'Alanis Morissette', 'Everything - Single', 'Everything.wma');
  const r = await identifyFile(file, { mediaKind: 'audio', mbClient: neverConfirms, useMusicBrainz: true, rootDir: TEST_FILES_DIR });
  assert.equal(r.ok, true);
  assert.equal(r.artist, 'Alanis Morissette', 'from the real tag');
  assert.equal(r.title, 'Everything', 'filled in from the filename since the title tag is missing');
  assert.equal(r.identifyMethod, 'assisted_only');
});

test('identify: folder structure (Artist/Album/File) fills in a missing artist tag', { skip }, async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'identify-folder-test-'));
  try {
    await fsp.mkdir(path.join(tmpDir, 'Some Artist', 'Some Album'), { recursive: true });
    // An untagged file (no artist/title from tags) whose filename also has
    // no parseable artist - the folder structure is the only signal left.
    const dest = path.join(tmpDir, 'Some Artist', 'Some Album', 'video file.mp4');
    await fsp.copyFile(ALICE_IN_CHAINS_MP4, dest);
    const r = await identifyFile(dest, {
      mediaKind: 'video',
      mbClient: neverConfirms,
      useMusicBrainz: true,
      rootDir: tmpDir,
    });
    assert.equal(r.ok, true);
    assert.equal(r.artist, 'Some Artist', 'no tags and no parseable filename artist - must come from the folder');
    assert.equal(r.identifyMethod, 'filename_only');
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test('identify: title-only MusicBrainz fallback accepts a high-confidence, duration-corroborated match', { skip }, async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'identify-title-only-test-'));
  try {
    const dest = path.join(tmpDir, 'somesong.mp4');
    await fsp.copyFile(ALICE_IN_CHAINS_MP4, dest);
    const highConfidence = {
      searchRecording: async ({ artist }) => {
        if (artist) return { candidate: null, confident: false, error: null }; // no artist to search with in this scenario
        return {
          confident: false, // below the client's own auto-confirm bar, but...
          candidate: { musicbrainzRecordingId: 'mb-title-only', artist: 'Some Real Artist', title: 'somesong', album: null, confidence: 0.95 },
        };
      },
    };
    const r = await identifyFile(dest, { mediaKind: 'video', mbClient: highConfidence, useMusicBrainz: true });
    assert.equal(r.ok, true);
    assert.equal(r.identifyMethod, 'title_only_mb');
    assert.equal(r.artist, 'Some Real Artist');
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test('identify: title-only MusicBrainz fallback rejects a low-confidence match rather than guessing an artist', { skip }, async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'identify-title-only-reject-test-'));
  try {
    const dest = path.join(tmpDir, 'somesong.mp4');
    await fsp.copyFile(ALICE_IN_CHAINS_MP4, dest);
    const lowConfidence = {
      searchRecording: async () => ({
        confident: false,
        candidate: { musicbrainzRecordingId: 'mb-weak', artist: 'Maybe This Artist', title: 'somesong', album: null, confidence: 0.6 },
      }),
    };
    const r = await identifyFile(dest, { mediaKind: 'video', mbClient: lowConfidence, useMusicBrainz: true });
    assert.equal(r.ok, false, 'a 0.6-confidence artist-less match must not be trusted enough to attribute an artist');
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});
