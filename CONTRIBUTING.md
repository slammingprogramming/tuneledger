# Contributing to TuneLedger

Thanks for taking a look. This project is early and moving fast, so a few notes to make
contributions easy to review and merge.

## Before you start

For anything beyond a small fix, please open an issue first to discuss the approach -
especially for anything touching the deduplication engine, the database schema, or the
identification pipeline (`server/lib/identify.js`, `tags.js`, `filename-guess.js`,
`folder-guess.js`, `musicbrainz.js`), since those have a lot of accumulated, deliberately
conservative design decisions behind them (see the README's
[Deduplication algorithm](README.md#deduplication-algorithm) and
[How identification works](README.md#how-identification-works) sections before assuming a
behavior is a bug rather than intentional caution).

## Development setup

```bash
cd app
npm install
npm test
npm start
```

See the [README](README.md) for the full local setup, Docker instructions, and an
explanation of the database schema.

## Database changes

**Schema changes must be strictly additive.** A new migration file
(`migrations/00N_description.sql`), never an edit to an existing one. See
[Forward compatibility & migrations](README.md#forward-compatibility--migrations) - a
database created by any past version of TuneLedger must keep working with every future
version, with no manual migration step. PRs that edit an already-shipped migration file
will be asked to change approach.

## Tests

- Run `npm test` before opening a PR - it should be green.
- New behavior should come with a test. The existing suite (`app/tests/`) uses Node's
  built-in `node:test` runner - no extra framework to learn.
- Tests that need real media files or a real Spotify export skip automatically when that
  data isn't present (see the README's [Tests](README.md#tests) section) - you don't need
  personal data to get a clean test run.

## Commit signing

Maintainer commits on this repository are signed. You're not required to sign your own
commits to open a PR, but if you'd like to and want to verify an existing signed commit
yourself, the maintainer's signing key is in [`.github/allowed_signers`](.github/allowed_signers):

```bash
git config gpg.ssh.allowedSignersFile .github/allowed_signers
git log --show-signature
```

## Pull requests

- Keep PRs focused - one change, one PR, makes review much faster.
- Describe *why*, not just *what*, especially for anything affecting matching/dedup
  behavior - a one-line rationale saves a lot of back-and-forth.
- By submitting a contribution, you agree it's licensed under the same terms as the rest
  of the project (see [LICENSE](LICENSE)).

## Reporting bugs vs. security issues

Regular bugs: open a GitHub issue as normal. Security vulnerabilities: see
[SECURITY.md](SECURITY.md) - please don't file those as regular public issues.
