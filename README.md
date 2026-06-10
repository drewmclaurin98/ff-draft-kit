# FF Draft Kit — War Room

A single-file, live fantasy football draft board for offline drafts where some owners join remotely. Everyone opens the same page on their own device (phone, laptop, or a TV in the room) and picks sync live across all of them.

**Live demo (after enabling GitHub Pages):** `https://drewmclaurin98.github.io/ff-draft-kit/`

## Features

- **Live shared board** — picks sync across every device viewing the page (in-person + remote).
- **Configurable draft** — teams, rounds, snake/linear order, seconds per pick.
- **Exact draft order** — arrange owners with ↑/↓ controls (top = pick 1.01).
- **Traded picks** — reassign any individual pick to a new owner; the order is unchanged, only who keeps that pick.
- **Keepers** — one per team at a chosen round cost; locked out of the pool and shown on the board from the start.
- **Absent owners** — flag a team Remote, build a pre-ranked queue, and use Autopick on their turn.
- **Excel import** — load draft order, traded picks, and keepers from one spreadsheet (downloadable template included in the app).
- **Excel export** — Picks by Round + Rosters sheets, including keepers (even mid-draft).
- Pre-loaded with a current half-PPR consensus player list (editable).

## How it's built

Everything lives in one file (`index.html`) — HTML, CSS, and JavaScript, no build step.
It uses [SheetJS](https://sheetjs.com/) (loaded from a CDN) for Excel import/export.

> **Note on live sync:** the cross-device sync relies on a shared key-value storage API
> provided by the Claude Artifacts runtime (`window.storage`). When the page is hosted on
> GitHub Pages, that API is not present, so the app automatically falls back to **local-only
> mode** (it still works on a single device, the status dot reads "Local only"). To get true
> multi-device sync, run it inside the Claude Artifacts environment, or swap the storage layer
> (see `Store` in `index.html`) for your own backend (e.g. Firebase, Supabase, or a small
> WebSocket server). The storage interface it expects is just `get/set` on a shared key.

## Run locally

Just open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Enable GitHub Pages

1. Push this repo (see below).
2. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**.
3. Branch: `main`, folder: `/ (root)`. Save.
4. Wait ~1 minute, then open `https://drewmclaurin98.github.io/ff-draft-kit/`.
