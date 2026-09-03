# TuneLedger

[![CI](https://github.com/slammingprogramming/tuneledger/actions/workflows/ci.yml/badge.svg)](https://github.com/slammingprogramming/tuneledger/actions/workflows/ci.yml)
[![License: AGPL v3+](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md)
[![GitHub issues](https://img.shields.io/github/issues/slammingprogramming/tuneledger.svg)](https://github.com/slammingprogramming/tuneledger/issues)
[![GitHub last commit](https://img.shields.io/github/last-commit/slammingprogramming/tuneledger.svg)](https://github.com/slammingprogramming/tuneledger/commits/main)
[![GitHub stars](https://img.shields.io/github/stars/slammingprogramming/tuneledger.svg?style=social)](https://github.com/slammingprogramming/tuneledger/stargazers)

![Express](https://img.shields.io/badge/backend-Express-000000?logo=express&logoColor=white)
![SQLite](https://img.shields.io/badge/database-SQLite-003B57?logo=sqlite&logoColor=white)
![MusicBrainz](https://img.shields.io/badge/identification-MusicBrainz-BA478F?logo=musicbrainz&logoColor=white)
![Docker](https://img.shields.io/badge/deploy-Docker-2496ED?logo=docker&logoColor=white)
![No build step](https://img.shields.io/badge/frontend-vanilla%20JS%2C%20no%20build%20step-yellow.svg)

**Keep track of every song you want, own, identify, and acquire.**

TuneLedger turns messy, scattered evidence of "music I want" — Spotify CSV exports,
Windows Media Player playlists, and folders of music you've already ripped or downloaded —
into one clean, deduplicated, persistent Artist → Album → Track manifest. It does **not**
download anything itself — it identifies what a track actually is (via MusicBrainz),
organizes it, tracks what you already have vs. still need, and lets you pick up exactly
where you left off, indefinitely, across as many imports as you throw at it, from as many
sources as you have.

```
Spotify CSV ┐
WPL playlist ├─→ normalize → identify (MusicBrainz) → deduplicate → organize → ledger → check off
Local files  ┘
```

See [Roadmap](#roadmap) for where this is headed (Apple Music/YouTube import, automated
acquisition via Lidarr).

## Contents

- [Quick start](#quick-start)
- [Docker](#docker)
- [How the CSV maps to the data model](#how-the-csv-maps-to-the-data-model)
- [The four data layers](#the-four-data-layers)
- [Database schema](#database-schema)
- [Deduplication algorithm](#deduplication-algorithm)
- [Sorting](#sorting)
- [Using the app](#using-the-app)
- [Import / export workflow example](#import--export-workflow-example)
- [Importing additional CSVs later](#importing-additional-csvs-later)
- [Local library scanning & WPL import](#local-library-scanning--wpl-import)
- [Roadmap](#roadmap)
- [Backup & restore](#backup--restore)
- [Configuration](#configuration)
- [Tests](#tests)
- [Project layout](#project-layout)

## Quick start

Requires Node.js 18+ (tested on Node 24). No external database server needed — everything
lives in a single SQLite file.

```bash
cd app
npm install
npm start
```

Open `http://localhost:3000`. Go to the **Import** tab, choose your Spotify CSV, click
**Import CSV**. Then use the **Queue** tab to browse Artist → Album → Track and check things
off as you download them.

The database file is created at `app/data/library.db` on first run. Set `DB_PATH` to put it
somewhere else, and `PORT` to change the port:

```bash
DB_PATH=/path/to/library.db PORT=8080 npm start
```

## Docker

```bash
cd app
docker compose up --build
```

This builds the image, starts the server on `http://localhost:3000`, and stores the
database in `./app/data` on the host (bind-mounted into the container at `/data`), so it
survives container rebuilds. Edit `docker-compose.yml` if you want a different port or
data location.

## How the CSV maps to the data model

The importer does **not** assume a fixed Spotify CSV layout. It inspects the header row and
maps known column-name variants to internal fields; anything it doesn't recognize is still
preserved (see [below](#the-four-data-layers)). This matters because "a Spotify CSV" isn't
one fixed format — this project ships with a real-world example (`spotify liked songs
rj.csv`, an [Exportify](https://exportify.net)-style "Liked Songs" export) that turned out
to differ from the sample field list in the original spec: it has **no `Track Number` or
`Disc Number` column**, but does include per-track audio features (`Danceability`, `Energy`,
`Tempo`, etc.), `Genres`, `Record Label`, and a stable `Track URI`.

| Internal field    | Accepted header spellings (case-insensitive)                          |
|--------------------|-------------------------------------------------------------------------|
| `trackUri`         | `Track URI`, `Spotify URI`, `URI`                                       |
| `trackId`          | `Track ID`, `Spotify ID`, `Spotify Track ID`                            |
| `trackName`        | `Track Name`, `Name`, `Title`, `Track`                                  |
| `albumName`        | `Album Name`, `Album`                                                   |
| `artistNames`      | `Artist Name(s)`, `Artist Names`, `Artist(s)`, `Artist`                 |
| `albumArtist`      | `Album Artist Name(s)`, `Album Artist`, `Album Artist(s)`               |
| `trackNumber`      | `Track Number`, `Track #`, `#`, `Track No`                              |
| `discNumber`       | `Disc Number`, `Disc`                                                   |
| `releaseDate`      | `Release Date`, `Album Release Date`                                    |
| `durationMs`       | `Duration (ms)`, `Duration Ms`, `Duration`                              |
| `popularity`       | `Popularity`                                                            |
| `explicit`         | `Explicit`                                                              |
| `addedAt`          | `Added At`, `Date Added`, `Added`                                       |
| `genres`           | `Genres`, `Artist Genre(s)`, `Artist Genres`                            |
| `recordLabel`      | `Record Label`, `Label`                                                 |
| `isrc`             | `ISRC`                                                                   |

Add more spellings in `server/lib/importer.js`'s `FIELD_ALIASES` if you have an export
variant that uses different header text — nothing else about the pipeline needs to change,
because unrecognized columns are never discarded (they land in `raw_rows` and in
`normalized_entries.extra_json`).

If a future CSV **does** include `Track Number`/`Disc Number`, the importer picks them up
automatically and the queue sorts by them; when they're absent (as in the real fixture
here), tracks within an album fall back to alphabetical order rather than being left
unordered.

## The four data layers

Per the design brief, source data is never mutated or thrown away just because it got
deduplicated:

```
RAW SOURCE DATA        raw_rows            - verbatim copy of every CSV row (as JSON), forever
      ↓
NORMALIZED DATA        normalized_entries  - one parsed/cleaned row per raw row (1:1)
      ↓
CANONICAL TRACKS       canonical_tracks    - one row per distinct recording you'll download
      ↓
DOWNLOAD QUEUE         (canonical_tracks.status + ignored)
```

- **`raw_rows`** — every row from every import, byte-for-byte as parsed, plus a
  `parse_status`/`parse_error` if something looked off (missing title, wrong column count,
  etc). Nothing is ever deleted from here as a side effect of deduplication.
- **`normalized_entries`** — the same rows after cleanup: split multi-artist fields,
  version-tag extraction (see below), unicode/case/punctuation-normalized sort keys, parsed
  numeric fields. Still one row per raw row.
- **`canonical_tracks`** — the actual queue. One row per song you intend to download.
  Multiple `normalized_entries` fold into one `canonical_tracks` row via `track_sources`,
  which is what lets the UI say "Duplicate occurrences: 3" without losing the individual
  source records.
- **Download queue** is just `canonical_tracks.status` (`not_started` / `in_progress` /
  `downloaded` / `skipped` / `problem`) plus an `ignored` flag — there's no separate queue
  table because the canonical track *is* the queue item.

## Database schema

SQLite, via `better-sqlite3`. Full DDL across [`migrations/001_init.sql`](migrations/001_init.sql),
[`migrations/002_local_library.sql`](migrations/002_local_library.sql), and
[`migrations/003_mark_downloaded_toggle.sql`](migrations/003_mark_downloaded_toggle.sql).

```
imports              one row per CSV/scan/WPL import (filename, counts, source_type)
raw_rows              →  imports            verbatim source rows (or a JSON snapshot of a scanned file's identify() result)
normalized_entries     →  raw_rows (1:1)    cleaned/parsed rows - also carries file_path/media_kind/
                                             musicbrainz_recording_id/identify_method for local-scan-sourced rows
artists                                     canonical artist list (dedup grouping key)
albums                 →  artists           canonical album list, per artist
canonical_tracks       →  artists, albums   THE QUEUE — one row per distinct recording
track_sources           →  canonical_tracks, normalized_entries   duplicate traceability
status_history          →  canonical_tracks  every status change, timestamped
manual_overrides        →  canonical_tracks  audit log of every user-initiated edit/merge/split
possible_duplicates     →  canonical_tracks×2 fuzzy-stage flags awaiting human review
scan_jobs                                    one row per directory scan / WPL import (progress, for polling)
file_moves               →  scan_jobs        every file staged/moved to the review folder, with why
```

Key design choices:

- **A track can have multiple sources** (`track_sources`, one row per contributing
  `normalized_entries` row) — that's how "this song appeared on the album, a reissue, and a
  compilation" is represented without three queue entries.
- **Download status belongs to `canonical_tracks`**, not to any individual source, because
  there's exactly one thing to download regardless of how many releases it appeared on.
- **Manual decisions persist** in `manual_overrides` (an append-only audit log) and directly
  in the row they affected — merges, splits, preferred-source changes, field edits, ignores,
  and duplicate confirm/reject decisions are all logged with before/after values.
- **`possible_duplicates`** uses `ON DELETE SET NULL` (not `CASCADE`) on its foreign keys, so
  a *resolved* (confirmed/rejected) flag survives as history even after the tracks it
  referenced get merged away by that same confirmation. Only still-*pending* flags are
  pruned when a track they reference disappears.

### Forward compatibility & migrations

**A database from any past version of TuneLedger will always open cleanly with any future
version.** This is a hard rule the project follows, not just current behavior:

- Migrations are **strictly additive and numbered** (`001_`, `002_`, `003_`, ...). A shipped
  migration file is never edited or deleted after release — a schema change always arrives
  as a *new* numbered file.
- `server/db.js` tracks which migrations have run in a `_migrations` table and applies only
  the ones a given database hasn't seen yet, in order, inside a transaction, on every
  startup. Opening an old database with a newer build of the app just runs whatever new
  migrations have shipped since; opening a current database with the same version is a
  no-op.
- New columns are added with `ALTER TABLE ... ADD COLUMN` with a sensible `DEFAULT`, so
  existing rows (and any code that doesn't know about the new column yet) keep working
  unmodified. Nothing is ever silently dropped, renamed in place, or backfilled destructively.
- If a future change ever genuinely requires reshaping existing data (not just adding to
  it), that migration will transform data forward, in place, inside the same transaction —
  never require a manual export/reimport, and never touch `raw_rows` (the original
  source-of-truth layer - see [The four data layers](#the-four-data-layers)) since that's
  what makes such a transform re-derivable/auditable in the first place.

Practically: back up `data/library.db` before a major version bump the same way you'd back
up anything (see [Backup & restore](#backup--restore)), but you should never *need* to
migrate data by hand between versions.

## Deduplication algorithm

Implemented in `server/lib/dedupe.js`, run as a separate pass (`runDedupe`) after import, and
designed to be **safe to re-run at any time**: it only processes `normalized_entries` that
aren't linked to a canonical track yet, so already-decided tracks (and their download status)
are never touched or recreated.

Matching happens in stages, most confident first, all scoped to entries sharing the same
canonical artist (cheap and correct, since the whole point is "same song, same artist"):

1. **Exact identifier** — same `spotify_track_id`. Mainly useful for literal re-imports
   (the same CSV row twice) since Spotify actually assigns *different* track IDs to the same
   recording on different releases, so this alone doesn't catch cross-release duplicates.
2. **Exact normalized metadata** — same artist + same full normalized title text + duration
   within 1.5s. Catches "the same song, byte-identical title, appears on two releases" (e.g.
   a plain "Money" on both the studio album and a compilation).
3. **Normalized title stem** — same artist + same title with version annotations stripped
   (`"Money (2011 Remaster)"` → stem `"Money"`) + **same detected version type** + duration
   within 4s. A "Live" version and a "Remaster" have different version types and will not
   merge here, by design — see the "song identity vs. release identity" note below.
4. **Fuzzy scoring** — bigram Dice-coefficient similarity on the title stem, still scoped to
   same artist + same version type + duration within tolerance. Scores ≥ the configured
   auto-merge threshold (default `0.92`) merge automatically; scores ≥ the review threshold
   (default `0.78`) get written to `possible_duplicates` as **"possible duplicate — review"**
   instead of being merged or dropped. A duration gap that's otherwise disqualifying still
   generates a review flag (with the gap noted) rather than silently doing nothing — see the
   `TOKYO HEAT - Club Mix` vs `TOKYO HEAT (Tokyo Drift)` case in the real fixture, which are
   two different mixes 59 seconds apart in length that share an identical stripped title.
   Titles that differ only by a **number** (`"Track 1"` vs `"Track 12"`, `"Interlude 1"` vs
   `"Interlude 2"`) are explicitly excluded from fuzzy auto-merge, since differing digits are
   usually exactly what distinguishes two different tracks, and raw string similarity can't
   tell "close in edit distance" from "different track."
5. **Manual resolution** — the Review Duplicates tab lets you confirm or reject anything
   stage 4 flagged; merge/split/set-preferred are available on any track at any time (see
   [Using the app](#using-the-app)).

### Version-type detection

Titles are parsed for trailing annotations — `"Title (Annotation)"`, `"Title [Annotation]"`,
or `"Title - Annotation"` — and classified into a fixed vocabulary: `remaster`, `live`,
`acoustic`, `radio_edit`, `extended`, `remix`, `demo`, `instrumental`, `mono`, `stereo`,
`cover`, `single_version`, `edit`, `alternate`, or `other` (an annotation that doesn't match
a known keyword, kept as its own type so it isn't silently treated as identical to the plain
title). This satisfies the "normalize the *notation*, don't blindly merge the *recording*"
distinction the design is built around: `"Song (Remastered)"`, `"Song - Remastered"`, and
`"Song [Remastered]"` are all recognized as the *same annotation type* consistently, but a
remaster is still kept as a separate canonical track from the original by default (stages
2-4 all require matching version types) — because remasters, live takes, and remixes are
often genuinely different masters/recordings, not just formatting differences. Auto-merging
them by default would risk exactly the kind of "genuinely different recording" collapse the
brief warns against; the fuzzy/review stage and manual merge are there for when they really
are close enough.

### Song identity vs. release identity

`"Money"` on *The Dark Side of the Moon* and `"Money"` on *Echoes: The Best of Pink Floyd*
resolve to **one** canonical track (same recording, two releases) — the compilation
appearance is retained as a second row in `track_sources`, not deleted. `"Money"`,
`"Money (Live)"`, and `"Money (2011 Remaster)"` remain **three separate** canonical tracks,
because their version types differ.

### Choosing the preferred (primary) source

When multiple sources fold into one canonical track, the display fields (title, track/disc
number, duration, and which album the track is filed under) come from whichever source is
currently "primary." Preference order is configurable in
[`config/dedupe.json`](config/dedupe.json):

```json
{
  "releaseCategoryPreference": {
    "album": 0, "deluxe": 1, "soundtrack": 2, "unknown": 2.5, "compilation": 3, "single": 4
  }
}
```

Lower wins. Release category is guessed from the album name (`"Greatest Hits"` →
compilation, `"... (Deluxe Edition)"` → deluxe, album name equal to track name → single,
etc. — see `classifyReleaseCategory` in `server/lib/normalize.js`) since the real-world CSV
this project ships with has no explicit release-type column. Ties break on earliest release
date. Edit the JSON file and restart the server to change the ranking — no code changes
needed. You can also override the choice per-track any time via **"Make preferred"** in the
duplicate-sources panel.

## Sorting

Primary ordering is always **Artist → Album → Disc → Track**:

- Artists and albums sort by a normalized key that strips a leading "The"/"A"/"An" so "The
  Beatles" files under B, not T.
- Within an album: disc number, then track number, both numeric (not string) so track 10
  doesn't sort before track 2.
- When track numbers are missing entirely (as in the shipped example CSV), tracks fall back
  to alphabetical order by title rather than being left in import order.

## Using the app

- **Queue tab** — Artist rows expand to Album rows expand to Track rows, each lazily loaded
  (only the artist list is loaded up front; album/track data is fetched on expand), so the
  UI stays fast with thousands of tracks. Checkbox = toggle downloaded. A status dropdown
  next to it gives access to the full `not_started` / `in_progress` / `downloaded` /
  `skipped` / `problem` range without cluttering the primary checkbox interaction.
- **Duplicate badge** (`×N`) — click to expand the contributing source releases for that
  track, with **Make preferred** and **Split out** actions.
- **✎** — edit artist / album / track number / disc number. Click a track title directly to
  rename it inline.
- **⊘ / ↺** — ignore / restore a track (removed from progress counts without deleting it).
- **Search tab** — flat, filterable, paginated view across the whole library: text search,
  artist/album filters, status, version type, duplicates-only, missing-metadata, ignored.
- **Review Duplicates tab** — anything the fuzzy stage flagged instead of guessing at;
  confirm to merge, reject to keep separate permanently.
- **Import / Import History tabs** — upload a CSV, see exactly what happened (row counts,
  warnings for unparseable rows, dedup stats), and review past imports.
- **Local Library tab** — scan a directory of music you already have, or import a `.wpl`
  playlist; see [Local library scanning & WPL import](#local-library-scanning--wpl-import).

## Import / export workflow example

```
1. Import tab → choose "spotify liked songs rj.csv" → Import CSV
   → 1603 rows read, 1600 usable, 3 warnings (blank titles - still preserved in raw data)
   → 1557 unique tracks after dedup, 43 duplicate source rows folded in, 2 flagged for review

2. Review Duplicates tab → inspect the 2 flagged pairs → confirm or reject

3. Queue tab → work through Artist → Album → Track, checking things off as you download them

4. Close the app. Reopen it later (or on another day) - everything is exactly as you left it.

5. Export tab (via API): GET /api/export.csv for a spreadsheet-friendly export, or
   GET /api/export-remaining.txt for a plain "Artist/Album/## - Track" list of everything
   NOT yet downloaded, suitable for feeding into another tool.
```

## Importing additional CSVs later

Re-importing is always safe and never creates duplicate queue entries:

- Rows that match an existing canonical track (by ID, exact metadata, or title+duration) are
  linked as an additional source — the existing `downloaded` status is **never** touched or
  reset.
- Only genuinely new songs create new canonical tracks.
- Re-importing the *exact same file twice* is a no-op for the queue (verified by the
  idempotency tests) — you can safely re-run an export whenever you like without fear of
  bloating the list.

```
Existing database: 1,557 unique tracks, 312 downloaded
New CSV: 2,100 records
Result: some rows matched existing tracks (linked as extra sources, status untouched),
        the rest became new canonical tracks; 312 downloaded stays 312 downloaded.
```

## Local library scanning & WPL import

Beyond importing a Spotify CSV, the app can also scan music you **already have** and
reconcile it against the queue — so anything you already own gets checked off
automatically instead of you doing it by hand, and anything it can't recognize gets set
aside for a human to look at instead of being silently ignored or misfiled.

### How identification works

Three independent signals are gathered for each file, then merged field-by-field (real
tags always win over inferred data) — in priority order (`server/lib/identify.js`):

1. **Embedded tags** (ID3/Vorbis/MP4/ASF/etc, read via `music-metadata`). If both artist
   and title are present, they're confirmed/canonicalized against **MusicBrainz** where
   possible (`tags_mb`), else trusted alone (`tags_only`).
2. **Folder structure**, when tags are missing or incomplete: `Artist/Album/File.ext` is
   an extremely common library layout (this app was tested against a real Windows Media
   Player library export using exactly this convention), and fills gaps a file's own tags
   leave open.
3. **The filename**, parsed against the two conventions that actually show up in real
   libraries (`"NN Title - Artist"` for numbered rips, `"Artist - Title"` for single
   downloaded videos) — used to fill in a missing title, or a missing artist when the
   folder didn't provide one either.
   - If *some* real tag data contributed (e.g. a tag had the artist but not the title),
     the merged result is confirmed against MusicBrainz where possible (`assisted_mb`) or
     trusted at a reduced-but-still-meaningful confidence (`assisted_only`).
   - If there were no usable tags at all and everything came from folder/filename, the
     same applies at lower confidence (`filename_mb` / `filename_only`).
4. **Title-only MusicBrainz search**, as an absolute last resort when there's a title but
   *no* artist from any source (tags, folder, or filename). An artist-less search is much
   lower-precision, so this only accepts a very high-confidence (≥0.92), duration-
   corroborated hit (`title_only_mb`) — it is never used to merely guess an artist.
5. **Unresolved** — routed to manual review. Either it's music MusicBrainz genuinely
   doesn't know about with no filename/folder hint either, or it isn't music at all (a
   stray voice memo, a document that got mixed into the folder, etc).

A few real-world data problems this pipeline specifically handles (found via the ~380
example files this project was tested against, kept in `test files/` outside the repo's
tracked fixtures — a real, messy, years-old Windows Media Player library export):

- **Corrupt tags**: one sample file had a WMA year tag of literal `2232`. Implausible years
  (outside 1860–next year) are discarded rather than trusted.
- **Redundant tagging**: a title tag of `"What'd I Say - Ray Charles"` with a *separate*,
  correct `artist` tag of `"Ray Charles"` — the echoed artist suffix is stripped from the
  title.
- **Incomplete tags filled from folder structure**: a file tagged with artist `"Alanis
  Morissette"` but *no title tag at all*, sitting in `Alanis Morissette/Everything -
  Single/Everything.wma` — the title comes from the filename, the album from the folder.
  Folder inference deliberately requires two directory levels (`Artist/Album/File`) and
  ignores known generic folder names (`Karaoke`, `Unknown Artist`, `Unknown Album` — the
  literal folder names Windows Media Player itself creates for an unidentified CD rip) so
  a single-level category folder never gets mistaken for an artist.
- **Unlabeled-rip placeholders**: filenames/titles like `"Track 2"` or `"Track_03"` — a
  common artifact when ripping software finds no CDDB/metadata match — are recognized as
  non-titles rather than trusted at face value.
- **YouTube-rip noise**: `"Man in the Box (Official Video)"` is recognized as the same
  recording as `"Man in the Box"`, not a distinct "version" — `(Official Video)`,
  `(Official Audio)`, `(Lyric Video)`, `(HD)` etc. describe the file's source, not the song.
- **Karaoke/instrumental-backing tracks** are recognized as their own distinct version type
  (not merged with the original vocal recording) — this library's test data included an
  entire folder of them.
- **Deceptively similar titles**: MusicBrainz text search can return a very different
  recording (a live take, a different mix) that happens to share an identical or
  near-identical title — a large duration mismatch measurably lowers confidence rather
  than being ignored just because the text matched perfectly.

Matching a local file against the existing queue reuses the **exact same dedup engine**
described above, plus one additional highest-priority stage: an exact **MusicBrainz
recording ID** match, since that identifies the same canonical recording regardless of
text differences.

### Marking matches as downloaded (or not)

When a local file links to a canonical track — whether that track already existed from a
CSV import or was just created by the scan — you choose what that means, per scan:

- **"Mark it downloaded"** (default) — you already have this, don't ask you to download it
  again. This is what makes local scanning function as a real cross-reference against the
  wishlist instead of just another list to check off by hand.
- **"Link it but keep queued"** — record the file as a known source (visible in the
  track's duplicate-sources panel) without changing its status. Use this for a
  quality-upgrade pass: scan a folder of low-bitrate rips you specifically want to
  *replace*, and they stay on the to-do list instead of being marked complete.

This choice is recorded per scan (`scan_jobs.mark_downloaded`) and per matched file
(`normalized_entries.mark_downloaded_on_match`), so different scans of different folders
can make different choices without affecting each other.

### Directory scans

**Local Library** tab → enter a directory path → **Start Scan**. The whole tree is walked
recursively. Files are classified by extension:

- Audio: `.mp3 .flac .m4a .aac .wav .wma .ogg .opus .alac .aiff .ape .wv`
- Video: `.mp4 .mkv .webm .avi .mov .m4v .flv .wmv`
- Anything else (album art, `.nfo`, `.txt`, etc.) is left alone — not moved, not reported.

Scans run as a background job (MusicBrainz's usage policy caps lookups at ~1/sec, so a
large library can take a while) — progress polls live in the UI and the job can be
cancelled mid-scan.

**Nothing is moved on disk by default.** Unidentified files are *staged* (recorded in the
`file_moves` table with what would happen and why) but left in place until you click
**"Apply N pending moves"**, or check "Move unidentified files immediately" before
starting the scan. Identified files, by contrast, are written to the database
unconditionally during the scan itself — that's a safe, reversible action (undo by
ignoring/deleting the import), unlike moving real files around on disk, which is why only
the latter defaults to a dry run.

Unidentified files move into `_needs_review/` inside the scanned folder (configurable),
preserving their original relative subpath so nothing collides and origin stays traceable.
Re-scanning the same directory later automatically skips that folder, so applied moves
don't get reprocessed in a loop.

### WPL playlists

**Local Library** tab → **Import a .wpl playlist** → enter the `.wpl` file's path.

Windows Media Player playlists come in two genuinely different shapes:

- A **static** playlist lists actual files (`<media src="...">`) — each referenced file is
  resolved (relative paths are resolved against the playlist's own folder; Windows-style
  backslash paths are normalized so this also works if the app is running in a Linux
  Docker container) and run through the identical identify → insert → dedupe pipeline as a
  directory scan. A reference to a file that no longer exists on disk is reported as
  **missing**, distinctly from a file that was found but couldn't be identified.
- A **smart/auto playlist** (e.g. "recently added, unrated" — the example `.wpl` this
  project was built against is exactly this kind) is a saved *query*, not a file list.
  There's nothing to import; the app reports this plainly (with the rule it found) instead
  of silently returning zero results or erroring.

### MusicBrainz setup

Edit [`config/musicbrainz.json`](config/musicbrainz.json) before doing a large scan:
MusicBrainz's usage policy requires a descriptive `User-Agent` with a real contact method
(email or URL) for their free web service — an anonymous one can get rate-limited. No
account or API key is required for text-based recording lookup (this app does not do
acoustic/audio fingerprinting — identification is tag- and filename-based, confirmed via
MusicBrainz's metadata search, not by analyzing the audio itself).

## Roadmap

TuneLedger's job is to be the single, durable manifest of every song you want, own,
identify, and acquire — no matter how many different tools and platforms that evidence is
scattered across, or how many times you re-import it. What's implemented today:

- Spotify CSV export import (any Exportify-style export - playlist, Liked Songs, etc.)
- WPL (Windows Media Player playlist) import, static and smart/dynamic
- Local file scanning: recursive directory scan, tag/folder/filename identification
  confirmed against MusicBrainz, with a choice per scan of whether a match completes the
  queue item or just links it as a known source (see
  [Marking matches as downloaded (or not)](#marking-matches-as-downloaded-or-not))

Planned:

- **More import sources** — Apple Music exports, YouTube exports/playlists (with the
  non-music carved out automatically, the same way local scanning already separates music
  from things that just happened to be in the folder), and other platforms as they come up.
  Each new source is designed to slot into the same `raw_rows → normalized_entries →
  canonical_tracks` pipeline every existing source already uses, so it gets deduplication,
  cross-referencing, and the persistent manifest for free rather than needing its own
  parallel logic.
- **Automated acquisition via Lidarr** — hook the queue up to a running Lidarr instance
  (the `*arr` app for music, same family as Sonarr/Radarr) so TuneLedger can hand off
  everything still `not_started` and let Lidarr search/grab it automatically, closing the
  loop from "I found evidence I want this song" all the way to "it's in Jellyfin." The
  queue/status model (one canonical track, one status, full history) is already shaped to
  support this — this is additive on the acquisition side, not a rework of the manifest.

## Backup & restore

Everything lives in one SQLite file (plus its WAL/SHM sidecar files while the server is
running). To back up:

```bash
# stop the server first (or use `sqlite3 library.db ".backup backup.db"` for a live copy)
cp app/data/library.db app/data/library.db.bak
```

To restore, stop the server, replace `app/data/library.db` with your backup, and start the
server again — the migration runner is idempotent and will not touch existing data.

With Docker, the whole `./data` folder on the host is the thing to back up (`docker compose
down` first if you want a guaranteed-consistent copy, though `.backup` works live too).

## Configuration

| Env var         | Default                | Purpose                                                    |
|------------------|-------------------------|--------------------------------------------------------------|
| `DB_PATH`        | `app/data/library.db`  | Path to the SQLite database file                            |
| `PORT`           | `3000`                 | HTTP port                                                    |
| `LIBRARY_ROOTS`  | unset (unrestricted)   | Confine directory scans/WPL imports to these directories - see below |

Deduplication weights/thresholds: [`config/dedupe.json`](config/dedupe.json) (see
[Deduplication algorithm](#deduplication-algorithm) above). MusicBrainz User-Agent/
confidence threshold: [`config/musicbrainz.json`](config/musicbrainz.json) (see
[MusicBrainz setup](#musicbrainz-setup) above).

### `LIBRARY_ROOTS`

By design, [directory scans and WPL imports](#local-library-scanning--wpl-import) accept
*any* path the operator names - the same trust model as pointing Jellyfin, Sonarr, Radarr, or
Lidarr at a library folder: the person calling this API is this app's own operator, not an
untrusted third party, so there's no single "correct" root to confine it to by default.

If you'd rather lock a running instance down anyway - e.g. it's reachable by more than just
you - set `LIBRARY_ROOTS` to one or more absolute directories, separated by the OS path-list
delimiter (`:` on Linux/macOS, `;` on Windows). Every `rootPath`, `wplPath`, and
`reviewFolder` must then resolve to one of those directories (or something inside them), or
the request is rejected with a 400:

```bash
LIBRARY_ROOTS="/mnt/music:/mnt/music-backup" npm start        # Linux/macOS
LIBRARY_ROOTS="D:\Music;E:\Music Backup" npm start             # Windows
```

Leaving it unset preserves today's behavior of scanning whatever directory you point it at.
See [`server/lib/safe-path.js`](server/lib/safe-path.js) for the implementation.

## Tests

```bash
cd app
npm test
```

116 tests (Node's built-in `node:test` runner, no extra test framework dependency) covering:
CSV parsing, unicode handling, missing/malformed fields, exact and fuzzy deduplication,
version-type preservation (remaster/live/remix/karaoke all stay separate), the
duration-mismatch guard, the numeric-token guard, disc/track/artist/album sorting, status
persistence, every manual override (merge/split/set-preferred/edit/ignore/confirm/reject),
single- and repeated-import idempotency, importing a second overlapping CSV, an HTTP-level
server smoke test, larger synthetic imports (5,000 rows) for performance/regression
coverage, tag reading and its cleanup heuristics (corrupt-year rejection, echoed-artist
stripping), folder-structure inference (and its "Unknown Artist"/single-level-folder
guardrails), filename-guessing including unlabeled-rip placeholder rejection and the
weaker MB-verification-required secondary patterns (no-space/asymmetric dashes, "Title by
Artist", underscore-wrapped titles, karaoke "in the style of X" credits), a MusicBrainz
client test suite against a fake `fetch` (no live network dependency, so the suite stays
fast/deterministic/offline-safe), the full identify → insert → dedupe pipeline including
the MBID matching stage, the title-only last-resort MusicBrainz fallback (accept/reject
cases), and the local-file-marks-existing-queue-item-downloaded cross-reference (both the
default "mark downloaded" behavior and the "link but keep queued" quality-upgrade-pass
toggle), WPL parsing for static playlists, single- and multi-`<querySet>` smart/dynamic
playlists, recursive directory scanning (including the review-folder move/apply/
re-scan-exclusion flow), and the async scan-job HTTP API.

A handful of tests are **bonus sanity checks against real media files and a real Spotify
export**, never checked into the repo (copyrighted/personal data) — if you don't have a
`test files/` folder or a `spotify liked songs rj.csv` sitting next to this repo, those
tests skip cleanly rather than failing; `npm test` and CI never depend on them. Destructive
operations in the local-scan/WPL tests (file moves) always run against temp-directory
copies, never the real files.

## Project layout

```
app/
  server/
    index.js            Express app entry point
    db.js                SQLite connection + migration runner
    lib/
      importer.js        CSV → raw_rows + normalized_entries
      normalize.js        text/version normalization helpers
      dedupe.js            multi-stage matching engine (CSV + local-file sources)
      mutations.js         status changes + all manual overrides
      queries.js            read-side queries backing the API
      exporter.js            CSV / plain-text export
      tags.js                embedded audio/video tag reading + cleanup
      filename-guess.js      last-resort filename → artist/title parsing
      folder-guess.js         Artist/Album/File folder-structure inference
      musicbrainz.js            rate-limited MusicBrainz recording-search client
      identify.js                tags -> folder -> filename -> MusicBrainz identification pipeline
      library-scanner.js          recursive directory scan + safe file-move-to-review
      wpl.js                       Windows Media Player playlist (.wpl) import
    routes/
      api.js               REST API (CSV import, queue, search, export, overrides)
      library.js            REST API (directory scans, WPL import, scan-job polling)
  migrations/
    001_init.sql         base schema
    002_local_library.sql local-scan/WPL columns + scan_jobs/file_moves tables
    003_mark_downloaded_toggle.sql per-scan/per-entry mark-downloaded-on-match toggle
  config/
    dedupe.json          tunable dedup weights/thresholds
    musicbrainz.json      MusicBrainz User-Agent/confidence threshold
  public/                 frontend (vanilla HTML/CSS/JS, no build step)
  fixtures/                synthetic CSVs/WPL used by the test suite
  tests/                    automated tests (node:test)
  Dockerfile, docker-compose.yml
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, the additive-only migration policy,
and PR expectations. This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

## Security

Found a vulnerability? Please don't file it as a public issue - see [SECURITY.md](SECURITY.md)
for private, verified reporting.

## Acknowledgments

- [MusicBrainz](https://musicbrainz.org) — the open, community-maintained recording database
  that TuneLedger's identification pipeline confirms tags/folder/filename guesses against. No
  audio fingerprinting, no account, no API key - just polite, rate-limited use of their free
  metadata search per [their usage policy](https://musicbrainz.org/doc/MusicBrainz_API).
- [Exportify](https://exportify.net) — the export tool this project's CSV field-mapping was
  built and tested against.
- Everyone who files an issue, opens a PR, or reports a vulnerability responsibly through
  [SECURITY.md](SECURITY.md).

## License

[AGPL-3.0-or-later](LICENSE). If you host a modified version of TuneLedger as a network
service, the AGPL requires you to make your modified source available to the people using it
- see the license for the exact terms.
