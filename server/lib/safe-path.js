'use strict';

const path = require('path');

class InvalidPathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidPathError';
    this.statusCode = 400;
  }
}

/**
 * Validate and canonicalize a filesystem path that ultimately traces back
 * to a client request (a directory to scan, a .wpl file to import, a media
 * reference inside one). This app's core feature is reading/scanning
 * locations the user names - the same trust model as pointing Jellyfin,
 * Lidarr, or any other self-hosted media tool at a library folder - so
 * there is no single "allowed root" to confine every path to by default
 * (see assertWithinConfiguredRoots below for the opt-in version of that).
 * What's always invalid regardless of that: a non-string value, an empty/
 * whitespace-only string, or a NUL byte (which truncates the string at the
 * OS/native-binding layer and can be used to make a path look validated
 * while actually resolving to something else). Resolving through
 * `path.resolve` also collapses any `.`/`..` segments into a single
 * canonical absolute path before it reaches an fs call, instead of a raw,
 * unnormalized string built by concatenation.
 */
function assertSafePath(input, label = 'path') {
  if (typeof input !== 'string' || !input.trim()) {
    throw new InvalidPathError(`${label} must be a non-empty string`);
  }
  if (input.includes('\0')) {
    throw new InvalidPathError(`${label} must not contain a NUL byte`);
  }
  return path.resolve(input);
}

/**
 * Optional hard boundary on top of assertSafePath: if the operator has set
 * LIBRARY_ROOTS (one or more absolute directories, separated by the OS
 * path-list delimiter - `:` on Linux/macOS, `;` on Windows), every
 * rootPath/wplPath/reviewFolder must resolve to one of those directories
 * or something inside them. Left unset (the default), TuneLedger keeps its
 * normal behavior of scanning whatever directory the operator names - see
 * the note on assertSafePath above for why that's the appropriate default
 * for a self-hosted, single-operator tool. Setting LIBRARY_ROOTS is for
 * anyone who wants to lock a running instance down to specific library
 * folders regardless (e.g. it's reachable by more than just its operator).
 */
function getConfiguredRoots() {
  const raw = process.env.LIBRARY_ROOTS;
  if (!raw) return null;
  const roots = raw
    .split(path.delimiter)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => path.resolve(r));
  return roots.length ? roots : null;
}

function isWithinRoot(root, candidate) {
  if (candidate === root) return true;
  const rel = path.relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function assertWithinConfiguredRoots(resolvedPath, label = 'path') {
  const roots = getConfiguredRoots();
  if (!roots) return resolvedPath;
  if (!roots.some((root) => isWithinRoot(root, resolvedPath))) {
    throw new InvalidPathError(`${label} is outside the directories allowed by LIBRARY_ROOTS`);
  }
  return resolvedPath;
}

/** assertSafePath + assertWithinConfiguredRoots in one call - the normal entry point for a request-supplied library path. */
function assertSafeLibraryPath(input, label = 'path') {
  return assertWithinConfiguredRoots(assertSafePath(input, label), label);
}

module.exports = {
  InvalidPathError,
  assertSafePath,
  getConfiguredRoots,
  assertWithinConfiguredRoots,
  assertSafeLibraryPath,
};
