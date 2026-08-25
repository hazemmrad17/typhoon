"""
Configuration centrale de l'orchestrateur.

Toutes les URLs de base et cles sont lues depuis les variables
d'environnement (voir .env.example). Rien n'est code en dur dans les
connecteurs : ce fichier est le seul endroit a modifier si une URL change.
"""

from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# backend/app/core/config.py -> backend/ -> projet racine
BASE_DIR = Path(__file__).resolve().parent.parent.parent
ROOT_DIR = BASE_DIR.parent


class Settings(BaseSettings):
    # Un seul .env à la racine du projet (pas de backend/.env).
    model_config = SettingsConfigDict(
        env_file=(ROOT_DIR / ".env",), extra="ignore"
    )

    # BDNB (aucune cle necessaire, confirme par un test reel - voir le guide)
    bdnb_api_key: str | None = None
    bdnb_base_url: str = "https://api.bdnb.io"

    # Georisques v1 (public, sans cle)
    georisques_base_url: str = "https://www.georisques.gouv.fr/api/v1"

    # Geocodage (BAN / Geoplateforme IGN, public, sans cle)
    geocoding_url: str = "https://data.geopf.fr/geocodage/search"

    # Attribution LO 2.0 — obligatoire dans chaque bloc de provenance du contrat
    # canonique (source + date de derniere mise a jour du jeu de donnees).
    # Mettre a jour le millesime a chaque nouvelle publication fournisseur.
    attribution_georisques: str = (
        "Source Géorisques (BRGM / MTE) — données à jour au <millésime>"
    )
    attribution_bdnb: str = (
        "Source BDNB (CSTB) — données à jour au <millésime>"
    )

    # IGN Altimetrie (Geoplateforme, public, sans cle)
    ign_altitude_base_url: str = "https://data.geopf.fr/altimetrie/1.0"

    # CORS — origines autorisées, séparées par des virgules. Par défaut,
    # seulement le frontend Vite en dev local (port 5173) : un joker "*"
    # fonctionnait tant qu'aucun vrai frontend n'était déployé derrière un
    # domaine, mais laisse n'importe quel site tiers appeler l'API une fois
    # en ligne. Positionner CORS_ALLOWED_ORIGINS (liste séparée par des
    # virgules) avec le(s) domaine(s) réel(s) du frontend en production.
    cors_allowed_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    # Limitation de débit (app/core/rate_limit.py) sur les routes qui
    # déclenchent une vraie collecte (BDNB/Géorisques) — protège la facture
    # des APIs externes autant que le service lui-même.
    rate_limit_requests: int = 30
    rate_limit_window_seconds: float = 60.0

    # Clés d'API pilote (FR-21) — séparées par virgules. Vide = accès ouvert
    # (mode dev, warning journalisé). Ne jamais logger ces valeurs.
    api_keys: str = ""

    # Budget mensuel d'appels BDNB (FR-28) — garde-fou du lot ; la requête
    # unitaire interactive n'est jamais bloquée par lui en v1.
    bdnb_monthly_budget: int = 10000

    # Divers
    http_timeout_seconds: float = 15.0


settings = Settings()
