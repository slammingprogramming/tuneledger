'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { openDb } = require('../server/db');
const { importCsv } = require('../server/lib/importer');
const { runDedupe } = require('../server/lib/dedupe');
const queries = require('../server/lib/queries');
const { sortKey } = require('../server/lib/normalize');

function freshDb() {
  return openDb(':memory:');
}
function fixture(name) {
  return path.join(__dirname, '..', 'fixtures', name);
}

function setup(file) {
  const db = freshDb();
  importCsv(db, fixture(file), { filename: file });
  runDedupe(db);
  return db;
}

test('sorting: tracks within an album are ordered by disc then track number, not alphabetically', () => {
  const db = setup('basic.csv');
  const wall = db.prepare("SELECT id FROM albums WHERE name = 'The Wall'").get();
  const tracks = queries.albumTracks(db, wall.id);
  // Alphabetically "Hey You" < "In The Flesh?" < "Is There..." < "The Thin Ice",
  // but disc/track order must be: disc1/1, disc1/2, disc2/1, disc2/2.
  assert.deepEqual(
    tracks.map((t) => `${t.disc_number}.${t.track_number} ${t.title}`),
    ['1.1 In The Flesh?', '1.2 The Thin Ice', '2.1 Hey You', '2.2 Is There Anybody Out There?']
  );
});

test('sorting: albums for an artist are alphabetical (by sort key, e.g. ignoring a leading "The")', () => {
  const db = setup('basic.csv');
  const artist = db.prepare("SELECT id FROM artists WHERE name = 'Pink Floyd'").get();
  const albums = queries.artistAlbums(db, artist.id);
  const names = albums.map((a) => a.name);
  const sorted = [...names].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  assert.deepEqual(names, sorted);
  assert.deepEqual(names, ['The Dark Side of the Moon', 'Delicate Sound of Thunder', 'The Wall']);
});

test('sorting: artists are listed alphabetically (leading articles ignored)', () => {
  const db = setup('basic.csv');
  const result = queries.listArtists(db, { limit: 100 });
  const names = result.artists.map((a) => a.name);
  // "The Beatles" sorts by "beatles" (article stripped), which is before
  // "pink floyd" - not literal string order.
  assert.deepEqual(names, ['The Beatles', 'Pink Floyd']);
});

test('sorting: tracks without a track number fall back to alphabetical, not left unordered', () => {
  const db = freshDb();
  const csvPath = require('node:path').join(require('os').tmpdir(), 'sorting-no-tracknum.csv');
  require('node:fs').writeFileSync(
    csvPath,
    'Track URI,Track Name,Album Name,Artist Name(s),Release Date,Duration (ms),Popularity,Explicit,Added By,Added At,Genres,Record Label\n' +
      'spotify:track:s1,Zebra Song,No Track Numbers,Test Artist,2020-01-01,200000,10,false,,2021-01-01T00:00:00Z,,\n' +
      'spotify:track:s2,Apple Song,No Track Numbers,Test Artist,2020-01-01,200000,10,false,,2021-01-01T00:00:00Z,,\n'
  );
  importCsv(db, csvPath, { filename: 'x' });
  runDedupe(db);
  const album = db.prepare("SELECT id FROM albums WHERE name = 'No Track Numbers'").get();
  const tracks = queries.albumTracks(db, album.id);
  assert.deepEqual(tracks.map((t) => t.title), ['Apple Song', 'Zebra Song']);
});
