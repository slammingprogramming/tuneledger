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
 * there is no single "allowed root" to confine every path to. What's
 * always invalid regardless of that: a non-string value, an empty/
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

module.exports = { assertSafePath, InvalidPathError };
