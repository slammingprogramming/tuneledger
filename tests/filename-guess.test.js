'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { guessFromFilename } = require('../server/lib/filename-guess');

test('filename-guess: "Artist - Title (annotation)" convention (no track number)', () => {
  const r = guessFromFilename('Alice In Chains - Man in the Box (Official Video).mp4');
  assert.equal(r.artist, 'Alice In Chains');
  assert.equal(r.title, 'Man in the Box');
  assert.equal(r.trackNumber, null);
  assert.equal(r.hasArtist, true);
});

test('filename-guess: "NN Title - Artist" convention (track-numbered rip)', () => {
  const r = guessFromFilename("12 What'd I Say - Ray Charles.mp3");
  assert.equal(r.trackNumber, 12);
  assert.equal(r.title, "What'd I Say");
  assert.equal(r.artist, 'Ray Charles');
});

test('filename-guess: "NN - Title" and "NN Title" with no artist at all', () => {
  const a = guessFromFilename("01 - Let's Stay Together.mp3");
  assert.equal(a.trackNumber, 1);
  assert.equal(a.title, "Let's Stay Together");
  assert.equal(a.artist, null);

  const b = guessFromFilename('05 Desperado.wma');
  assert.equal(b.trackNumber, 5);
  assert.equal(b.title, 'Desperado');
  assert.equal(b.artist, null);
});

test('filename-guess: hyphenated words without spaces are not mistaken for a separator', () => {
  const r = guessFromFilename('Rock-A-Fella Records Anthem.mp3');
  assert.equal(r.artist, null);
  assert.ok(r.title);
});

test('filename-guess: purely numeric filenames are not plausible', () => {
  const r = guessFromFilename('1999.mp3');
  assert.equal(r.isPlausible, false);
});

test('filename-guess: a 4-digit leading number is not mistaken for a track number', () => {
  // Should NOT be parsed as track "199" + "9.mp3"; the whole thing is implausible/numeric.
  const r = guessFromFilename('1999 Bonus Track.mp3');
  assert.notEqual(r.trackNumber, 199);
});

test('filename-guess: generic placeholder names are rejected even if non-numeric', () => {
  const r = guessFromFilename('Track.mp3');
  assert.equal(r.isPlausible, false);
});

test('filename-guess: "Track N" unlabeled-rip placeholders are rejected (real artifact of CDDB-less rips)', () => {
  assert.equal(guessFromFilename('02 Track 2.mp3').isPlausible, false);
  assert.equal(guessFromFilename('Track02.mp3').isPlausible, false);
  assert.equal(guessFromFilename('Track_03.mp3').isPlausible, false);
});
