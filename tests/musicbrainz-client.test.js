'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMusicBrainzClient, buildQuery, luceneEscape } = require('../server/lib/musicbrainz');

function fakeFetch(handler) {
  return async (url, opts) => handler(url, opts);
}

function jsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body) };
}

test('musicbrainz: buildQuery combines artist/title/album with Lucene AND', () => {
  const q = buildQuery({ artist: 'Al Green', title: "Let's Stay Together" });
  assert.equal(q, `recording:"Let's Stay Together" AND artist:"Al Green"`);
});

test('musicbrainz: luceneEscape escapes special characters', () => {
  assert.equal(luceneEscape('AC/DC'), 'AC\\/DC');
});

test('musicbrainz: a high-score, duration-matching candidate is confident', async () => {
  const client = createMusicBrainzClient({
    userAgent: 'test/0.1',
    fetchImpl: fakeFetch(() =>
      jsonResponse(200, {
        recordings: [
          {
            id: 'abc-123',
            title: 'Money',
            score: 100,
            length: 382000,
            'artist-credit': [{ name: 'Pink Floyd' }],
            releases: [{ title: 'The Dark Side of the Moon', date: '1973-03-01', 'release-group': { primary_type: 'Album' } }],
          },
        ],
      })
    ),
  });
  const result = await client.searchRecording({ artist: 'Pink Floyd', title: 'Money', durationMs: 382000 });
  assert.equal(result.confident, true);
  assert.equal(result.candidate.musicbrainzRecordingId, 'abc-123');
});

test('musicbrainz: a wildly different duration pulls confidence down even with a perfect text score', async () => {
  const client = createMusicBrainzClient({
    userAgent: 'test/0.1',
    fetchImpl: fakeFetch(() =>
      jsonResponse(200, {
        recordings: [
          {
            id: 'abc-123',
            title: 'Money',
            score: 100,
            length: 382000,
            'artist-credit': [{ name: 'Pink Floyd' }],
            releases: [],
          },
        ],
      })
    ),
  });
  // Local file is 60s different from MB's candidate - likely a different edit/mix.
  const result = await client.searchRecording({ artist: 'Pink Floyd', title: 'Money', durationMs: 322000 });
  assert.equal(result.confident, false);
});

test('musicbrainz: no results -> not confident, no error', async () => {
  const client = createMusicBrainzClient({
    userAgent: 'test/0.1',
    fetchImpl: fakeFetch(() => jsonResponse(200, { recordings: [] })),
  });
  const result = await client.searchRecording({ artist: 'Nobody', title: 'Nothing' });
  assert.equal(result.confident, false);
  assert.equal(result.candidate, null);
  assert.equal(result.error, null);
});

test('musicbrainz: network error degrades gracefully instead of throwing', async () => {
  const client = createMusicBrainzClient({
    userAgent: 'test/0.1',
    fetchImpl: fakeFetch(() => {
      throw new Error('simulated network failure');
    }),
  });
  const result = await client.searchRecording({ artist: 'X', title: 'Y' });
  assert.equal(result.confident, false);
  assert.match(result.error, /network error/);
});

test('musicbrainz: a 503 is retried once before giving up', async () => {
  let calls = 0;
  const client = createMusicBrainzClient({
    userAgent: 'test/0.1',
    fetchImpl: fakeFetch(() => {
      calls += 1;
      if (calls === 1) return jsonResponse(503, {});
      return jsonResponse(200, { recordings: [] });
    }),
  });
  const result = await client.searchRecording({ artist: 'X', title: 'Y' });
  assert.equal(calls, 2);
  assert.equal(result.error, null);
});

test('musicbrainz: prefers a studio album release over a compilation when both are attached', async () => {
  const client = createMusicBrainzClient({
    userAgent: 'test/0.1',
    fetchImpl: fakeFetch(() =>
      jsonResponse(200, {
        recordings: [
          {
            id: 'abc-123',
            title: 'Money',
            score: 100,
            length: 382000,
            'artist-credit': [{ name: 'Pink Floyd' }],
            releases: [
              {
                title: 'Greatest Hits',
                date: '1990-01-01',
                'release-group': { 'secondary-types': ['Compilation'] },
                media: [{ position: 1, track: [{ number: '3' }] }],
              },
              {
                title: 'The Dark Side of the Moon',
                date: '1973-03-01',
                'release-group': { primary_type: 'Album' },
                media: [{ position: 1, track: [{ number: '6' }] }],
              },
            ],
          },
        ],
      })
    ),
  });
  const result = await client.searchRecording({ artist: 'Pink Floyd', title: 'Money', durationMs: 382000 });
  assert.equal(result.candidate.album, 'The Dark Side of the Moon');
  assert.equal(result.candidate.releaseCategoryHint, 'album');
});
