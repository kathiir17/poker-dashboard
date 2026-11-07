# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A poker night dashboard for the Sivanehru family and friends: leaderboard, session scorer, history, per-player stats, and rules. The whole app is one file, `index.html` (inline CSS + vanilla JS, no framework, no build step, no dependencies, no tests).

## Running and deploying

- **Run locally:** `open index.html` (opens in the default browser). It talks to the live Supabase database even when run locally — saving or deleting a session locally changes real data.
- **Deploy:** GitHub Pages serves `main` at the repo root → https://kathiir17.github.io/poker-dashboard/. **Pushing to `main` publishes immediately**, so verify changes locally before pushing.

## Architecture (`index.html`)

The `<script>` is divided into sections marked with `// ══════ NAME ══════` banners.

**Persistence.** All data lives in a single row of the Supabase `sessions` table, in its `data` JSON column, accessed via the REST API with the public anon key (`dbLoad`/`dbSave`). Every change rewrites the entire `seasons` array (`persist()`); there is no per-session row. There is no auth or concurrency control — last write wins.

**Data model.** `seasons = [{name, system, sessions:[{name, date:"DD/MM/YYYY", results:[{player, buyin, final}]}]}]`. Money is in £. `init()` migrates old data: if the stored row isn't in the seasons format, it re-seeds from the hard-coded `SEASON1` constant plus an empty Season 2 and overwrites the DB.

**Scoring systems.** Two coexist:
- `"pnl"` (current): players ranked by *shrunk* average PnL, `pnlTot / (n + K)` with `K=3`, which pulls players with few sessions toward zero.
- `"old"` (Season 1 only): bucketed points from `final/buyin` multiple (`BKT`, `interpPts`) times a rebuy penalty (`rebuyMult`). Archived seasons with `system:"old"` get a toggle to view either system; the global `SYS` controls which metric `ranked()` uses.

**Views and state.** Global mutable state (`seasons`, `curSeason`, `SYS`, `TAB`, scorer/edit vars). `render()` dispatches to one `renderX()` per tab, each of which rebuilds its panel with `innerHTML` template strings; event handlers are inline `onclick`/`oninput` attributes calling global functions. Charts are hand-built SVG strings (`barCentred`, `barSimple`, `formChart`).

**Seasons and read-only rules.** `curSeason === -1` means the "All time" view. Only the last season (`isActiveSeason()`) is editable; archived seasons and All time are read-only in the Session and History tabs. In All time, `curSessions()` returns a *new flattened copy*, so mutating it does not persist — any write path must stay gated by `isActiveSeason()`.

**Player identity.** Players are plain name strings; `KNOWN` fixes avatar colours for regulars, others get a colour by name hash. A typo in a name creates a separate player.
