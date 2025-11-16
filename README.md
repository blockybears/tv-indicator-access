# TradingView Invite-Only Access Manager

This package automates granting invite-only access to your TradingView indicators via Playwright. It enumerates your invite-only scripts, lets you curate which ones are managed, and grants/revokes access for users with optional expiration.

## Prerequisites

- Node.js 18+ (or latest LTS)
- npm

## Install

1) Install dependencies

```
npm install
```

2) Install Playwright Chromium browser

```
npm run install-deps
```

## Authentication

Headless is the default. If your session is missing or expired, the script will auto-detect a login redirect and temporarily open a visible window for you to log in, then save the session and continue headless.

You can also initialize the session explicitly:

```
npm run save-session
```

This opens a visible Chromium window at the TradingView sign-in page. After login is detected, it saves `tv-storage.json` (re-used by all commands).

## First Run: Build Your Managed Script List

1) Refresh invite-only scripts into a single selection file:

```
npm run refresh-invite-list -- --profile-url https://www.tradingview.com/u/YourUsername/#published-scripts
```

This writes `script-selection.json` with your invite-only scripts (`title`, `url`, `id`, `slug`, and `enabled`).

2) Edit `script-selection.json` and set `enabled: true` for the scripts you want the grant command to manage.

3) (Optional) Print invite-only scripts to stdout:

```
npm run list -- --profile-url https://www.tradingview.com/u/YourUsername/#published-scripts
```

## Grant Access

Grant to users using the curated selection file (headless by default):

```
npm run grant -- --users user1 user2 --no-expiry
```

Or set an expiry:

```
# Fixed date (YYYY-MM-DD)
npm run grant -- --users user1 user2 --expires 2025-12-31

# Relative days from today
npm run grant -- --users user1 user2 --days 30
```

Grant for specific scripts (skip enumeration) by URL or ID:

```
npm run grant -- --users user1 user2 --no-expiry --scripts https://www.tradingview.com/script/mbJMk5vq-Adaptive-SwitchBack/

# Multiple scripts by ID or URL (space- or comma-separated)
npm run grant -- --users user1 user2 --days 14 --scripts mbJMk5vq TfrGq8AP
```

Troubleshoot with a visible browser:

```
npm run grant -- --headed --users user1 --no-expiry
```

## Flags and Behavior

- `--headed` / `--show`
  - Run with a visible browser. Default is headless.
- `--list-only`
  - Print invite-only scripts to stdout. Does not write files or grant access.
- `--refresh-invite-list`
  - Enumerate invite-only scripts and write `script-selection.json`. This is your single source of truth; toggle `enabled` to include/exclude.
  - Requires `--profile-url https://www.tradingview.com/u/<user>/#published-scripts`.
- `--grant`
  - Perform the grant flow. Used in `npm run grant`.
- `--users`
  - One or more TradingView usernames. Accepts space- or comma-separated lists. Required for `--grant`.
- `--scripts`
  - Optional scripts to process directly (URLs or IDs); space- or comma-separated. Skips profile enumeration.
- `--no-expiry` | `--expires YYYY-MM-DD` | `--days N`
  - Choose the expiry behavior. One of these is required when granting access.
- `--all`
  - Process all invite-only scripts from enumeration, ignoring `script-selection.json`. Use carefully for bulk operations.
- `--profile-url`
  - Your profile scripts page URL. Required for `--refresh-invite-list` and `--list-only`. Also required for `grant` if you are not using `--scripts` or an up-to-date `script-selection.json`.

Notes
- Invite-only filter is always applied; privacy is not modified, and both public and private invite-only scripts are included.
- The grant flow revokes existing access for a user first, then re-adds with the specified expiry so you can update a subscription period safely.

## Examples

1) Build selection, enable a few, grant to one user without expiry

```
npm run refresh-invite-list -- --profile-url https://www.tradingview.com/u/YourUser/#published-scripts
# edit script-selection.json -> set enabled: true for a few scripts
npm run grant -- --users upslidedown --no-expiry
```

2) Grant to multiple users with a fixed date expiry (headless)

```
npm run grant -- --users godzcopilot --expires 2025-12-31
```

3) Grant directly to a specific script by URL

```
npm run grant -- --users godzcopilot --days 30 --scripts https://www.tradingview.com/script/mbJMk5vq-Adaptive-SwitchBack/
```

4) Troubleshoot with a visible browser

```
npm run grant -- --headed --users godzcopilot --no-expiry
```

## Files

- `index.js` — main automation script
- `save-session.js` — standalone interactive auth to save `tv-storage.json`
- `package.json` — npm scripts and dependencies
- `script-selection.json` — single file to curate which scripts are managed (written by `refresh-invite-list`)
