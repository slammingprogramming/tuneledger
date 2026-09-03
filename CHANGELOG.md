# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project doesn't yet follow
strict semantic versioning (pre-1.0 territory, effectively) but version bumps are still
meaningful milestones.

## [Unreleased]

- Public GitHub repository prep: issue/PR templates, CI, contributing/security/code-of-conduct docs.
- Security hardening in response to CodeQL findings on the public repo: a shared
  `server/lib/safe-path.js` validator (rejects non-string/empty/NUL-byte path input, canonicalizes
  via `path.resolve`) applied everywhere a request-supplied path reaches the filesystem
  (`rootPath`, `wplPath`, `reviewFolder`, WPL media references, and the CSV-import path branch);
  a per-IP rate limiter on `/api`; bounded/rewritten regexes in `filename-guess.js` to remove
  polynomial-backtracking shapes; and an explicit `permissions: contents: read` on the CI workflow.
- Follow-up hardening: bumped `multer` 1.x -> 2.x (fixes several published DoS advisories);
  added an opt-in `LIBRARY_ROOTS` env var that confines directory scans/WPL imports to specific
  directories, with a real path-containment check (see the README's Configuration section); and
  documented, inline-suppressed the remaining path-injection findings that are inherent to this
  app's by-design "scan any directory the operator names" feature (same trust model as
  Jellyfin/Sonarr/Radarr/Lidarr) when `LIBRARY_ROOTS` is left unset.

## [1.1.0]

### Added

- Rebrand to **TuneLedger**.
- Local library scanning: recursive directory scan, tag/folder/filename identification
  confirmed against MusicBrainz, with a per-scan choice of whether a match marks the queue
  item downloaded or just links it as a known source.
- WPL (Windows Media Player playlist) import, for both static playlists and smart/dynamic
  (query-based) playlists.
- MusicBrainz-backed identification pipeline: embedded tags → folder structure →
  filename → MusicBrainz confirmation, including a conservative title-only last-resort
  search and a set of weaker, MB-verification-required filename patterns.
- New recognized version type: `karaoke` (backing tracks are never merged with the
  original vocal recording).
- MBID (MusicBrainz recording ID) exact-match dedup stage.

### Fixed

- WPL/directory-scan imports that identified nothing left their `imports` row showing
  "0 rows" even when many references were actually processed.

## [1.0.0]

### Added

- Spotify CSV import (Exportify-style exports), with column auto-detection.
- Multi-stage deduplication engine (exact ID, exact metadata, normalized title, fuzzy
  candidate scoring with a human-review queue for anything ambiguous).
- Persistent Artist → Album → Track download queue with per-track status, manual
  overrides (merge/split/edit/ignore), and full status history.
- CSV/plain-text export.
- Docker/Compose deployment.
