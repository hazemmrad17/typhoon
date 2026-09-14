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
- Mode VFX `/zone` (simulation visuelle non contractuelle) : `constitution.md`
  §2.1 · spec `docs/workflow/vfx-spec.md` · plan `docs/workflow/vfx-plan.md`.
- Boucle scénario → carte de `/zone` (référence FuseLab) :
  `docs/workflow/scenario-plan.md`. **Invariant acquis (SCN-001)** : les clés de
  scénario du moteur (`damageModel.SCENARIOS[].key` = `extreme | moyen |
  frequent | faible`) SONT les clés réglementaires TRI — ne pas réintroduire de
  table de correspondance locale. Les anciennes clés
  (`direct | west | east | offshore`) ne sont que des alias dépréciés.
- **Deux seuils, jamais confondus (SCN-002)** : `INFRA_THRESHOLD_M` (0,3 m)
  gouverne les DOMMAGES (compteurs, tuiles) ; `mapImpactFromDepth` gouverne ce
  que la CARTE peint (dès une profondeur > 0).
- **Le scénario pilote le niveau, la pluie ne pilote que la forme** (SCN-004) :
  `scenarioDepthAt(profile, hourIndex, peakM)` — la classe TRI officielle fixe
  le pic (fait réglementaire), la prévision de pluie n'en fixe que la courbe.
  Journée sèche → rampe divergée documentée + libellé « montée : hypothèse ».
  Ne JAMAIS réintroduire un `depthAt` météo-dépendant comme source du niveau :
  cela rendait tout scénario invisible par temps sec, ce qui se lit comme une
  panne. Hors TRI reste strictement 0 m.
- **Sélection par défaut = classe la plus intense cartographiée**
  (`mostIntenseMappedScenario`) : une fois par diagnostic, et seulement si le
  scénario courant n'est pas cartographié. Les rangs non cartographiés sont
  `disabled` (un clic sans effet se lit comme un bug).
- **Absence ≠ panne (SCN-003)** : « hors TRI » est un fait, « service
  indisponible » est un échec de source — deux messages distincts. Le
  connecteur porte cinq vérités distinctes (`triAbsenceKind`) : chargement,
  panne, dans un TRI **sans classe** au point, hors TRI, appartenance non
  vérifiée. Formulation unique partagée (`triAbsenceText`) entre panneau,
  console et rapport.
- **TRI : BBOX à l'échelle du POINT** (`POINT_MARGIN_DEG` ≈ 55 m, jamais la
  taille d'un quartier) : mesuré à Nantes, une boîte large remplit le cap
  `count` de polygones 2 km plus loin, donc le polygone couvrant l'adresse
  n'est jamais dans la page → « hors TRI » sur un quai. Tout polygone
  contenant le point coupe une boîte centrée sur lui : élargir ne gagne rien
  et perd des réponses. `ms:LIMITETRI_FXX` (périmètre, sans `ht_min`/`ht_max`)
  n'est JAMAIS dans `SCENARIO_QUERY` — elle ne sert qu'à trancher
  « dans un TRI ? » (`in_tri`), via le parseur GML générique.
- Mode VFX : le rendu cinématique passe par `zone/vfx/vfxInputs.ts` et rien
  d'autre ; le repli illustratif n'existe qu'en VFX et porte toujours
  `partial` (libellé §2.1). `impactModel` ne doit JAMAIS importer ce module.

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
- Plan & tâches : `docs/workflow/plan.md` (+ scénarios : `docs/workflow/scenario-plan.md` · VFX : `docs/workflow/vfx-plan.md`)
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
