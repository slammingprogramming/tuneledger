'use strict';

const path = require('path');
const { cleanWhitespace, extractVersionInfo, DASH_CHARS } = require('./normalize');

const GENERIC_PLACEHOLDERS = new Set(['track', 'audio', 'video', 'untitled', 'unknown', 'new track']);
// Unlabeled-rip placeholders like "Track 2", "Track02", "Track_03" - a very
// common artifact of ripping software when no metadata/CDDB match was
// found. Real song titles essentially never take this exact shape.
const GENERIC_TRACK_NUM_RE = /^track[\s._-]*\d+$/i;

function isPlausiblePart(s) {
  if (!s) return false;
  const trimmed = cleanWhitespace(s);
  if (trimmed.length < 2) return false;
  if (/^\d+$/.test(trimmed)) return false; // just a number, e.g. an id/track digits
  if (GENERIC_PLACEHOLDERS.has(trimmed.toLowerCase())) return false;
  if (GENERIC_TRACK_NUM_RE.test(trimmed)) return false;
  return true;
}

// Trailing descriptor words that sometimes ride along with no bracket/dash
// to set them off ("shinedown sounds of madness lyrics", "... karaoke
// lyri" - truncated by an upload tool's filename length limit). Stripped
// only when building a MusicBrainz *query* string - never silently baked
// into a stored title.
const TRAILING_NOISE_RE = new RegExp(
  '\\s*\\b(karaoke|lyrics?|lyri|instrumental|official\\s*(music\\s*)?video|official\\s*audio|hd|hq)\\b\\.?\\s*$',
  'i'
);
function stripTrailingNoise(s) {
  if (!s) return s;
  let prev;
  let cur = cleanWhitespace(s);
  do {
    prev = cur;
    cur = cleanWhitespace(cur.replace(TRAILING_NOISE_RE, ''));
  } while (cur !== prev && cur.length > 0);
  return cur || s;
}

const LEADING_TRACK_NUM_RE = /^(\d{1,3})[\s._-]+(.+)$/;
const DASH_SPLIT_RE = new RegExp(`^(.+?)\\s+[${DASH_CHARS}]\\s+(.+)$`);

/**
 * Best-effort guess of {artist, title, trackNumber} from a bare filename,
 * used only when embedded tags don't give us anything usable. Two
 * conventions show up in real libraries and both appear in this project's
 * test fixtures:
 *
 *   "12 What'd I Say - Ray Charles.mp3"           (track-numbered rip: "Title - Artist")
 *   "Alice In Chains - Man in the Box (...).mp4"   (YouTube-style download: "Artist - Title")
 *
 * These are structurally ambiguous from the filename alone (a lone
 * "X - Y" could be either convention) - a leading track-number prefix is
 * used as the signal for which convention applies, since track-numbered
 * filenames are characteristic of ripped album filenames, and un-numbered
 * "Artist - Title" is the near-universal convention for single downloaded
 * videos/tracks. Confidence should always be treated as low relative to
 * tags or a MusicBrainz-confirmed match - see identify.js.
 */
function guessFromFilename(filePath) {
  const base = cleanWhitespace(path.basename(filePath, path.extname(filePath)));

  let trackNumber = null;
  let rest = base;
  const numMatch = base.match(LEADING_TRACK_NUM_RE);
  if (numMatch) {
    trackNumber = parseInt(numMatch[1], 10);
    rest = cleanWhitespace(numMatch[2]);
  }

  let artist = null;
  let title = rest;
  const dashMatch = rest.match(DASH_SPLIT_RE);
  if (dashMatch) {
    if (trackNumber != null) {
      // "NN Title - Artist"
      title = dashMatch[1];
      artist = dashMatch[2];
    } else {
      // "Artist - Title"
      artist = dashMatch[1];
      title = dashMatch[2];
    }
  }

  const { stem, versionType, versionDetail } = extractVersionInfo(title);
  title = stem;

  const titleOk = isPlausiblePart(title);
  const artistOk = isPlausiblePart(artist);

  return {
    trackNumber,
    artist: artistOk ? artist : null,
    title: titleOk ? title : null,
    versionType,
    versionDetail,
    // Enough to attempt an artist+title search.
    isPlausible: titleOk,
    hasArtist: artistOk,
  };
}

const STYLE_OF_RE = /\bin the style of\s+(.+)$/i;
const BY_RE = /^(.+?)\s+by\s+(.+)$/i;
const ASYMMETRIC_DASH_A_RE = new RegExp(`^(.+?)[${DASH_CHARS}]\\s+(.+)$`); // "Artist- Title"
const ASYMMETRIC_DASH_B_RE = new RegExp(`^(.+?)\\s+[${DASH_CHARS}](.+)$`); // "Artist -Title"
const TIGHT_DASH_RE = new RegExp(`^([^${DASH_CHARS}]+)[${DASH_CHARS}]([^${DASH_CHARS}]+)$`); // "Artist-Title", no spaces
const UNDERSCORE_WRAP_RE = /^(.+?)_(.+?)_/; // "Artist _Title_ Extra"
const UNDERSCORE_SPLIT_RE = /^([^_]+)_([^_]+)$/; // "Movie_Song", exactly one underscore

/**
 * Weaker, structurally-ambiguous artist/title hypotheses for filenames that
 * don't fit the primary "Artist - Title" / "NN Title - Artist" conventions
 * - real examples that motivated each pattern, all from the same library:
 *
 *   "Apollo 440-Stop The Rock.mp3"                    no-space dash (order unknown -> both tried)
 *   "Billy Ocean- Loverboy (...).mp3"                  asymmetric dash spacing
 *   "Breakdown by Seether (lyrics).mp3"                "Title by Artist"
 *   "Pop Evil _Boss's Daughter_ Single.mp3"            underscore-wrapped title
 *   "Tarzan_YabbaDabbaDo.wma"                          lone underscore as separator
 *   "...in the Style of Garth Brooks karaoke lyri.mp4" karaoke-style attribution
 *
 * These are deliberately NOT used to accept an identification on their own
 * (unlike the primary guess) - each candidate here must still be confirmed
 * against MusicBrainz by the caller (see identify.js) before being trusted,
 * since the split point itself is a guess, not a reliable convention.
 */
function guessSecondaryCandidates(filePath) {
  const base = cleanWhitespace(path.basename(filePath, path.extname(filePath)));
  let rest = base;
  const numMatch = base.match(LEADING_TRACK_NUM_RE);
  if (numMatch) rest = cleanWhitespace(numMatch[2]);

  const { stem, versionType, versionDetail } = extractVersionInfo(rest);

  const candidates = [];
  const seen = new Set();
  const push = (rawArtist, rawTitle, source) => {
    const artist = cleanWhitespace(String(rawArtist || '').replace(/_/g, ' '));
    const title = cleanWhitespace(String(rawTitle || '').replace(/_/g, ' '));
    if (!isPlausiblePart(artist) || !isPlausiblePart(title)) return;
    const key = `${artist.toLowerCase()} ${title.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ artist, title, versionType, versionDetail, source });
  };

  const styleMatch = stem.match(STYLE_OF_RE);
  if (styleMatch) {
    push(stripTrailingNoise(styleMatch[1]), stem.slice(0, styleMatch.index), 'style-of');
  }

  const byMatch = stem.match(BY_RE);
  if (byMatch) push(byMatch[2], byMatch[1], 'by');

  const asymA = stem.match(ASYMMETRIC_DASH_A_RE);
  if (asymA) push(asymA[1], asymA[2], 'asymmetric-dash');
  const asymB = stem.match(ASYMMETRIC_DASH_B_RE);
  if (asymB) push(asymB[1], asymB[2], 'asymmetric-dash');

  const tight = stem.match(TIGHT_DASH_RE);
  if (tight) {
    push(tight[1], tight[2], 'tight-dash');
    push(tight[2], tight[1], 'tight-dash-reversed');
  }

  const wrap = stem.match(UNDERSCORE_WRAP_RE);
  if (wrap) push(wrap[1], wrap[2], 'underscore-wrap');

  const usplit = stem.match(UNDERSCORE_SPLIT_RE);
  if (usplit) {
    push(usplit[1], usplit[2], 'underscore-split');
    push(usplit[2], usplit[1], 'underscore-split-reversed');
  }

  return candidates;
}

module.exports = { guessFromFilename, guessSecondaryCandidates, isPlausiblePart, stripTrailingNoise };
