'use strict';

const { getOrCreateArtist, getOrCreateAlbum, loadConfig, isBetterPrimary } = require('./dedupe');
const { sortKey } = require('./normalize');

const STATUS_VALUES = ['not_started', 'in_progress', 'downloaded', 'skipped', 'problem'];

function assertTrackExists(db, id) {
  const row = db.prepare('SELECT * FROM canonical_tracks WHERE id = ?').get(id);
  if (!row) {
    const err = new Error(`Track ${id} not found`);
    err.statusCode = 404;
    throw err;
  }
  return row;
}

function setStatus(db, trackId, newStatus, note) {
  if (!STATUS_VALUES.includes(newStatus)) {
    const err = new Error(`Invalid status '${newStatus}'. Must be one of: ${STATUS_VALUES.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }
  const track = assertTrackExists(db, trackId);
  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE canonical_tracks SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    ).run(newStatus, trackId);
    db.prepare(
      'INSERT INTO status_history (canonical_track_id, old_status, new_status, note) VALUES (?, ?, ?, ?)'
    ).run(trackId, track.status, newStatus, note || null);
  });
  tx();
  return { id: trackId, status: newStatus };
}

function setIgnored(db, trackId, ignored, note) {
  const track = assertTrackExists(db, trackId);
  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE canonical_tracks SET ignored = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    ).run(ignored ? 1 : 0, trackId);
    db.prepare(
      `INSERT INTO manual_overrides (action_type, canonical_track_id, field, old_value, new_value, note)
       VALUES (?, ?, 'ignored', ?, ?, ?)`
    ).run(ignored ? 'ignore' : 'unignore', trackId, String(track.ignored), String(ignored ? 1 : 0), note || null);
  });
  tx();
  return { id: trackId, ignored: !!ignored };
}

const EDITABLE_FIELDS = ['title', 'track_number', 'disc_number', 'notes'];

/** Direct field edits that don't require re-parenting artist/album. */
function editFields(db, trackId, fields, note) {
  const track = assertTrackExists(db, trackId);
  const updates = [];
  const values = [];
  const logs = [];
  for (const key of Object.keys(fields || {})) {
    if (!EDITABLE_FIELDS.includes(key)) continue;
    const newVal = fields[key];
    const oldVal = track[key];
    if (String(oldVal) === String(newVal)) continue;
    updates.push(`${key} = ?`);
    values.push(newVal);
    logs.push([key, oldVal, newVal]);
    if (key === 'title') {
      updates.push('sort_key = ?');
      values.push(sortKey(newVal));
    }
  }
  if (!updates.length) return { id: trackId, changed: false };
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE canonical_tracks SET ${updates.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    ).run(...values, trackId);
    for (const [field, oldVal, newVal] of logs) {
      db.prepare(
        `INSERT INTO manual_overrides (action_type, canonical_track_id, field, old_value, new_value, note)
         VALUES ('edit_field', ?, ?, ?, ?, ?)`
      ).run(trackId, field, String(oldVal), String(newVal), note || null);
    }
  });
  tx();
  return { id: trackId, changed: true };
}

/** Re-assign a track to a different artist/album (also an "edit", but needs get-or-create). */
function editArtistAlbum(db, trackId, { artistName, albumName }, note) {
  const track = assertTrackExists(db, trackId);
  const tx = db.transaction(() => {
    let artistId = track.artist_id;
    let albumId = track.album_id;
    if (artistName) {
      artistId = getOrCreateArtist(db, artistName);
    }
    if (albumName || artistName) {
      const currentAlbum = db.prepare('SELECT name, release_date, release_category FROM albums WHERE id = ?').get(track.album_id);
      albumId = getOrCreateAlbum(
        db,
        artistId,
        albumName || currentAlbum.name,
        currentAlbum.release_date,
        currentAlbum.release_category
      );
    }
    if (artistId !== track.artist_id || albumId !== track.album_id) {
      db.prepare(
        "UPDATE canonical_tracks SET artist_id = ?, album_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
      ).run(artistId, albumId, trackId);
      db.prepare(
        `INSERT INTO manual_overrides (action_type, canonical_track_id, field, old_value, new_value, note)
         VALUES ('edit_field', ?, 'artist_album', ?, ?, ?)`
      ).run(trackId, `${track.artist_id}/${track.album_id}`, `${artistId}/${albumId}`, note || null);
    }
  });
  tx();
  return { id: trackId, changed: true };
}

/** Merge `sourceId` into `targetId`: all of source's duplicate sources move to target, source row is removed. */
function mergeTracks(db, sourceId, targetId, note) {
  if (sourceId === targetId) {
    const err = new Error('Cannot merge a track into itself');
    err.statusCode = 400;
    throw err;
  }
  assertTrackExists(db, sourceId);
  assertTrackExists(db, targetId);
  const tx = db.transaction(() => {
    db.prepare('UPDATE track_sources SET canonical_track_id = ?, is_primary = 0 WHERE canonical_track_id = ?').run(
      targetId,
      sourceId
    );
    // Only prune *pending* review flags touching either track - a flag that
    // was already confirmed/rejected is resolved history and must survive
    // the merge (its dangling side just goes NULL via the FK).
    db.prepare(
      `DELETE FROM possible_duplicates
       WHERE status = 'pending' AND (canonical_track_id_a IN (?, ?) OR canonical_track_id_b IN (?, ?))`
    ).run(sourceId, targetId, sourceId, targetId);
    db.prepare(
      `INSERT INTO manual_overrides (action_type, canonical_track_id, related_id, note)
       VALUES ('merge', ?, ?, ?)`
    ).run(targetId, sourceId, note || null);
    db.prepare('DELETE FROM canonical_tracks WHERE id = ?').run(sourceId);
  });
  tx();
  return { targetId, mergedFrom: sourceId };
}

/** Pull one contributing source entry out of a canonical track into its own new canonical track. */
function splitSource(db, canonicalTrackId, normalizedEntryId, note) {
  const track = assertTrackExists(db, canonicalTrackId);
  const sourceCount = db
    .prepare('SELECT COUNT(*) c FROM track_sources WHERE canonical_track_id = ?')
    .get(canonicalTrackId).c;
  if (sourceCount <= 1) {
    const err = new Error('Track has only one source; nothing to split');
    err.statusCode = 400;
    throw err;
  }
  const source = db
    .prepare('SELECT * FROM track_sources WHERE canonical_track_id = ? AND normalized_entry_id = ?')
    .get(canonicalTrackId, normalizedEntryId);
  if (!source) {
    const err = new Error('That source entry does not belong to this track');
    err.statusCode = 400;
    throw err;
  }
  const entry = db.prepare('SELECT * FROM normalized_entries WHERE id = ?').get(normalizedEntryId);

  const tx = db.transaction(() => {
    const artistId = getOrCreateArtist(db, entry.artist_display);
    const albumId = getOrCreateAlbum(db, artistId, entry.album_raw, entry.release_date, entry.release_category);
    const newTrackInfo = db
      .prepare(
        `INSERT INTO canonical_tracks
           (artist_id, album_id, title, sort_key, version_type, track_number, disc_number, duration_ms, primary_normalized_entry_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        artistId,
        albumId,
        entry.track_raw,
        sortKey(entry.track_title_stem || entry.track_raw),
        entry.version_type,
        entry.track_number,
        entry.disc_number,
        entry.duration_ms,
        entry.id
      );
    const newTrackId = newTrackInfo.lastInsertRowid;

    db.prepare(
      'UPDATE track_sources SET canonical_track_id = ?, is_primary = 1 WHERE id = ?'
    ).run(newTrackId, source.id);

    // If the entry we just split out was the primary source of the
    // original track, promote the best remaining source to primary.
    if (source.is_primary) {
      const config = loadConfig();
      const remaining = db
        .prepare(
          `SELECT ne.* FROM track_sources ts JOIN normalized_entries ne ON ne.id = ts.normalized_entry_id
           WHERE ts.canonical_track_id = ?`
        )
        .all(canonicalTrackId);
      let best = remaining[0];
      for (const r of remaining.slice(1)) {
        if (isBetterPrimary(r, best, config)) best = r;
      }
      db.prepare(
        `UPDATE canonical_tracks SET artist_id = ?, album_id = ?, title = ?, sort_key = ?, version_type = ?,
           track_number = ?, disc_number = ?, duration_ms = ?, primary_normalized_entry_id = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`
      ).run(
        getOrCreateArtist(db, best.artist_display),
        getOrCreateAlbum(db, getOrCreateArtist(db, best.artist_display), best.album_raw, best.release_date, best.release_category),
        best.track_raw,
        sortKey(best.track_title_stem || best.track_raw),
        best.version_type,
        best.track_number,
        best.disc_number,
        best.duration_ms,
        best.id,
        canonicalTrackId
      );
      db.prepare('UPDATE track_sources SET is_primary = 1 WHERE canonical_track_id = ? AND normalized_entry_id = ?').run(
        canonicalTrackId,
        best.id
      );
    }

    db.prepare(
      `INSERT INTO manual_overrides (action_type, canonical_track_id, related_id, note)
       VALUES ('split', ?, ?, ?)`
    ).run(newTrackId, canonicalTrackId, note || null);

    return newTrackId;
  });
  const newTrackId = tx();
  return { originalId: canonicalTrackId, newId: newTrackId };
}

function setPreferred(db, canonicalTrackId, normalizedEntryId, note) {
  assertTrackExists(db, canonicalTrackId);
  const source = db
    .prepare('SELECT * FROM track_sources WHERE canonical_track_id = ? AND normalized_entry_id = ?')
    .get(canonicalTrackId, normalizedEntryId);
  if (!source) {
    const err = new Error('That source entry does not belong to this track');
    err.statusCode = 400;
    throw err;
  }
  const entry = db.prepare('SELECT * FROM normalized_entries WHERE id = ?').get(normalizedEntryId);
  const tx = db.transaction(() => {
    const artistId = getOrCreateArtist(db, entry.artist_display);
    const albumId = getOrCreateAlbum(db, artistId, entry.album_raw, entry.release_date, entry.release_category);
    db.prepare(
      `UPDATE canonical_tracks SET artist_id = ?, album_id = ?, title = ?, sort_key = ?, version_type = ?,
         track_number = ?, disc_number = ?, duration_ms = ?, primary_normalized_entry_id = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`
    ).run(
      artistId,
      albumId,
      entry.track_raw,
      sortKey(entry.track_title_stem || entry.track_raw),
      entry.version_type,
      entry.track_number,
      entry.disc_number,
      entry.duration_ms,
      entry.id,
      canonicalTrackId
    );
    db.prepare('UPDATE track_sources SET is_primary = 0 WHERE canonical_track_id = ?').run(canonicalTrackId);
    db.prepare('UPDATE track_sources SET is_primary = 1 WHERE id = ?').run(source.id);
    db.prepare(
      `INSERT INTO manual_overrides (action_type, canonical_track_id, related_id, note)
       VALUES ('set_preferred', ?, ?, ?)`
    ).run(canonicalTrackId, normalizedEntryId, note || null);
  });
  tx();
  return { id: canonicalTrackId, preferredEntryId: normalizedEntryId };
}

function confirmDuplicate(db, possibleDuplicateId, note) {
  const pd = db.prepare('SELECT * FROM possible_duplicates WHERE id = ?').get(possibleDuplicateId);
  if (!pd) {
    const err = new Error('Possible-duplicate record not found');
    err.statusCode = 404;
    throw err;
  }
  const tx = db.transaction(() => {
    // Mark resolved *before* merging: mergeTracks prunes pending review
    // flags touching either track, and this row must survive as history.
    db.prepare(
      "UPDATE possible_duplicates SET status = 'confirmed', resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    ).run(possibleDuplicateId);
    mergeTracks(db, pd.canonical_track_id_b, pd.canonical_track_id_a, note || 'confirmed possible duplicate');
    db.prepare(
      `INSERT INTO manual_overrides (action_type, canonical_track_id, related_id, note)
       VALUES ('confirm_duplicate', ?, ?, ?)`
    ).run(pd.canonical_track_id_a, pd.canonical_track_id_b, note || null);
  });
  tx();
  return { id: possibleDuplicateId, status: 'confirmed', mergedInto: pd.canonical_track_id_a };
}

function rejectDuplicate(db, possibleDuplicateId, note) {
  const pd = db.prepare('SELECT * FROM possible_duplicates WHERE id = ?').get(possibleDuplicateId);
  if (!pd) {
    const err = new Error('Possible-duplicate record not found');
    err.statusCode = 404;
    throw err;
  }
  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE possible_duplicates SET status = 'rejected', resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    ).run(possibleDuplicateId);
    db.prepare(
      `INSERT INTO manual_overrides (action_type, canonical_track_id, related_id, note)
       VALUES ('reject_duplicate', ?, ?, ?)`
    ).run(pd.canonical_track_id_a, pd.canonical_track_id_b, note || null);
  });
  tx();
  return { id: possibleDuplicateId, status: 'rejected' };
}

module.exports = {
  STATUS_VALUES,
  setStatus,
  setIgnored,
  editFields,
  editArtistAlbum,
  mergeTracks,
  splitSource,
  setPreferred,
  confirmDuplicate,
  rejectDuplicate,
};
