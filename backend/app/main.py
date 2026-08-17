"""
Entrypoint FastAPI — expose le StateGraph LangGraph comme un service de
diagnostic (cf. README racine, section "Backend — communication
inter-agents").

Lancement (port 8000 — convention repo, cf. README) :
    cd backend
    uvicorn app.main:app --reload --port 8000

CORS : origines autorisées lues depuis `settings.cors_allowed_origins`
(variable d'environnement CORS_ALLOWED_ORIGINS, liste séparée par des
virgules) — par défaut le frontend Vite en dev local uniquement. Positionner
cette variable avec le(s) domaine(s) réel(s) avant tout déploiement.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import artisans, chat, diagnostic, health, property_id as property_id_router
from app.api.routes import geocoding as geocoding_router
from app.api.routes import simulation as simulation_router
from app.core.config import settings
from app.core.logging import configure_logging, get_logger
from app.core.rate_limit import RateLimitMiddleware
from app.property_id.service import init_service as init_property_id_service
from app.recommandations.service import load_index

configure_logging()
logger = get_logger(__name__)

app = FastAPI(title="Typhoon — API diagnostic climatique", version="0.1.0")

_cors_origins = [o.strip() for o in settings.cors_allowed_origins.split(",") if o.strip()]

app.add_middleware(RateLimitMiddleware)
# CORS ajouté en dernier : Starlette place le dernier middleware ajouté
# à l'extérieur de la pile, donc CORS voit et enrichit toutes les réponses,
# y compris un 429 renvoyé directement par le rate limiter.
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(diagnostic.router)
app.include_router(chat.router)
app.include_router(artisans.router)
app.include_router(artisans.legacy_router)
app.include_router(property_id_router.router)
app.include_router(geocoding_router.router, prefix="/api", tags=["geocoding"])
app.include_router(simulation_router.router, tags=["simulation"])


@app.on_event("startup")
async def on_startup() -> None:
    # Index de l'agent recommandations (~19 Mo, ~900 fiches) : charge une
    # seule fois ici plutot qu'a chaque requete /diagnostic, cf.
    # app/recommandations/service.py. Si l'index manque, on demarre quand meme
    # (les recommandations resteront vides) — ne pas bloquer le service.
    try:
        load_index()
    except Exception as exc:
        logger.warning("Index RAG non charge : %s — les recommandations resteront vides", exc)
    init_property_id_service()
    logger.info(
        "Typhoon API demarree — routes : POST /diagnostic, GET /health, "
        "POST /api/v1/artisans/matching, POST /property-id/generate, GET /property-id/{id}"
    )
