# =============================================================================
#   Pipeline canonique — adresse -> DiagnosticRecord (spec FR-17)
#
#   Le produit est ce service. Une seule transaction : géocodage (avec portes
#   de confiance), puis collecte parallèle Géorisques + BDNB, puis fusion en
#   contrat canonique. Le batch et tout futur surface répètent CE pipeline.
#
#   Dégradation : échec BDNB -> enregistrement partiel 200 (erreur explicite).
#   Échec géocodage -> 422/502 avant tout appel source. Échec WFS -> faits
#   communaux, present=null sur les aléas géométriques (jamais inféré).
# =============================================================================

from __future__ import annotations

import asyncio
import re
import time
from datetime import datetime, timezone

import httpx

from app.connectors.bdnb import BdnbAdresseIntrouvable, fetch_bdnb
from app.connectors.geocoding import (
    GeocodeResult,
    GeocodingError,
    geocode_address,
    reverse_geocode,
)
from app.connectors.georisques import (
    fetch_georisques_raw,
    risque_report_from_raw,
)
from app.schemas.diagnostic_record import (
    AleaRecord,
    DiagnosticRecord,
    PerBuilding,
    PerBuildingMethod,
    Resolution,
    SourceProvenance,
)
from app.schemas.risque_report import AleaDetail
from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)

# Détecte les "adresses" fournies comme coordonnées brutes "lat,lon" (FR-05)
_LATLON_RE = re.compile(r"^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$")

# Seuil de confiance du géocodeur — en dessous : adresse ambiguë, rejet avant
# tout appel source (FR-03).
MIN_GEOCODE_SCORE = 0.4

# Couches testées par proximité (points/lignes) vs polygones stricts.
_PROXIMITY_CODES = {"ssp", "canalisations"}
_PROXIMITY_RADIUS_M = 200.0

# Où trouver le résultat géométrique d'un aléa dans `batiment` du brut.
_BATIMENT_LOOKUP: dict[str, tuple[str, str | None]] = {
    "inondation": ("ppr_par_type", "inondation"),
    "mouvement_terrain": ("ppr_par_type", "mouvement_terrain"),
    "feu_foret": ("ppr_par_type", "feu_foret"),
    "avalanche": ("ppr_par_type", "avalanche"),
    "ppr": ("ppr", None),
    "ssp": ("ssp", None),
    "canalisations": ("canalisations", None),
}


class AdresseAmbigueError(RuntimeError):
    """Score de géocodage trop faible pour trancher."""

    def __init__(self, label_propose: str, score: float):
        super().__init__(f"score {score:.2f}")
        self.label_propose = label_propose


async def _fetch_bdnb_avec_repli(
    client: httpx.AsyncClient, address: str, label_ban: str
) -> dict | None:
    """Interroge BDNB avec repli de géocodage (même sémantique que la route GET)."""
    try:
        return await fetch_bdnb(client, label_ban)
    except BdnbAdresseIntrouvable:
        if label_ban == address:
            raise
        logger.info(
            "  [bdnb] libellé BAN non trouvé (%r), nouvel essai avec l'adresse brute (%r)",
            label_ban, address,
        )
        return await fetch_bdnb(client, address)


def _resolution_of(detail: AleaDetail) -> Resolution:
    """Normalise la chaîne historique en enum canonique, PAR CODE d'aléa :
    le zonage sismique décrétal sort de la source libellé « estimate » alors
    qu'il est communal par nature (FR-13) ; seul le RGA est une estimation
    faute de source vectorielle câblée (FR-12)."""
    if detail.code == "rga":
        return Resolution.COMMUNE_LEVEL_ESTIMATE
    if detail.code in {"sismicite", "radon"}:
        return Resolution.COMMUNE_LEVEL
    text = (detail.resolution or "").lower()
    if text.startswith("per-building"):
        return Resolution.PER_BUILDING
    if "estimate" in text or not text:
        return Resolution.COMMUNE_LEVEL_ESTIMATE
    return Resolution.COMMUNE_LEVEL


def _per_building_of(code: str, raw: dict | None) -> PerBuilding | None:
    """Carve-out explicite : objet présent uniquement si un test géométrique a
    réellement eu lieu (WFS disponible). Sinon clé absente de la sérialisation."""
    if not raw:
        return None
    section, sub_key = _BATIMENT_LOOKUP.get(code, ("", None))
    if not section:
        return None
    block = ((raw.get("batiment") or {}).get(section)) or {}
    info = block.get(sub_key) if sub_key else block
    if not info or info.get("resolution") != "per-building":
        return None
    method = (
        PerBuildingMethod.PROXIMITY if code in _PROXIMITY_CODES
        else PerBuildingMethod.POINT_IN_POLYGON
    )
    return PerBuilding(
        method=method,
        radius_m=_PROXIMITY_RADIUS_M if code in _PROXIMITY_CODES else None,
        count=int(info.get("count") or 0),
    )


def _alea_record(detail: AleaDetail, raw: dict | None) -> AleaRecord:
    return AleaRecord(
        code=detail.code,
        libelle=detail.libelle,
        present=detail.present,
        present_commune=detail.present_commune,
        zonage=detail.zonage,
        hauteur_eau_m=detail.hauteur_eau_m,
        zone_sismique=detail.zone_sismique,
        catnat_historique=detail.catnat_historique,
        per_building=_per_building_of(detail.code, raw),
        source="georisques",
        url_detail=detail.url_detail,
        erreur=detail.erreur,
        resolution=_resolution_of(detail),
    )


def to_canonical_record(
    report,  # RisqueReport
    raw: dict | None,
    bdnb_data: dict | None,
    *,
    bdnb_error: str | None = None,
    genere_le: str,
) -> DiagnosticRecord:
    """RisqueReport (lignée historique) + brut + fiche BDNB -> contrat canonique."""
    erreurs_partielles = list(report.erreurs_partielles)

    bdnb_block = None
    if bdnb_data is not None:
        bdnb_block = {
            "donnees": bdnb_data,
            "_source": {
                "provider": "BDNB",
                "url": settings.bdnb_base_url,
                "attribution": settings.attribution_bdnb,
                "recuperee_le": genere_le,
            },
        }
    elif bdnb_error:
        erreurs_partielles.append(bdnb_error)

    now = genere_le
    record = DiagnosticRecord(
        adresse={
            "saisie": report.adresse_saisie,
            "normalisee": report.adresse_normalisee,
            "citycode": report.code_insee,
            "lat": report.lat,
            "lon": report.lon,
        },
        aleas=[_alea_record(a, raw) for a in report.aleas],
        bdnb=bdnb_block,
        georisques_source={
            "provider": "Géorisques",
            "url": "https://www.georisques.gouv.fr",
            "attribution": settings.attribution_georisques,
            "recuperee_le": now,
        },
        erreurs_partielles=erreurs_partielles,
        genere_le=now,
    )
    return record


async def build_diagnostic_record(adresse: str) -> DiagnosticRecord:
    """Point d'entrée unique : une adresse française -> un DiagnosticRecord.

    Lève :
      - AdresseAmbigueError : score < MIN_GEOCODE_SCORE (422 côté route)
      - GeocodingError      : adresse introuvable (422)
      - httpx.HTTPError     : géocodeur injoignable (502)
    """
    t0 = time.perf_counter()
    logger.info("canonical -- début diagnostic %r", adresse)
    erreurs_partielles: list[str] = []

    async with httpx.AsyncClient(timeout=settings.http_timeout_seconds) as client:
        latlon_match = _LATLON_RE.match(adresse)
        if latlon_match:
            lat_in, lon_in = float(latlon_match.group(1)), float(latlon_match.group(2))
            geo: GeocodeResult = await reverse_geocode(client, lat_in, lon_in)
        else:
            geo = await geocode_address(client, adresse)

        if geo.score < MIN_GEOCODE_SCORE:
            raise AdresseAmbigueError(geo.label, geo.score)

        async def _safe_bdnb() -> dict | None:
            try:
                return await _fetch_bdnb_avec_repli(client, adresse, geo.label)
            except BdnbAdresseIntrouvable:
                erreurs_partielles.append("bdnb: adresse non reconnue par le géocodeur BDNB")
                return None
            except Exception as exc:
                logger.warning("  [bdnb] ECHEC -> %s: %s", type(exc).__name__, exc)
                erreurs_partielles.append(f"bdnb: {type(exc).__name__}: {exc}")
                return None

        raw_geo, bdnb_data = await asyncio.gather(
            fetch_georisques_raw(client, geo.citycode, geo.lat, geo.lon),
            _safe_bdnb(),
        )

    report = risque_report_from_raw(
        raw_geo,
        adresse_saisie=adresse,
        adresse_normalisee=geo.label,
        lat=geo.lat,
        lon=geo.lon,
        code_insee=geo.citycode,
    )
    # Les erreurs de sous-sources Géorisques arrivent via le rapport ; on y
    # ajoute celles de la branche BDNB collectées pendant la collecte.
    for entry in erreurs_partielles:
        if entry not in report.erreurs_partielles:
            report.erreurs_partielles.append(entry)

    record = to_canonical_record(
        report,
        raw_geo,
        bdnb_data,
        genere_le=datetime.now(timezone.utc).isoformat(),
    )
    logger.info(
        "canonical -- terminé en %.2fs (%d aléas, %d erreur(s))",
        time.perf_counter() - t0, len(record.aleas), len(record.erreurs_partielles),
    )
    return record
