'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'tracker.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// Schéma
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS exercises (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name    TEXT NOT NULL UNIQUE,
    factor  REAL NOT NULL DEFAULT 1.0,  -- pondération volume biceps (rowing = 0.5, etc.)
    active  INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    date  TEXT NOT NULL,                -- ISO YYYY-MM-DD
    notes TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS sets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    exercise_id INTEGER NOT NULL REFERENCES exercises(id),
    weight      REAL NOT NULL DEFAULT 0,   -- kg (lest ou haltère), 0 = poids du corps
    reps        INTEGER NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Seed : exercices du programme + cibles par défaut
const seedExercises = [
  ['Chin-ups lestés', 1.0],
  ['Curl haltères supination', 1.0],
  ['Curl marteau', 1.0],
  ['Rowing supination', 0.5],
];
const insertEx = db.prepare('INSERT OR IGNORE INTO exercises (name, factor) VALUES (?, ?)');
for (const [name, factor] of seedExercises) insertEx.run(name, factor);

const setSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
setSetting.run('weekly_target_min', '12');
setSetting.run('weekly_target_max', '15');
setSetting.run('sessions_per_week', '3');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Lundi de la semaine ISO contenant la date donnée (YYYY-MM-DD). */
function isoWeekMonday(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const day = d.getUTCDay() || 7; // dimanche = 7
  d.setUTCDate(d.getUTCDate() - day + 1);
  return d.toISOString().slice(0, 10);
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Exercices --------------------------------------------------------------
app.get('/api/exercises', (req, res) => {
  res.json(db.prepare('SELECT * FROM exercises WHERE active = 1 ORDER BY id').all());
});

app.post('/api/exercises', (req, res) => {
  const { name, factor } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name requis' });
  const f = Number.isFinite(+factor) ? Math.max(0, Math.min(1, +factor)) : 1.0;
  try {
    const info = db.prepare('INSERT INTO exercises (name, factor) VALUES (?, ?)').run(name.trim(), f);
    res.status(201).json(db.prepare('SELECT * FROM exercises WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    res.status(409).json({ error: 'Exercice déjà existant' });
  }
});

// --- Séances ----------------------------------------------------------------
app.get('/api/sessions', (req, res) => {
  const limit = Math.min(+(req.query.limit || 30), 200);
  const sessions = db
    .prepare('SELECT * FROM sessions ORDER BY date DESC, id DESC LIMIT ?')
    .all(limit);
  const setsStmt = db.prepare(`
    SELECT s.id, s.exercise_id, e.name AS exercise, e.factor, s.weight, s.reps
    FROM sets s JOIN exercises e ON e.id = s.exercise_id
    WHERE s.session_id = ? ORDER BY s.id
  `);
  res.json(sessions.map((sess) => ({ ...sess, sets: setsStmt.all(sess.id) })));
});

app.post('/api/sessions', (req, res) => {
  const date = (req.body && req.body.date) || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date invalide (YYYY-MM-DD)' });
  const existing = db.prepare('SELECT * FROM sessions WHERE date = ?').get(date);
  if (existing) return res.json(existing); // une séance par jour : idempotent
  const info = db.prepare('INSERT INTO sessions (date) VALUES (?)').run(date);
  res.status(201).json(db.prepare('SELECT * FROM sessions WHERE id = ?').get(info.lastInsertRowid));
});

app.delete('/api/sessions/:id', (req, res) => {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- Séries -----------------------------------------------------------------
app.post('/api/sessions/:id/sets', (req, res) => {
  const { exercise_id, weight, reps } = req.body || {};
  const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'séance introuvable' });
  if (!Number.isFinite(+exercise_id) || !Number.isFinite(+reps) || +reps <= 0) {
    return res.status(400).json({ error: 'exercise_id et reps > 0 requis' });
  }
  const w = Number.isFinite(+weight) ? +weight : 0;
  const info = db
    .prepare('INSERT INTO sets (session_id, exercise_id, weight, reps) VALUES (?, ?, ?, ?)')
    .run(session.id, +exercise_id, w, Math.round(+reps));
  const row = db
    .prepare(`SELECT s.id, s.exercise_id, e.name AS exercise, e.factor, s.weight, s.reps
              FROM sets s JOIN exercises e ON e.id = s.exercise_id WHERE s.id = ?`)
    .get(info.lastInsertRowid);
  res.status(201).json(row);
});

app.delete('/api/sets/:id', (req, res) => {
  db.prepare('DELETE FROM sets WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- Stats ------------------------------------------------------------------
// Volume hebdo pondéré + nombre de séances, sur N dernières semaines.
app.get('/api/stats/weekly', (req, res) => {
  const weeks = Math.min(+(req.query.weeks || 10), 52);
  const rows = db
    .prepare(`
      SELECT sess.date, e.factor
      FROM sets s
      JOIN sessions sess ON sess.id = s.session_id
      JOIN exercises e ON e.id = s.exercise_id
    `)
    .all();
  const sessionDates = db.prepare('SELECT DISTINCT date FROM sessions').all().map((r) => r.date);

  const byWeek = {};
  for (const r of rows) {
    const wk = isoWeekMonday(r.date);
    byWeek[wk] = byWeek[wk] || { volume: 0, sessions: new Set() };
    byWeek[wk].volume += r.factor;
  }
  for (const d of sessionDates) {
    const wk = isoWeekMonday(d);
    byWeek[wk] = byWeek[wk] || { volume: 0, sessions: new Set() };
    byWeek[wk].sessions.add(d);
  }

  // Génère les N dernières semaines, même vides
  const out = [];
  const today = new Date().toISOString().slice(0, 10);
  let monday = isoWeekMonday(today);
  for (let i = 0; i < weeks; i++) {
    const entry = byWeek[monday] || { volume: 0, sessions: new Set() };
    out.unshift({ week: monday, volume: Math.round(entry.volume * 10) / 10, sessions: entry.sessions.size });
    const d = new Date(monday + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - 7);
    monday = d.toISOString().slice(0, 10);
  }
  res.json({ settings: getSettings(), weeks: out });
});

// Meilleure série (charge, puis reps) et dernière série, par exercice.
app.get('/api/stats/progress', (req, res) => {
  const exercises = db.prepare('SELECT * FROM exercises WHERE active = 1 ORDER BY id').all();
  const bestStmt = db.prepare(`
    SELECT s.weight, s.reps, sess.date FROM sets s
    JOIN sessions sess ON sess.id = s.session_id
    WHERE s.exercise_id = ?
    ORDER BY s.weight DESC, s.reps DESC LIMIT 1
  `);
  const lastStmt = db.prepare(`
    SELECT s.weight, s.reps, sess.date FROM sets s
    JOIN sessions sess ON sess.id = s.session_id
    WHERE s.exercise_id = ?
    ORDER BY sess.date DESC, s.id DESC LIMIT 1
  `);
  res.json(
    exercises.map((e) => ({
      exercise: e.name,
      best: bestStmt.get(e.id) || null,
      last: lastStmt.get(e.id) || null,
    }))
  );
});

// --- Réglages ----------------------------------------------------------------
app.get('/api/settings', (req, res) => res.json(getSettings()));

app.put('/api/settings', (req, res) => {
  const allowed = ['weekly_target_min', 'weekly_target_max', 'sessions_per_week'];
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const k of allowed) {
    if (req.body && req.body[k] !== undefined) upsert.run(k, String(req.body[k]));
  }
  res.json(getSettings());
});

// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Biceps tracker sur http://localhost:${PORT} — DB: ${DB_PATH}`);
});
