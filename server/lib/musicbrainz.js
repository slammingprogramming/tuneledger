'use strict';

// Some networks (observed in sandboxed/containerized environments) have a
// broken IPv6 path that fails the TLS handshake while IPv4 works fine.
// Node's fetch/DNS resolution tries IPv6 first by default, which makes every
// request to musicbrainz.org intermittently fail with ECONNRESET for no
// application-level reason. Preferring IPv4 resolution is a safe global
// default for this process either way.
require('dns').setDefaultResultOrder('ipv4first');

// Thin client for the MusicBrainz recording search web service.
//
// MusicBrainz's usage policy for the free web service requires (a) a
// descriptive User-Agent identifying the application + a contact method, and
// (b) no more than ~1 request/second from a single client. Both are enforced
// here rather than left to callers, so every call site automatically stays
// compliant regardless of how many files are being scanned.
//
// The client is exposed as a factory (createMusicBrainzClient) rather than a
// bare set of functions so tests can construct a fake implementation of the
// same shape instead of hitting the real network.

const DEFAULT_BASE_URL = 'https://musicbrainz.org/ws/2';
const DEFAULT_USER_AGENT = 'TuneLedger/1.1 (set MUSICBRAINZ_CONTACT env var or config/musicbrainz.json)';
const MIN_INTERVAL_MS = 1100; // MusicBrainz asks for <=1 req/sec; pad slightly.

function luceneEscape(s) {
  // Escape Lucene special characters MusicBrainz's search parser understands.
  return String(s).replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1');
}

function buildQuery({ artist, title, album }) {
  const parts = [];
  if (title) parts.push(`recording:"${luceneEscape(title)}"`);
  if (artist) parts.push(`artist:"${luceneEscape(artist)}"`);
  if (album) parts.push(`release:"${luceneEscape(album)}"`);
  return parts.join(' AND ');
}

/** How close two durations are, as a 0..1 score (1 = identical, 0 = >=15s apart). */
function durationCloseness(a, b) {
  if (a == null || b == null) return 0.5; // neutral - can't corroborate either way
  const diff = Math.abs(a - b);
  return Math.max(0, 1 - diff / 15000);
}

function pickAlbum(recording) {
  const releases = recording.releases || [];
  if (!releases.length) return { name: null, date: recording['first-release-date'] || null, category: 'unknown', trackNumber: null, discNumber: null };
  // Prefer an "Official" studio-album-shaped release over compilations/singles when several are attached to the same recording.
  const scored = releases.map((r) => {
    const secondary = (r['release-group'] && r['release-group']['secondary-types']) || [];
    const primary = (r['release-group'] && r['release-group']['primary-type']) || null;
    let category = 'album';
    if (secondary.includes('Compilation')) category = 'compilation';
    else if (secondary.includes('Live')) category = 'live';
    else if (primary === 'Single') category = 'single';
    else if (secondary.includes('Soundtrack')) category = 'soundtrack';
    const weight = category === 'album' ? 0 : category === 'single' ? 3 : category === 'live' ? 2 : 2.5;
    const media = (r.media && r.media[0]) || {};
    const track = (media.track && media.track[0]) || {};
    return {
      name: r.title,
      date: r.date || null,
      category,
      weight,
      trackNumber: track.number ? parseInt(track.number, 10) : null,
      discNumber: media.position || null,
    };
  });
  scored.sort((a, b) => a.weight - b.weight || (a.date || '9999').localeCompare(b.date || '9999'));
  return scored[0];
}

function toCandidate(recording, hint) {
  const artistCredit = (recording['artist-credit'] || []).map((c) => c.name).join('');
  const mbScore = typeof recording.score === 'number' ? recording.score : parseInt(recording.score, 10) || 0;
  const durationScore = durationCloseness(hint.durationMs, recording.length);
  // Weighted blend: MusicBrainz's own text-relevance score matters most, but
  // duration carries enough weight that a wildly different length (>15s)
  // can pull even a "100" text match below the default confidence
  // threshold - a compilation edit / radio cut / wrong match can share an
  // identical title. A *small* gap barely moves this, since MB frequently
  // has a slightly different length on file for the same recording.
  const confidence = Math.min(1, (mbScore / 100) * 0.6 + durationScore * 0.4);
  const albumInfo = pickAlbum(recording);
  return {
    musicbrainzRecordingId: recording.id,
    artist: artistCredit || hint.artist,
    title: recording.title,
    album: albumInfo.name,
    releaseDate: albumInfo.date,
    releaseCategoryHint: albumInfo.category,
    trackNumber: albumInfo.trackNumber,
    discNumber: albumInfo.discNumber,
    durationMs: recording.length || null,
    mbScore,
    confidence,
  };
}

function createMusicBrainzClient({
  baseUrl = DEFAULT_BASE_URL,
  userAgent = DEFAULT_USER_AGENT,
  minConfidence = 0.75,
  fetchImpl = fetch,
} = {}) {
  let lastCallAt = 0;

  async function throttle() {
    const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
  }

  /**
   * Search for the best-matching recording. Returns the best candidate
   * (regardless of confidence) plus whether it clears `minConfidence`, so
   * callers can decide what to do with a low-confidence hit rather than
   * just getting `null`.
   */
  async function searchRecording({ artist, title, album, durationMs }, { retries = 1 } = {}) {
    const query = buildQuery({ artist, title, album });
    if (!query) return { candidate: null, confident: false, error: 'empty query' };

    const url = `${baseUrl}/recording/?query=${encodeURIComponent(query)}&fmt=json&limit=5`;
    await throttle();
    let res;
    try {
      res = await fetchImpl(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' } });
    } catch (err) {
      return { candidate: null, confident: false, error: `network error: ${err.message}` };
    }
    if (res.status === 503 && retries > 0) {
      await new Promise((r) => setTimeout(r, 2000));
      return searchRecording({ artist, title, album, durationMs }, { retries: retries - 1 });
    }
    if (!res.ok) {
      return { candidate: null, confident: false, error: `MusicBrainz HTTP ${res.status}` };
    }
    let json;
    try {
      json = await res.json();
    } catch (err) {
      return { candidate: null, confident: false, error: `bad JSON response: ${err.message}` };
    }
    const recordings = json.recordings || [];
    if (!recordings.length) return { candidate: null, confident: false, error: null };

    const candidates = recordings.map((r) => toCandidate(r, { artist, durationMs }));
    candidates.sort((a, b) => b.confidence - a.confidence);
    const best = candidates[0];
    return { candidate: best, confident: best.confidence >= minConfidence, error: null };
  }

  return { searchRecording };
}

module.exports = { createMusicBrainzClient, buildQuery, luceneEscape, DEFAULT_USER_AGENT };
