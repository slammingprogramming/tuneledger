# Security Policy

## Supported versions

TuneLedger is pre-1.0 and moving quickly. Security fixes are made against the `main`
branch and released as soon as possible; there is no separate long-term-support branch to
back-port to yet.

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security vulnerability.** Filing it in
public before a fix is available puts every other user at risk in the meantime.

Instead:

1. Open an issue that states only that a security-relevant issue exists and that you'd
   like to report it privately — no technical details, no proof of concept, nothing
   exploitable. Just a flag that something needs attention.
2. Reach out over SimpleX Chat: **<https://smp14.simplex.im/a#3gZ-zeHs4QrFZKLAN0o3SC_XQJXhj1eYBVTO_c0FAtg>**
3. We'll do a public-key-signature exchange over the issue you opened to verify each other
   — you prove you're the person who filed that issue, and the maintainer proves they're
   the maintainer. Once that two-way verification is done, we'll continue the conversation
   privately over SimpleX with full details.

This exists so reports can be attributed to a real, verified reporter (useful for credit,
and for follow-up questions) without ever putting your identity, contact details, or the
vulnerability itself in public. It's a one-time verification: once you're checked out, you
can reach the same SimpleX contact directly for anything in the future without repeating
the process.

Reports are acknowledged as promptly as possible, and credited (if you'd like) once a fix
ships.

## Scope

TuneLedger runs entirely locally against a SQLite database you control - there's no hosted
service, no accounts, and no server-side attack surface beyond what you run yourself
(the local Express server, and outbound requests to MusicBrainz). Vulnerability reports are
most useful when they concern:

- Data handling that could corrupt or leak the local database
- Something in the import/scan pipeline that could execute unintended code or write files
  outside the directories a user explicitly pointed the app at
- Dependency vulnerabilities with a real, reachable impact in how this project uses them

Non-issues: the app assumes you trust the machine it's running on and the CSV/media files
you feed it, the same way any local desktop tool does.
