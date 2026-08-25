"""
Entrypoint FastAPI — API de diagnostic climatique simplifié.

Le produit est la fusion de données brutes (Géorisques + BDNB) par
bâtiment, avec provenance et résolution sur chaque fait. Le scoring,
le jumeau numérique 3D, les simulations, Copernicus et Open-Meteo sont
supprimés.

Lancement (port 8000) :
    cd backend
    uvicorn app.main:app --reload --port 8000

CORS : origines autorisées lues depuis `settings.cors_allowed_origins`
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import diagnostic, health, geocoding as geocoding_router
from app.core.config import settings
from app.core.logging import configure_logging, get_logger
from app.core.rate_limit import RateLimitMiddleware

configure_logging()
logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Gestion du cycle de vie de l'application (remplace on_event)."""
    logger.info(
        "Typhoon API démarrée (v0.2.0) — routes : POST /diagnostic/adresse, GET /health, GET /api/geocode/search"
    )
    yield


app = FastAPI(title="Typhoon — API diagnostic climatique", version="0.2.0", lifespan=lifespan)

_cors_origins = [o.strip() for o in settings.cors_allowed_origins.split(",") if o.strip()]

app.add_middleware(RateLimitMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(diagnostic.router)
app.include_router(geocoding_router.router, prefix="/api", tags=["geocoding"])
