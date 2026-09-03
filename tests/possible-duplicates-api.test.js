'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { openDb } = require('../server/db');
const buildApiRouter = require('../server/routes/api');

function startTestServer() {
  const db = openDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api', buildApiRouter(db));
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ server, db, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

// Regression test for a bug found during manual QA: confirming a possible
// duplicate merges canonical_track_id_b away (its FK goes NULL rather than
// cascading), but the /api/possible-duplicates listing originally used
// INNER JOINs on both sides, which silently hid resolved rows with a NULL
// side from status=confirmed/rejected queries even though they were
// correctly persisted in the database.
test('possible-duplicates API: a confirmed record remains visible via the API after its merged-away side goes NULL', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const csvPath = path.join(os.tmpdir(), 'pd-api-test.csv');
    fs.writeFileSync(
      csvPath,
      'Track URI,Track Name,Album Name,Artist Name(s),Release Date,Duration (ms),Popularity,Explicit,Added By,Added At,Genres,Record Label\n' +
        'spotify:track:d1,Tokyo Heat - Club Mix,Tokyo Heat,C.H.A.Y.,2023-01-01,219435,10,false,,2023-01-01T00:00:00Z,,\n' +
        'spotify:track:d2,Tokyo Heat (Tokyo Drift),Tokyo Heat,C.H.A.Y.,2023-01-01,160629,10,false,,2023-01-01T00:00:00Z,,\n'
    );
    const buf = fs.readFileSync(csvPath);
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'text/csv' }), 'pd-api-test.csv');
    await fetch(`${baseUrl}/api/imports`, { method: 'POST', body: form });

    const pendingRes = await fetch(`${baseUrl}/api/possible-duplicates?status=pending`);
    const pending = await pendingRes.json();
    assert.equal(pending.length, 1);

    const confirmRes = await fetch(`${baseUrl}/api/possible-duplicates/${pending[0].id}/confirm`, { method: 'POST' });
    assert.equal(confirmRes.status, 200);

    const confirmedRes = await fetch(`${baseUrl}/api/possible-duplicates?status=confirmed`);
    const confirmed = await confirmedRes.json();
    assert.equal(confirmed.length, 1, 'the resolved record must still be visible via the API, not silently dropped by an inner join');
    assert.equal(confirmed[0].status, 'confirmed');
  } finally {
    server.close();
  }
});
