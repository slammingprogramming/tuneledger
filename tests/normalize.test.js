'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractVersionInfo,
  classifyReleaseCategory,
  sortKey,
  splitArtists,
  normalizeForKey,
} = require('../server/lib/normalize');

test('extractVersionInfo: plain title has no version tag', () => {
  const r = extractVersionInfo('Money');
  assert.equal(r.stem, 'Money');
  assert.equal(r.versionType, 'original');
});

test('extractVersionInfo: recognizes remaster in brackets and parens', () => {
  assert.equal(extractVersionInfo('Money (2011 Remaster)').versionType, 'remaster');
  assert.equal(extractVersionInfo('Money [2011 Remaster]').versionType, 'remaster');
  assert.equal(extractVersionInfo('Money - Remastered 2011').versionType, 'remaster');
});

test('extractVersionInfo: recognizes live, acoustic, remix, radio edit, demo, instrumental', () => {
  assert.equal(extractVersionInfo('Money (Live)').versionType, 'live');
  assert.equal(extractVersionInfo('Everlong - Acoustic Version').versionType, 'acoustic');
  assert.equal(extractVersionInfo('Falling (blackbear Remix)').versionType, 'remix');
  assert.equal(extractVersionInfo('Feel So Close - Radio Edit').versionType, 'radio_edit');
  assert.equal(extractVersionInfo('Idea 15 (Demo)').versionType, 'demo');
  assert.equal(extractVersionInfo('Layla (Instrumental)').versionType, 'instrumental');
});

test('extractVersionInfo: stem strips annotation but keeps title intact', () => {
  const r = extractVersionInfo('Fierce Battle (From "Final Fantasy VI") [2018 Remaster]');
  assert.equal(r.stem, 'Fierce Battle');
  assert.equal(r.versionType, 'remaster');
});

test('extractVersionInfo: does not mangle hyphenated words without surrounding spaces', () => {
  const r = extractVersionInfo('Rock-A-Fella');
  assert.equal(r.stem, 'Rock-A-Fella');
  assert.equal(r.versionType, 'original');
});

test('extractVersionInfo: splits on first " - " marker, not the last', () => {
  const r = extractVersionInfo('Sunflower - Spider-Man: Into the Spider-Verse');
  assert.equal(r.stem, 'Sunflower');
});

test('normalizeForKey: case, whitespace, unicode, punctuation all collapse to same key', () => {
  const variants = ['Money', 'money', '  MONEY  ', 'Money!', 'Money.'];
  const keys = variants.map(normalizeForKey);
  for (const k of keys) assert.equal(k, keys[0]);
});

test('normalizeForKey: diacritics normalize consistently', () => {
  assert.equal(normalizeForKey('Café'), normalizeForKey('Cafe'));
  assert.equal(normalizeForKey('Mötley Crüe'), normalizeForKey('Motley Crue'));
});

test('sortKey: strips leading articles for alphabetical sorting', () => {
  assert.equal(sortKey('The Beatles'), sortKey('Beatles'));
  // "A Tribe Called Quest" sorts by "tribe called quest" (article stripped),
  // which is after "beatles" alphabetically (t > b) - not before.
  assert.equal(sortKey('The Beatles') < sortKey('A Tribe Called Quest'), true);
});

test('splitArtists: splits on semicolon, trims whitespace', () => {
  assert.deepEqual(splitArtists('Post Malone;Swae Lee'), ['Post Malone', 'Swae Lee']);
  assert.deepEqual(splitArtists('Solo Artist'), ['Solo Artist']);
  assert.deepEqual(splitArtists(''), []);
});

test('classifyReleaseCategory: recognizes compilations, deluxe, soundtrack, singles', () => {
  assert.equal(classifyReleaseCategory('Greatest Hits'), 'compilation');
  assert.equal(classifyReleaseCategory('...And Justice for All (Remastered Deluxe Box Set)'), 'deluxe');
  assert.equal(classifyReleaseCategory('Guardians of the Galaxy: Awesome Mix (Original Motion Picture Soundtrack)'), 'soundtrack');
  assert.equal(classifyReleaseCategory('Boombastic'), 'album');
  assert.equal(classifyReleaseCategory('Sunflower', 'Sunflower'), 'single');
});
