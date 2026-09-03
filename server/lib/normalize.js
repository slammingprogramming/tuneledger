'use strict';

// ---------------------------------------------------------------------------
// Text normalization helpers used both for display sort-keys and for the
// dedup matching engine (dedupe.js). Keep this module dependency-free so its
// behavior is easy to unit test in isolation.
// ---------------------------------------------------------------------------

/** Collapse whitespace and trim. */
function cleanWhitespace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** Lowercase, strip diacritics, strip punctuation -> stable comparison key. */
function normalizeForKey(s) {
  return cleanWhitespace(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // combining diacritics
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // strip punctuation, keep letters/numbers
    .replace(/\s+/g, ' ')
    .trim();
}

const LEADING_ARTICLES = /^(the|a|an)\s+/i;

/** Sort key for artists/albums: strip leading article, normalize. */
function sortKey(s) {
  const cleaned = cleanWhitespace(s).replace(LEADING_ARTICLES, '');
  return normalizeForKey(cleaned);
}

/** Split a Spotify "Artist Name(s)" field into individual artist names. */
function splitArtists(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/;|,\s*&\s*|\s+&\s+/)
    .map((s) => cleanWhitespace(s))
    .filter(Boolean);
}

// Version-tag vocabulary, ordered by priority when multiple keywords match
// the same annotation text (first match wins).
const VERSION_RULES = [
  { type: 'remaster', re: /\bremaster(ed)?\b/i },
  // Checked before 'instrumental'/'live' since karaoke tracks are commonly
  // labeled "Karaoke Instrumental Lyrics" or similar - a backing track with
  // no vocals is not a substitute for the original recording, so it must
  // not be silently merged with it.
  { type: 'karaoke', re: /\bkaraoke\b/i },
  { type: 'live', re: /\blive\b/i },
  { type: 'acoustic', re: /\bacoustic\b/i },
  { type: 'radio_edit', re: /\bradio\s*edit\b/i },
  { type: 'extended', re: /\bextended\b/i },
  { type: 'remix', re: /\bre-?mix(ed)?\b/i },
  { type: 'demo', re: /\bdemo\b/i },
  { type: 'instrumental', re: /\binstrumental\b/i },
  { type: 'mono', re: /\bmono\b/i },
  { type: 'stereo', re: /\bstereo\b/i },
  { type: 'cover', re: /\bcover\s*(version)?\b/i },
  { type: 'single_version', re: /\bsingle\s*version\b/i },
  { type: 'edit', re: /\bedit\b/i },
  { type: 'alternate', re: /\balternate|alt\.?\s*version|new version\b/i },
];

// Annotations that describe how a file was *sourced* (a YouTube rip label,
// a resolution tag) rather than a musically distinct version of the
// recording. These should not create a separate canonical track from the
// plain title - "Man in the Box (Official Video)" is the same recording as
// "Man in the Box" from the studio album, just labeled by where it came from.
const SOURCE_NOISE_RE = /\b(official\s*(music\s*)?video|official\s*audio|lyric(s)?\s*(video)?|visualizer|4k|hd|hq|full\s*hd|music\s*video)\b/i;

// Separator glyphs different tools use in place of a plain hyphen for
// "Artist - Title" style credits: en-dash, em-dash, bullet, middle dot.
// Seen in the wild on a real karaoke file: "Pink Floyd • Hey You".
const DASH_CHARS = '\\-–—•·';

// Matches "(...)" / "[...]" groups, and a " - annotation" suffix introduced
// by a space-dash-space (Spotify's common way of tagging remasters/live
// versions/remixes, e.g. "Money - Live", "Feel So Close - Radio Edit").
// Requires spaces around the dash so hyphenated words ("Rock-A-Fella") are
// left untouched, and splits on the *first* such marker so titles whose
// annotation itself contains a hyphen (movie titles, etc.) keep the whole
// remainder as one annotation instead of being chopped at the last dash.
const TRAILING_ANNOTATION_RE = new RegExp(`\\s+[${DASH_CHARS}]\\s+(.+)$`);
const BRACKETED_RE = /[\(\[]([^()[\]]+)[\)\]]/g;

/**
 * Split a raw track title into { stem, versionType, versionDetail }.
 * `stem` is the title with trailing/bracketed annotations removed, suitable
 * for matching the "same underlying recording" across releases.
 */
function extractVersionInfo(rawTitle) {
  let title = cleanWhitespace(rawTitle);
  const annotations = [];

  // Pull bracketed/parenthetical annotations off (may be more than one).
  let stripped = title.replace(BRACKETED_RE, (m, inner) => {
    annotations.push(inner);
    return ' ';
  });
  stripped = cleanWhitespace(stripped);

  // Pull a single trailing " - annotation" suffix, but only if it does not
  // consume the whole title (avoids treating "Artist - Title" style single
  // dashes as annotations, and avoids destroying titles that are just
  // hyphenated normally, e.g. "Rock-A-Fella").
  const trailMatch = stripped.match(TRAILING_ANNOTATION_RE);
  if (trailMatch && trailMatch[1] && stripped.length - trailMatch[0].length >= 2) {
    annotations.push(trailMatch[1]);
    stripped = cleanWhitespace(stripped.slice(0, stripped.length - trailMatch[0].length));
  }

  const stem = stripped || title;

  let versionType = 'original';
  let versionDetail = null;
  for (const ann of annotations) {
    for (const rule of VERSION_RULES) {
      if (rule.re.test(ann)) {
        versionType = rule.type;
        versionDetail = cleanWhitespace(ann);
        break;
      }
    }
    if (versionType !== 'original') break;
  }
  // If we stripped annotation text but none matched a known keyword, still
  // record it as "other" so genuinely different edits aren't silently
  // treated as identical to the plain title (e.g. featured-artist remixes
  // credited only by name, "Japanese Version", etc) - UNLESS it's just
  // source/quality noise ("Official Video", "HD"), which describes the file
  // rather than the recording and shouldn't fork off a separate version.
  if (versionType === 'original' && annotations.length) {
    const meaningful = annotations.filter((a) => !SOURCE_NOISE_RE.test(a));
    if (meaningful.length) {
      versionType = 'other';
      versionDetail = cleanWhitespace(meaningful.join(' / '));
    }
  }

  return { stem, versionType, versionDetail };
}

const COMPILATION_RE = /\b(greatest hits|best of|anthology|collection|essentials?|the hits|singles collection)\b/i;
const DELUXE_RE = /\b(deluxe|expanded|anniversary( edition)?|reissue|bonus track|special edition|super deluxe)\b/i;
const SOUNDTRACK_RE = /\b(soundtrack|original motion picture|original score|from the motion picture)\b/i;

/** Heuristic classification of an album's release type from its name. */
function classifyReleaseCategory(albumName, trackStem) {
  const album = cleanWhitespace(albumName);
  if (!album) return 'unknown';
  if (COMPILATION_RE.test(album)) return 'compilation';
  if (SOUNDTRACK_RE.test(album)) return 'soundtrack';
  if (DELUXE_RE.test(album)) return 'deluxe';
  if (trackStem && normalizeForKey(album) === normalizeForKey(trackStem)) return 'single';
  return 'album';
}

module.exports = {
  cleanWhitespace,
  normalizeForKey,
  sortKey,
  splitArtists,
  extractVersionInfo,
  classifyReleaseCategory,
  DASH_CHARS,
};
