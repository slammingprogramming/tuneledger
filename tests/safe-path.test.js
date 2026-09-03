'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  InvalidPathError,
  assertSafePath,
  getConfiguredRoots,
  assertWithinConfiguredRoots,
  assertSafeLibraryPath,
} = require('../server/lib/safe-path');

// Each test that touches LIBRARY_ROOTS saves/restores it, since it's
// process-global state - Node's test runner isolates env mutations
// between files (each file runs in its own process) but not between
// tests within this same file.
function withLibraryRoots(value, fn) {
  const prev = process.env.LIBRARY_ROOTS;
  if (value === undefined) delete process.env.LIBRARY_ROOTS;
  else process.env.LIBRARY_ROOTS = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.LIBRARY_ROOTS;
    else process.env.LIBRARY_ROOTS = prev;
  }
}

test('assertSafePath: rejects non-string input', () => {
  assert.throws(() => assertSafePath(undefined), InvalidPathError);
  assert.throws(() => assertSafePath(null), InvalidPathError);
  assert.throws(() => assertSafePath(42), InvalidPathError);
});

test('assertSafePath: rejects empty/whitespace-only strings', () => {
  assert.throws(() => assertSafePath(''), InvalidPathError);
  assert.throws(() => assertSafePath('   '), InvalidPathError);
});

test('assertSafePath: rejects a NUL byte', () => {
  assert.throws(() => assertSafePath('valid/looking/path\0/etc/passwd'), InvalidPathError);
});

test('assertSafePath: resolves a relative path to an absolute one', () => {
  const resolved = assertSafePath('some/relative/dir');
  assert.ok(path.isAbsolute(resolved));
  assert.equal(resolved, path.resolve('some/relative/dir'));
});

test('getConfiguredRoots: unset LIBRARY_ROOTS returns null (unrestricted)', () => {
  withLibraryRoots(undefined, () => {
    assert.equal(getConfiguredRoots(), null);
  });
});

test('getConfiguredRoots: parses a delimiter-separated list into resolved absolute paths', () => {
  const rootA = path.resolve(__dirname, 'fixtures-root-a');
  const rootB = path.resolve(__dirname, 'fixtures-root-b');
  withLibraryRoots([rootA, rootB].join(path.delimiter), () => {
    assert.deepEqual(getConfiguredRoots(), [rootA, rootB]);
  });
});

test('assertWithinConfiguredRoots: unrestricted by default, passes any resolved path through unchanged', () => {
  withLibraryRoots(undefined, () => {
    const p = path.resolve('/anywhere/at/all');
    assert.equal(assertWithinConfiguredRoots(p), p);
  });
});

test('assertWithinConfiguredRoots: allows a path inside a configured root', () => {
  const root = path.resolve(__dirname, 'fixtures-root');
  withLibraryRoots(root, () => {
    const inside = path.join(root, 'Artist', 'Album');
    assert.equal(assertWithinConfiguredRoots(inside), inside);
    // the root itself is allowed too
    assert.equal(assertWithinConfiguredRoots(root), root);
  });
});

test('assertWithinConfiguredRoots: rejects a path outside every configured root', () => {
  const root = path.resolve(__dirname, 'fixtures-root');
  withLibraryRoots(root, () => {
    assert.throws(() => assertWithinConfiguredRoots(path.resolve(__dirname, 'somewhere-else')), InvalidPathError);
  });
});

test('assertWithinConfiguredRoots: a sibling directory that merely shares a name prefix is not "inside" the root', () => {
  // Regression guard for the classic path-prefix bug: "/music" must not
  // match "/music-backup" just because the strings share a prefix.
  const root = path.resolve(__dirname, 'music');
  withLibraryRoots(root, () => {
    assert.throws(() => assertWithinConfiguredRoots(path.resolve(__dirname, 'music-backup')), InvalidPathError);
  });
});

test('assertSafeLibraryPath: combines validation and root containment', () => {
  const root = path.resolve(__dirname, 'fixtures-root');
  withLibraryRoots(root, () => {
    const inside = path.join(root, 'Artist');
    assert.equal(assertSafeLibraryPath(inside, 'rootPath'), inside);
    assert.throws(() => assertSafeLibraryPath(path.resolve(__dirname, 'elsewhere'), 'rootPath'), InvalidPathError);
    assert.throws(() => assertSafeLibraryPath('bad\0path', 'rootPath'), InvalidPathError);
  });
});
