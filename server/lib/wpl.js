'use strict';

const fs = require('fs/promises');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const { identifyFile } = require('./identify');
const { classifyMediaKind, moveToReview, insertIdentifiedFile, DEFAULT_REVIEW_FOLDER_NAME } = require('./library-scanner');
const { runDedupe } = require('./dedupe');

function toArray(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

/**
 * Parse a .wpl (Windows Media Player playlist) file. WPL comes in two
 * genuinely different shapes that look similar but need different handling:
 *
 *  - A *static* playlist lists actual files: <body><seq><media src="..."/></seq></body>
 *  - A "smart"/auto playlist (e.g. "recently added, unrated") has no file
 *    list at all - just a saved query (<smartPlaylist><querySet>...). There
 *    is nothing to import; this is not an error, just an empty result the
 *    caller should report clearly rather than silently returning nothing.
 */
function parseWpl(xmlText) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const doc = parser.parse(xmlText);
  const smil = doc.smil;
  if (!smil) throw new Error('Not a recognizable WPL file (missing <smil> root element)');

  const title = smil.head && smil.head.title;
  const seq = smil.body && smil.body.seq;
  const isSmart = !!(seq && seq.smartPlaylist);
  const mediaEntries = seq ? toArray(seq.media) : [];

  return {
    title: title || null,
    isSmart,
    smartPlaylistDescription: isSmart ? describeSmartPlaylist(seq.smartPlaylist) : null,
    mediaRefs: mediaEntries.map((m) => m['@_src']).filter(Boolean),
  };
}

/**
 * Best-effort human-readable summary of a smart playlist's rule, for
 * reporting purposes only. A playlist can have multiple <querySet>
 * elements (WMP's UI equivalent of "match ANY of these rule groups" - an
 * OR across groups, AND within a group's fragments), which fast-xml-parser
 * represents as an array instead of a single object once there's more than
 * one, so this has to handle both shapes.
 */
function describeSmartPlaylist(sp) {
  try {
    const querySets = toArray(sp.querySet);
    if (!querySets.length) return 'dynamic query-based playlist';
    const groups = querySets.map((qs) => {
      const filter = qs.sourceFilter;
      if (!filter) return null;
      const fragments = toArray(filter.fragment);
      const parts = fragments.map((f) => {
        const args = toArray(f.argument);
        const condition = args.find((a) => a['@_name'] === 'condition');
        const value = args.find((a) => a['@_name'] === 'value');
        return `${f['@_name']} ${condition ? condition['#text'] : ''} ${value ? value['#text'] : ''}`.trim();
      });
      return parts.join('; ') || null;
    }).filter(Boolean);
    return groups.join(' OR ') || 'dynamic query-based playlist';
  } catch {
    return 'dynamic query-based playlist';
  }
}

/**
 * WPL files are a Windows Media Player format and always use Windows-style
 * backslash-separated paths, but this app may run on Linux (e.g. in
 * Docker), where `\` isn't a path separator and relative-path resolution
 * would otherwise silently fail to find anything. Absolute Windows paths
 * (drive letters) can't be meaningfully resolved on a different OS/
 * filesystem regardless - that's an inherent limitation, not something to
 * paper over.
 */
function toPlatformRelativePath(ref) {
  if (process.platform === 'win32') return ref;
  return ref.replace(/\\/g, '/');
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Import a .wpl file: resolves each referenced media path (relative paths
 * are resolved against the playlist's own directory, matching how Windows
 * Media Player itself interprets them), then runs every found file through
 * the same identify -> insert -> dedupe pipeline as a directory scan.
 * Smart/dynamic playlists (no static file list) return immediately with
 * `isSmart: true` and nothing else to do.
 */
async function importWpl(db, {
  wplPath,
  reviewFolder,
  dryRun = true,
  useMusicBrainz = true,
  markDownloaded = true,
  mbClient,
  scanJobId = null,
  onProgress = () => {},
}) {
  const xmlText = await fs.readFile(wplPath, 'utf8');
  const parsed = parseWpl(xmlText);

  if (parsed.isSmart) {
    return {
      isSmart: true,
      smartPlaylistDescription: parsed.smartPlaylistDescription,
      totalRefs: 0,
      identifiedCount: 0,
      missingCount: 0,
      reviewCount: 0,
      skippedCount: 0,
      importId: null,
    };
  }

  const wplDir = path.dirname(wplPath);
  const resolvedReview = reviewFolder || path.join(wplDir, DEFAULT_REVIEW_FOLDER_NAME);

  const insertImport = db.prepare(
    `INSERT INTO imports (filename, label, row_count, ok_count, error_count, source_type, root_path)
     VALUES (?, ?, 0, 0, 0, 'wpl', ?)`
  );
  const importInfo = insertImport.run(path.basename(wplPath), parsed.title || null, wplPath);
  const importId = importInfo.lastInsertRowid;

  const stats = {
    isSmart: false,
    totalRefs: parsed.mediaRefs.length,
    identifiedCount: 0,
    missingCount: 0,
    reviewCount: 0,
    skippedCount: 0,
    importId,
  };

  let processed = 0;
  for (const rawRef of parsed.mediaRefs) {
    processed += 1;
    onProgress({ totalFiles: stats.totalRefs, processedFiles: processed, currentFile: rawRef });

    const ref = toPlatformRelativePath(rawRef);
    const resolved = path.isAbsolute(ref) ? ref : path.resolve(wplDir, ref);
    const mediaKind = classifyMediaKind(resolved);
    if (!mediaKind) {
      stats.skippedCount += 1;
      continue;
    }
    if (!(await fileExists(resolved))) {
      db.prepare(
        `INSERT INTO file_moves (scan_job_id, original_path, new_path, reason, applied)
         VALUES (?, ?, ?, ?, 0)`
      ).run(scanJobId, resolved, resolved, 'referenced by WPL but not found on disk (moved/deleted since playlist was made)');
      stats.missingCount += 1;
      continue;
    }

    let result;
    try {
      result = await identifyFile(resolved, { mediaKind, mbClient, useMusicBrainz, rootDir: wplDir });
    } catch (err) {
      result = { ok: false, reason: `identify error: ${err.message}` };
    }

    if (result.ok) {
      insertIdentifiedFile(db, importId, result, markDownloaded);
      stats.identifiedCount += 1;
    } else {
      const dest = path.join(resolvedReview, path.basename(resolved));
      let appliedNow = false;
      let finalDest = dest;
      if (!dryRun) {
        finalDest = await moveToReview(resolved, wplDir, resolvedReview);
        appliedNow = true;
      }
      db.prepare(
        `INSERT INTO file_moves (scan_job_id, original_path, new_path, reason, applied, moved_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(scanJobId, resolved, finalDest, result.reason, appliedNow ? 1 : 0, appliedNow ? new Date().toISOString() : null);
      stats.reviewCount += 1;
    }
  }

  if (stats.identifiedCount > 0) {
    runDedupe(db, { importId });
  }
  // Always record what was actually processed, even when nothing was
  // identified (e.g. every reference pointed at a path that doesn't exist
  // on this machine) - otherwise Import History misleadingly shows "0
  // rows" for a playlist that in fact had hundreds of references.
  db.prepare('UPDATE imports SET row_count = ?, ok_count = ? WHERE id = ?').run(
    stats.identifiedCount + stats.reviewCount + stats.missingCount,
    stats.identifiedCount,
    importId
  );

  return stats;
}

module.exports = { parseWpl, importWpl };
