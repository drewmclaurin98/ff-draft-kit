# FF Draft Kit

A single-file, live fantasy football draft board for in-person drafts where some owners join remotely. Everyone opens the same URL on their own device (phone, laptop, or a TV in the room) and picks sync live across all of them via Firebase.

**Live demo:** `https://drewmclaurin98.github.io/ff-draft-kit/`

---

## Features

- **Live shared board** — picks sync in real time across every device via Firebase Realtime Database.
- **Configurable draft** — set number of teams, rounds, snake or linear order, and seconds per pick.
- **Exact draft order** — arrange owners with up/down controls before the draft starts (top = pick 1.01).
- **Traded picks** — reassign any individual pick to a different owner; slot order stays the same, only the recipient changes.
- **Keepers** — one keeper per team at a chosen round cost; the player is locked out of the pool and shown on the board before the draft begins.
- **Absent owners** — flag a team as Remote, build a pre-ranked queue for them, and use Autopick when it's their turn.
- **Commissioner mode** — PIN-protected access so only the commissioner can control setup, start/reset the draft, undo picks, run autopick, and manage queues.
- **Excel import** — load draft order, traded picks, and keepers from a spreadsheet (a blank template is downloadable inside the app).
- **Excel export** — exports a Picks by Round sheet, a Rosters sheet, and a hidden Draft State sheet that lets you resume the exact draft later.
- **Draft resume** — import a previously exported file mid-draft to restore the full state (picks, queues, config) on any device.
- **Expand board** — a fullscreen button overlays the draft board across the entire viewport for easy viewing on a shared TV.
- Pre-loaded with a current half-PPR consensus player list (editable in setup).

---

## How the draft works

### 1. Setup (commissioner only)

Before starting the draft the commissioner fills out the Setup screen:

- **Teams** — enter each owner's name and arrange them in draft order with the up/down arrows. The team at the top of the list holds pick 1.01.
- **Rounds** — how many rounds the draft runs.
- **Draft type** — Snake reverses the order every other round (1–2–3–3–2–1…); Linear keeps the same order every round.
- **Pick timer** — optional countdown in seconds per pick. Set to 0 to disable.
- **Keepers** — for each team that has a keeper, select the player and the round that pick is "spent" on. The cell for that round is pre-filled on the board and the player is removed from the available pool.
- **Traded picks** — reassign individual round slots to a different team. The slot stays in the original position in the order; the board just shows who actually owns it.
- **Player pool** — the list of available players loaded at startup. Names, positions, and teams can be edited directly in the pool editor.

Click **Start Draft** when ready. This locks the config and syncs it to all connected devices.

### 2. The draft board

The draft board is a grid with one column per team and one row per round. Each cell shows:

- The drafted player's name, position badge, and pick number (e.g. 3.05)
- A "KEEPER" label for pre-set keepers
- A "→ Owner" label if the pick was traded to a different team

The column header for the team currently on the clock is highlighted. After each pick the board automatically scrolls to center that team's column.

The **Draft Board** and **Rosters** tabs switch between the grid view and a card-per-team roster view. On mobile, the Players list and the Board are in separate tabs so both panels are fully usable on a small screen.

### 3. Making a pick

When it is a team's turn:

1. Find the player in the **Players** panel on the left. Use the search box or filter by position (QB / RB / WR / TE / K / DST).
2. Click the player's row. A **Draft** button appears (always visible on mobile).
3. Click **Draft** to confirm. The pick is written to Firebase instantly and all devices update within a second.

The player is removed from the pool and their name fills the corresponding cell on the board.

### 4. Pick timer

If a timer was configured, a countdown bar runs during each pick. When it hits zero the turn passes automatically (commissioner can also use Autopick manually at any time).

### 5. Autopick and queues

For owners who are absent or remote and can't pick for themselves:

- Mark their team **Remote** in setup.
- During the draft, open the **Pre-Draft Queue** panel and add players in priority order using the **+Q** button next to any player.
- When that team's pick comes up, click **Autopick** (or wait for the timer) to draft the highest-available player from their queue. If the queue is exhausted, Autopick picks the highest-ranked available player.

### 6. Commissioner controls

The commissioner PIN is set in `index.html` (search for `COMMISSIONER_PIN`). Anyone who opens the page without the PIN sees a view-only board and can only draft when it is their own team's turn.

With the PIN entered (via the commissioner button in the top bar), the commissioner can:

- Edit setup and reset the draft
- Start the draft and undo the last pick
- Run Autopick for any team
- Manage pre-draft queues
- Export/import the draft state

### 7. Export and resume

Click **Export to Excel** at any point during or after the draft. The file contains:

- **Picks by Round** — the full board in spreadsheet form
- **Rosters** — each team's picks listed together
- **Draft State** (hidden sheet) — a complete JSON snapshot of the draft

To resume a draft on another day, import that same exported file. The app detects the Draft State sheet and restores the exact pick history, config, queues, and traded picks — no manual editing needed. The restored state is pushed to Firebase so all devices sync immediately.

---

## How it's built

Everything lives in one file (`index.html`) — HTML, CSS, and JavaScript, no build step.

- **[Firebase Realtime Database](https://firebase.google.com/docs/database)** (compat SDK v10) — real-time push sync across all devices. The app listens with `onValue` so updates arrive in under a second without polling.
- **[SheetJS](https://sheetjs.com/)** — Excel import and export.
- **Fallback** — if `FIREBASE_CONFIG.databaseURL` is empty the app runs in local-only mode (single device, no sync). The status dot in the top bar reads "Local only".

To use your own Firebase project: create a Realtime Database (start in test mode), copy the web app config into the `FIREBASE_CONFIG` block near the top of the `<script>` section, and update the database security rules when you're ready to restrict access.

---

## Run locally

Open `index.html` directly in a browser, or serve the folder to avoid any browser file-protocol restrictions:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

---

## Enable GitHub Pages

1. Push this repo to GitHub.
2. Go to **Settings → Pages → Build and deployment → Source: Deploy from a branch**.
3. Branch: `main`, folder: `/ (root)`. Save.
4. Wait ~1 minute, then open `https://drewmclaurin98.github.io/ff-draft-kit/`.
