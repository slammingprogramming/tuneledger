'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { runLibraryScan, moveFileTo } = require('../lib/library-scanner');
const { importWpl } = require('../lib/wpl');
const { createMusicBrainzClient } = require('../lib/musicbrainz');

const MB_CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'musicbrainz.json');

function loadMbConfig() {
  return JSON.parse(fs.readFileSync(MB_CONFIG_PATH, 'utf8'));
}

function wrap(fn) {
  return (req, res, next) => {
    try {
      fn(req, res, next);
    } catch (err) {
      next(err);
    }
  };
}

module.exports = function buildLibraryRouter(db) {
  const router = express.Router();

  // In-memory cancellation flags, keyed by scan_jobs.id. Fine for a
  // single-process local app; a cancel request just needs to be seen by the
  // loop currently running in this same process.
  const cancelFlags = new Map();

  function mbClientFor(useMusicBrainz) {
    if (!useMusicBrainz) return null;
    const cfg = loadMbConfig();
    return createMusicBrainzClient({ userAgent: cfg.userAgent, minConfidence: cfg.minConfidence });
  }

  function updateJobProgress(jobId, fields) {
    const sets = Object.keys(fields)
      .map((k) => `${k} = @${k}`)
      .join(', ');
    db.prepare(`UPDATE scan_jobs SET ${sets} WHERE id = @id`).run({ ...fields, id: jobId });
  }

  // ---- Directory scan ------------------------------------------------------

  router.post(
    '/library-scan',
    wrap((req, res) => {
      const { rootPath, reviewFolder, dryRun = true, useMusicBrainz = true, markDownloaded = true } = req.body || {};
      if (!rootPath) return res.status(400).json({ error: 'rootPath is required' });
      if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
        return res.status(400).json({ error: `Not a directory: ${rootPath}` });
      }

      const jobInfo = db
        .prepare(
          `INSERT INTO scan_jobs (source_type, root_path, review_folder, status, dry_run, use_musicbrainz, mark_downloaded)
           VALUES ('local_scan', ?, ?, 'running', ?, ?, ?)`
        )
        .run(rootPath, reviewFolder || null, dryRun ? 1 : 0, useMusicBrainz ? 1 : 0, markDownloaded ? 1 : 0);
      const jobId = jobInfo.lastInsertRowid;
      cancelFlags.set(jobId, false);

      const mbClient = mbClientFor(useMusicBrainz);

      runLibraryScan(db, {
        rootDir: rootPath,
        reviewFolder,
        dryRun,
        useMusicBrainz,
        markDownloaded,
        mbClient,
        scanJobId: jobId,
        isCancelled: () => cancelFlags.get(jobId) === true,
        onProgress: ({ totalFiles, processedFiles, currentFile }) => {
          updateJobProgress(jobId, {
            total_files: totalFiles,
            processed_files: processedFiles,
            current_file: currentFile || null,
          });
        },
      })
        .then((result) => {
          updateJobProgress(jobId, {
            status: result.cancelled ? 'cancelled' : 'completed',
            total_files: result.totalFiles,
            processed_files: result.processedFiles,
            identified_count: result.identifiedCount,
            review_count: result.reviewCount,
            skipped_count: result.skippedCount,
            current_file: null,
            import_id: result.importId,
            finished_at: new Date().toISOString(),
          });
        })
        .catch((err) => {
          updateJobProgress(jobId, {
            status: 'failed',
            error: err.message,
            finished_at: new Date().toISOString(),
          });
        })
        .finally(() => cancelFlags.delete(jobId));

      res.json({ scanJobId: jobId });
    })
  );

  // ---- WPL import ------------------------------------------------------------

  router.post(
    '/wpl-import',
    wrap((req, res) => {
      const { wplPath, reviewFolder, dryRun = true, useMusicBrainz = true, markDownloaded = true } = req.body || {};
      if (!wplPath) return res.status(400).json({ error: 'wplPath is required' });
      if (!fs.existsSync(wplPath)) return res.status(400).json({ error: `File not found: ${wplPath}` });

      const jobInfo = db
        .prepare(
          `INSERT INTO scan_jobs (source_type, root_path, review_folder, status, dry_run, use_musicbrainz, mark_downloaded)
           VALUES ('wpl', ?, ?, 'running', ?, ?, ?)`
        )
        .run(wplPath, reviewFolder || null, dryRun ? 1 : 0, useMusicBrainz ? 1 : 0, markDownloaded ? 1 : 0);
      const jobId = jobInfo.lastInsertRowid;
      cancelFlags.set(jobId, false);

      const mbClient = mbClientFor(useMusicBrainz);

      importWpl(db, {
        wplPath,
        reviewFolder,
        dryRun,
        useMusicBrainz,
        markDownloaded,
        mbClient,
        scanJobId: jobId,
        onProgress: ({ totalFiles, processedFiles, currentFile }) => {
          updateJobProgress(jobId, {
            total_files: totalFiles,
            processed_files: processedFiles,
            current_file: currentFile || null,
          });
        },
      })
        .then((result) => {
          if (result.isSmart) {
            updateJobProgress(jobId, {
              status: 'completed',
              error: `Smart/dynamic playlist - no static file list to import (rule: ${result.smartPlaylistDescription})`,
              finished_at: new Date().toISOString(),
            });
            return;
          }
          updateJobProgress(jobId, {
            status: 'completed',
            total_files: result.totalRefs,
            processed_files: result.totalRefs,
            identified_count: result.identifiedCount,
            review_count: result.reviewCount,
            skipped_count: result.skippedCount + result.missingCount,
            import_id: result.importId,
            finished_at: new Date().toISOString(),
          });
        })
        .catch((err) => {
          updateJobProgress(jobId, {
            status: 'failed',
            error: err.message,
            finished_at: new Date().toISOString(),
          });
        })
        .finally(() => cancelFlags.delete(jobId));

      res.json({ scanJobId: jobId });
    })
  );

  // ---- Job status / control ---------------------------------------------------

  router.get(
    '/library-scan/:id',
    wrap((req, res) => {
      const job = db.prepare('SELECT * FROM scan_jobs WHERE id = ?').get(req.params.id);
      if (!job) return res.status(404).json({ error: 'Scan job not found' });
      const moves = db
        .prepare('SELECT * FROM file_moves WHERE scan_job_id = ? ORDER BY id LIMIT 500')
        .all(req.params.id);
      res.json({ ...job, fileMoves: moves });
    })
  );

  router.get(
    '/library-scan',
    wrap((req, res) => {
      res.json(db.prepare('SELECT * FROM scan_jobs ORDER BY id DESC LIMIT 50').all());
    })
  );

  router.post(
    '/library-scan/:id/cancel',
    wrap((req, res) => {
      const id = Number(req.params.id);
      if (!cancelFlags.has(id)) {
        return res.status(400).json({ error: 'Job is not currently running' });
      }
      cancelFlags.set(id, true);
      res.json({ id, cancelling: true });
    })
  );

  router.post(
    '/library-scan/:id/apply-moves',
    wrap(async (req, res) => {
      const id = req.params.id;
      const pending = db.prepare('SELECT * FROM file_moves WHERE scan_job_id = ? AND applied = 0').all(id);
      let applied = 0;
      const errors = [];
      for (const m of pending) {
        try {
          const actualDest = await moveFileTo(m.original_path, m.new_path);
          db.prepare('UPDATE file_moves SET applied = 1, moved_at = ?, new_path = ? WHERE id = ?').run(
            new Date().toISOString(),
            actualDest,
            m.id
          );
          applied += 1;
        } catch (err) {
          errors.push({ id: m.id, path: m.original_path, error: err.message });
        }
      }
      res.json({ applied, failed: errors.length, errors });
    })
  );

  return router;
};
