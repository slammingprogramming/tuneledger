'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { guessFromPath } = require('../server/lib/folder-guess');

test('folder-guess: Artist/Album/Track.ext (real WMP library layout) yields artist + album', () => {
  const root = 'E:/Music';
  const file = path.join(root, 'Alanis Morissette', 'Everything - Single', 'Everything.wma');
  const r = guessFromPath(file, root);
  assert.equal(r.artist, 'Alanis Morissette');
  assert.equal(r.album, 'Everything - Single');
});

test('folder-guess: a single-level folder is not treated as an artist (too ambiguous)', () => {
  const root = 'E:/Music';
  const file = path.join(root, 'Karaoke', 'some track.mp4');
  const r = guessFromPath(file, root);
  assert.equal(r.artist, null);
});

test('folder-guess: a flat file directly under the scan root has no folder signal at all', () => {
  const root = 'E:/Music';
  const file = path.join(root, 'some track.mp3');
  const r = guessFromPath(file, root);
  assert.equal(r.artist, null);
  assert.equal(r.album, null);
});

test('folder-guess: "Unknown Artist"/"Unknown Album" (literal WMP rip placeholders) are rejected', () => {
  const root = 'E:/Music';
  const file = path.join(root, 'Unknown artist', 'Unknown album', 'Track 2.mp3');
  const r = guessFromPath(file, root);
  assert.equal(r.artist, null);
  assert.equal(r.album, null);
});
