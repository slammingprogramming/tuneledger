'use strict';

const fs = require('fs/promises');
const path = require('path');
const { identifyFile } = require('./identify');
const { runDedupe } = require('./dedupe');
const { normalizeForKey, classifyReleaseCategory } = require('./normalize');
const { assertSafeLibraryPath } = require('./safe-path');

const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.aac', '.wav', '.wma', '.ogg', '.opus', '.alac', '.aiff', '.ape', '.wv']);
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.flv', '.wmv']);
const DEFAULT_REVIEW_FOLDER_NAME = '_needs_review';

function classifyMediaKind(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (VIDEO_EXT.has(ext)) return 'video';
  return null;
}

/** Recursively enumerate audio/video files under `rootDir`, skipping any review folder from a prior scan. */
async function* walkMediaFiles(rootDir, { excludeDirNames }) {
  const safeRootDir = assertSafeLibraryPath(rootDir, 'rootDir');
  // Operator-supplied library directory, optionally confined by LIBRARY_ROOTS (see README/SECURITY.md) - same trust model as pointing Jellyfin/Lidarr at a library folder.
  const entries = await fs.readdir(safeRootDir, { withFileTypes: true }); // codeql[js/path-injection]
  for (const entry of entries) {
    const full = path.join(safeRootDir, entry.name);
    if (entry.isDirectory()) {
      if (excludeDirNames.has(entry.name)) continue;
      yield* walkMediaFiles(full, { excludeDirNames });
    } else if (entry.isFile()) {
      const kind = classifyMediaKind(full);
      if (kind) yield { filePath: full, mediaKind: kind };
    }
  }
}

async function countMediaFiles(rootDir, opts) {
  let n = 0;
  for await (const _ of walkMediaFiles(rootDir, opts)) n++; // eslint-disable-line no-unused-vars
  return n;
}

function parseReleaseYear(dateStr) {
  if (!dateStr) return null;
  const m = String(dateStr).match(/^(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Move a file to an exact destination path, creating parent directories,
 * never overwriting an existing file (appends " (1)", " (2)", ... instead),
 * and falling back to copy+delete when rename() can't cross a device/drive
 * boundary. Returns the actual destination used.
 */
async function moveFileTo(filePath, destPath) {
  const safeFilePath = assertSafeLibraryPath(filePath, 'filePath');
  const safeDestPath = assertSafeLibraryPath(destPath, 'destPath');
  // Destination is always inside the review folder (optionally LIBRARY_ROOTS-confined) or an explicit apply-moves target already validated above.
  await fs.mkdir(path.dirname(safeDestPath), { recursive: true }); // codeql[js/path-injection]

  let dest = safeDestPath;
  let n = 1;
  const { dir, name, ext } = path.parse(safeDestPath);
  while (await fileExists(dest)) {
    dest = path.join(dir, `${name} (${n})${ext}`);
    n += 1;
  }

  try {
    await fs.rename(safeFilePath, dest); // codeql[js/path-injection] both endpoints already validated above (assertSafeLibraryPath / LIBRARY_ROOTS)
  } catch (err) {
    if (err.code === 'EXDEV') {
      // Cross-device move (e.g. different drive) - rename() can't do this atomically.
      await fs.copyFile(safeFilePath, dest); // codeql[js/path-injection]
      await fs.unlink(safeFilePath); // codeql[js/path-injection]
    } else {
      throw err;
    }
  }
  return dest;
}

/** Move a file, preserving `rootDir`-relative structure under `reviewFolder`. */
async function moveToReview(filePath, rootDir, reviewFolder) {
  const safeRootDir = assertSafeLibraryPath(rootDir, 'rootDir');
  const safeReviewFolder = assertSafeLibraryPath(reviewFolder, 'reviewFolder');
  const rel = path.relative(safeRootDir, assertSafeLibraryPath(filePath, 'filePath'));
  return moveFileTo(filePath, path.join(safeReviewFolder, rel));
}

async function fileExists(p) {
  try {
    await fs.access(p); // codeql[js/path-injection] p always derives from an already-validated rootDir/destPath above
    return true;
  } catch {
    return false;
  }
}

/**
 * Insert one identified file as a synthetic raw_row + normalized_entries
 * row, exactly mirroring what importCsv does for a CSV line - this is what
 * lets the existing dedupe engine reconcile local files against everything
 * already in the queue (Spotify imports, other scans, WPL references).
 *
 * `markDownloaded` controls whether *linking this file to a canonical
 * track* should also mark that track downloaded (see dedupe.js). Default
 * true: "I already have this, don't ask me to download it." Pass false for
 * a quality-upgrade pass - e.g. scanning a folder of known-low-bitrate rips
 * you specifically want to keep queued for a better-quality re-download,
 * while still recording that you have *a* copy as a source.
 */
function insertIdentifiedFile(db, importId, result, markDownloaded = true) {
  const insertRaw = db.prepare(
    `INSERT INTO raw_rows (import_id, row_number, raw_json, parse_status, parse_error)
     VALUES (?, ?, ?, 'ok', NULL)`
  );
  const rowCountRow = db.prepare('SELECT COUNT(*) c FROM raw_rows WHERE import_id = ?').get(importId);
  const rawInfo = insertRaw.run(importId, rowCountRow.c + 1, JSON.stringify(result));
  const rawRowId = rawInfo.lastInsertRowid;

  const releaseCategory = classifyReleaseCategory(result.album, result.title);

  db.prepare(
    `INSERT INTO normalized_entries (
       raw_row_id, import_id, spotify_track_uri, spotify_track_id,
       artist_raw, artist_names_json, artist_display, artist_norm,
       album_raw, album_norm, track_raw, track_title_stem, track_norm,
       version_type, version_detail, track_number, disc_number, duration_ms,
       release_date, release_year, explicit, popularity, genres, record_label,
       added_at, release_category, extra_json,
       file_path, media_kind, musicbrainz_recording_id, identify_method, identify_confidence,
       mark_downloaded_on_match
     ) VALUES (
       @raw_row_id, @import_id, NULL, NULL,
       @artist_raw, @artist_names_json, @artist_display, @artist_norm,
       @album_raw, @album_norm, @track_raw, @track_title_stem, @track_norm,
       @version_type, @version_detail, @track_number, @disc_number, @duration_ms,
       @release_date, @release_year, NULL, NULL, @genres, @record_label,
       NULL, @release_category, NULL,
       @file_path, @media_kind, @musicbrainz_recording_id, @identify_method, @identify_confidence,
       @mark_downloaded_on_match
     )`
  ).run({
    raw_row_id: rawRowId,
    import_id: importId,
    artist_raw: result.artist,
    artist_names_json: JSON.stringify([result.artist]),
    artist_display: result.artist,
    artist_norm: normalizeForKey(result.artist),
    album_raw: result.album,
    album_norm: normalizeForKey(result.album || result.title),
    track_raw: result.title,
    track_title_stem: result.title,
    track_norm: normalizeForKey(result.title),
    version_type: result.versionType,
    version_detail: result.versionDetail,
    track_number: result.trackNumber,
    disc_number: result.discNumber,
    duration_ms: result.durationMs,
    release_date: result.releaseDate,
    release_year: parseReleaseYear(result.releaseDate),
    genres: result.genres,
    record_label: result.recordLabel,
    release_category: releaseCategory,
    file_path: result.filePath,
    media_kind: result.mediaKind,
    musicbrainz_recording_id: result.musicbrainzRecordingId,
    identify_method: result.identifyMethod,
    identify_confidence: result.identifyConfidence,
    mark_downloaded_on_match: markDownloaded ? 1 : 0,
  });
}

/**
 * Scan `rootDir` recursively for audio/video files, identify each one
 * (tags -> MusicBrainz -> filename, see identify.js), insert identified
 * files into the normal import/dedupe pipeline (auto-marking matched queue
 * items as downloaded), and stage-or-execute moving unidentified files into
 * a review folder.
 *
 * File moves are staged (file_moves row with applied=0) rather than
 * executed when dryRun is true (the default) - nothing on disk changes
 * until /api/library-scan/:id/apply-moves is called, or the scan is run
 * again with dryRun:false. Database writes for *identified* files happen
 * unconditionally, since those are safe/reversible (delete the import,
 * ignore the tracks) unlike moving real files around on someone's disk.
 *
 * `markDownloaded` (default true) controls whether a match against the
 * queue marks that track downloaded - see insertIdentifiedFile for the
 * quality-upgrade-pass use case for setting this false.
 */
async function runLibraryScan(db, {
  rootDir,
  reviewFolder,
  dryRun = true,
  useMusicBrainz = true,
  markDownloaded = true,
  mbClient,
  scanJobId = null,
  isCancelled = () => false,
  onProgress = () => {},
}) {
  rootDir = assertSafeLibraryPath(rootDir, 'rootDir');
  const resolvedReview = reviewFolder ? assertSafeLibraryPath(reviewFolder, 'reviewFolder') : path.join(rootDir, DEFAULT_REVIEW_FOLDER_NAME);
  const excludeDirNames = new Set([path.basename(resolvedReview)]);

  const total = await countMediaFiles(rootDir, { excludeDirNames });
  onProgress({ totalFiles: total, processedFiles: 0 });

  const insertImport = db.prepare(
    `INSERT INTO imports (filename, label, row_count, ok_count, error_count, source_type, root_path)
     VALUES (?, ?, 0, 0, 0, 'local_scan', ?)`
  );
  const importInfo = insertImport.run(path.basename(rootDir), `Local scan: ${rootDir}`, rootDir);
  const importId = importInfo.lastInsertRowid;

  const stats = { totalFiles: total, processedFiles: 0, identifiedCount: 0, reviewCount: 0, skippedCount: 0 };

  let processed = 0;
  for await (const { filePath, mediaKind } of walkMediaFiles(rootDir, { excludeDirNames })) {
    if (isCancelled()) break;
    processed += 1;
    onProgress({ totalFiles: total, processedFiles: processed, currentFile: filePath });

    let result;
    try {
      result = await identifyFile(filePath, { mediaKind, mbClient, useMusicBrainz, rootDir });
    } catch (err) {
      result = { ok: false, reason: `identify error: ${err.message}` };
    }

    if (result.ok) {
      insertIdentifiedFile(db, importId, result, markDownloaded);
      stats.identifiedCount += 1;
    } else {
      const insertMove = db.prepare(
        `INSERT INTO file_moves (scan_job_id, original_path, new_path, reason, applied, moved_at)
         VALUES (@scan_job_id, @original_path, @new_path, @reason, @applied, @moved_at)`
      );
      const dest = path.join(resolvedReview, path.relative(rootDir, filePath));
      let appliedNow = false;
      let finalDest = dest;
      if (!dryRun) {
        finalDest = await moveToReview(filePath, rootDir, resolvedReview);
        appliedNow = true;
      }
      insertMove.run({
        scan_job_id: scanJobId,
        original_path: filePath,
        new_path: finalDest,
        reason: result.reason,
        applied: appliedNow ? 1 : 0,
        moved_at: appliedNow ? new Date().toISOString() : null,
      });
      stats.reviewCount += 1;
    }
    stats.processedFiles = processed;
  }

  if (stats.identifiedCount > 0) {
    runDedupe(db, { importId });
  }
  // Always record what was actually scanned, even when nothing was
  // identified - otherwise Import History misleadingly shows "0 rows" for a
  // directory that in fact had hundreds of files, all sent to review.
  db.prepare('UPDATE imports SET row_count = ?, ok_count = ? WHERE id = ?').run(
    stats.identifiedCount + stats.reviewCount,
    stats.identifiedCount,
    importId
  );

  return { importId, resolvedReview, ...stats, cancelled: isCancelled() };
}

module.exports = {
  runLibraryScan,
  classifyMediaKind,
  walkMediaFiles,
  countMediaFiles,
  moveToReview,
  moveFileTo,
  insertIdentifiedFile,
  DEFAULT_REVIEW_FOLDER_NAME,
  AUDIO_EXT,
  VIDEO_EXT,
};
