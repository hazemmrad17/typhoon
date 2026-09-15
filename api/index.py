"""
Point d'entrée Vercel (Python serverless) — route TOUT le backend FastAPI.

Si ce module crashe, l'erreur réelle est masquée par le 500 générique
FUNCTION_INVOCATION_FAILED : ce wrapper capture TOUTE exception au
chargement et la renvoie dans la réponse HTTP pour qu'elle soit visible
directement dans le navigateur / les Runtime Logs.
"""

import sys
import traceback
from pathlib import Path

# Marqueur que la fonction Python a bien été atteinte (visible dans la
# réponse si l'import du backend échoue).
_DIAGNOSTIC = {"reached": True}


def _load_backend() -> None:
    here = Path(__file__).resolve()
    candidates = [
        here.parent.parent / "backend",   # standard : /var/task/api/index.py
        here.parent / "backend",          # variante : /var/task/backend
        Path.cwd() / "backend",           # dernier recours : CWD/backend
    ]
    for cand in candidates:
        if (cand / "app" / "main.py").exists():
            sys.path.insert(0, str(cand))
            return
    raise RuntimeError(
        "backend/ introuvable depuis api/index.py — "
        f"candidats testés: {[str(c) for c in candidates]} — "
        f"cwd={Path.cwd()} — fichiers ici: {[p.name for p in here.parent.iterdir()]}"
    )


try:
    _load_backend()
    from app.main import app  # noqa: E402
except Exception:  # pragma: no cover — diagnostic du démarrage Vercel
    _tb = traceback.format_exc()

    from fastapi import FastAPI
    from fastapi.responses import PlainTextResponse

    app = FastAPI()
    _DIAGNOSTIC["traceback"] = _tb

    @app.api_route("/{path:path}", methods=["GET", "POST", "OPTIONS"])
    async def _startup_failure(path: str):
        return PlainTextResponse(
            "BACKEND STARTUP FAILED — voir le traceback ci-dessous\n\n"
            + _DIAGNOSTIC["traceback"],
            status_code=500,
        )
