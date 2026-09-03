'use strict';

const { cleanWhitespace } = require('./normalize');

// music-metadata v11 is ESM-only; this codebase is CommonJS, so it's loaded
// via a cached dynamic import instead of require().
let mmPromise = null;
function loadMusicMetadata() {
  if (!mmPromise) mmPromise = import('music-metadata');
  return mmPromise;
}

const CURRENT_YEAR = new Date().getFullYear();

/** Reject obviously-corrupt year values (seen in the wild: ASF/WMA files with garbage year tags). */
function plausibleYear(y) {
  return Number.isInteger(y) && y >= 1860 && y <= CURRENT_YEAR + 1;
}

/**
 * Some rippers/taggers bake the artist into the title field itself
 * ("What'd I Say - Ray Charles" with a *separate*, correct artist tag of
 * "Ray Charles"). Strip that redundant suffix so the title used for
 * matching/display is just the song title.
 */
function stripEchoedArtist(title, artist) {
  if (!title || !artist) return title;
  const suffix = ` - ${artist}`;
  if (title.toLowerCase().endsWith(suffix.toLowerCase())) {
    return cleanWhitespace(title.slice(0, title.length - suffix.length));
  }
  return title;
}

/**
 * Read embedded tags from an audio or video file. Never throws - a file
 * with no/corrupt tags just yields hasUsableTags: false so callers fall
 * through to the filename-guess stage.
 */
async function readTags(filePath) {
  try {
    const mm = await loadMusicMetadata();
    const meta = await mm.parseFile(filePath, { skipCovers: true, duration: true });
    const c = meta.common;
    const rawArtist = cleanWhitespace(c.artist || (c.artists && c.artists[0]) || '');
    const rawTitle = cleanWhitespace(c.title || '');
    const title = stripEchoedArtist(rawTitle, rawArtist);
    const year = plausibleYear(c.year) ? c.year : null;

    return {
      hasUsableTags: !!(rawArtist && title),
      artist: rawArtist || null,
      title: title || null,
      album: cleanWhitespace(c.album || '') || null,
      albumArtist: cleanWhitespace(c.albumartist || '') || null,
      trackNumber: (c.track && c.track.no) || null,
      discNumber: (c.disk && c.disk.no) || null,
      year,
      releaseDate: year ? String(year) : null,
      genres: (c.genre || []).join(', ') || null,
      recordLabel: (c.label || []).join(', ') || null,
      durationMs: meta.format.duration ? Math.round(meta.format.duration * 1000) : null,
      container: meta.format.container || null,
      codec: meta.format.codec || null,
    };
  } catch (err) {
    return {
      hasUsableTags: false,
      artist: null,
      title: null,
      album: null,
      albumArtist: null,
      trackNumber: null,
      discNumber: null,
      year: null,
      releaseDate: null,
      genres: null,
      recordLabel: null,
      durationMs: null,
      container: null,
      codec: null,
      readError: err.message,
    };
  }
}

module.exports = { readTags, stripEchoedArtist, plausibleYear };
