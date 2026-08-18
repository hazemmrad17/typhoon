"""
Configuration centrale de l'orchestrateur.

Toutes les URLs de base et cles sont lues depuis les variables
d'environnement (voir .env.example). Rien n'est code en dur dans les
connecteurs : ce fichier est le seul endroit a modifier si une URL change.

Les chemins de cache/lookup (Copernicus, DVF) sont ancres sur l'emplacement
du projet (BASE_DIR), pas sur le repertoire courant : ils pointent donc
toujours vers backend/data/... quel que soit l'endroit d'ou la commande est
lancee. Comme ce projet vit sous D:\\Talan\\Typhoon-2, ces telechargements
se font sous D:, pas sous C: (deplacez aussi le venv Python et le cache pip
sous D: si l'espace sur C: est limite - ce sont eux qui en consomment le plus).
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

    # IGN Altimetrie (Geoplateforme, public, sans cle)
    ign_altitude_base_url: str = "https://data.geopf.fr/altimetrie/1.0"

    # Open-Meteo Climate API (public, sans cle en usage non-commercial)
    open_meteo_climate_url: str = "https://climate-api.open-meteo.com/v1/climate"

    # Copernicus Climate Data Store (compte + jeton requis, voir le guide
    # et le docstring de app/connectors/copernicus.py). Desactive par defaut
    # car le premier lancement declenche un telechargement multi-gigaoctets.
    # --- CHANGEZ ICI --- passez a True pour activer Copernicus dans le workflow.
    # Vous pouvez aussi le definir via COPERNICUS_ENABLED=true dans .env.
    copernicus_enabled: bool = False
    copernicus_cache_dir: str = str(BASE_DIR / "data" / "lookup" / "copernicus")

    # Identifiants Copernicus Climate Data Store (compte + jeton CDS).
    # Lus depuis le .env racine (CDSAPI_URL / CDSAPI_KEY) et injectes dans
    # os.environ par app/connectors/copernicus.py._ensure_credentials_in_env
    # avant chaque appel cdsapi (qui, lui, lit os.environ ou ~/.cdsapirc).
    cdsapi_url: str = ""
    cdsapi_key: str = ""

    # CORS — origines autorisées, séparées par des virgules. Par défaut,
    # seulement le frontend Vite en dev local (port 5173) : un joker "*"
    # fonctionnait tant qu'aucun vrai frontend n'était déployé derrière un
    # domaine, mais laisse n'importe quel site tiers appeler l'API une fois
    # en ligne. Positionner CORS_ALLOWED_ORIGINS (liste séparée par des
    # virgules) avec le(s) domaine(s) réel(s) du frontend en production.
    cors_allowed_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    # Limitation de débit (app/core/rate_limit.py) sur les routes qui
    # déclenchent une vraie collecte (BDNB/Géorisques/Mistral/Copernicus) —
    # protège la facture des APIs externes autant que le service lui-même.
    rate_limit_requests: int = 30
    rate_limit_window_seconds: float = 60.0

    # Divers
    http_timeout_seconds: float = 15.0


settings = Settings()
