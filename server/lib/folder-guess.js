'use strict';

const path = require('path');
const { cleanWhitespace } = require('./normalize');

const GENERIC_FOLDER_NAMES = new Set([
  'music', 'downloads', 'download', 'karaoke', 'videos', 'video', 'audio',
  'unclassified', 'unknown', 'misc', 'various', 'various artists', 'new folder',
  // Windows Media Player itself creates these exact folder names when it
  // rips/imports a CD it can't identify against its metadata service -
  // seen verbatim in real playlist exports this app was tested against.
  'unknown artist', 'unknown album',
]);

/**
 * Many real libraries (this app was tested against a real Windows Media
 * Player library export) are organized `Artist/Album/Track.ext` - a folder
 * layout carries real signal, especially useful when a file's own tags are
 * incomplete (e.g. an artist tag present but the title tag missing, or
 * vice versa - both show up in the wild; WMP-era WMA encoders were
 * inconsistent about writing every field).
 *
 * Deliberately conservative: only fires when there are *two* directory
 * levels between the scan root and the file (Artist/Album/File), since a
 * single-level folder is far more likely to be a generic category
 * ("Karaoke", "Downloads") than an artist name, and guessing wrong would
 * misattribute a track to a fake "artist" in the queue.
 */
function guessFromPath(filePath, rootDir) {
  const rel = path.relative(rootDir, filePath);
  const segments = rel.split(path.sep).filter(Boolean);
  // segments = [...dirs, filename] - need at least 2 dirs + filename = length >= 3
  if (segments.length < 3) return { artist: null, album: null };

  const album = cleanWhitespace(segments[segments.length - 2]);
  const artist = cleanWhitespace(segments[segments.length - 3]);

  const artistOk = artist && artist.length >= 2 && !GENERIC_FOLDER_NAMES.has(artist.toLowerCase());
  const albumOk = album && album.length >= 1 && !GENERIC_FOLDER_NAMES.has(album.toLowerCase());

  return {
    artist: artistOk ? artist : null,
    album: albumOk ? album : null,
  };
}

module.exports = { guessFromPath };
