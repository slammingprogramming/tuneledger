'use strict';

const fs = require('fs');
const path = require('path');
const { sortKey } = require('./normalize');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'dedupe.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

/** Bigram Dice coefficient - cheap, dependency-free, good for short titles. */
function bigrams(s) {
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

function diceCoefficient(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bgA = bigrams(a);
  const bgB = bigrams(b);
  const counts = new Map();
  for (const bg of bgA) counts.set(bg, (counts.get(bg) || 0) + 1);
  let overlap = 0;
  for (const bg of bgB) {
    const c = counts.get(bg) || 0;
    if (c > 0) {
      overlap += 1;
      counts.set(bg, c - 1);
    }
  }
  return (2 * overlap) / (bgA.length + bgB.length);
}

/**
 * Titles that differ only by a number ("Track 1" vs "Track 12", "Interlude
 * 1" vs "Interlude 2", "Symphony No. 5" vs "No. 9") can score deceptively
 * high on bigram similarity while being genuinely different tracks - the
 * digits are exactly the part that distinguishes them. Treat differing
 * numeric tokens as disqualifying for the fuzzy stage rather than trusting
 * the raw similarity score.
 */
function numberTokens(s) {
  return (s.match(/\d+/g) || []).map((n) => String(parseInt(n, 10)));
}

function hasConflictingNumbers(a, b) {
  const numsA = numberTokens(a);
  const numsB = numberTokens(b);
  if (!numsA.length || !numsB.length) return false;
  const setA = new Set(numsA);
  const setB = new Set(numsB);
  if (setA.size !== setB.size) return true;
  for (const n of setA) if (!setB.has(n)) return true;
  return false;
}

function releaseWeight(category, config) {
  const table = config.releaseCategoryPreference;
  return table[category] !== undefined ? table[category] : table.unknown;
}

function durationsClose(a, b, toleranceMs) {
  if (a == null || b == null) return true; // can't compare -> don't block the match on this alone
  return Math.abs(a - b) <= toleranceMs;
}

function getOrCreateArtist(db, name) {
  const key = sortKey(name);
  const existing = db.prepare('SELECT id, name FROM artists WHERE sort_key = ?').get(key);
  if (existing) return existing.id;
  const info = db
    .prepare('INSERT INTO artists (name, sort_key) VALUES (?, ?)')
    .run(name, key);
  return info.lastInsertRowid;
}

function getOrCreateAlbum(db, artistId, name, releaseDate, releaseCategory) {
  const albumName = name || 'Unknown Album';
  const key = sortKey(albumName);
  const existing = db
    .prepare('SELECT id FROM albums WHERE artist_id = ? AND sort_key = ?')
    .get(artistId, key);
  if (existing) return existing.id;
  const info = db
    .prepare(
      'INSERT INTO albums (artist_id, name, sort_key, release_date, release_category) VALUES (?, ?, ?, ?, ?)'
    )
    .run(artistId, albumName, key, releaseDate || null, releaseCategory || 'unknown');
  return info.lastInsertRowid;
}

function entryAlbumWeight(entry, config) {
  return releaseWeight(entry.release_category, config);
}

/** Is `candidateEntry` a better primary source than `currentEntry` for a canonical track? */
function isBetterPrimary(candidateEntry, currentEntry, config) {
  const wCand = entryAlbumWeight(candidateEntry, config);
  const wCur = entryAlbumWeight(currentEntry, config);
  if (wCand !== wCur) return wCand < wCur;
  // Same category weight -> prefer the earlier release (more "canonical").
  const dCand = candidateEntry.release_date || '9999';
  const dCur = currentEntry.release_date || '9999';
  return dCand < dCur;
}

function applyPrimary(db, canonicalTrackId, entry, artistId, albumId) {
  db.prepare(
    `UPDATE canonical_tracks SET
       artist_id = ?, album_id = ?, title = ?, sort_key = ?, version_type = ?,
       track_number = ?, disc_number = ?, duration_ms = ?,
       primary_normalized_entry_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
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
  db.prepare('UPDATE track_sources SET is_primary = 0 WHERE canonical_track_id = ?').run(
    canonicalTrackId
  );
  db.prepare(
    'UPDATE track_sources SET is_primary = 1 WHERE canonical_track_id = ? AND normalized_entry_id = ?'
  ).run(canonicalTrackId, entry.id);
}

function createCanonicalTrack(db, entry, artistId, albumId) {
  const info = db
    .prepare(
      `INSERT INTO canonical_tracks
         (artist_id, album_id, title, sort_key, version_type, track_number, disc_number,
          duration_ms, primary_normalized_entry_id)
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
  return info.lastInsertRowid;
}

/**
 * A normalized_entry backed by a real file on disk (local library scan or
 * WPL reference) means the user already *has* a copy of the recording - but
 * not necessarily the copy they want to keep. Someone doing a quality-
 * upgrade pass (re-downloading a low-bitrate rip in FLAC, say) wants the
 * file *linked* as a known source without the queue item being marked
 * complete, so it stays on the to-do list. Each scan chooses this via
 * `mark_downloaded_on_match`, carried per normalized_entries row (set at
 * scan time from the scan's markDownloaded option - see library-scanner.js/
 * wpl.js) so the dedupe engine can decide per-entry without a join. When
 * enabled, this intentionally overwrites any prior status (including
 * skipped/problem) since having the file is about as strong a completion
 * signal as this app can get.
 */
function markDownloadedIfLocalFile(db, canonicalTrackId, entry) {
  if (!entry.file_path || !entry.mark_downloaded_on_match) return;
  const track = db.prepare('SELECT status FROM canonical_tracks WHERE id = ?').get(canonicalTrackId);
  if (!track || track.status === 'downloaded') return;
  db.prepare(
    "UPDATE canonical_tracks SET status = 'downloaded', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
  ).run(canonicalTrackId);
  db.prepare(
    "INSERT INTO status_history (canonical_track_id, old_status, new_status, note) VALUES (?, ?, 'downloaded', ?)"
  ).run(canonicalTrackId, track.status, `Matched local file: ${entry.file_path}`);
}

function linkSource(db, canonicalTrackId, entry, stage, score, isPrimary) {
  db.prepare(
    `INSERT INTO track_sources (canonical_track_id, normalized_entry_id, match_stage, match_score, is_primary)
     VALUES (?, ?, ?, ?, ?)`
  ).run(canonicalTrackId, entry.id, stage, score, isPrimary ? 1 : 0);
  markDownloadedIfLocalFile(db, canonicalTrackId, entry);
}

/**
 * Fetch existing canonical tracks (with their primary entry's key fields)
 * for a given artist, to compare a new normalized_entry against. Small
 * per-artist working set keeps this fast even with a large library since
 * matching is always scoped to a single artist.
 */
function candidatesForArtist(db, artistId) {
  return db
    .prepare(
      `SELECT ct.id AS canonical_track_id, ct.version_type, ct.sort_key,
              ne.id AS entry_id, ne.track_norm, ne.track_title_stem, ne.version_type AS entry_version_type,
              ne.duration_ms, ne.release_date, ne.release_category, ne.spotify_track_id, ne.track_raw,
              ne.musicbrainz_recording_id
       FROM canonical_tracks ct
       JOIN normalized_entries ne ON ne.id = ct.primary_normalized_entry_id
       WHERE ct.artist_id = ? AND ct.ignored = 0`
    )
    .all(artistId);
}

/**
 * Process every normalized_entries row that isn't linked to a canonical
 * track yet (via track_sources). Safe to call repeatedly / incrementally:
 * already-linked entries and their canonical_track ids/status are never
 * touched, which is what keeps download progress stable across re-imports.
 */
function runDedupe(db, { importId } = {}) {
  const config = loadConfig();

  const whereImport = importId ? 'AND ne.import_id = ?' : '';
  const params = importId ? [importId] : [];
  const entries = db
    .prepare(
      `SELECT ne.* FROM normalized_entries ne
       LEFT JOIN track_sources ts ON ts.normalized_entry_id = ne.id
       WHERE ts.id IS NULL ${whereImport}
       ORDER BY ne.artist_norm, ne.album_norm, ne.disc_number, ne.track_number, ne.id`
    )
    .all(...params);

  const stats = { processed: 0, newCanonical: 0, mergedExact: 0, mergedMeta: 0, mergedTitle: 0, mergedFuzzy: 0, flaggedForReview: 0 };

  const tx = db.transaction(() => {
    for (const entry of entries) {
      stats.processed += 1;
      const artistId = getOrCreateArtist(db, entry.artist_display);
      const candidates = candidatesForArtist(db, artistId);

      // Stage 0: exact MusicBrainz recording ID. This is the single most
      // reliable signal available - MBIDs identify the same canonical
      // recording per MusicBrainz's own database, independent of whatever
      // text differences exist between how two sources spelled the title.
      let match = null;
      if (entry.musicbrainz_recording_id) {
        match = candidates.find((c) => c.musicbrainz_recording_id === entry.musicbrainz_recording_id);
        if (match) {
          linkSource(db, match.canonical_track_id, entry, 'mbid', 1.0, false);
          maybePromotePrimary(db, match, entry, artistId, config);
          stats.mergedExact += 1;
          continue;
        }
      }

      // Stage 1: exact Spotify track ID (only meaningful across imports /
      // duplicate CSV rows - different releases get different IDs).
      if (entry.spotify_track_id) {
        match = candidates.find((c) => c.spotify_track_id === entry.spotify_track_id);
        if (match) {
          linkSource(db, match.canonical_track_id, entry, 'exact_id', 1.0, false);
          maybePromotePrimary(db, match, entry, artistId, config);
          stats.mergedExact += 1;
          continue;
        }
      }

      // Stage 2: exact normalized metadata (artist scope already applied) -
      // same full normalized title + close duration.
      match = candidates.find(
        (c) =>
          c.track_norm === entry.track_norm &&
          durationsClose(c.duration_ms, entry.duration_ms, config.durationToleranceMsExactMeta)
      );
      if (match) {
        linkSource(db, match.canonical_track_id, entry, 'exact_meta', 0.99, false);
        maybePromotePrimary(db, match, entry, artistId, config);
        stats.mergedMeta += 1;
        continue;
      }

      // Stage 3: normalized title stem match - same stem, same version
      // classification, duration within a looser tolerance.
      match = candidates.find(
        (c) =>
          c.track_title_stem === entry.track_title_stem &&
          c.entry_version_type === entry.version_type &&
          durationsClose(c.duration_ms, entry.duration_ms, config.durationToleranceMsTitleStem)
      );
      if (match) {
        linkSource(db, match.canonical_track_id, entry, 'normalized_title', 0.95, false);
        maybePromotePrimary(db, match, entry, artistId, config);
        stats.mergedTitle += 1;
        continue;
      }

      // Stage 4: fuzzy candidate scoring, same version classification only
      // (different version types are never auto-merged, however similar the
      // titles look - a Remix is not a substitute for the Original). A
      // duration gate is still required here even though the stems may be
      // identical: our keyword list doesn't recognize every annotation
      // (e.g. "Club Mix"), so two rows can end up with the same stripped
      // stem while actually being different mixes/edits. When durations are
      // known and far apart, that's stronger evidence than title text.
      let best = null;
      let bestScore = 0;
      // Also track the best title match ignoring the duration gate, purely
      // to decide whether a duration-blocked near-match deserves a review
      // flag (e.g. identical stem, ~1 minute duration gap - could be a
      // genuinely different mix, or could be bad metadata; not our call to
      // auto-decide, but worth surfacing).
      let bestIgnoringDuration = null;
      let bestScoreIgnoringDuration = 0;
      for (const c of candidates) {
        if (c.entry_version_type !== entry.version_type) continue;
        if (hasConflictingNumbers(c.track_title_stem, entry.track_title_stem)) continue;
        const score = diceCoefficient(c.track_title_stem, entry.track_title_stem);
        if (score > bestScoreIgnoringDuration) {
          bestScoreIgnoringDuration = score;
          bestIgnoringDuration = c;
        }
        if (!durationsClose(c.duration_ms, entry.duration_ms, config.durationToleranceMsTitleStem)) continue;
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      if (best && bestScore >= config.fuzzyAutoMergeThreshold) {
        linkSource(db, best.canonical_track_id, entry, 'fuzzy', bestScore, false);
        maybePromotePrimary(db, best, entry, artistId, config);
        stats.mergedFuzzy += 1;
        continue;
      }

      // No confident match -> this entry seeds its own canonical track.
      const albumId = getOrCreateAlbum(
        db,
        artistId,
        entry.album_raw,
        entry.release_date,
        entry.release_category
      );
      const canonicalId = createCanonicalTrack(db, entry, artistId, albumId);
      linkSource(db, canonicalId, entry, 'new', 1.0, true);
      stats.newCanonical += 1;

      // If it was merely *close* to something (below auto-merge threshold,
      // or blocked only by a duration mismatch), flag it for human review
      // instead of silently dropping the signal.
      const reviewCandidate = best || bestIgnoringDuration;
      const reviewScore = best ? bestScore : bestScoreIgnoringDuration;
      if (reviewCandidate && reviewScore >= config.fuzzyReviewThreshold) {
        const [a, b] = [canonicalId, reviewCandidate.canonical_track_id].sort((x, y) => x - y);
        const durationNote =
          !best && reviewCandidate.duration_ms != null && entry.duration_ms != null
            ? `; duration differs by ${Math.abs(reviewCandidate.duration_ms - entry.duration_ms)}ms`
            : '';
        db.prepare(
          `INSERT OR IGNORE INTO possible_duplicates (canonical_track_id_a, canonical_track_id_b, score, reason)
           VALUES (?, ?, ?, ?)`
        ).run(
          a,
          b,
          reviewScore,
          `Fuzzy title similarity ${reviewScore.toFixed(2)} (same artist, version type '${entry.version_type}')${durationNote}`
        );
        stats.flaggedForReview += 1;
      }
    }
  });
  tx();

  return stats;
}

function maybePromotePrimary(db, matchRow, entry, artistId, config) {
  const currentEntry = {
    release_category: matchRow.release_category,
    release_date: matchRow.release_date,
  };
  if (isBetterPrimary(entry, currentEntry, config)) {
    const albumId = getOrCreateAlbum(
      db,
      artistId,
      entry.album_raw,
      entry.release_date,
      entry.release_category
    );
    applyPrimary(db, matchRow.canonical_track_id, entry, artistId, albumId);
  }
}

module.exports = {
  loadConfig,
  diceCoefficient,
  runDedupe,
  getOrCreateArtist,
  getOrCreateAlbum,
  isBetterPrimary,
};
