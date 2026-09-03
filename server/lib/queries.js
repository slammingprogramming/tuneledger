'use strict';

// Read-side query helpers backing the API. Kept separate from the routes so
// they're easy to unit test and reuse between the JSON API and the export
// endpoints.

const TRACK_ORDER_SQL = `
  (ct.disc_number IS NULL), ct.disc_number,
  (ct.track_number IS NULL), ct.track_number,
  ct.sort_key
`;

function overallStats(db) {
  const totals = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status='downloaded' THEN 1 ELSE 0 END) AS downloaded,
         SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) AS skipped,
         SUM(CASE WHEN status='problem' THEN 1 ELSE 0 END) AS problem,
         SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END) AS in_progress,
         SUM(CASE WHEN status='not_started' THEN 1 ELSE 0 END) AS not_started
       FROM canonical_tracks WHERE ignored = 0`
    )
    .get();
  const artists = db.prepare('SELECT COUNT(DISTINCT artist_id) c FROM canonical_tracks WHERE ignored=0').get().c;
  const albums = db.prepare('SELECT COUNT(DISTINCT album_id) c FROM canonical_tracks WHERE ignored=0').get().c;
  const ignored = db.prepare('SELECT COUNT(*) c FROM canonical_tracks WHERE ignored=1').get().c;
  const pendingReview = db.prepare("SELECT COUNT(*) c FROM possible_duplicates WHERE status='pending'").get().c;
  const total = totals.total || 0;
  const downloaded = totals.downloaded || 0;
  return {
    artists,
    albums,
    uniqueTracks: total,
    downloaded,
    remaining: total - downloaded,
    skipped: totals.skipped || 0,
    problem: totals.problem || 0,
    inProgress: totals.in_progress || 0,
    notStarted: totals.not_started || 0,
    ignored,
    pendingReview,
    progressPct: total ? Math.round((downloaded / total) * 1000) / 10 : 0,
  };
}

function listArtists(db, { q, status, limit = 200, offset = 0 } = {}) {
  const where = ['ct.ignored = 0'];
  const params = {};
  if (q) {
    where.push('a.name LIKE @q');
    params.q = `%${q}%`;
  }
  const rows = db
    .prepare(
      `SELECT a.id, a.name, a.sort_key,
              COUNT(*) AS trackCount,
              SUM(CASE WHEN ct.status='downloaded' THEN 1 ELSE 0 END) AS downloadedCount,
              COUNT(DISTINCT ct.album_id) AS albumCount
       FROM canonical_tracks ct
       JOIN artists a ON a.id = ct.artist_id
       WHERE ${where.join(' AND ')}
       GROUP BY a.id
       ${status === 'incomplete' ? 'HAVING downloadedCount < trackCount' : ''}
       ${status === 'complete' ? 'HAVING downloadedCount = trackCount' : ''}
       ORDER BY a.sort_key
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit, offset });
  const totalRow = db
    .prepare(
      `SELECT COUNT(*) c FROM (
         SELECT a.id FROM canonical_tracks ct JOIN artists a ON a.id = ct.artist_id
         WHERE ${where.join(' AND ')} GROUP BY a.id
       )`
    )
    .get(params);
  return {
    total: totalRow.c,
    artists: rows.map((r) => ({
      id: r.id,
      name: r.name,
      trackCount: r.trackCount,
      downloadedCount: r.downloadedCount,
      albumCount: r.albumCount,
      progressPct: r.trackCount ? Math.round((r.downloadedCount / r.trackCount) * 1000) / 10 : 0,
    })),
  };
}

function artistAlbums(db, artistId) {
  const albums = db
    .prepare(
      `SELECT al.id, al.name, al.release_date, al.release_category,
              COUNT(*) AS trackCount,
              SUM(CASE WHEN ct.status='downloaded' THEN 1 ELSE 0 END) AS downloadedCount
       FROM canonical_tracks ct
       JOIN albums al ON al.id = ct.album_id
       WHERE ct.artist_id = ? AND ct.ignored = 0
       GROUP BY al.id
       ORDER BY al.sort_key`
    )
    .all(artistId);
  return albums.map((a) => ({
    ...a,
    progressPct: a.trackCount ? Math.round((a.downloadedCount / a.trackCount) * 1000) / 10 : 0,
  }));
}

function albumTracks(db, albumId) {
  const tracks = db
    .prepare(
      `SELECT ct.*, (
         SELECT COUNT(*) FROM track_sources ts WHERE ts.canonical_track_id = ct.id
       ) AS sourceCount
       FROM canonical_tracks ct
       WHERE ct.album_id = ? AND ct.ignored = 0
       ORDER BY ${TRACK_ORDER_SQL}`
    )
    .all(albumId);
  return tracks;
}

function trackSources(db, canonicalTrackId) {
  return db
    .prepare(
      `SELECT ts.id AS source_id, ts.match_stage, ts.match_score, ts.is_primary,
              ne.id AS normalized_entry_id, ne.track_raw, ne.album_raw, ne.artist_raw,
              ne.duration_ms, ne.release_date, ne.release_category, ne.version_type,
              ne.version_detail, ne.added_at, ne.spotify_track_uri, ne.import_id
       FROM track_sources ts
       JOIN normalized_entries ne ON ne.id = ts.normalized_entry_id
       WHERE ts.canonical_track_id = ?
       ORDER BY ts.is_primary DESC, ne.release_date ASC`
    )
    .all(canonicalTrackId);
}

function trackDetail(db, id) {
  const track = db
    .prepare(
      `SELECT ct.*, a.name AS artist_name, al.name AS album_name
       FROM canonical_tracks ct
       JOIN artists a ON a.id = ct.artist_id
       JOIN albums al ON al.id = ct.album_id
       WHERE ct.id = ?`
    )
    .get(id);
  if (!track) return null;
  return { ...track, sources: trackSources(db, id) };
}

function searchTracks(db, filters = {}) {
  const {
    q,
    artist,
    album,
    status,
    versionType,
    disc,
    importId,
    duplicatesOnly,
    missingMetadata,
    ignored,
    limit = 100,
    offset = 0,
  } = filters;

  const where = [];
  const params = {};

  if (ignored === 'only') where.push('ct.ignored = 1');
  else if (!ignored || ignored === 'exclude') where.push('ct.ignored = 0');
  // ignored === 'include' -> no filter

  if (q) {
    where.push('(ct.title LIKE @q OR a.name LIKE @q OR al.name LIKE @q)');
    params.q = `%${q}%`;
  }
  if (artist) {
    where.push('a.name LIKE @artist');
    params.artist = `%${artist}%`;
  }
  if (album) {
    where.push('al.name LIKE @album');
    params.album = `%${album}%`;
  }
  if (status) {
    where.push('ct.status = @status');
    params.status = status;
  }
  if (versionType) {
    where.push('ct.version_type = @versionType');
    params.versionType = versionType;
  }
  if (disc !== undefined && disc !== null && disc !== '') {
    where.push('ct.disc_number = @disc');
    params.disc = disc;
  }
  if (importId) {
    where.push(
      'ct.id IN (SELECT ts.canonical_track_id FROM track_sources ts JOIN normalized_entries ne ON ne.id=ts.normalized_entry_id WHERE ne.import_id = @importId)'
    );
    params.importId = importId;
  }
  if (duplicatesOnly) {
    where.push('(SELECT COUNT(*) FROM track_sources ts WHERE ts.canonical_track_id = ct.id) > 1');
  }
  if (missingMetadata) {
    where.push("(ct.track_number IS NULL OR al.release_date IS NULL OR ct.duration_ms IS NULL)");
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db
    .prepare(
      `SELECT ct.id, ct.title, ct.status, ct.version_type, ct.track_number, ct.disc_number,
              ct.ignored, a.name AS artist_name, al.name AS album_name,
              (SELECT COUNT(*) FROM track_sources ts WHERE ts.canonical_track_id = ct.id) AS sourceCount
       FROM canonical_tracks ct
       JOIN artists a ON a.id = ct.artist_id
       JOIN albums al ON al.id = ct.album_id
       ${whereSql}
       ORDER BY a.sort_key, al.sort_key, ${TRACK_ORDER_SQL}
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit, offset });

  const total = db
    .prepare(
      `SELECT COUNT(*) c FROM canonical_tracks ct
       JOIN artists a ON a.id = ct.artist_id
       JOIN albums al ON al.id = ct.album_id
       ${whereSql}`
    )
    .get(params).c;

  return { total, tracks: rows };
}

module.exports = {
  overallStats,
  listArtists,
  artistAlbums,
  albumTracks,
  trackSources,
  trackDetail,
  searchTracks,
  TRACK_ORDER_SQL,
};
