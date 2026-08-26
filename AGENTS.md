# AGENTS.md

> Fichier lu par les agents IA avant toute modification. Court, concret, à jour.

## Projet

Typhoon — service de données climatiques **par bâtiment** pour les assureurs
français. Une adresse → un JSON canonique joignant aléas Géorisques (WFS,
point-in-polygon) et vulnérabilité BDNB (139 champs verbatim), avec
provenance et niveau de résolution sur chaque fait. Pas de score, pas de
narration IA (voir `constitution.md` §2).

## Méthodologie

Workflow spec-driven : `.agents/skills/spec-driven-development/`.

- `constitution.md` — règles non négociables. À lire AVANT toute proposition.
- `docs/workflow/` — brainstorm, concept, spec, plan (+ notes).
- Un changement de contrat passe d'abord par la constitution (amendement),
  puis la spec — jamais l'inverse.

## Commandes

```bash
# backend (depuis backend/)
python -m pytest tests/ -q          # suite hors-ligne (<60 s) — avant de finir TOUTE tâche
ruff check app tests                # lint
uvicorn app.main:app --reload --port 8000

# frontend (depuis frontend/)
npm run build                       # tsc -b && vite build
npm test                            # vitest run
```

## Discipline de test

- Tests écrits **avant** l'implémentation ; un commit `test(TXXX)` échouant,
  puis un commit `feat(TXXX)`. Ne JAMAIS modifier les tests existants pendant
  une tâche de feature — les supprimer ne se fait que dans un change set de
  suppression dédié.
- Suite offline obligatoirement verte ; les tests live sont un tier séparé.

## Contraintes non déductibles du code

- Interdit dans le contrat sérialisé : `niveau`/bandes D03, tout score,
  recommandations IA, Copernicus. Le schéma (`app/schemas/diagnostic_record.py`)
  refuse ces champs — ne pas les rajouter.
- Chaque objet aléa porte `source` + `resolution` + attribution LO 2.0.
  RGA est TOUJOURS `commune-level-estimate` tant qu'aucune source vectorielle
  n'est câblée (amendement constitution requis pour changer).
- Batch = N × le pipeline unitaire (`build_diagnostic_record`). Aucune
  seconde implémentation bulk.
- Les quotas upstream sont protégés côté client (BDNB 120 req/min,
  Géoplateforme 50 req/s) — vérifier les constantes chez le fournisseur
  avant de les faire entrer dans un test.
- Clés API jamais journalisées. Adresses tolérées dans les logs applicatifs.

## Où regarder

- Spécification : `docs/workflow/spec.md` (statut, FR-xx)
- Plan & tâches : `docs/workflow/plan.md`
- Décisions : `docs/workflow/01-brainstorm-notes.md`, `concept.md`
- Schéma du contrat : `backend/app/schemas/diagnostic_record.py`

## Pièges connus

- Le WFS Géorisques exige un AsyncClient DÉDIÉ (keep-alive lié au backend ;
  mélanger REST/WFS sur un même client provoque des 404 en cascade).
- GML 3.2 uniquement, ordre d'axes lat/lon quand srsName `urn:ogc:def:crs`.
- Arrondissements : Paris/Lyon/Marseille doivent être retranslatés vers la
  commune parente avant les endpoints communaux (`_commune_code`).
- Le géocodeur renvoie 429+Retry-After à 50 req/s/IP — helper
  `_get_with_429_retry`, une seule réattente.
