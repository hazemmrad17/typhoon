# Démo assureur — parcours de 5 minutes

> PoC « underwriting » : un diagnostic par adresse, la carte de décision avec
> trajectoire climatique (2026 → 2050 → 2100), le rapport PDF, le Portfolio
> (import CSV en lot) et la Watchlist. Tout tourne en local.

## 1. Lancer le backend (port 8000)

```bash
cd backend
# .env déjà présent : COPERNICUS_ENABLED=true, CDSAPI_URL/CDSAPI_KEY, MISTRAL_API_KEY
venv/Scripts/python.exe -m uvicorn app.main:app --reload --port 8000
```

Vérifier la santé : `curl http://127.0.0.1:8000/health`

**Copernicus (2100) :** la première fois, la collecte déclenche un
téléchargement CDS multi-gigaoctets (licence déjà acceptée sur le compte).
État en direct :

```bash
curl http://127.0.0.1:8000/diagnostic/copernicus/status
# { "download_complete": true, ... } → les horizons 2050/2100 sont remplis
```

Tant que `download_complete` est `false`, la carte de décision affiche la
bannière « téléchargement en cours » et 2100 reste « non simulé » — le reste
du parcours fonctionne normalement.

## 2. Lancer le frontend (port 5173)

```bash
cd frontend
npm run dev
# → http://localhost:5173
```

## 3. Profil « Assurance »

Le profil pilote le stepper (`assurance` → Adresse · Décision · Analyse ·
Recommandations · Rapport) et les entrées sidenav (Dashboard, Portfolio,
Watchlist).

1. Ouvrir **Paramètres → Compte** (engrenage en bas de la sidenav)
2. Sélectionner le profil **Assurance**
3. Revenir sur `/dashboard` — les cartes de stats, le tableau des derniers
   diagnostics et la file de validation se remplissent depuis le cache local

## 4. Adresse de démo recommandée

```
14 Avenue des Palmiers 06200 Nice
```

- Étape **Adresse** : coller l'adresse, Entrée ↵
- Étape **Décision** : verdict, pastilles de risques, trajectoire
  2026/2050/2100 (boutons d'horizon + comparaison RCP 4.5/8.5 quand le CDS
  est téléchargé), panneau « Sources & provenance », boutons **Copier la
  synthèse** / **Exporter PDF** / **Ajouter à la watchlist**
- Étape **Analyse** : fiche bâtiment BDNB (enveloppe, DPE, risques bâtiment)
- Étape **Rapport** : rapport narratif Mistral + export PDF

## 5. Portfolio (import CSV en lot)

1. Sidenav → **Portfolio**
2. Déposer un CSV (une colonne `adresse`, une adresse par ligne) — un exemple :

   ```csv
   adresse
   14 Avenue des Palmiers 06200 Nice
   2 Rue de la Lande 37140 Bourgueil
   26 Rue Victor Hugo 37140 Bourgueil
   3 Avenue de la Bourdonnais 75007 Paris
   ```

3. La page affiche : cartes de stats, barre de progression du lot,
   histogramme D03, heatmap (si coordonnées disponibles) et le tableau
   détaillé avec pastilles de bande + « à expertiser »
4. Exports : CSV et synthèse PDF

## 6. Watchlist

- Depuis la carte de décision : **Ajouter à la watchlist**
- Sidenav → **Watchlist** : la carte apparaît avec le code INSEE ; le badge
  « nouveaux CatNat » s'allume si la commune a plus d'arrêtés que lors de la
  dernière visite (données déjà collectées, aucun appel réseau)

## 7. Tests & vérification

```bash
# Backend — suite complète
cd backend && venv/Scripts/python.exe -m pytest -q        # 177 passed

# Frontend — typecheck + tests de fumée des pages assureur
cd frontend && npx tsc -b --force && npm test            # vitest, 7 passed
```

## Limites connues de la démo (honnêteté)

- L'authentification est simulée (`mockUser.ts` + localStorage) — le profil
  « Assurance » est un choix de démo, pas un vrai compte
- Le disclaimer du PDF est un placeholder — à faire valider par la conformité
  avant tout usage réel
- Les résultats de lot du Portfolio vivent en `sessionStorage` (perdus à la
  fermeture de l'onglet) ; le store batch backend est en mémoire
- 2050 vient d'Open-Meteo (ne varie pas avec le RCP) ; seul 2100 varie selon
  le scénario Copernicus
