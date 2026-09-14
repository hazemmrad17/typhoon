"""Photos terrain réelles du secteur (Panoramax) — support visuel des scénarios.

Pourquoi cette source, et pas une banque d'images : les cartes de scénarios de
l'étape 2 ont besoin d'une IMAGE, et une illustration générique (photo d'inondation
trouvée ailleurs) recréerait exactement le décalage que ce projet combat — un
visuel qui ne parle pas du lieu analysé. Panoramax est le fonds photographique
terrestre ouvert français (IGN / DINUM et contributeurs locaux) : chaque image
est géolocalisée, datée, orientée, avec producteur et licence. On cherche donc
la photo la plus proche DU SECTEUR, et on refuse d'en inventer une.

Deux points de méthode :

1. **Orientation.** Une photo à 15 m peut regarder dans le sens opposé et ne
   montrer qu'une façade d'en face. Panoramax publie `view:azimuth` (direction
   de prise de vue) : on préfère donc la photo qui REGARDE le point analysé
   (azimut ≈ cap photo→site), et seulement à défaut la plus proche. Chaque
   réponse porte l'écart d'orientation mesuré, pour que l'écart soit visible.
2. **Refus explicite.** Sans photo dans le rayon, la réponse est valide et
   `available = False` avec sa raison : l'UI retombe alors sur son visuel
   abstrait. Aucune image n'est substituée en silence.

Comme le reste du projet, aucune exception ne remonte : un service indisponible
produit une réponse typée « indisponible » avec sa raison.

Source : API Panoramax — https://api.panoramax.xyz (licence etalab-2.0).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import httpx

from app.core.config import settings

SOURCE_PANORAMAX = "Panoramax (IGN / DINUM) — photos terrain, licence etalab-2.0"

# Rayon de recherche : une rue, pas un quartier. Au-delà, la photo ne parle plus
# du bâtiment analysé.
SEARCH_RADIUS_M = 60.0
# Nombre de photos examinées pour choisir la mieux orientée.
SEARCH_LIMIT = 24
# Tolérance d'orientation : au-delà, la photo est acceptée mais signalée comme
# « ne regardant pas le point » (l'écart est renvoyé dans la réponse).
FACING_TOLERANCE_DEG = 45.0

_EARTH_R_M = 6_371_008.8


@dataclass(frozen=True)
class PanoCandidate:
    """Une photo Panoramax, réduite aux champs dont l'UI a besoin."""

    id: str
    lat: float
    lon: float
    azimuth: float | None  # direction de prise de vue (0-360, nord = 0)
    thumb_url: str | None  # largeur 500 px — taille des cartes
    sd_url: str | None  # largeur 2048 px
    captured_at: str | None
    producer: str | None
    licence: str | None
    page_url: str


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Distance orthodromique en mètres (WGS84 sphérique, précision suffisante)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * _EARTH_R_M * math.asin(min(1.0, math.sqrt(a)))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Cap (0-360, nord = 0) du point 1 vers le point 2."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def angular_diff_deg(a: float, b: float) -> float:
    """Écart angulaire le plus court entre deux caps (0-180)."""
    d = abs((a - b) % 360.0)
    return d if d <= 180.0 else 360.0 - d


def parse_feature(feature: dict[str, Any]) -> PanoCandidate | None:
    """Convertit une `Feature` Panoramax en candidat, ou None si inexploitable.

    Aucune géométrie, aucun identifiant ou aucune vignette => le candidat est
    écarté : mieux vaut pas de photo qu'une photo sans provenance.
    """
    try:
        pid = str(feature.get("id") or "")
        coords = (feature.get("geometry") or {}).get("coordinates") or []
        if not pid or len(coords) < 2:
            return None
        lon, lat = float(coords[0]), float(coords[1])
        assets = feature.get("assets") or {}
        thumb = (assets.get("thumb") or {}).get("href")
        sd = (assets.get("sd") or {}).get("href")
        if not thumb and not sd:
            return None
        props = feature.get("properties") or {}
        az_raw = props.get("view:azimuth")
        try:
            azimuth = float(az_raw) % 360.0 if az_raw is not None else None
        except (TypeError, ValueError):
            azimuth = None
        return PanoCandidate(
            id=pid,
            lat=lat,
            lon=lon,
            azimuth=azimuth,
            thumb_url=thumb or sd,
            sd_url=sd or thumb,
            captured_at=props.get("datetimetz") or props.get("datetime"),
            producer=props.get("geovisio:producer"),
            licence=props.get("license"),
            page_url=f"{settings.panoramax_viewer_url}{pid}",
        )
    except (TypeError, ValueError, AttributeError):
        return None


@dataclass(frozen=True)
class PanoMatch:
    """Photo retenue + ce qui a motivé le choix.

    `facing_error_deg` est l'écart entre l'axe de prise de vue et la direction
    du point analysé : ≤ FACING_TOLERANCE_DEG, la photo regarde le point ;
    au-delà, c'est la photo la plus proche, pas la mieux orientée.
    """

    candidate: PanoCandidate
    distance_m: float
    facing_error_deg: float | None  # None = orientation inconnue


def pick_best_photo(
    candidates: list[PanoCandidate], site_lat: float, site_lon: float
) -> PanoMatch | None:
    """Choisit la photo qui parle le mieux du point analysé.

    Règle, dans cet ordre :
      1. parmi les photos qui REGARDENT le point (écart d'orientation connu et
         sous la tolérance), prendre la plus proche ;
      2. sinon la photo la plus proche, orientation inconnue ou non conforme —
         l'écart est alors renvoyé pour être affiché tel quel.

    Fonction pure : c'est ici qu'est la décision, et elle est testée sans réseau.
    """
    if not candidates:
        return None

    scored: list[tuple[float, float, PanoMatch]] = []
    for cand in candidates:
        dist = haversine_m(site_lat, site_lon, cand.lat, cand.lon)
        facing: float | None = None
        if cand.azimuth is not None:
            # Si la caméra est à 40 m au nord du site, elle regarde le site si
            # son azimut vaut le cap caméra→site, soit l'inverse du cap site→caméra.
            to_camera = bearing_deg(site_lat, site_lon, cand.lat, cand.lon)
            facing = angular_diff_deg(cand.azimuth, (to_camera + 180.0) % 360.0)
        match = PanoMatch(candidate=cand, distance_m=dist, facing_error_deg=facing)
        # Tri : d'abord « regarde le point », ensuite la proximité.
        looking = facing is not None and facing <= FACING_TOLERANCE_DEG
        scored.append((0.0 if looking else 1.0, dist, match))

    scored.sort(key=lambda row: (row[0], row[1]))
    return scored[0][2]


def _bbox(lat: float, lon: float, radius_m: float) -> str:
    """Emprise carrée (minx,miny,maxx,maxy) autour du point, en degrés."""
    dlat = radius_m / 111_320.0
    dlon = radius_m / max(1.0, 111_320.0 * math.cos(math.radians(lat)))
    return f"{lon - dlon:.6f},{lat - dlat:.6f},{lon + dlon:.6f},{lat + dlat:.6f}"


def _empty(reason: str, label: str, *, candidates: int = 0) -> dict[str, Any]:
    return {
        "available": False,
        "reason": reason,
        "label": label,
        "candidates": candidates,
        "id": None,
        "distance_m": None,
        "facing_ok": False,
        "facing_error_deg": None,
        "view_azimuth": None,
        "captured_at": None,
        "thumb_url": None,
        "sd_url": None,
        "page_url": None,
        "producer": None,
        "licence": None,
        "source": SOURCE_PANORAMAX,
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
    }


async def fetch_site_photo(
    lat: float, lon: float, radius_m: float = SEARCH_RADIUS_M
) -> dict[str, Any]:
    """Photo terrain réelle la plus représentative du point analysé.

    Ne lève jamais : retourne `available = False` et sa raison si le fonds ne
    couvre pas le point ou si le service est indisponible.
    """
    try:
        params = {
            "bbox": _bbox(lat, lon, radius_m),
            "limit": str(SEARCH_LIMIT),
        }
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(8.0), follow_redirects=True
        ) as client:
            resp = await client.get(settings.panoramax_search_url, params=params)
            resp.raise_for_status()
            payload = resp.json()

        features = payload.get("features") or []
        candidates = [c for c in (parse_feature(f) for f in features) if c]
        match = pick_best_photo(candidates, lat, lon)
        if match is None:
            return _empty(
                "no_coverage",
                f"Aucune photo Panoramax dans un rayon de {int(radius_m)} m autour du "
                "point : le secteur n'est pas couvert par le fonds (aucune image "
                "générique n'est substituée).",
                candidates=len(candidates),
            )

        cand = match.candidate
        return {
            "available": True,
            "reason": None,
            "label": None,
            "candidates": len(candidates),
            "id": cand.id,
            "distance_m": round(match.distance_m, 1),
            # La photo regarde-t-elle le point analysé ? Sinon elle reste la plus
            # proche des environs : l'UI le dit au lieu de le laisser croire.
            "facing_ok": (
                match.facing_error_deg is not None
                and match.facing_error_deg <= FACING_TOLERANCE_DEG
            ),
            "facing_error_deg": (
                None if match.facing_error_deg is None else round(match.facing_error_deg, 1)
            ),
            "view_azimuth": None if cand.azimuth is None else round(cand.azimuth, 1),
            "captured_at": cand.captured_at,
            "thumb_url": cand.thumb_url,
            "sd_url": cand.sd_url,
            "page_url": cand.page_url,
            "producer": cand.producer,
            "licence": cand.licence,
            "source": SOURCE_PANORAMAX,
            "retrieved_at": datetime.now(timezone.utc).isoformat(),
        }
    except Exception as exc:  # noqa: BLE001 — contrat « ne casse jamais l'UI »
        return _empty(
            "error",
            f"photos terrain indisponibles ({type(exc).__name__})",
        )
