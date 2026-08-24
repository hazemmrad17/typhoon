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
    en direct (coûteux/lent à chaque appel, cf. le même choix assumé pour
    `copernicus_status()`) : seulement "est-ce configuré", pas "est-ce en
    ligne à l'instant T". Utile pour un tableau de bord d'exploitation ou un
    diagnostic rapide après déploiement — pas un remplacement du monitoring
    des connecteurs individuels."""
    return {
        "status": "ok",
        "dependencies": {
            "copernicus": {
                "enabled": settings.copernicus_enabled,
                "configured": bool(settings.cdsapi_url and settings.cdsapi_key),
                "note": "Projections 2100 indisponibles si désactivé ou non configuré (repli honnête, pas d'erreur).",
            },
            "bdnb": {"configured": True, "note": "API publique, aucune clé requise."},
            "georisques": {"configured": True, "note": "API publique, aucune clé requise."},
        },
        "cors_allowed_origins": [o.strip() for o in settings.cors_allowed_origins.split(",") if o.strip()],
        "rate_limit": {
            "requests": settings.rate_limit_requests,
            "window_seconds": settings.rate_limit_window_seconds,
        },
    }
