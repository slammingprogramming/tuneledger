'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractVersionInfo } = require('../server/lib/normalize');

test('extractVersionInfo: "Official Video"/"Official Audio"/"HD" are source noise, not a distinct version', () => {
  assert.equal(extractVersionInfo('Man in the Box (Official Video)').versionType, 'original');
  assert.equal(extractVersionInfo('Money (Official Audio)').versionType, 'original');
  assert.equal(extractVersionInfo('Song Title [HD]').versionType, 'original');
  assert.equal(extractVersionInfo('Song Title (Lyric Video)').versionType, 'original');
});

test('extractVersionInfo: source noise does not mask a real version annotation alongside it', () => {
  const r = extractVersionInfo('Man in the Box (Live) (Official Video)');
  assert.equal(r.versionType, 'live');
  assert.equal(r.stem, 'Man in the Box');
});

test('extractVersionInfo: a non-noise, non-keyword annotation still becomes "other" (not silently dropped)', () => {
  const r = extractVersionInfo('Song Title (Japanese Version)');
  assert.equal(r.versionType, 'other');
});

test('extractVersionInfo: karaoke/instrumental-backing tracks are a distinct version, not merged with the original', () => {
  const r1 = extractVersionInfo("Can't Help Falling In Love (Karaoke Version)");
  assert.equal(r1.versionType, 'karaoke');
  assert.equal(r1.stem, "Can't Help Falling In Love");

  const r2 = extractVersionInfo('Hey You (CC) [Karaoke Instrumental Lyrics]');
  assert.equal(r2.versionType, 'karaoke', 'karaoke must win over the generic "instrumental" keyword also present');
});
