# Audit du projet Typhoon — 3 octobre 2026

> Audit exécuté sur le dépôt réel : suites lancées, build lancé, lint lancé,
> instance en ligne interrogée. Chaque constat est daté et reproductible.
> Les constats sont classés par gravité décroissante.

## Résumé

L'architecture est saine. Le produit tient debout, les invariants sont réels,
les suites passent. **Ce qui manque n'est pas de la conception, c'est de la
finition** — et deux des manques sont des violations directes de règles que la
constitution du projet prétend faire respecter.

Trois constats bloquants, cinq constats de finition, deux constats d'hygiène.

---

## Vérifié vert (pour mémoire)

| Contrôle | Résultat |
|---|---|
| Backend `pytest` | **216 passed**, 0 échec |
| Backend `ruff check app tests` | All checks passed |
| Backend `ruff check .` (commande CI) | All checks passed |
| Frontend `vitest run` | **147 passed** (21 fichiers) |
| Frontend `npm run build` (`tsc -b && vite build`) | ✓ built in 37 s |
| Frontend `eslint .` | **0 erreur**, 52 avertissements |
| Instance `typhoon-rose.vercel.app/health` | `200 {"status":"ok"}` |
| `.env` suivi par git | **non** — correctement ignoré |
| Secrets dans les fichiers suivis | aucun détecté |
| `dangerouslySetInnerHTML` | absent |

---

## Bloquant

### B1 — La CI ne peut pas être verte

`.github/workflows/ci.yml` contient :

```yaml
- name: Audit (npm)
  run: npm audit --audit-level=moderate
```

Exécution réelle : **code de sortie 1**.

```
2 vulnerabilities (1 low, 1 high)
dompurify  3.4.13 - 3.4.15   — DOM XSS (GHSA-p98j-92pf-mc4p)
brace-expansion              — DoS via recursion (GHSA-6j4f-fj2g-mc7p)
```

**Conséquence** : la constitution §8 impose « CI green required before merge ».
Cette étape échoue à chaque push et chaque PR, donc la porte de fusion est
cassée depuis un moment. Soit la CI a été ignorée, soit elle n'a jamais été
regardée — dans les deux cas la règle ne protège plus rien.

**Note** : `dompurify` est une dépendance transitive et n'est **utilisée nulle
part** dans `src/` (vérifié). La vulnérabilité est donc probablement sans
impact réel, mais elle fait échouer la porte.

**Correctifs possibles** : `npm audit fix` (le plus simple), ou remplacer
l'étape par un audit non bloquant avec revue, ou exclure les dépendances de
développement non embarquées (`--omit=dev`).

### B2 — L'invariant « suite < 60 s » est faux

Le README, la spécification (§4) et la constitution (§4) affirment tous :
« suite hors-ligne, < 60 s ».

Mesure réelle :

```
216 passed, 2 warnings in 235.79s (0:03:55)
```

**235 secondes, soit 4× la valeur annoncée.** C'est une exigence écrite et
non tenue. Deux causes identifiées :

- des attentes en temps réel non simulées dans certains tests ;
- le coût de démarrage de `TestClient` répété.

L'effet pratique est important : à 4 minutes, la suite n'est plus exécutée
« avant de finir toute tâche » comme le prescrit `AGENTS.md`. Elle est
contournée, donc les régressions passent.

### B3 — `.env.example` ne documente pas les variables

La constitution §5 est explicite et étiquetée `[CI]` :

> « All credentials via environment variables; `.env.example` documents every
> variable. **[CI]** — grep gate + example file kept current. »

Contenu réel du fichier : **5 variables**.

Variables effectivement lues par le code et absentes du fichier :

```
VITE_MAPBOX_TOKEN              VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY  VITE_WINDY_API_KEY
VITE_API_BASE                  MISTRAL_API_KEY
MISTRAL_MODEL                  API_KEYS
BDNB_API_KEY                   CDSAPI_KEY / CDSAPI_URL
```

Le README contient un tableau correct de ces variables — mais le fichier que la
constitution désigne comme la référence ne les contient pas. Un nouveau
contributeur qui suit la procédure du README (« copier `.env.example` »)
obtient une configuration incomplète et un frontend sans carte.

---

## Finition

### F1 — Un test de dégradation passe sans rien tester

`backend/tests/test_wfs_integration.py:191`

```python
monkeypatch.setattr(gg, "_new_wfs_client", lambda: broken_wfs_client())
```

`broken_wfs_client` est une fonction `async`. Le `lambda` renvoie donc une
**coroutine**, jamais attendue. Le monkeypatch installe un faux client qui n'est
pas un context manager asynchrone — l'entrée dans le contexte ne se comporte pas
comme prévu, et l'exécution produit :

```
RuntimeWarning: coroutine 'broken_wfs_client' was never awaited
```

Le test passe, mais il ne prouve pas ce qu'il annonce prouver (que le WFS en
panne dégrade la réponse sans casser la jambe REST). C'est exactement la classe
de bug que le rapport décrit comme la plus dangereuse : un test vert qui ne
teste rien.

**Correctif** : `lambda: broken_wfs_client()` → `broken_wfs_client` (la fonction
elle-même), puisque l'appelant fait déjà `async with ...()`.

### F2 — Alias déprécié maintenu en vie par son propre test

`frontend/src/zone/floodAlea.ts:106`

```ts
/** @deprecated ... ne pas utiliser dans du code neuf. */
export const UI_SCENARIO_TRI_KEY = SCENARIO_TRI_KEY;
```

Grep sur tout `frontend/src` : **une seule référence**, son propre test
(`floodAlea.test.ts:72-75`). Aucun appelant en production.

La constitution §2 dit « No dormant code. Retired features are deleted, not
commented out or left unreferenced. » Cet export est non référencé, et le test
qui le couvre existe uniquement pour couvrir l'export mort. Les deux devraient
disparaître ensemble.

Le même schéma existe pour `depthAt` dans `floodSim.ts` (marqué `@deprecated`
mais toujours exporté).

### F3 — Aucun ErrorBoundary

Grep sur `frontend/src` : aucun `componentDidCatch` ni
`getDerivedStateFromError`.

`Zone.tsx` fait 1 117 lignes, `UnifiedMap.tsx` en fait 2 555. Une exception de
rendu dans l'un ou l'autre — par exemple sur un payload source légèrement
inattendu — blanchit **toute** l'application. En démonstration devant un jury,
c'est le scénario le plus coûteux possible, et il coûte une vingtaine de lignes
à prévenir.

### F4 — Dépendances non épinglées

`backend/requirements.txt` : **1 seule contrainte de version** (`pydantic>=2`).

```
fastapi            uvicorn[standard]     pydantic>=2
pydantic-settings  httpx                requests
pyproj             python-dotenv        pytest
pytest-asyncio     ruff
```

Sur une fonction serverless, une reconstruction peut tirer une version majeure
incompatible sans qu'aucun commit n'ait changé. Le `package-lock.json` du
frontend est, lui, correctement versionné.

**Incohérence associée** : la CI épingle Python **3.13**, le venv local tourne en
**3.14.6**. Les deux environnements ne testent pas la même chose.

### F5 — Dépendance interdite par la constitution §1

`requirements.txt` déclare `requests`, jamais importé (vérifié par grep).

Constitution §1 : « New HTTP calls use `httpx.AsyncClient`. `requests` appears
nowhere in new code. » Le code respecte la règle (53 fichiers utilisent `httpx`),
mais la dépendance est déclarée. Elle alourdit le paquet serverless et contredit
la règle dans le fichier même qui la liste.

---

## Hygiène

### H1 — Dépôt Git imbriqué

`hazemmrad17.github.io/` contient son propre `.git` et apparaît comme non suivi
dans le dépôt principal. C'est un projet distinct (portfolio Next.js) qui n'a
rien à voir avec Typhoon. Il brouille `git status`, pèse dans les recherches, et
n'est ni versionné ni ignoré proprement. À sortir du répertoire ou à ajouter au
`.gitignore`.

### H2 — 52 avertissements eslint

Aucune erreur, mais : `no-explicit-any` dans `config.ts` (le fichier de
configuration des couches), une directive `eslint-disable` devenue inutile dans
`ReportPage.tsx:563`, et des avertissements `react-refresh` dans `auth.tsx`.
Le seuil « 0 erreur » est tenu ; le seuil « propre » ne l'est pas.

### H3 — Compteurs du README dérivés

README : « 214 tests backend, 143 tests frontend ». Réel : **216** et **147**.
Le rapport de stage que j'ai rédigé reprend ces chiffres — à corriger aux deux
endroits.

---

## Ce qui n'est pas un problème

Pour éviter de confondre finition et conception, voici ce qui a été examiné et
jugé sain :

- **Les invariants sont réels, pas déclaratifs.** Le schéma refuse réellement
  les champs de score ; les tests de dégradation existent réellement ; la
  trichotomie `present` est implémentée. Ce n'est pas de la documentation qui
  décrit une intention.
- **La gestion des secrets est bonne.** `.env` non suivi, `.gitignore` couvre
  les variantes (`.env.*`, `*.env.txt`) avec un commentaire expliquant pourquoi —
  c'est le signe qu'un incident a eu lieu et a été traité.
- **Le lint backend est propre sur tout le dépôt**, pas seulement sur `app`.
- **Le bundle est correctement découpé** par route ; les gros morceaux (mapbox
  1,8 Mo, pdf 785 ko) sont chargés paresseusement et inévitables.
- **L'accessibilité est soignée** : plus de 100 attributs `aria-label`, des
  `role` corrects, `aria-live` sur les états de chargement.
- **Le routage est complet** et les routes protégées sont derrière
  `RequireAuth`.

---

## Plan de correction proposé

| Priorité | Constat | Effort estimé |
|---|---|---|
| 1 | B1 — rendre la CI verte | 10 min |
| 2 | B3 — compléter `.env.example` | 20 min |
| 3 | F1 — corriger le test qui ne teste rien | 15 min |
| 4 | F3 — ajouter un ErrorBoundary | 30 min |
| 5 | F5 + F4 — retirer `requests`, épingler les versions | 30 min |
| 6 | B2 — ramener la suite sous 60 s | 1–2 h |
| 7 | F2 — supprimer les alias morts et leurs tests | 30 min |
| 8 | H1, H2, H3 — hygiène | 30 min |

**Les cinq premiers points représentent environ deux heures** et suppriment
tous les constats bloquants ainsi que les deux défauts les plus visibles. Le
point 6 est le seul qui demande un vrai travail d'investigation.

---

## Conclusion

Le projet n'a pas un problème de conception, il a un problème de **dernier
kilomètre**. Les trois constats bloquants sont tous du même type : une règle
écrite, un mécanisme censé la faire respecter, et un écart entre les deux qui
n'a pas été vu parce que personne n'a relancé le contrôle.

C'est précisément la faiblesse que le rapport de stage identifie au
chapitre 12 : « les tests vérifiaient que le code ne plantait pas, pas qu'il
disait vrai ». Le même diagnostic s'applique ici au niveau du projet — la CI et
les métriques annoncées n'ont pas été vérifiées contre la réalité.
