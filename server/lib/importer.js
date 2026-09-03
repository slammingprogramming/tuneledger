'use strict';

const fs = require('fs');
const { parse } = require('csv-parse/sync');
const { assertSafePath } = require('./safe-path');
const {
  cleanWhitespace,
  normalizeForKey,
  splitArtists,
  extractVersionInfo,
  classifyReleaseCategory,
} = require('./normalize');

// Canonical field -> accepted header spellings (case-insensitive, trimmed).
// Extend this list as new Spotify/Exportify export variants are encountered;
// nothing else about the importer needs to change since unmapped columns
// are still preserved verbatim in raw_rows and in normalized_entries.extra_json.
const FIELD_ALIASES = {
  trackUri: ['track uri', 'spotify uri', 'uri'],
  trackId: ['track id', 'spotify id', 'spotify track id'],
  trackName: ['track name', 'name', 'title', 'track'],
  albumName: ['album name', 'album'],
  artistNames: ['artist name(s)', 'artist names', 'artist(s)', 'artist'],
  albumArtist: ['album artist name(s)', 'album artist', 'album artist(s)'],
  trackNumber: ['track number', 'track #', '#', 'track no'],
  discNumber: ['disc number', 'disc'],
  releaseDate: ['release date', 'album release date'],
  durationMs: ['duration (ms)', 'duration ms', 'duration'],
  popularity: ['popularity'],
  explicit: ['explicit'],
  addedBy: ['added by'],
  addedAt: ['added at', 'date added', 'added'],
  genres: ['genres', 'artist genre(s)', 'artist genres'],
  recordLabel: ['record label', 'label'],
  isrc: ['isrc'],
};

function buildColumnMap(header) {
  const lower = header.map((h) => cleanWhitespace(h).toLowerCase());
  const map = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const idx = lower.findIndex((h) => aliases.includes(h));
    map[field] = idx >= 0 ? header[idx] : null;
  }
  return map;
}

function parseIntOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function parseBoolOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return 1;
  if (s === 'false' || s === '0' || s === 'no') return 0;
  return null;
}

function parseReleaseYear(dateStr) {
  if (!dateStr) return null;
  const m = String(dateStr).match(/^(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

function extractTrackId(uri, idField) {
  if (idField) return idField;
  if (uri && uri.startsWith('spotify:track:')) return uri.slice('spotify:track:'.length);
  return null;
}

/**
 * Read and parse a Spotify/Exportify-style CSV. Returns the header, the
 * detected column mapping, and the raw records (array of plain objects
 * keyed by the *original* header strings, values always strings).
 */
function readCsv(fileOrBuffer) {
  const buf = Buffer.isBuffer(fileOrBuffer)
    ? fileOrBuffer
    : fs.readFileSync(assertSafePath(fileOrBuffer, 'CSV file path'));
  const records = parse(buf, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    trim: false,
  });
  const header = records.length ? Object.keys(records[0]) : [];
  // csv-parse with relax_column_count can produce rows missing some keys;
  // csv-parse also exposes info via the `info` option, but for our purposes
  // a simple re-parse to get the header row robustly is enough.
  let realHeader = header;
  try {
    const headerOnly = parse(buf, { bom: true, to_line: 1, relax_column_count: true });
    if (headerOnly.length) realHeader = headerOnly[0].map((h) => cleanWhitespace(h));
  } catch (e) {
    // fall back to inferred header
  }
  return { header: realHeader, records };
}

/**
 * Import a CSV file into the database: every row is preserved verbatim in
 * raw_rows, then a best-effort normalized_entries row is derived from it.
 * Canonical-track deduplication happens separately (see dedupe.js) so this
 * function stays purely about faithfully ingesting the source file.
 */
function importCsv(db, fileOrBuffer, { filename, label } = {}) {
  const { header, records } = readCsv(fileOrBuffer);
  if (!header.length) {
    throw new Error('CSV appears to have no header row / no columns.');
  }
  const columnMap = buildColumnMap(header);
  const mappedHeaders = new Set(Object.values(columnMap).filter(Boolean));
  const extraHeaders = header.filter((h) => !mappedHeaders.has(h));

  const insertImport = db.prepare(
    `INSERT INTO imports (filename, label, row_count, ok_count, error_count, column_map)
     VALUES (?, ?, 0, 0, 0, ?)`
  );
  const info = insertImport.run(
    filename || (typeof fileOrBuffer === 'string' ? fileOrBuffer : 'upload.csv'),
    label || null,
    JSON.stringify({ header, columnMap, extraHeaders })
  );
  const importId = info.lastInsertRowid;

  const insertRaw = db.prepare(
    `INSERT INTO raw_rows (import_id, row_number, raw_json, parse_status, parse_error)
     VALUES (?, ?, ?, ?, ?)`
  );
  const insertNorm = db.prepare(`
    INSERT INTO normalized_entries (
      raw_row_id, import_id, spotify_track_uri, spotify_track_id,
      artist_raw, artist_names_json, artist_display, artist_norm,
      album_raw, album_norm, track_raw, track_title_stem, track_norm,
      version_type, version_detail, track_number, disc_number, duration_ms,
      release_date, release_year, explicit, popularity, genres, record_label,
      added_at, release_category, extra_json
    ) VALUES (@raw_row_id, @import_id, @spotify_track_uri, @spotify_track_id,
      @artist_raw, @artist_names_json, @artist_display, @artist_norm,
      @album_raw, @album_norm, @track_raw, @track_title_stem, @track_norm,
      @version_type, @version_detail, @track_number, @disc_number, @duration_ms,
      @release_date, @release_year, @explicit, @popularity, @genres, @record_label,
      @added_at, @release_category, @extra_json)
  `);

  const warnings = [];
  let okCount = 0;
  let errorCount = 0;
  let skippedNoTitle = 0;

  const tx = db.transaction(() => {
    records.forEach((row, i) => {
      const rowNumber = i + 2; // +1 for 1-based, +1 for header line
      const get = (field) => {
        const h = columnMap[field];
        if (!h) return '';
        const v = row[h];
        return v === undefined || v === null ? '' : String(v);
      };

      const expectedCols = header.length;
      const actualCols = Object.keys(row).length;
      let parseStatus = 'ok';
      let parseError = null;
      if (actualCols !== expectedCols) {
        parseStatus = 'warning';
        parseError = `Column count mismatch: expected ${expectedCols}, got ${actualCols}`;
      }

      const trackRaw = cleanWhitespace(get('trackName'));
      const albumRaw = cleanWhitespace(get('albumName'));
      const artistRaw = cleanWhitespace(get('artistNames'));

      if (!trackRaw) {
        parseStatus = 'warning';
        parseError = parseError
          ? `${parseError}; missing track name`
          : 'missing track name';
      }

      const rawResult = insertRaw.run(
        importId,
        rowNumber,
        JSON.stringify(row),
        parseStatus,
        parseError
      );
      const rawRowId = rawResult.lastInsertRowid;

      if (parseStatus === 'ok') okCount += 1;
      else {
        errorCount += 1;
        warnings.push({ rowNumber, message: parseError, trackRaw, albumRaw, artistRaw });
      }

      if (!trackRaw) {
        skippedNoTitle += 1;
        return; // no usable title -> no normalized_entries row, but raw_row preserved above
      }

      const artists = splitArtists(artistRaw);
      const primaryArtist = artists[0] || artistRaw || 'Unknown Artist';
      const { stem, versionType, versionDetail } = extractVersionInfo(trackRaw);
      const releaseDate = cleanWhitespace(get('releaseDate'));
      const releaseCategory = classifyReleaseCategory(albumRaw, stem);
      const uri = cleanWhitespace(get('trackUri'));
      const trackId = extractTrackId(uri, cleanWhitespace(get('trackId')) || null);

      const extra = {};
      for (const h of extraHeaders) {
        if (row[h] !== undefined && row[h] !== '') extra[h] = row[h];
      }

      insertNorm.run({
        raw_row_id: rawRowId,
        import_id: importId,
        spotify_track_uri: uri || null,
        spotify_track_id: trackId || null,
        artist_raw: artistRaw || null,
        artist_names_json: JSON.stringify(artists),
        artist_display: primaryArtist,
        artist_norm: normalizeForKey(primaryArtist),
        album_raw: albumRaw || null,
        album_norm: normalizeForKey(albumRaw || trackRaw),
        track_raw: trackRaw,
        track_title_stem: stem,
        track_norm: normalizeForKey(trackRaw),
        version_type: versionType,
        version_detail: versionDetail,
        track_number: parseIntOrNull(get('trackNumber')),
        disc_number: parseIntOrNull(get('discNumber')),
        duration_ms: parseIntOrNull(get('durationMs')),
        release_date: releaseDate || null,
        release_year: parseReleaseYear(releaseDate),
        explicit: parseBoolOrNull(get('explicit')),
        popularity: parseIntOrNull(get('popularity')),
        genres: cleanWhitespace(get('genres')) || null,
        record_label: cleanWhitespace(get('recordLabel')) || null,
        added_at: cleanWhitespace(get('addedAt')) || null,
        release_category: releaseCategory,
        extra_json: Object.keys(extra).length ? JSON.stringify(extra) : null,
      });
    });

    db.prepare('UPDATE imports SET row_count = ?, ok_count = ?, error_count = ? WHERE id = ?').run(
      records.length,
      okCount,
      errorCount,
      importId
    );
  });

  tx();

  return {
    importId,
    filename: filename || (typeof fileOrBuffer === 'string' ? fileOrBuffer : 'upload.csv'),
    header,
    columnMap,
    extraHeaders,
    rowCount: records.length,
    okCount,
    warningCount: errorCount,
    skippedNoTitle,
    warnings,
  };
}

module.exports = { importCsv, readCsv, buildColumnMap, FIELD_ALIASES };
