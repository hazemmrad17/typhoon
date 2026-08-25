# =============================================================================
#   Middleware d'authentification par clé d'API (FR-21)
#
#   Clés lues depuis settings.api_keys (séparées par virgules, espaces tolérés).
#   Liste vide -> mode ouvert (dev) ; un warning est émis au premier appel.
#   La clé n'est jamais journalisée — ni en clair, ni tronquée : rien du tout.
# =============================================================================

from __future__ import annotations

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import JSONResponse, Response

from fastapi import Request

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)

_EXEMPT_PATHS = {"/health", "/health/detailed"}
_open_mode_warned = False


class ApiKeyMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        if request.url.path in _EXEMPT_PATHS:
            return await call_next(request)

        configured = [k.strip() for k in settings.api_keys.split(",") if k.strip()]
        if not configured:
            global _open_mode_warned
            if not _open_mode_warned:
                logger.warning(
                    "API_KEYS non configurée — endpoint ouvert (mode dev). "
                    "Définir API_KEYS avant tout pilot externe."
                )
                _open_mode_warned = True
            return await call_next(request)

        provided = request.headers.get("x-api-key")
        if not provided:
            return JSONResponse(
                {"detail": {"error": "cle_api_manquante",
                            "hint": "Fournir l'en-tête X-API-Key."}},
                status_code=401,
            )
        if provided not in configured:
            # Volontairement générique : ni la clé fournie, ni sa longueur,
            # ni la liste des valides ne fuient dans la réponse ou les logs.
            return JSONResponse({"detail": {"error": "cle_api_invalide"}}, status_code=403)

        return await call_next(request)
