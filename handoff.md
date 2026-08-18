# Handoff — Copernicus « Projection climatique » (Typhoon2-Alpha)

Date : 2026-08-18 · Auteur : agent opencode

Ce document résume ce qui a été fait (2 chantiers terminés), puis ce qui a été
découvert en enquêtant sur la demande « unités réelles vs indice 0-100 »
(1 découverte architecturale critique + 1 décision en attente).

---

## 1. Chantier terminé — Consolidation du panneau Copernicus

**Problème d'origine** : deux composants concurrents existaient :
`CopernicusPanel.tsx` (simple, inutilisé) et `CopernicusPanelEnhanced.tsx`
(créé par l'ancien agent « Codebuff », commit `26a3913`) avec du CSS inline en
hexadécimal, des faux onglets `md-text-button` et une recherche d'indicateurs
cassée (l'onglet Graphiques rendait vide).

**Ce qui a été fait** :

| Action | Fichier |
|---|---|
| Composant unique fusionné écrit (4 onglets `md-tabs` M3 : Évolution SVG, Périodes retour, Qualité, Tableau + `CopernicusStatusBanner` + sélecteur RCP) | `frontend/src/components/CopernicusPanel.tsx` |
| Feuille de style M3 complète écrite (tokens `--md-sys-color-*`, `var(--accent)`, `color-mix`, responsive) | `frontend/src/styles/copernicus.css` |
| `CopernicusPanelEnhanced.tsx` et `copernicus-enhanced.css` supprimés | — |
| Import/rendu de `Zone.tsx` basculés sur `CopernicusPanel` + `copernicus.css` ; cluster mort `band`/`maxScore`/`aleaScore`/`D03` supprimé (lint) | `frontend/src/routes/Zone.tsx` |
| CSS `.cds-panel/.cds-chart*/.cds-table/.cds-cell*` mort supprimé (~100 lignes, gardé `.cds-banner*`) ; sélecteur overflow `.zone-panel-body > .cop-panel` corrigé | `frontend/src/styles/zone.css` |

**Vérifications** : `tsc -b --noEmit` OK, `eslint` propre sur tous les fichiers
touchés, `vitest` 14/14 OK, `vite build` OK.
Erreurs lint pré-existantes (hors périmètre, code mort de l'ancien agent) :
`InsurerInsights.tsx` et `BuildingFiche.tsx` (`no-unused-vars`).

---

## 2. Chantier terminé — Placement des textes de source

Demande : « les textes indiquant les sources sont déplacés ». Le panneau
affichait deux lignes de texte nues et flottantes :
- « Hors périmètre Copernicus CDS (non modélisés à 2100) : … » (`<p class="cop-note">`)
- « Source : Copernicus Climate Data Store (ECMWF) · … » (`<footer class="cop-meta">`)

**Ce qui a été fait** (`CopernicusPanel.tsx` + `copernicus.css`) : les deux
textes sont regroupés dans un unique pied de panneau cohérent
(`<footer class="cop-footer">`) en carte `surface-container` avec bordure
arrondie, icônes (block / database), lien vers le dataset CDS officiel
(`sis-ecde-climate-indicators`) et mention explicite de l'échelle
« indice d'exposition 0-100 ». Les classes `.cop-note`/`.cop-meta` mortes ont
été remplacées. Vérifié : eslint + tsc OK.

---

## 3. Découverte — les valeurs affichées sont un indice 0-100, pas des unités climatiques

Question utilisateur : « les indications sont basées sur quoi ? 0-100 ? On ne
peut pas mettre les vraies unités ? »

**Réponse factuelle** (constaté dans le code, pas une opinion) :
- La trajectoire expose, par péril et par horizon, la variable brute **F = indice
  d'exposition 0-100** (`TrajectoirePoint.valeur`, `unite` = `"indice 0-100"`,
  cf. `PERILS_TRAJECTOIRE`). C'est un score dérivé, jamais la climatologie brute.
  → `frontend/src/zone/config.ts:165` et `backend/app/scoring/risk_model.py` (HEAD).
- Les **vraies unités CDS** (jours de canicule/an, °C, m/s, fréquence de
  précipitations extrêmes…) ne sont calculées côté backend QUE pour le bloc
  2100 Copernicus, via `extract_climate_2100()`
  → `backend/app/connectors/copernicus.py:476`. Elles ne sont pas exposées
  péril par péril dans la trajectoire.
- Référence documentaire : dataset CDS « Climate indicators for Europe
  from 1940 to 2100 » (`sis-ecde-climate-indicators`),
  https://cds.climate.copernicus.eu/datasets/sis-ecde-climate-indicators

---

## 4. Découverte critique — la trajectoire n'existe plus dans le backend actuel

En enquêtant pour « mettre les vraies unités », un constat plus large est
apparu : **le rewrite en cours (Codebuff) a supprimé toute la pipeline de
scoring/trajectoire** côté backend.

### État HEAD (commit `26a3913`) — l'ancien pipeline existait
- `backend/app/scoring/risk_model.py` : `compute_trajectoire()` + `compute_risk_scores()`
- Route `POST /diagnostic/fast` (`run_diagnostic_fast`) qui retournait `trajectoire`
- `backend/app/agents/` : scoring_agent, interpretation_agent, digital_twin…
- Connecteurs : Open-Meteo, DVF, Lidar, etc.

### État du working tree (rewrite en cours, non commité)
- **Supprimés** : `risk_model.py`, `/diagnostic/fast`, `digital_twin/`,
  `open_meteo.py`, tout `app/scoring/`, `app/recommandations/`, `partner_api/`,
  artisans, simulation… (→ `git status` : 100+ fichiers `D`)
- La philosophie affichée (`app/api/routes/diagnostic.py` en tête) :
  « Le produit se recentre sur la **fusion de données brutes** … Le scoring, le
  jumeau numérique 3D et les simulations sont supprimés. »
- Le collector actuel (`app/agents/collector_agent.py:68`) retourne uniquement :
  `adresse`, `bdnb`, `georisques`, `copernicus`, `erreurs_sources`, `genere_le`.

### Conséquence directe
Le frontend appelle toujours `POST /diagnostic/fast` et lit
`trajectoire` (`Zone.tsx:190`, `Zone.tsx:386`, `diagnosticCache.ts`,
`CopernicusPanel.tsx`) → **cette route renvoie actuellement un 404**. Le panneau
Copernicus (comme `DecisionCard`, `ProvenancePanel`, `InsurerInsights`) est donc
déconnecté du backend tant que le rewrite frontend n'est pas fait.

### MAIS — les vraies unités sont déjà disponibles dans le contrat brut
Le bloc `copernicus.donnees` du contrat actuel contient les **séries annuelles
complètes 1940→2100 en vraies unités**, par variable et par scénario :
`{scenario}_yearly__{variable}` → liste annuelle (jours de canicule, °C, m/s…),
via `read_indicators_at_point()` (`copernicus.py:319`). Les deux RCP
(`rcp4_5`, `rcp8_5`) sont téléchargés. Aucune fenêtre 2026/2050/2100 n'est
encore calculée côté serveur (ni côté front).

---

## 5. Décision en attente — comment fournir les vraies unités

Trois options avaient été présentées à l'utilisateur ; la demande finale est
rédiger ce handoff (la décision de fond reste ouverte) :

1. **Rebuild de la trajectoire à partir des séries CDS brutes** *(recommandé)* —
   petit helper backend qui fenêtre la série annuelle par variable/scénario
   (2026 = années récentes, 2050 = 2041-2050, 2100 = 2090-2100), expose des
   valeurs en vraies unités (jours/an, °C, m/s) dans `building_data`, puis
   `CopernicusPanel` lit directement ces unités. Cohérent avec le pivot
   « données brutes » du rewrite, ne restaure aucun module supprimé.
2. **Restauration de l'ancienne pipeline** (`risk_model.py` + `/diagnostic/fast`
   depuis HEAD), puis enrichissement péril/péril. Contredit le rewrite.
3. **Garder l'indice 0-100** et seulement le documenter dans l'UI.

### Pistes d'implémentation si option 1 retenue
- Backend : fonction type `extract_trajectoire_brute(climat_copernicus)` dans
  `app/connectors/copernicus.py` (réutiliser `_pick_key`,
  `_series_value_2100`, le motif fenêtre `_HORIZON_2100_WINDOW`), clés du genre
  `{variable}__{scenario}` → `{2026, 2050, 2100}` + `unite` ; ajoutée dans le
  contrat `building_data["copernicus"]`.
- Frontend : adapter `CopernicusPanel` (ou un nouveau panneau) pour consommer
  cette structure par variable/catégorie (température, précipitations,
  sécheresse, vent) avec les vraies unités affichées dans les graphiques,
  « Périodes retour » et le tableau.
- Vérifier que la réponse `/diagnostic/adresse` (POST, déjà utilisée par le
  frontend) embarque bien ce nouveau bloc sans casser le contrat existant.

---

## Fichiers clés

- `frontend/src/components/CopernicusPanel.tsx` — panneau fusionné (4 onglets)
- `frontend/src/styles/copernicus.css` — styles M3 du panneau
- `frontend/src/routes/Zone.tsx` — point d'entrée (import + rendu + rattrapage)
- `frontend/src/zone/config.ts` — types `Trajectoire*` / `SCENARIOS`
- `frontend/src/styles/zone.css` — `.zone-panel-body > .cop-panel`, `.cds-banner*`
- `backend/app/connectors/copernicus.py` — lecture CDS, `extract_climate_2100`
- `backend/app/agents/collector_agent.py` — contrat brut actuel (pas de trajectoire)
- `backend/app/api/routes/diagnostic.py` — routes actives (pas de `/diagnostic/fast`)
- `backend/app/scoring/risk_model.py` — **supprimé** ; disponible à HEAD (git) pour référence
