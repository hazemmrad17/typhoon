"""
collector_agent : orchestrateur de collecte de données brutes.

Le produit est la fusion de données brutes (Géorisques + BDNB) par
bâtiment. L'assureur applique son propre modèle actuariel —
on ne produit ni score, ni niveau, ni recommandations.

Contrat de sortie :
    adresse → geocodage → lat/lon/citycode
    bdnb → fiche bâtiment complète (139 champs)
    georisques → aléas réglementaires bruts
    erreurs_sources → liste des erreurs par source
    genere_le → timestamp UTC

Aucun champ calculé, aucune pondération, aucun "niveau" (faible/modéré/élevé).
Juste des faits, avec provenance.
"""

from __future__ import annotations

import asyncio
import re
import time
from collections.abc import Awaitable
from datetime import datetime, timezone

import httpx

from app.connectors import bdnb as bdnb_connector
from app.connectors.bdnb import BdnbAdresseIntrouvable
from app.connectors import georisques as georisques_connector
from app.connectors.geocoding import geocode_address, reverse_geocode
from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)

# Détecte les "adresses" en fait fournies comme coordonnées brutes "lat,lon"
_LATLON_RE = re.compile(r"^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$")


async def _safe_call(source_name: str, coro, erreurs: list[dict]):
    """Exécute un connecteur et convertit toute exception en entrée d'erreur."""
    started = time.perf_counter()
    try:
        result = await coro
        logger.info("  [%s] OK (%.2fs)", source_name, time.perf_counter() - started)
        return result
    except Exception as exc:
        logger.warning("  [%s] ECHEC (%.2fs) -> %s: %s", source_name, time.perf_counter() - started, type(exc).__name__, exc)
        erreurs.append({"source": source_name, "erreur": f"{type(exc).__name__}: {exc}"})
        return None


async def _fetch_bdnb_avec_repli(client: httpx.AsyncClient, address: str, label_ban: str) -> dict | None:
    """Interroge BDNB avec repli de géocodage."""
    try:
        return await bdnb_connector.fetch_bdnb(client, label_ban)
    except BdnbAdresseIntrouvable:
        if label_ban == address:
            raise
        logger.info("  [bdnb] libellé BAN non trouvé (%r), nouvel essai avec l'adresse brute (%r)", label_ban, address)
        return await bdnb_connector.fetch_bdnb(client, address)


async def collect(address: str) -> dict:
    """Point d'entrée principal : collecte des données brutes pour une adresse.

    Retourne le contrat de sortie brut sans aucun scoring ni interprétation.
    """
    logger.info("collector_agent -- début collecte pour %r", address)
    t0 = time.perf_counter()
    erreurs: list[dict] = []

    async with httpx.AsyncClient(timeout=settings.http_timeout_seconds) as client:
        # Étape 1 - géocodage
        logger.info("etape 1/3 -- géocodage")
        latlon_match = _LATLON_RE.match(address)
        if latlon_match:
            lat_in, lon_in = float(latlon_match.group(1)), float(latlon_match.group(2))
            geocode = await reverse_geocode(client, lat_in, lon_in)
            logger.info(
                "  -> reverse geocode %s (citycode=%s, lat=%.5f, lon=%.5f)",
                geocode.label, geocode.citycode, geocode.lat, geocode.lon,
            )
        else:
            geocode = await geocode_address(client, address)
            logger.info(
                "  -> %s (citycode=%s, lat=%.5f, lon=%.5f, score=%.2f)",
                geocode.label, geocode.citycode, geocode.lat, geocode.lon, geocode.score,
            )

        # Étape 2 - collecte parallèle
        logger.info("etape 2/3 -- collecte parallèle (bdnb, georisques)")
        tasks: dict[str, Awaitable] = {
            "bdnb": _safe_call("bdnb", _fetch_bdnb_avec_repli(client, address, geocode.label), erreurs),
            "georisques": _safe_call(
                "georisques",
                georisques_connector.fetch_georisques_raw(client, geocode.citycode, geocode.lat, geocode.lon),
                erreurs,
            ),
        }

        keys = list(tasks.keys())
        results = await asyncio.gather(*(tasks[k] for k in keys))
        resolved = dict(zip(keys, results))

        bdnb_data = resolved["bdnb"]
        georisques_data = resolved["georisques"]

    # Étape 3 - assemblage du contrat brut
    logger.info("etape 3/3 -- assemblage du contrat (%d erreur(s) de source)", len(erreurs))
    now_iso = datetime.now(timezone.utc).isoformat()

    building_data = {
        "adresse": {
            "label": geocode.label,
            "citycode": geocode.citycode,
            "postcode": geocode.postcode,
            "city": geocode.city,
            "lat": geocode.lat,
            "lon": geocode.lon,
        },
        "bdnb": {
            "donnees": bdnb_data,
            "_source": {
                "provider": "BDNB",
                "url": "https://bndb.ai",
                "recuperee_le": now_iso,
            },
        },
        "georisques": {
            "donnees": georisques_data or {"erreurs": ["georisques totalement indisponible"]},
            "_source": {
                "provider": "Géorisques",
                "url": "https://www.georisques.gouv.fr",
                "recuperee_le": now_iso,
            },
        },
        "erreurs_sources": erreurs,
        "genere_le": now_iso,
    }

    logger.info(
        "collector_agent -- terminé en %.2fs (%d erreur(s))",
        time.perf_counter() - t0, len(erreurs),
    )
    return building_data
