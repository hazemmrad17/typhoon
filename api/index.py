"""
Point d'entrée Vercel (Python serverless) — sert TOUT le backend FastAPI.

Trois contraintes du builder `@vercel/python` :

1. il exige une variable de module `app` / `application` / `handler` liée au
   niveau RACINE du fichier (hors try/except, hors if). C'est la raison de
   l'affectation finale `app = _handler` — la seule ligne non indentée du
   fichier qui lie `app` ;
2. `backend/` doit être importable : le path est ajouté ci-dessous, le
   répertoire étant bundlé automatiquement dans le lambda (`/var/task/backend`);
3. si l'import du backend échoue, le 500 générique
   `FUNCTION_INVOCATION_FAILED` masque l'erreur réelle : on renvoie donc une
   app de diagnostic qui affiche le traceback dans le navigateur.
"""

import sys
import traceback
from pathlib import Path


def _install_backend_path() -> Path:
    """Ajoute `backend/` au sys.path et le renvoie (lève si introuvable)."""
    here = Path(__file__).resolve()
    candidates = [
        here.parent.parent / "backend",  # /var/task/api/index.py -> /var/task/backend
        here.parent / "backend",  # variante : /var/task/backend
        Path.cwd() / "backend",  # dernier recours : CWD/backend
    ]
    for cand in candidates:
        if (cand / "app" / "main.py").exists():
            sys.path.insert(0, str(cand))
            return cand
    raise RuntimeError(
        "backend/ introuvable depuis api/index.py — "
        f"candidats testés: {[str(c) for c in candidates]} — "
        f"cwd={Path.cwd()} — fichiers ici: {[p.name for p in here.parent.iterdir()]}"
    )


def _diagnostic_app(tb: str):
    """App FastAPI minimale qui expose le traceback de démarrage."""
    from fastapi import FastAPI
    from fastapi.responses import PlainTextResponse

    diag = FastAPI()

    @diag.api_route("/{path:path}", methods=["GET", "POST", "OPTIONS"])
    async def _startup_failure(path: str):  # pragma: no cover — diagnostic Vercel
        return PlainTextResponse(
            "BACKEND STARTUP FAILED — voir le traceback ci-dessous\n\n" + tb,
            status_code=500,
        )

    return diag


try:
    _backend_dir = _install_backend_path()
    from app.main import app as _backend_app

    _handler = _backend_app
except Exception:  # pragma: no cover — diagnostic du démarrage Vercel
    _handler = _diagnostic_app(traceback.format_exc())

# Liaison RACINE exigée par @vercel/python — ne pas indenter.
app = _handler
application = app
