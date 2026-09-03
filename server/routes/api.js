'use strict';

const express = require('express');
const multer = require('multer');
const { importCsv } = require('../lib/importer');
const { runDedupe } = require('../lib/dedupe');
const queries = require('../lib/queries');
const mutations = require('../lib/mutations');
const exporter = require('../lib/exporter');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

function wrap(fn) {
  return (req, res, next) => {
    try {
      fn(req, res, next);
    } catch (err) {
      next(err);
    }
  };
}

module.exports = function buildApiRouter(db) {
  const router = express.Router();

  // ---- Imports -----------------------------------------------------------

  router.post(
    '/imports',
    upload.single('file'),
    wrap((req, res) => {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded (expected multipart field "file")' });
      }
      const importResult = importCsv(db, req.file.buffer, {
        filename: req.file.originalname,
        label: req.body.label,
      });
      const dedupeStats = runDedupe(db);
      res.json({ import: importResult, dedupe: dedupeStats });
    })
  );

  router.get(
    '/imports',
    wrap((req, res) => {
      const rows = db.prepare('SELECT * FROM imports ORDER BY id DESC').all();
      res.json(
        rows.map((r) => ({
          ...r,
          column_map: r.column_map ? JSON.parse(r.column_map) : null,
        }))
      );
    })
  );

  router.get(
    '/imports/:id',
    wrap((req, res) => {
      const imp = db.prepare('SELECT * FROM imports WHERE id = ?').get(req.params.id);
      if (!imp) return res.status(404).json({ error: 'Import not found' });
      imp.column_map = imp.column_map ? JSON.parse(imp.column_map) : null;
      res.json(imp);
    })
  );

  router.get(
    '/imports/:id/rows',
    wrap((req, res) => {
      const status = req.query.status; // ok | warning | error
      const limit = Math.min(parseInt(req.query.limit, 10) || 200, 2000);
      const offset = parseInt(req.query.offset, 10) || 0;
      const where = ['import_id = ?'];
      const params = [req.params.id];
      if (status) {
        where.push('parse_status = ?');
        params.push(status);
      }
      const rows = db
        .prepare(
          `SELECT * FROM raw_rows WHERE ${where.join(' AND ')} ORDER BY row_number LIMIT ? OFFSET ?`
        )
        .all(...params, limit, offset);
      const total = db.prepare(`SELECT COUNT(*) c FROM raw_rows WHERE ${where.join(' AND ')}`).get(...params).c;
      res.json({ total, rows: rows.map((r) => ({ ...r, raw_json: JSON.parse(r.raw_json) })) });
    })
  );

  // ---- Stats ---------------------------------------------------------------

  router.get(
    '/stats',
    wrap((req, res) => {
      res.json(queries.overallStats(db));
    })
  );

  // ---- Artists / Albums / Tracks (tree navigation) -------------------------

  router.get(
    '/artists',
    wrap((req, res) => {
      const { q, status } = req.query;
      const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
      const offset = parseInt(req.query.offset, 10) || 0;
      res.json(queries.listArtists(db, { q, status, limit, offset }));
    })
  );

  router.get(
    '/artists/:id/albums',
    wrap((req, res) => {
      res.json(queries.artistAlbums(db, req.params.id));
    })
  );

  router.get(
    '/albums/:id/tracks',
    wrap((req, res) => {
      res.json(queries.albumTracks(db, req.params.id));
    })
  );

  // ---- Search / flat filtering ---------------------------------------------

  router.get(
    '/tracks',
    wrap((req, res) => {
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
      const offset = parseInt(req.query.offset, 10) || 0;
      res.json(
        queries.searchTracks(db, {
          q: req.query.q,
          artist: req.query.artist,
          album: req.query.album,
          status: req.query.status,
          versionType: req.query.versionType,
          disc: req.query.disc,
          importId: req.query.importId,
          duplicatesOnly: req.query.duplicatesOnly === 'true',
          missingMetadata: req.query.missingMetadata === 'true',
          ignored: req.query.ignored, // 'exclude' (default) | 'only' | 'include'
          limit,
          offset,
        })
      );
    })
  );

  router.get(
    '/tracks/:id',
    wrap((req, res) => {
      const track = queries.trackDetail(db, req.params.id);
      if (!track) return res.status(404).json({ error: 'Track not found' });
      res.json(track);
    })
  );

  router.post(
    '/tracks/:id/status',
    wrap((req, res) => {
      res.json(mutations.setStatus(db, req.params.id, req.body.status, req.body.note));
    })
  );

  router.post(
    '/tracks/:id/ignore',
    wrap((req, res) => {
      res.json(mutations.setIgnored(db, req.params.id, true, req.body && req.body.note));
    })
  );

  router.post(
    '/tracks/:id/unignore',
    wrap((req, res) => {
      res.json(mutations.setIgnored(db, req.params.id, false, req.body && req.body.note));
    })
  );

  router.patch(
    '/tracks/:id',
    wrap((req, res) => {
      const { artistName, albumName, note, ...fields } = req.body || {};
      if (artistName || albumName) {
        mutations.editArtistAlbum(db, req.params.id, { artistName, albumName }, note);
      }
      const result = mutations.editFields(db, req.params.id, fields, note);
      res.json(result);
    })
  );

  router.post(
    '/tracks/merge',
    wrap((req, res) => {
      res.json(mutations.mergeTracks(db, req.body.sourceId, req.body.targetId, req.body.note));
    })
  );

  router.post(
    '/tracks/:id/split',
    wrap((req, res) => {
      res.json(mutations.splitSource(db, req.params.id, req.body.normalizedEntryId, req.body.note));
    })
  );

  router.post(
    '/tracks/:id/set-preferred',
    wrap((req, res) => {
      res.json(mutations.setPreferred(db, req.params.id, req.body.normalizedEntryId, req.body.note));
    })
  );

  // ---- Possible duplicates (fuzzy-match review queue) -----------------------

  router.get(
    '/possible-duplicates',
    wrap((req, res) => {
      const statusFilter = req.query.status || 'pending';
      const rows = db
        .prepare(
          `SELECT pd.*, ct1.title AS title_a, a1.name AS artist_a, ct2.title AS title_b, a2.name AS artist_b
           FROM possible_duplicates pd
           LEFT JOIN canonical_tracks ct1 ON ct1.id = pd.canonical_track_id_a
           LEFT JOIN artists a1 ON a1.id = ct1.artist_id
           LEFT JOIN canonical_tracks ct2 ON ct2.id = pd.canonical_track_id_b
           LEFT JOIN artists a2 ON a2.id = ct2.artist_id
           WHERE pd.status = ?
           ORDER BY pd.created_at DESC`
        )
        .all(statusFilter);
      res.json(rows);
    })
  );

  router.post(
    '/possible-duplicates/:id/confirm',
    wrap((req, res) => {
      res.json(mutations.confirmDuplicate(db, req.params.id, req.body && req.body.note));
    })
  );

  router.post(
    '/possible-duplicates/:id/reject',
    wrap((req, res) => {
      res.json(mutations.rejectDuplicate(db, req.params.id, req.body && req.body.note));
    })
  );

  // ---- Export ---------------------------------------------------------------

  router.get(
    '/export.csv',
    wrap((req, res) => {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="download_queue.csv"');
      res.send(exporter.toCsv(db));
    })
  );

  router.get(
    '/export.txt',
    wrap((req, res) => {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="download_queue.txt"');
      res.send(exporter.toPlainText(db));
    })
  );

  router.get(
    '/export-remaining.txt',
    wrap((req, res) => {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="remaining_downloads.txt"');
      res.send(exporter.toRemainingPlainText(db));
    })
  );

  return router;
};
