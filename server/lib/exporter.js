'use strict';

const { TRACK_ORDER_SQL } = require('./queries');

function allTracksOrdered(db, { includeIgnored = false } = {}) {
  return db
    .prepare(
      `SELECT ct.*, a.name AS artist_name, al.name AS album_name,
              (SELECT COUNT(*) FROM track_sources ts WHERE ts.canonical_track_id = ct.id) AS sourceCount
       FROM canonical_tracks ct
       JOIN artists a ON a.id = ct.artist_id
       JOIN albums al ON al.id = ct.album_id
       ${includeIgnored ? '' : 'WHERE ct.ignored = 0'}
       ORDER BY a.sort_key, al.sort_key, ${TRACK_ORDER_SQL}`
    )
    .all();
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(db, opts) {
  const rows = allTracksOrdered(db, opts);
  const header = ['Artist', 'Album', 'Disc', 'Track Number', 'Track', 'Status', 'Version', 'Duplicate Count'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.artist_name,
        r.album_name,
        r.disc_number ?? '',
        r.track_number ?? '',
        r.title,
        r.status,
        r.version_type,
        r.sourceCount,
      ]
        .map(csvEscape)
        .join(',')
    );
  }
  return lines.join('\r\n') + '\r\n';
}

function sanitizeForPath(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim();
}

/** Plain-text export: one candidate relative path per line, Artist/Album/## - Track. */
function toPlainText(db, opts) {
  const rows = allTracksOrdered(db, opts);
  const lines = rows.map((r) => {
    const num = r.track_number != null ? String(r.track_number).padStart(2, '0') + ' - ' : '';
    return `${sanitizeForPath(r.artist_name)}/${sanitizeForPath(r.album_name)}/${num}${sanitizeForPath(r.title)}`;
  });
  return lines.join('\n') + '\n';
}

/** Same as toPlainText but only rows not yet downloaded - the actual "to-do" list. */
function toRemainingPlainText(db) {
  const rows = allTracksOrdered(db).filter((r) => r.status !== 'downloaded');
  const lines = rows.map((r) => {
    const num = r.track_number != null ? String(r.track_number).padStart(2, '0') + ' - ' : '';
    return `${sanitizeForPath(r.artist_name)}/${sanitizeForPath(r.album_name)}/${num}${sanitizeForPath(r.title)}`;
  });
  return lines.join('\n') + '\n';
}

module.exports = { toCsv, toPlainText, toRemainingPlainText, allTracksOrdered };
