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

# Vercel exécute la fonction depuis /var/task/ avec la racine du dépôt en CWD —
# mais selon le runtime le chemin relatif peut différer : chercher backend/
# de façon robuste (fichier → api/ → racine).
_HERE = Path(__file__).resolve()
_CANDIDATES = [
    _HERE.parent.parent / "backend",          # déploiement standard : /var/task/api/index.py
    _HERE.parent / "backend",                 # variante : /var/task/backend
    Path.cwd() / "backend",                   # dernier recours : CWD/backend
]
for _cand in _CANDIDATES:
    if (_cand / "app" / "main.py").exists():
        sys.path.insert(0, str(_cand))
        break
else:
    # Dernier recours : chemin relatif brut (lève une erreur explicite dans les logs)
    sys.path.insert(0, str(_HERE.parent.parent / "backend"))

from app.main import app  # noqa: E402

# Vercel attend une variable `app` (ASGI) au niveau du module.
__all__ = ["app"]
