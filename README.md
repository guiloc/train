# Carnet de charge — Biceps

Tracker et planificateur d'entraînement biceps. Node.js/Express + SQLite (better-sqlite3), frontend vanilla.

Principes intégrés :
- **Séance auto-proposée** : en arrivant sur l'onglet Séance, le plan du jour est déjà calculé — exercices, charge, reps et nombre de séries — il n'y a qu'à cocher : chaque série affiche son objectif de reps (✓ = réussi tel quel, case « autre » sinon). Première séance : 7 reps, lest à zéro. Rotation des exercices les moins récemment travaillés, double progression (même charge en visant +1 rep, puis +2,5 kg et retour à 8 reps quand toutes les séries atteignent 12), volume plafonné par la cible hebdo. Cible atteinte → séance courte d'entretien pour garder la chaîne.
- **Volume hebdo pondéré** avec zone cible 12–15 séries (rowing compte 0,5)
- **Chaîne de régularité** (habit tracking façon *Atomic Habits*) : 3 séances/semaine
- **Progression visible** : record et dernière perf par exercice
- Saisie minimale : exercice → kg → reps → Entrée

## Lancer en local

```bash
npm install
npm start
# http://localhost:3000
```

La base est créée automatiquement dans `./data/tracker.db`.

## Déployer sur Railway

1. Pousser le repo :
   ```bash
   git init && git add . && git commit -m "init biceps tracker"
   git remote add origin <ton-repo>
   git push -u origin main
   ```
2. Sur Railway : **New Project → Deploy from GitHub repo**. Railway détecte Node et lance `npm start` (le port est lu via `process.env.PORT`).
3. **Persistance de la base — indispensable** : sans volume, la SQLite est effacée à chaque redéploiement.
   - Sur le service : **Settings → Volumes → Add Volume**, mount path `/data`
   - Ajouter la variable d'environnement : `DB_PATH=/data/tracker.db`
4. Redéployer. C'est tout.

> L'application n'a **pas d'authentification**. Sur Railway l'URL est publique : soit ajouter un auth basique (middleware Express, 10 lignes), soit restreindre via un nom de domaine privé/proxy. À toi de voir selon l'usage.

## API

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/exercises` | Liste des exercices (+ facteur de pondération) |
| POST | `/api/exercises` | Ajouter un exercice `{name, factor}` |
| GET | `/api/sessions?limit=30` | Séances avec leurs séries |
| POST | `/api/sessions` | Créer/récupérer la séance du jour `{date}` (idempotent) |
| POST | `/api/sessions/:id/sets` | Ajouter une série `{exercise_id, weight, reps}` |
| DELETE | `/api/sets/:id` | Supprimer une série |
| GET | `/api/plan?date=YYYY-MM-DD` | Séance du jour calculée (exercices, charge, reps, séries, séries déjà faites) |
| GET | `/api/stats/weekly?weeks=10` | Volume pondéré + séances par semaine ISO |
| GET | `/api/stats/progress` | Record et dernière série par exercice |
| GET/PUT | `/api/settings` | Cibles (`weekly_target_min/max`, `sessions_per_week`) |

## Schéma

- `exercises(id, name, factor, active)` — `factor` = pondération volume biceps
- `sessions(id, date, notes)` — une séance par jour
- `sets(id, session_id, exercise_id, weight, reps, created_at)` — `weight = 0` → poids du corps
- `settings(key, value)`
