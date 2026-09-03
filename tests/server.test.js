'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const path = require('node:path');
const { openDb } = require('../server/db');
const buildApiRouter = require('../server/routes/api');

function startTestServer() {
  const db = openDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api', buildApiRouter(db));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ server, db, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('server: end-to-end HTTP smoke test (import -> stats -> status -> export)', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const csvPath = path.join(__dirname, '..', 'fixtures', 'basic.csv');
    const fs = require('node:fs');
    const buf = fs.readFileSync(csvPath);
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'text/csv' }), 'basic.csv');

    const importRes = await fetch(`${baseUrl}/api/imports`, { method: 'POST', body: form });
    assert.equal(importRes.status, 200);
    const importJson = await importRes.json();
    assert.equal(importJson.import.rowCount, 14);

    const statsRes = await fetch(`${baseUrl}/api/stats`);
    const stats = await statsRes.json();
    assert.ok(stats.uniqueTracks > 0);

    const artistsRes = await fetch(`${baseUrl}/api/artists?q=Beatles`);
    const artists = await artistsRes.json();
    assert.equal(artists.artists.length, 1);
    assert.equal(artists.artists[0].name, 'The Beatles');

    const albumsRes = await fetch(`${baseUrl}/api/artists/${artists.artists[0].id}/albums`);
    const albums = await albumsRes.json();
    const abbeyRoad = albums.find((a) => a.name === 'Abbey Road');
    assert.ok(abbeyRoad);

    const tracksRes = await fetch(`${baseUrl}/api/albums/${abbeyRoad.id}/tracks`);
    const tracks = await tracksRes.json();
    assert.ok(tracks.length >= 2);

    const statusRes = await fetch(`${baseUrl}/api/tracks/${tracks[0].id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'downloaded' }),
    });
    assert.equal(statusRes.status, 200);

    const exportRes = await fetch(`${baseUrl}/api/export.csv`);
    const csvText = await exportRes.text();
    assert.match(csvText, /Artist,Album,Disc,Track Number,Track,Status,Version,Duplicate Count/);
    assert.match(csvText, /The Beatles/);
  } finally {
    server.close();
  }
});
