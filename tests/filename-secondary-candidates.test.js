'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { guessSecondaryCandidates, stripTrailingNoise } = require('../server/lib/filename-guess');
const { guessFromFilename } = require('../server/lib/filename-guess');

test('secondary candidates: no-space dash produces both orderings ("Apollo 440-Stop The Rock")', () => {
  const cands = guessSecondaryCandidates('Apollo 440-Stop The Rock.mp3');
  assert.ok(cands.some((c) => c.artist === 'Apollo 440' && c.title === 'Stop The Rock'));
  assert.ok(cands.some((c) => c.artist === 'Stop The Rock' && c.title === 'Apollo 440'));
});

test('secondary candidates: asymmetric dash spacing ("Billy Ocean- Loverboy")', () => {
  const cands = guessSecondaryCandidates("Billy Ocean- Loverboy (Released '85).mp3");
  assert.ok(cands.some((c) => c.artist === 'Billy Ocean' && c.title === 'Loverboy'));
});

test('secondary candidates: "Title by Artist" convention', () => {
  const cands = guessSecondaryCandidates('Breakdown by Seether (lyrics).mp3');
  assert.ok(cands.some((c) => c.artist === 'Seether' && c.title === 'Breakdown'));
});

test('secondary candidates: underscore-wrapped title', () => {
  const cands = guessSecondaryCandidates("Pop Evil _Boss's Daughter_ Single.mp3");
  assert.ok(cands.some((c) => c.artist === 'Pop Evil' && c.title === "Boss's Daughter"));
});

test('secondary candidates: lone underscore as a separator, both orderings', () => {
  const cands = guessSecondaryCandidates('Tarzan_YabbaDabbaDo.wma');
  assert.ok(cands.some((c) => c.artist === 'Tarzan' && c.title === 'YabbaDabbaDo'));
  assert.ok(cands.some((c) => c.artist === 'YabbaDabbaDo' && c.title === 'Tarzan'));
});

test('secondary candidates: karaoke "in the style of X" attribution, with trailing noise stripped', () => {
  const cands = guessSecondaryCandidates(
    'Friends In Low Places (Studio Version) in the Style of Garth Brooks karaoke lyri.mp4'
  );
  assert.ok(cands.some((c) => c.artist === 'Garth Brooks' && c.title === 'Friends In Low Places'));
});

test('secondary candidates: never duplicate the primary guess or each other', () => {
  const cands = guessSecondaryCandidates('Apollo 440-Stop The Rock.mp3');
  const keys = cands.map((c) => `${c.artist}|${c.title}`.toLowerCase());
  assert.equal(new Set(keys).size, keys.length);
});

test('secondary candidates: a clean "Artist - Title" file yields no secondary candidates (primary already confident)', () => {
  // Already handled by the primary guess - secondary patterns shouldn't
  // also fire redundantly/spuriously on well-formed filenames.
  const cands = guessSecondaryCandidates('Alice In Chains - Man in the Box.mp4');
  assert.equal(cands.length, 0);
});

test('primary guess: bullet and en/em-dash separators are recognized (real karaoke file used "•")', () => {
  const r1 = guessFromFilename('Pink Floyd • Hey You [Karaoke Instrumental Lyrics].mp4');
  assert.equal(r1.artist, 'Pink Floyd');
  assert.equal(r1.title, 'Hey You');
  assert.equal(r1.versionType, 'karaoke');

  const r2 = guessFromFilename('Artist Name – Song Title.mp3');
  assert.equal(r2.artist, 'Artist Name');
  assert.equal(r2.title, 'Song Title');
});

test('stripTrailingNoise: removes bare trailing "lyrics"/"karaoke" not caught by bracket/dash annotation stripping', () => {
  assert.equal(stripTrailingNoise('shinedown sounds of madness lyrics'), 'shinedown sounds of madness');
  assert.equal(stripTrailingNoise('some song karaoke'), 'some song');
  assert.equal(stripTrailingNoise('Clean Title'), 'Clean Title');
});
