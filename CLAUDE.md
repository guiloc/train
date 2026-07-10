# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Carnet de charge — Biceps": a personal biceps-training tracker and auto-planner. Node.js/Express backend with a `better-sqlite3` database, and a single-file vanilla-JS/HTML frontend. No build step, no framework, no tests.

The whole app is three files: `server.js` (backend + schema + planning logic), `public/index.html` (entire frontend: markup, CSS, and JS in one file), and `README.md` (French; documents the API and deployment).

## Atomic Habits principles — apply to every feature decision

This app's entire reason for existing is habit formation (James Clear's *Atomic Habits*), not just workout logging. Any new feature, UI change, or planning-logic tweak should be checked against these before being built:

- **Make it obvious** — never make the user decide what to do. The auto-proposed plan and the week calendar exist so there's always a single obvious next action, not a choice.
- **Make it easy** — minimize input friction (exercise → kg → reps → Enter; one-tap checkmarks). Don't add steps, confirmations, or required fields to the logging path.
- **Make it satisfying** — immediate visible feedback for showing up: checkmarks, streak counter, toasts. Reward the action of logging, not just eventual PRs.
- **The 2-minute rule** — the habit must always be scalable down to something trivial ("une seule série validée suffit à maintenir la chaîne"). Never design a feature that makes a full/complete session the only thing that "counts."
- **Never miss twice** — missing one session (or a mandatory rest day) is normal and expected; missing two in a row is what actually breaks a habit. Prefer nudges/alerts framed around "don't miss twice" over rigid weekly quotas — this is already the intent behind the weekly alert and should guide any similar feature.
- **Identity over outcome** — the point is "someone who shows up," not chasing a number. Don't build features that shame or guilt-trip on missed volume/PRs; keep tone matter-of-fact (see existing copy in `public/index.html`).

## Commands

```bash
npm install
npm start          # node server.js — http://localhost:3000
npm run dev         # node --watch server.js — auto-restart on change
```

There is no lint, build, or test command/config in this project — don't invent one.

The SQLite DB is created automatically at `./data/tracker.db` (override with `DB_PATH` env var; port via `PORT`). Deleting `data/tracker.db*` resets all state — schema and seed data recreate on next start.

`server.js` auto-loads a local `.env` file if present (simple `KEY=VALUE` parser, no dependency; real environment variables always take precedence). `.env` is gitignored — create one locally for `BASIC_AUTH_USER`/`BASIC_AUTH_PASS` instead of exporting them each time.

## Architecture

**Backend (`server.js`)** is a single file, top to bottom:
1. DB setup (`better-sqlite3`, WAL mode, FK on) and inline schema (`exercises`, `sessions`, `sets`, `settings` tables), with seed data for the 4 default exercises and default weekly targets.
2. Plain Express routes for CRUD on exercises/sessions/sets and stats (`/api/stats/weekly`, `/api/stats/progress`).
3. `buildPlan(date)` — the core domain logic, exposed via `GET /api/plan?date=`. This is what makes the app "auto-proposed": given any date (past, today, or future), it computes which exercises to do, how many sets, and target weight/reps, with no client-side calculation. Key pieces:
   - **Mandatory rest day**: first thing `buildPlan` checks is whether `date - 1` had a real logged session (`hasSetsOn(prevDay(date))`); if so it short-circuits and returns `{ date, rest: true, items: [], ... }` — no exercises, no rotation/progression computed. At least one rest day between sessions is a hard rule, not a suggestion.
   - **Rotation**: exercises ordered by least-recently-trained (`lastDate` per exercise).
   - **Double progression**: same weight aiming for +1 rep; once every set of an exercise hits `REP_MAX` (12), jump weight by `WEIGHT_INCREMENT` (2.5kg) and reset to `REP_MIN` (8) reps. Based on the exercise's last session strictly before the plan's date, so the plan stays stable while today's session is in progress.
   - **Weekly volume budget**: sessions/week and min/max weekly targets (`settings` table) determine a per-session set budget, capped by what's left in the ISO week (Monday-anchored, see `isoWeekMonday`). Once the weekly target is met, the plan switches to a 1-set "maintenance" session (`maintenance: true`) to preserve the habit streak rather than stopping outright.
   - Each exercise's contribution to volume is weighted by its `factor` (0–1; e.g. rowing counts 0.5 toward biceps volume, isolation moves count 1.0).
   - `done_sets`/`done_log` on each plan item reflect sets already logged on `date`, so the frontend can show completed checkmarks and the plan is idempotent to reload.
   - Calling `buildPlan` with a future date does **not** simulate intervening training days — it only looks at real logged sets before that date. This was a deliberate choice (see git history): an earlier version cascaded a simulated "every intervening day fully trained" chain in a rolled-back transaction, but that's unrealistic for muscle recovery. Don't reintroduce cascading simulation without discussing it — any future date just previews "what if this were the next session, assuming nothing happens before it," so several future days in a row can legitimately show identical content.
4. Auth is a single blanket middleware ahead of everything else, not per-route logic — see "Auth" below.

**Frontend (`public/index.html`)** is a single IIFE with no dependencies (no bundler, no framework). Four tabs (Séance/Volume/Progrès/Réglages) toggled by hiding/showing `<section>`s. Notable patterns:
- All server communication goes through a tiny `api()` wrapper around `fetch`.
- The weekly volume chart in the "Volume" tab is hand-rolled inline SVG (no charting library) — bars colored by whether they land in the target zone.
- "Streak" (chaîne) is computed client-side in `updateStreak()` from the weekly stats, not stored server-side.
- One session per calendar day; `ensureSession()` lazily creates/fetches it on the first set logged, matching the backend's idempotent `POST /api/sessions`.
- **Week calendar** (`renderWeekCal`, "Cette semaine" card): a Mon–Sun strip derived from `/api/sessions`, no dedicated backend endpoint. Per-day status priority is `done` (sets logged) > `repos` (previous day was trained — mirrors the backend's rest rule, computed client-side via `prevISO`) > `future`/`missed`. Only today and future days are clickable (`viewDate` state); clicking fetches `/api/plan?date=` and renders it **read-only** in the "Séance proposée" card (swapped to "Séance prévue" with a "← Aujourd'hui" back button), reusing the same `.plan-ex`/`.plan-head` markup as the live interactive plan minus the checkboxes.
- **Weekly alert** (`updateWeekAlert`, in `loadWeekly`): warns when hitting `sessions_per_week` is no longer mathematically possible given days left in the ISO week, using a greedy max-packing simulation that respects the mandatory-rest-day rule (`todayTrained` flag, set by `renderWeekCal`, gates the packing loop). `refresh()` deliberately awaits `loadSessions()` before `loadWeekly()` so `todayTrained` is fresh before the alert computes — don't reorder those without keeping that dependency in mind.

**Data model**: `exercises(id, name, factor, active)`, `sessions(id, date, notes)` (one row per day), `sets(id, session_id, exercise_id, weight, reps, created_at)` (`weight = 0` means bodyweight), `settings(key, value)` (weekly volume min/max, sessions/week).

## Auth

HTTP Basic auth is built in but **opt-in**: the middleware in `server.js` only activates if both `BASIC_AUTH_USER` and `BASIC_AUTH_PASS` are set (constant-time comparison via `crypto.timingSafeEqual`); otherwise the app is fully open, matching local dev. It's installed before `express.json()`/`express.static`, so it gates the whole app (static frontend + every API route) — there's no per-route auth logic to maintain.

## Deployment (Railway)

- **DB persistence requires a Volume**: without one, `data/tracker.db` lives on the container's ephemeral filesystem and is wiped on every redeploy. Mount a volume at `/data` and set `DB_PATH=/data/tracker.db`. Attach the volume *before* accumulating real data on a deploy — a volume added later starts empty, it doesn't adopt whatever was already on the ephemeral disk.
- Set `BASIC_AUTH_USER`/`BASIC_AUTH_PASS` as real Railway service variables (Settings → Variables) to lock down the public `*.up.railway.app` URL — there's no `.env` file on Railway (it's gitignored, never pushed), so these must be set directly in the platform's env var UI.
- Railway serves over HTTPS by default, so Basic Auth credentials aren't sent in the clear.

## Notes for changes

- Keep domain logic (progression, rotation, volume budgeting, rest-day rule) in `buildPlan()` server-side — the frontend intentionally does no planning math, only rendering and set-logging/read-only previews.
- `factor` is clamped to `[0, 1]` server-side on exercise creation (`Math.max(0, Math.min(1, +factor))`); keep that invariant if touching that route.
