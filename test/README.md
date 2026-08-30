# Tests

Two browser tests that run the **real** `index.html` across several simulated
devices at once. No Firebase project, no network, no draft night required.

Each test builds an offline copy of `index.html` (external `<script src>` tags
stripped), opens it in N iframes inside one Chromium page, and points all of
them at a shared in-memory fake Realtime Database (`fake-firebase.js`) that
delays every message and counts every byte.

## Setup

```bash
npm install --no-save playwright
```

Chromium is found automatically at `/opt/pw-browsers/...`, `/usr/bin/chromium`,
or wherever `CHROME_PATH` points. Nothing is downloaded.

## Load test

Measures what a draft actually costs each phone in the room.

```bash
node test/loadtest.mjs                                  # defaults: 12 teams, 15 rounds
node test/loadtest.mjs --teams 12 --rounds 15 --pool 1400 --latency 40
node test/loadtest.mjs --file /path/to/other.html       # compare against another build
node test/loadtest.mjs --headful                        # watch it happen
```

Reports bytes broadcast per pick, total draft traffic, sync latency
percentiles, and whether two simultaneous picks both survive.

## Functional test

Regression checks for keepers, traded picks, undo, autopick queues, cross-device
agreement, export/resume, and write races.

```bash
node test/functional.mjs
node test/functional.mjs --file /path/to/other.html
```

Exits non-zero on failure, so it drops straight into CI if you ever want it there.

## Baseline

Measured with 12 devices, 15 rounds, a 1,400-player pool and a 40ms link:

| | before | after |
|---|---|---|
| per pick, per device | 140.6 KB | 7.4 KB |
| whole draft, all devices | 293 MB | 15.4 MB |
| two simultaneous picks | 1 of 2 survived | 2 of 2 survived |
