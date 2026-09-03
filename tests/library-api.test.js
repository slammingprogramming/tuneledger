'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { openDb } = require('../server/db');
const buildApiRouter = require('../server/routes/api');
const buildLibraryRouter = require('../server/routes/library');

// Real example media, never checked into the repo (see README) - optional
// local-only sanity checks that skip cleanly when absent.
const REAL_FILES_DIR = path.join(__dirname, '..', '..', 'test files');
const skip = fs.existsSync(REAL_FILES_DIR) ? false : 'test files/ not present (optional, local-only fixture)';

function startTestServer() {
  const db = openDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api', buildApiRouter(db));
  app.use('/api', buildLibraryRouter(db));
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ server, db, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function pollUntilDone(baseUrl, jobId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${baseUrl}/api/library-scan/${jobId}`);
    const job = await res.json();
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for scan job to finish');
}

test('library API: directory scan runs as an async job reachable via polling (MusicBrainz disabled for determinism)', { skip }, async (t) => {
  const { server, baseUrl } = await startTestServer();
  t.after(() => server.close());

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lib-api-test-'));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  await fsp.copyFile(path.join(REAL_FILES_DIR, "01 - Let's Stay Together.mp3"), path.join(tmpDir, "01 - Let's Stay Together.mp3"));

  const startRes = await fetch(`${baseUrl}/api/library-scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rootPath: tmpDir, dryRun: true, useMusicBrainz: false }),
  });
  assert.equal(startRes.status, 200);
  const { scanJobId } = await startRes.json();
  assert.ok(scanJobId);

  const job = await pollUntilDone(baseUrl, scanJobId);
  assert.equal(job.status, 'completed');
  assert.equal(job.identified_count, 1);

  const statsRes = await fetch(`${baseUrl}/api/stats`);
  const stats = await statsRes.json();
  assert.equal(stats.downloaded, 1);
});

test('library API: rejects a rootPath that does not exist', async (t) => {
  const { server, baseUrl } = await startTestServer();
  t.after(() => server.close());
  const res = await fetch(`${baseUrl}/api/library-scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rootPath: path.join(os.tmpdir(), 'definitely-does-not-exist-xyz') }),
  });
  assert.equal(res.status, 400);
});

test('library API: apply-moves executes previously-staged moves', async (t) => {
  const { server, baseUrl } = await startTestServer();
  t.after(() => server.close());

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lib-api-move-test-'));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  await fsp.writeFile(path.join(tmpDir, 'unidentifiable.mp3'), 'not real audio');

  const startRes = await fetch(`${baseUrl}/api/library-scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rootPath: tmpDir, dryRun: true, useMusicBrainz: false }),
  });
  const { scanJobId } = await startRes.json();
  const job = await pollUntilDone(baseUrl, scanJobId);
  assert.equal(job.review_count, 1);
  assert.ok(fs.existsSync(path.join(tmpDir, 'unidentifiable.mp3')), 'dry run: file must still be in place');

  const applyRes = await fetch(`${baseUrl}/api/library-scan/${scanJobId}/apply-moves`, { method: 'POST' });
  const applyJson = await applyRes.json();
  assert.equal(applyJson.applied, 1);
  assert.ok(!fs.existsSync(path.join(tmpDir, 'unidentifiable.mp3')));
  assert.ok(fs.existsSync(path.join(tmpDir, '_needs_review', 'unidentifiable.mp3')));
});

test('library API: WPL import of a smart playlist reports it clearly instead of erroring', { skip }, async (t) => {
  const { server, baseUrl } = await startTestServer();
  t.after(() => server.close());

  const wplPath = path.join(REAL_FILES_DIR, 'Fresh tracks -- yet to be rated.wpl');
  const startRes = await fetch(`${baseUrl}/api/wpl-import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wplPath, useMusicBrainz: false }),
  });
  const { scanJobId } = await startRes.json();
  const job = await pollUntilDone(baseUrl, scanJobId);
  assert.equal(job.status, 'completed');
  assert.match(job.error, /[Ss]mart|dynamic/);
});

test('library API: cancel stops a running scan job', async (t) => {
  const { server, baseUrl } = await startTestServer();
  t.after(() => server.close());

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lib-api-cancel-test-'));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  // Enough files that cancellation has a real chance of landing mid-scan.
  for (let i = 0; i < 20; i++) {
    await fsp.writeFile(path.join(tmpDir, `file${i}.mp3`), `not real audio ${i}`);
  }

  const startRes = await fetch(`${baseUrl}/api/library-scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rootPath: tmpDir, dryRun: true, useMusicBrainz: false }),
  });
  const { scanJobId } = await startRes.json();
  const cancelRes = await fetch(`${baseUrl}/api/library-scan/${scanJobId}/cancel`, { method: 'POST' });
  assert.equal(cancelRes.status, 200);
  const job = await pollUntilDone(baseUrl, scanJobId);
  assert.ok(['cancelled', 'completed'].includes(job.status), 'should finish as cancelled, or complete if it beat the cancel request');
});
