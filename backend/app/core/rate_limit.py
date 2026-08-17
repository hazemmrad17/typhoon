"""
Limitation de débit — protège les routes qui déclenchent une cascade d'appels
externes (BDNB, Géorisques, IGN, Open-Meteo/Copernicus, Mistral) contre un
usage abusif ou un bug côté client qui boucle sans frein.

Implémentation mémoire, fenêtre glissante, par IP cliente — suffisant pour un
seul process, comme le store batch en mémoire (app/services/batch.py) fait le
même choix assumé. À remplacer par un backend partagé (Redis) si le service
tourne un jour derrière plusieurs workers/instances.
"""

from __future__ import annotations

import time
from collections import defaultdict

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import JSONResponse, Response

from app.core.config import settings

# Routes limitées : (méthode, chemin exact). Uniquement celles qui déclenchent
# une vraie collecte (BDNB/Géorisques/...) ou un appel Mistral — pas les
# lectures légères (statut Copernicus, fiche bâtiment déjà en cache, poll de
# batch). Chemins exacts (pas de préfixe) : évite d'attraper /diagnostic/fast
# ou /diagnostic/batch/{id} sous l'entrée bare "/diagnostic".
_LIMITED_ROUTES: frozenset[tuple[str, str]] = frozenset(
    {
        ("POST", "/diagnostic"),
        ("POST", "/diagnostic/fast"),
        ("POST", "/diagnostic/batch"),
        ("POST", "/diagnostic/recommandations"),
        ("POST", "/diagnostic/adresse/rapport"),
        ("GET", "/diagnostic/adresse"),
    }
)


class RateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app):
        super().__init__(app)
        self._hits: dict[str, list[float]] = defaultdict(list)

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        key = (request.method, request.url.path)
        if key not in _LIMITED_ROUTES:
            return await call_next(request)

        client_ip = request.client.host if request.client else "unknown"
        limit = settings.rate_limit_requests
        window = settings.rate_limit_window_seconds
        now = time.monotonic()
        cutoff = now - window

        hits = self._hits[client_ip]
        while hits and hits[0] < cutoff:
            hits.pop(0)

        if len(hits) >= limit:
            retry_after = max(1, int(window - (now - hits[0])))
            return JSONResponse(
                {
                    "detail": (
                        f"Trop de requêtes — limite de {limit} par {window:.0f}s dépassée "
                        "sur cette route. Réessayez dans quelques instants."
                    )
                },
                status_code=429,
                headers={"Retry-After": str(retry_after)},
            )

        hits.append(now)
        return await call_next(request)
