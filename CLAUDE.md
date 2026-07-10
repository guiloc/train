# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Carnet de charge — Biceps": a personal biceps-training tracker and auto-planner. Node.js/Express backend with a `better-sqlite3` database, and a single-file vanilla-JS/HTML frontend. No build step, no framework, no tests.

The whole app is three files: `server.js` (backend + schema + planning logic), `public/index.html` (entire frontend: markup, CSS, and JS in one file), and `README.md` (French; documents the API and deployment).

## Commands

```bash
npm install
npm start          # node server.js — http://localhost:3000
npm run dev         # node --watch server.js — auto-restart on change
```

There is no lint, build, or test command/config in this project — don't invent one.

The SQLite DB is created automatically at `./data/tracker.db` (override with `DB_PATH` env var; port via `PORT`). Deleting `data/tracker.db*` resets all state — schema and seed data recreate on next start.

## Architecture

**Backend (`server.js`)** is a single file, top to bottom:
1. DB setup (`better-sqlite3`, WAL mode, FK on) and inline schema (`exercises`, `sessions`, `sets`, `settings` tables), with seed data for the 4 default exercises and default weekly targets.
2. Plain Express routes for CRUD on exercises/sessions/sets and stats (`/api/stats/weekly`, `/api/stats/progress`).
3. `buildPlan(date)` — the core domain logic, exposed via `GET /api/plan`. This is what makes the app "auto-proposed": given a date, it computes which exercises to do, how many sets, and target weight/reps, with no client-side calculation. Key pieces:
   - **Rotation**: exercises ordered by least-recently-trained (`lastDate` per exercise).
   - **Double progression**: same weight aiming for +1 rep; once every set of an exercise hits `REP_MAX` (12), jump weight by `WEIGHT_INCREMENT` (2.5kg) and reset to `REP_MIN` (8) reps. Based on the exercise's last session strictly before the plan's date, so the plan stays stable while today's session is in progress.
   - **Weekly volume budget**: sessions/week and min/max weekly targets (`settings` table) determine a per-session set budget, capped by what's left in the ISO week (Monday-anchored, see `isoWeekMonday`). Once the weekly target is met, the plan switches to a 1-set "maintenance" session (`maintenance: true`) to preserve the habit streak rather than stopping outright.
   - Each exercise's contribution to volume is weighted by its `factor` (0–1; e.g. rowing counts 0.5 toward biceps volume, isolation moves count 1.0).
   - `done_sets` on each plan item reflects sets already logged today, so the frontend can show completed checkmarks and the plan is idempotent to reload.

**Frontend (`public/index.html`)** is a single IIFE with no dependencies (no bundler, no framework). Four tabs (Séance/Volume/Progrès/Réglages) toggled by hiding/showing `<section>`s. Notable patterns:
- All server communication goes through a tiny `api()` wrapper around `fetch`.
- The weekly volume chart in the "Volume" tab is hand-rolled inline SVG (no charting library) — bars colored by whether they land in the target zone.
- "Streak" (chaîne) is computed client-side in `updateStreak()` from the weekly stats, not stored server-side.
- One session per calendar day; `ensureSession()` lazily creates/fetches it on the first set logged, matching the backend's idempotent `POST /api/sessions`.

**Data model**: `exercises(id, name, factor, active)`, `sessions(id, date, notes)` (one row per day), `sets(id, session_id, exercise_id, weight, reps, created_at)` (`weight = 0` means bodyweight), `settings(key, value)` (weekly volume min/max, sessions/week).

## Notes for changes

- Keep domain logic (progression, rotation, volume budgeting) in `buildPlan()` server-side — the frontend intentionally does no planning math, only rendering and set-logging.
- The app has no authentication (see README's deployment section) — don't add auth-dependent assumptions without discussing it first, since the README explicitly leaves this as an intentional decision left to the deployer.
- `factor` is clamped to `[0, 1]` server-side on exercise creation (`Math.max(0, Math.min(1, +factor))`); keep that invariant if touching that route.
