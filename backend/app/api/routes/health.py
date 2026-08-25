from __future__ import annotations

from fastapi import APIRouter

from app.core.config import settings

router = APIRouter()


@router.get("/health")
def health() -> dict:
    """Sonde rapide (load balancer / orchestrateur) : aucun appel réseau,
    répond instantanément. Pour l'état des dépendances externes, voir
    `/health/detailed`."""
    return {"status": "ok"}


@router.get("/health/detailed")
def health_detailed() -> dict:
    """État de configuration des dépendances externes — pas de ping réseau
    en direct (coûteux/lent à chaque appel) : seulement "est-ce configuré",
    pas "est-ce en ligne à l'instant T". Utile pour un tableau de bord
    d'exploitation ou un diagnostic rapide après déploiement — pas un
    remplacement du monitoring des connecteurs individuels."""
    return {
        "status": "ok",
        "dependencies": {
            "bdnb": {"configured": True, "note": "API publique, aucune clé requise."},
            "georisques": {"configured": True, "note": "API publique, aucune clé requise."},
        },
        "cors_allowed_origins": [o.strip() for o in settings.cors_allowed_origins.split(",") if o.strip()],
        "rate_limit": {
            "requests": settings.rate_limit_requests,
            "window_seconds": settings.rate_limit_window_seconds,
        },
    }
