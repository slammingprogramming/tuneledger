'use strict';

const { readTags } = require('./tags');
const { guessFromFilename, guessSecondaryCandidates, stripTrailingNoise } = require('./filename-guess');
const { guessFromPath } = require('./folder-guess');
const { extractVersionInfo, cleanWhitespace } = require('./normalize');

/**
 * Identify a single audio/video file's song identity. Three independent
 * signal sources are gathered up front, then merged (real tags always win
 * over inferred data, field by field):
 *
 *   - Embedded tags (artist/title/album/etc, via music-metadata).
 *   - Folder structure: `Artist/Album/File.ext` is an extremely common
 *     library layout (this app was tested against a real Windows Media
 *     Player library export using exactly this convention) and fills gaps
 *     when a file's own tags are incomplete - e.g. an artist tag present
 *     but the title tag missing, which shows up in real WMA files.
 *   - The filename, parsed for `Artist - Title` / `NN Title - Artist`.
 *
 * Priority order for the merged result:
 *   1. Full tags (artist + title both present), confirmed/canonicalized
 *      against MusicBrainz where possible ('tags_mb'), else trusted alone
 *      ('tags_only').
 *   2. Partial tags assisted by folder/filename to fill the gap, confirmed
 *      against MusicBrainz where possible ('assisted_mb'), else trusted at
 *      a lower confidence than full tags ('assisted_only').
 *   3. No usable tags at all - filename/folder alone, confirmed against
 *      MusicBrainz ('filename_mb') or trusted unverified and low-confidence
 *      ('filename_only').
 *   4. Weaker filename splits (no-space dashes, "Title by Artist",
 *      underscore-wrapped titles, karaoke "in the style of X" credits) -
 *      only ever accepted when MusicBrainz actively confirms one
 *      ('filename_mb'), never trusted unverified.
 *   5. Title-only MusicBrainz search as an absolute last resort when
 *      there's a title but no artist from any source - only accepts a very
 *      high-confidence, duration-corroborated hit ('title_only_mb').
 *   6. Unresolved - caller should route the file to manual review, either
 *      it genuinely can't be identified or it isn't music at all.
 *
 * `rootDir` (the directory being scanned, or a WPL's own directory) is used
 * for the folder-structure signal; identification still works without it,
 * just without that assist.
 *
 * Returns `{ ok: true, ...fields }` or `{ ok: false, reason }`. Never
 * throws - I/O and network errors degrade to the next stage rather than
 * failing the whole file.
 */
async function identifyFile(filePath, { mediaKind, mbClient, useMusicBrainz = true, rootDir } = {}) {
  const tags = await readTags(filePath);
  const folder = rootDir ? guessFromPath(filePath, rootDir) : { artist: null, album: null };
  const filename = guessFromFilename(filePath);

  const tagsComplete = !!(tags.artist && tags.title);

  if (tagsComplete) {
    const mbResult = useMusicBrainz && mbClient
      ? await mbClient.searchRecording({ artist: tags.artist, title: tags.title, album: tags.album, durationMs: tags.durationMs })
      : null;
    if (mbResult && mbResult.confident) {
      return finalize({
        artist: mbResult.candidate.artist || tags.artist,
        title: mbResult.candidate.title || tags.title,
        album: mbResult.candidate.album || tags.album,
        trackNumber: mbResult.candidate.trackNumber ?? tags.trackNumber,
        discNumber: mbResult.candidate.discNumber ?? tags.discNumber,
        durationMs: tags.durationMs ?? mbResult.candidate.durationMs,
        releaseDate: mbResult.candidate.releaseDate || tags.releaseDate,
        genres: tags.genres,
        recordLabel: tags.recordLabel,
        musicbrainzRecordingId: mbResult.candidate.musicbrainzRecordingId,
        identifyMethod: 'tags_mb',
        identifyConfidence: mbResult.candidate.confidence,
        mediaKind,
        filePath,
      });
    }
    return finalize({
      artist: tags.artist,
      title: tags.title,
      album: tags.album,
      trackNumber: tags.trackNumber,
      discNumber: tags.discNumber,
      durationMs: tags.durationMs,
      releaseDate: tags.releaseDate,
      genres: tags.genres,
      recordLabel: tags.recordLabel,
      musicbrainzRecordingId: null,
      identifyMethod: 'tags_only',
      identifyConfidence: 0.85,
      mediaKind,
      filePath,
    });
  }

  // Tags are missing or incomplete - merge in folder/filename to fill gaps.
  // Real tag data always wins over inferred data, field by field.
  const mergedArtist = tags.artist || folder.artist || filename.artist;
  const mergedTitle = tags.title || filename.title;
  const mergedAlbum = tags.album || folder.album;
  const usedAnyRealTag = !!(tags.artist || tags.title);

  if (mergedArtist && mergedTitle) {
    const mbResult = useMusicBrainz && mbClient
      ? await mbClient.searchRecording({ artist: mergedArtist, title: mergedTitle, album: mergedAlbum, durationMs: tags.durationMs })
      : null;
    const assistedMethod = usedAnyRealTag ? 'assisted' : 'filename';
    if (mbResult && mbResult.confident) {
      return finalize({
        artist: mbResult.candidate.artist || mergedArtist,
        title: mbResult.candidate.title || mergedTitle,
        album: mbResult.candidate.album || mergedAlbum,
        trackNumber: mbResult.candidate.trackNumber ?? tags.trackNumber ?? filename.trackNumber,
        discNumber: mbResult.candidate.discNumber ?? tags.discNumber,
        durationMs: tags.durationMs ?? mbResult.candidate.durationMs,
        releaseDate: mbResult.candidate.releaseDate || tags.releaseDate,
        genres: tags.genres,
        recordLabel: tags.recordLabel,
        musicbrainzRecordingId: mbResult.candidate.musicbrainzRecordingId,
        identifyMethod: `${assistedMethod}_mb`,
        identifyConfidence: mbResult.candidate.confidence,
        mediaKind,
        filePath,
      });
    }
    // Unverified: still meaningfully more trustworthy when at least one
    // real tag contributed (assisted) than when everything was guessed.
    return finalize({
      artist: mergedArtist,
      title: mergedTitle,
      album: mergedAlbum,
      trackNumber: tags.trackNumber ?? filename.trackNumber,
      discNumber: tags.discNumber,
      durationMs: tags.durationMs,
      releaseDate: tags.releaseDate,
      genres: tags.genres,
      recordLabel: tags.recordLabel,
      musicbrainzRecordingId: null,
      identifyMethod: `${assistedMethod}_only`,
      identifyConfidence: usedAnyRealTag ? 0.65 : 0.5,
      mediaKind,
      filePath,
      versionType: tags.title ? undefined : filename.versionType,
      versionDetail: tags.title ? undefined : filename.versionDetail,
    });
  }

  // Still no artist. Before giving up on attribution entirely, try weaker,
  // structurally-ambiguous filename splits (no-space dashes, "Title by
  // Artist", underscore-wrapped titles, karaoke "in the style of X"
  // credits - see filename-guess.js). Each is just a hypothesis, so unlike
  // the primary filename guess, these are ONLY ever accepted when
  // MusicBrainz actively confirms one - never trusted unverified.
  if (useMusicBrainz && mbClient) {
    for (const candidate of guessSecondaryCandidates(filePath)) {
      const mbResult = await mbClient.searchRecording({
        artist: candidate.artist,
        title: candidate.title,
        durationMs: tags.durationMs,
      });
      if (mbResult.confident) {
        return finalize({
          artist: mbResult.candidate.artist || candidate.artist,
          title: mbResult.candidate.title || candidate.title,
          album: mbResult.candidate.album,
          trackNumber: mbResult.candidate.trackNumber ?? filename.trackNumber,
          discNumber: mbResult.candidate.discNumber,
          durationMs: tags.durationMs ?? mbResult.candidate.durationMs,
          releaseDate: mbResult.candidate.releaseDate,
          genres: tags.genres,
          recordLabel: tags.recordLabel,
          musicbrainzRecordingId: mbResult.candidate.musicbrainzRecordingId,
          identifyMethod: 'filename_mb',
          identifyConfidence: mbResult.candidate.confidence,
          mediaKind,
          filePath,
        });
      }
    }
  }

  // Absolute last resort: we have *a* title (from a tag or the filename)
  // but no artist from any source. An artist-less MusicBrainz search is
  // much lower-precision (matching against the whole database instead of
  // one artist's catalog), so this only accepts a very high-confidence,
  // duration-corroborated hit - never used to merely *guess* an artist.
  // The query text has trailing noise words (bare "lyrics", "karaoke", not
  // in a bracket/dash annotation so extractVersionInfo wouldn't catch them)
  // stripped, since they otherwise pollute an already-imprecise search.
  if (mergedTitle && useMusicBrainz && mbClient) {
    const mbResult = await mbClient.searchRecording({ title: stripTrailingNoise(mergedTitle), durationMs: tags.durationMs });
    if (mbResult.candidate && mbResult.candidate.confidence >= 0.92 && tags.durationMs != null) {
      return finalize({
        artist: mbResult.candidate.artist,
        title: mbResult.candidate.title || mergedTitle,
        album: mbResult.candidate.album || mergedAlbum,
        trackNumber: mbResult.candidate.trackNumber,
        discNumber: mbResult.candidate.discNumber,
        durationMs: tags.durationMs ?? mbResult.candidate.durationMs,
        releaseDate: mbResult.candidate.releaseDate,
        genres: tags.genres,
        recordLabel: tags.recordLabel,
        musicbrainzRecordingId: mbResult.candidate.musicbrainzRecordingId,
        identifyMethod: 'title_only_mb',
        identifyConfidence: mbResult.candidate.confidence,
        mediaKind,
        filePath,
      });
    }
  }

  // No artist from tags, folder, or filename, and MusicBrainz didn't
  // confirm one either - too weak to attribute confidently.
  return { ok: false, reason: 'no usable tags, and folder/filename gave no discernible artist to confirm a match against' };
}

/** Ensures every result carries a version-tag-stripped title + classification, however it got here. */
function finalize(fields) {
  let { title, versionType, versionDetail } = fields;
  title = cleanWhitespace(title);
  if (versionType === undefined) {
    const v = extractVersionInfo(title);
    title = v.stem;
    versionType = v.versionType;
    versionDetail = v.versionDetail;
  }
  return { ok: true, ...fields, title, versionType, versionDetail };
}

module.exports = { identifyFile };
