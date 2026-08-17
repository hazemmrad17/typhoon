# Typhoon 2 — Bastion

Diagnostic géo-risque par adresse : inondation, retrait-gonflement des
argiles, sismicité, radon, feux de forêt, mouvements de terrain, cavités,
avalanche — alimenté par **Géorisques**, **BDNB** et les projections
**Copernicus**, avec scoring, recommandations de travaux (RAG Mistral),
artisans RGE, rapport IA et export PDF.

## Structure

```
backend/    API FastAPI — diagnostic, scoring, recommandations, jumeau numérique
frontend/   React + Vite + Material Web — landing page, /zone (diagnostic), paramètres
docs/       Plans produit & techniques
```

## Branches

- `main` — **production uniquement**. Aucun push direct : passe par une
  merge-request depuis `develop`.
- `develop` — branche de travail : checkpoints, corrections et améliorations.

## Démarrage rapide

```bash
# Backend
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

# Frontend
cd frontend
npm install
npm run dev
```

Copier `.env.example` vers `.env` (backend) et compléter les clés
(MISTRAL_API_KEY, MAPBOX_TOKEN…).

## Convention de checkpoint

Chaque push sur `develop` est un point de contrôle : message concis décrivant
le changement, en français ou en anglais.
