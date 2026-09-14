"""
Point d'entrée Vercel (Python serverless) — route TOUT le backend FastAPI.

Un seul projet Vercel : le frontend est un build statique (frontend/dist),
le backend tourne en fonction serverless derrière les rewrites de
vercel.json (/api/*, /diagnostic/*, /health → ce fichier).

Le code backend vit dans backend/ : on l'ajoute au path pour que
`from app.main import app` se résolve depuis la fonction.
"""

import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from app.main import app  # noqa: E402

# Vercel attend une variable `app` (ASGI) au niveau du module.
__all__ = ["app"]
