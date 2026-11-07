# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A poker night dashboard for the Sivanehru family and friends: leaderboard, session scorer, history, per-player stats, and rules. The app is `index.html` (inline CSS + vanilla JS, no framework, no build step, no tests) plus `db.js`, the only file that talks to the database (Firebase Firestore, SDK loaded from Google's CDN).

## Running and deploying

- **Run locally:** `python3 -m http.server 8000` in the repo, then open http://localhost:8000 (`db.js` is an ES module, which browsers block from `file://`). It talks to the live Firestore database even when run locally — saving or deleting a session locally changes real data.
- **Deploy:** GitHub Pages serves `main` at the repo root → https://kathiir17.github.io/poker-dashboard/. **Pushing to `main` publishes immediately**, so verify changes locally before pushing.

## Architecture (`index.html`)

The `<script>` is divided into sections marked with `// ══════ NAME ══════` banners.

**Persistence.** Firestore project `poker-dashboard-bf0db`, no auth. `db.js` exposes `window.DB` (`loadAll`, `saveSession`, `deleteSession`, `startNewSeason`, …) and fires `db-ready`; `index.html` never imports Firebase. Each save writes one session document. Write paths update in-memory state only after the write succeeds.

**Firestore layout.** `config/app {activeSeasonNumber}` · `eras/{era-1|era-2}` · `eras/{era}/seasons/s{n} {name, number, system}` · `.../sessions/{id} {seq, name, date:"DD/MM/YYYY", results:[{player, buyin, final}]}` · `players/{name}`. Money is in £. Era 1 is the pre-November 2026 data, archived read-only; Era 2 is live. **On screen they are called "Chapter 1" and "Chapter 2"** (the pooled view of both is "All time" in the Chapter picker); the ids `era-1`/`era-2` are internal only.

**Security rules** live in `firestore.rules` and are applied by pasting into the Firebase console (Firestore → Rules → Publish); they are not deployed from the repo. They make Era 1 unwritable, let anyone add/edit/delete Era 2 sessions (shape-checked), only allow a new season numbered active+1, and make players add-only. The app's client-side checks (DD/MM/YYYY date, 2–20 players, name ≤60) mirror them.

**Admin key.** `~/code/secrets/poker-admin-key.json` (bypasses the security rules) — never copy it into the repo or print it.

**Scoring systems.** Two coexist:
- `"pnl"` (current): players ranked by *shrunk* average PnL, `pnlTot / (n + K)` with `K=3`, which pulls players with few sessions toward zero.
- `"old"` (Season 1 only): bucketed points from `final/buyin` multiple (`BKT`, `interpPts`) times a rebuy penalty (`rebuyMult`). Archived seasons with `system:"old"` get a toggle to view either system; the global `SYS` controls which metric `ranked()` uses.

**Views and state.** Global mutable state (`DATA`, `VIEW`, `seasons`, `curSeason`, `SYS`, `TAB`, scorer/edit vars). `VIEW` is `'era-2'`, `'era-1'` (Chapter 1) or `'all'`; `setView()` points `seasons` at that view's seasons. `render()` dispatches to one `renderX()` per tab, each of which rebuilds its panel with `innerHTML` template strings; event handlers are inline `onclick`/`oninput` attributes calling global functions. Charts are hand-built SVG strings (`barCentred`, `barSimple`, `formChart`).

**Seasons and read-only rules.** `curSeason === -1` means "All seasons" of the chosen chapter. `canEdit()`: any Era 2 season can be edited/deleted in History; `isActiveSeason()`: new sessions only go into the current Era 2 season. Chapter 1, All seasons and the pooled All time view are read-only. With curSeason -1, `curSessions()` returns a *new flattened copy*, so mutating it does not persist — any write path must stay gated by `canEdit()`.

**Player identity.** Players are plain name strings; `KNOWN` fixes avatar colours for regulars, others get a colour by name hash. A typo in a name creates a separate player.
