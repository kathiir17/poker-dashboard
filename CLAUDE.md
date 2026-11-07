# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A poker night dashboard for the Sivanehru family and friends: leaderboard, session scorer, history, stats, player pages, rivals, awards and rules. No framework, no build step. Files:
- `index.html`: the app (inline CSS + vanilla JS): all screens and rendering.
- `stats.js`: pure calculations (no DOM, no database): session selection, player stats, running totals, rivals, headlines, awards. A plain script, so its functions are globals.
- `db.js`: the only file that talks to the database (Firebase Firestore, SDK loaded from Google's CDN).
- `test.html`: checks `stats.js` against the live data (read-only). Open http://localhost:8000/test.html. Checks marked LIVE use the current season / All time and need their expected values updating after new sessions.

## Running and deploying

- **Run locally:** `python3 -m http.server 8000` in the repo, then open http://localhost:8000 (`db.js` is an ES module, which browsers block from `file://`). It talks to the live Firestore database even when run locally — saving or deleting a session locally changes real data.
- **Deploy:** GitHub Pages serves `main` at the repo root → https://kathiir17.github.io/poker-dashboard/. **Pushing to `main` publishes immediately**, so verify changes locally before pushing.

## Architecture (`index.html`)

The `<script>` is divided into sections marked with `// ══════ NAME ══════` banners.

**Persistence.** Firestore project `poker-dashboard-bf0db`, no auth. `db.js` exposes `window.DB` (`loadAll`, `saveSession`, `deleteSession`, `startNewSeason`, …) and fires `db-ready`; `index.html` never imports Firebase. Each save writes one session document. Write paths update in-memory state only after the write succeeds.

**Firestore layout.** `config/app {activeSeasonNumber}` · `config/colours {colours:{playerName: colourId}}` · `eras/{era-1|era-2}` · `eras/{era}/seasons/s{n} {name, number, system}` (`system` is a leftover the app ignores; `firestore.rules` still require `"pnl"` on new seasons) · `.../sessions/{id} {seq, name, date:"DD/MM/YYYY", results:[{player, buyin, final}], deleted?}` (sessions are never removed: "Delete" sets `deleted:true` and `loadSeason` hides them; restore by removing the field in the Firebase console) · `players/{name}`. Money is in £. Era 1 is the pre-November 2026 data, archived read-only; Era 2 is live. **On screen they are called "Chapter 1" and "Chapter 2"** (the pooled view of both is "All time" in the Chapter picker); the ids `era-1`/`era-2` are internal only.

**Security rules** live in `firestore.rules` and are applied by pasting into the Firebase console (Firestore → Rules → Publish); they are not deployed from the repo. They make Era 1 unwritable, let anyone add/edit Era 2 sessions (shape-checked, no real deletes), only allow a new season numbered active+1, make players add-only, and only allow palette colour ids in `config/colours` with no colour used twice. The app's client-side checks (DD/MM/YYYY date, 2–20 players, name ≤60) mirror them.

**Admin key.** `~/code/secrets/poker-admin-key.json` (bypasses the security rules) — never copy it into the repo or print it.

**Scoring.** A session's score is its PnL (`final − buyin`). Players are ranked by *shrunk* average PnL, `pnlTot / (n + K)` with `K=3` (in `stats.js`), which pulls players with few sessions toward zero. Summary amounts are shown rounded to 25p; entered amounts (in/out, a session's PnL) are exact.

**Awards** are computed per season by `seasonAwards()` / `allAwards()` in `stats.js`, never stored: locked once a newer season exists, "leading" for the current one; ties all win.

**Views and state.** Global mutable state (`DATA`, `VIEW`, `seasons`, `curSeason`, `TAB`, chart/scorer/edit vars). `VIEW` is `'era-2'`, `'era-1'` (Chapter 1) or `'all'`; `setView()` points `seasons` at that view's seasons, and `selSessions()` gives the selection's sessions (tagged with chapter/season, date order) for `stats.js`. `render()` dispatches to one `renderX()` per tab (Table, scorer, Sessions, Stats, player page, Rival analysis, Awards, More, Rules, Player colours), each of which rebuilds its panel with `innerHTML` template strings; event handlers are inline `onclick`/`oninput` attributes calling global functions. The title and Chapter/Season pickers show only on Table, Stats and Sessions. Charts are hand-built SVG strings: `lineChart()` (running total or per session; session numbers for one season, real dates with month labels and season markers for a chapter or All time).

**Seasons and read-only rules.** `curSeason === -1` means "All seasons" of the chosen chapter. `canEdit()`: any Era 2 season can be edited/deleted in History; `isActiveSeason()`: new sessions only go into the current Era 2 season. Chapter 1, All seasons and the pooled All time view are read-only. With curSeason -1, `curSessions()` returns a *new flattened copy*, so mutating it does not persist — any write path must stay gated by `canEdit()`.

**Player identity and colours.** Players are plain name strings; a typo in a name creates a separate player. Each player has one chip colour from `PALETTE` (no two share). `resolveColours()` decides them: saved choices in `config/colours`, then `DEFAULT_COLOURS`, then the first unused colour. The whole resolved map is saved whenever colours are written (More → Player colours, or a session with a new player), so adding a player never shifts anyone else. **To add a palette colour, add it to `PALETTE` in `index.html` and to the id list in `firestore.rules`.**
