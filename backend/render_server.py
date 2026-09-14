"""Point d'entrée Render — uvicorn app.render_server:app.

Render lance `uvicorn` sans module précis ; ce fichier garantit que
`app.main:app` est bien résolu depuis la racine du dépôt (Render démarre
depuis la racine, pas depuis backend/).
"""

from app.main import app

__all__ = ["app"]
