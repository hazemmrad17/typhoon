"""
WFS Géorisques — résolution des aléas au niveau du bâtiment.

L'API REST Géorisques (`gaspar/risques`, `gaspar/pprn`, …) est interrogée par
`code_insee` : elle répond « la commune est-elle concernée ? ». Pour répondre
« ce bâtiment précis est-il dans la zone ? » il faut interroger le WFS
(https://www.georisques.gouv.fr/services) et tester le point de l'adresse
contre les géométries réelles (point-in-polygon, ou proximité pour les
couches points/lignes).

Le WFS Géorisques (MapServer) ne sert que du GML 3.2 — pas de JSON malgré
`outputFormat=application/json`. On demande `text/xml; subtype=gml/3.2.1` et
on parse le GML nous-mêmes (parser minimal volontaire : géométries + 2-3
attributs utiles, cf. le parser frontal équivalent `frontend/src/zone/
mapHelpers.ts` qui fait le même travail côté carte).

Règle de contrat : aucun appel réseau ne doit faire échouer le diagnostic.
Si le WFS est indisponible, la résolution retombe au niveau commune
(`resolution="commune-level"`) sans lever d'exception.
"""

from __future__ import annotations

import asyncio
import math
from typing import Any
from xml.etree import ElementTree as ET

import httpx

WFS_BASE = "https://www.georisques.gouv.fr/services"

# Couches vecteur par aléa — noms vérifiés en direct sur le GetCapabilities
# (2026-08-14) et sur des requêtes réelles (voir config.ts côté frontend).
WFS_LAYER_MAP: dict[str, list[str]] = {
    "ssp": ["ms:SSP_CLASSIF_SIS_GE"],
    "ppr": [
        "ms:PPRN_PERIMETRE_INOND",
        "ms:PPRN_PERIMETRE_SUBMAR",
        "ms:PPRN_PERIMETRE_MVT",
        "ms:PPRN_PERIMETRE_SEISME",
        "ms:PPRN_PERIMETRE_AVALANCHE",
        "ms:PPRN_PERIMETRE_FEU",
        "ms:PPRT_PERIMETRE_RISQIND",
        "ms:PPRM_PERIMETRE_MINIER",
    ],
    "canalisations": ["ms:C_GAZ", "ms:C_HYDROCARBURES", "ms:C_PRODUITS_CHIM"],
}

# Ventilation des 8 couches PPR de WFS_LAYER_MAP["ppr"] par type de péril.
# L'agrégat "ppr" ci-dessus répond « un PPR quelconque touche-t-il ce point ? » —
# utile pour une carte générale, mais pas pour un péril précis : un bâtiment
# peut être dans un périmètre PPR sismique sans être dans un périmètre PPR
# inondation, et l'agrégat ne fait pas la différence.
#
# Cas particulier "seisme" : `PPRN_PERIMETRE_SEISME` est un PPRS (plan de
# prévention des risques sismiques, site-spécifique, prescrit dans une poignée
# de communes) — un instrument juridiquement distinct du zonage sismique
# national (5 zones, fixées par décret par commune, sans résolution plus fine
# possible). La résolution de l'aléa sismicité doit donc rester `commune-level`
# et n'utiliser ce type que comme signal annexe.
PPR_TYPE_LAYERS: dict[str, list[str]] = {
    "inondation": ["ms:PPRN_PERIMETRE_INOND", "ms:PPRN_PERIMETRE_SUBMAR"],
    "mouvement_terrain": ["ms:PPRN_PERIMETRE_MVT"],
    "seisme": ["ms:PPRN_PERIMETRE_SEISME"],
    "avalanche": ["ms:PPRN_PERIMETRE_AVALANCHE"],
    "feu_foret": ["ms:PPRN_PERIMETRE_FEU"],
    "risque_industriel": ["ms:PPRT_PERIMETRE_RISQIND"],
    "minier": ["ms:PPRM_PERIMETRE_MINIER"],
}

# Rayon de tolérance (mètres) pour les couches non-polygonales (points/lignes) :
# un site pollué à 50 m du bâtiment, ou une canalisation qui passe à 30 m, reste
# pertinent pour le diagnostic. Les polygones, eux, sont testés par point-in-polygon.
PROXIMITY_RADIUS_M = 200.0

_GML = "http://www.opengis.net/gml/3.2"

_GEOM_TYPES = {"Point", "LineString", "Polygon", "MultiSurface", "MultiPoint", "MultiLineString", "MultiPolygon"}


# ---------------------------------------------------------------------------
# GML 3.2 → géométries simples
# ---------------------------------------------------------------------------

def _local(el: ET.Element, name: str) -> ET.Element | None:
    for child in el:
        if child.tag.rsplit("}", 1)[-1] == name:
            return child
    return None


def _children_local(el: ET.Element, name: str) -> list[ET.Element]:
    return [c for c in el if c.tag.rsplit("}", 1)[-1] == name]


def _descendants_local(el: ET.Element, name: str) -> list[ET.Element]:
    out: list[ET.Element] = []
    for child in el:
        if child.tag.rsplit("}", 1)[-1] == name:
            out.append(child)
        out.extend(_descendants_local(child, name))
    return out


def _is_lat_lon_order(srs_name: str | None) -> bool:
    """En GML 3.2 avec `urn:ogc:def:crs:EPSG::4326`, l'ordre est (lat, lon) —
    cf. le parser frontal `isLatLonAxisOrder`. L'attribut vit sur l'élément
    géométrie (Polygon/MultiSurface…), pas sur le posList, d'où l'héritage. """
    return bool(srs_name) and srs_name.startswith("urn:") and "4326" in srs_name


def _parse_poslist(el: ET.Element, inherited_srs: str | None = None) -> list[tuple[float, float]]:
    """Parse une suite de coordonnées GML en tenant compte de l'ordre d'axes.

    On retourne des couples (lon, lat) pour rester cohérent avec le reste du
    backend (les autres connecteurs manipulent des (lon, lat)).
    """
    text = (el.text or "").strip()
    nums = [float(x) for x in text.split() if x]
    lat_lon_order = _is_lat_lon_order(el.get("srsName") or inherited_srs)
    pts: list[tuple[float, float]] = []
    for i in range(0, len(nums) - 1, 2):
        a, b = nums[i], nums[i + 1]
        pts.append((b, a) if lat_lon_order else (a, b))
    return pts


def _ring_points(ring_el: ET.Element, inherited_srs: str | None = None) -> list[tuple[float, float]]:
    poslist = _local(ring_el, "posList")
    if poslist is not None:
        return _parse_poslist(poslist, inherited_srs)
    coords = _local(ring_el, "coordinates")  # variante legacy GML 2
    if coords is not None:
        pts: list[tuple[float, float]] = []
        for pair in (coords.text or "").split():
            x, y = pair.split(",")
            pts.append((float(x), float(y)))
        return pts
    pos = _local(ring_el, "pos")
    if pos is not None:
        return _parse_poslist(pos, inherited_srs)
    return []


def _polygon_from_el(el: ET.Element, inherited_srs: str | None = None) -> list[list[tuple[float, float]]]:
    """GML Polygon → liste d'anneaux (exterieur + trous)."""
    srs = el.get("srsName") or inherited_srs
    exterior = _local(el, "exterior")
    if exterior is None:
        return []
    ring = _local(exterior, "LinearRing")
    if ring is None:
        ring = _local(exterior, "Ring")
    if ring is None:
        return []
    rings = [_ring_points(ring, srs)]
    for interior in _children_local(el, "interior"):
        iring = _local(interior, "LinearRing")
        if iring is None:
            iring = _local(interior, "Ring")
        if iring is not None:
            rings.append(_ring_points(iring, srs))
    return rings


def _geometry_from_el(el: ET.Element) -> dict[str, Any] | None:
    kind = el.tag.rsplit("}", 1)[-1]
    if kind == "Polygon":
        rings = _polygon_from_el(el)
        return {"type": "Polygon", "coordinates": rings} if rings else None
    if kind == "MultiSurface":
        polys: list[list[list[tuple[float, float]]]] = []
        srs = el.get("srsName")
        for member in _children_local(el, "surfaceMember"):
            poly = _local(member, "Polygon")
            if poly is None:
                poly = _local(member, "Surface")
            if poly is not None:
                rings = _polygon_from_el(poly, srs)
                if rings:
                    polys.append(rings)
        return {"type": "MultiPolygon", "coordinates": polys} if polys else None
    srs = el.get("srsName")
    if kind == "Point":
        pos = _local(el, "pos")
        if pos is not None:
            pts = _parse_poslist(pos, srs)
            return {"type": "Point", "coordinates": pts[0]} if pts else None
    if kind == "LineString":
        poslist = _local(el, "posList")
        if poslist is not None:
            pts = _parse_poslist(poslist, srs)
            return {"type": "LineString", "coordinates": pts} if len(pts) >= 2 else None
    return None


def _feature_geometry(feature_el: ET.Element) -> dict[str, Any] | None:
    """Cherche la géométrie d'une feature (wfs:member > ms:Type > ms:msGeometry)."""
    # Descend d'abord vers l'élément portant la géométrie : on prend la première
    # balise de géométrie GML en largeur (évite de prendre un polygone imbriqué
    # dans un MultiSurface à la place du MultiSurface).
    for el in feature_el.iter():
        if el.tag.rsplit("}", 1)[-1] in _GEOM_TYPES:
            geom = _geometry_from_el(el)
            if geom:
                return geom
    return None


def parse_gml_features(xml_text: str) -> list[dict[str, Any]]:
    """Convertit une réponse WFS GetFeature (GML 3.2) en liste de features.

    Retourne `[{type, coordinates, properties}]` — on ne lit que la géométrie
    et quelques attributs (identifiants, libellés) utiles au diagnostic.
    """
    if not xml_text or "<" not in xml_text:
        return []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []
    out: list[dict[str, Any]] = []
    for member in root.iter():
        if member.tag.rsplit("}", 1)[-1] != "member":
            continue
        geom = _feature_geometry(member)
        if geom is None:
            continue
        props: dict[str, Any] = {}
        # Quelques attributs plats utiles (identifiant, libellé le cas échéant).
        for attr in ("id_information", "libelle", "nom", "code_insee", "num_com"):
            el = _descendants_local(member, attr)
            if el and (el[0].text or "").strip():
                props[attr] = el[0].text.strip()
        out.append({"type": geom["type"], "coordinates": geom["coordinates"], "properties": props})
    return out


# ---------------------------------------------------------------------------
# Tests géométriques
# ---------------------------------------------------------------------------

def _point_in_ring(pt: tuple[float, float], ring: list[tuple[float, float]]) -> bool:
    """Ray casting : le point (lon, lat) est-il dans l'anneau ?"""
    x, y = pt
    inside = False
    n = len(ring)
    if n < 3:
        return False
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def point_in_polygon(pt: tuple[float, float], polygon: Any) -> bool:
    """Point (lon, lat) dans un Polygon / MultiPolygon GML.

    L'anneau extérieur est le premier ; les suivants sont des trous.
    """
    if polygon.get("type") == "Polygon":
        rings: list[list[tuple[float, float]]] = polygon["coordinates"]
        if not rings:
            return False
        if not _point_in_ring(pt, rings[0]):
            return False
        return not any(_point_in_ring(pt, r) for r in rings[1:])
    if polygon.get("type") == "MultiPolygon":
        return any(point_in_polygon(pt, {"type": "Polygon", "coordinates": p}) for p in polygon["coordinates"])
    return False


def _haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1 = a
    lon2, lat2 = b
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def _distance_to_segment_m(pt: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
    """Distance point → segment [a, b], en mètres (approximation plane locale)."""
    x, y = pt
    ax, ay = a
    bx, by = b
    # Projection paramétrique sur le segment (dans le plan lon/lat local).
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    if length_sq == 0:
        return _haversine_m(pt, a)
    t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / length_sq))
    proj = (ax + t * dx, ay + t * dy)
    return _haversine_m(pt, proj)


def _distance_to_geometry(pt: tuple[float, float], geom: dict[str, Any]) -> float | None:
    """Distance minimale point → géométrie (lignes/points), en mètres."""
    if geom.get("type") == "Point":
        return _haversine_m(pt, geom["coordinates"])
    if geom.get("type") == "LineString":
        coords: list[tuple[float, float]] = geom["coordinates"]
        return min(
            _distance_to_segment_m(pt, coords[i], coords[i + 1])
            for i in range(len(coords) - 1)
        )
    if geom.get("type") == "Polygon":
        ring = geom["coordinates"][0]
        return min(
            _distance_to_segment_m(pt, ring[i], ring[(i + 1) % len(ring)])
            for i in range(len(ring))
        )
    if geom.get("type") == "MultiPolygon":
        return min(
            _distance_to_segment_m(pt, ring[i], ring[(i + 1) % len(ring)])
            for p in geom["coordinates"]
            for ring in p
            for i in range(len(ring))
        )
    return None


def geometry_intersects_point(geom: dict[str, Any], pt: tuple[float, float], radius_m: float = PROXIMITY_RADIUS_M) -> bool:
    """Le point (lon, lat) touche-t-il la géométrie ?

    Polygones → point-in-polygon strict. Points/lignes → test de proximité
    (une canalisation à 30 m est un risque pertinent même si le bâtiment
    n'est pas dessus).
    """
    kind = geom.get("type")
    if kind in ("Polygon", "MultiPolygon"):
        return point_in_polygon(pt, geom)
    dist = _distance_to_geometry(pt, geom)
    return dist is not None and dist <= radius_m


# ---------------------------------------------------------------------------
# Fetch WFS
# ---------------------------------------------------------------------------

async def fetch_wfs_layer(
    client: httpx.AsyncClient,
    type_name: str,
    lon: float,
    lat: float,
    margin_deg: float = 0.02,
    count: int = 200,
) -> list[dict[str, Any]] | None:
    """Interroge une couche WFS par BBOX autour du point (comme le frontend).

    Filtre BBOX plutôt qu'attributaire : `cql_filter=code_insee=...` est
    silencieusement ignoré par le service et le nom du champ commune varie
    selon la couche — le BBOX fonctionne uniformément.
    """
    west, south = lon - margin_deg, lat - margin_deg
    east, north = lon + margin_deg, lat + margin_deg
    params = {
        "SERVICE": "WFS",
        "VERSION": "2.0.0",
        "REQUEST": "GetFeature",
        "TYPENAMES": type_name,
        "outputFormat": "text/xml; subtype=gml/3.2.1",
        "count": str(count),
        "BBOX": f"{south},{west},{north},{east},urn:ogc:def:crs:EPSG::4326",
    }
    # Le service WFS Géorisques est gratuit et peut répondre par intermittence
    # (erreur 5xx ou timeout). Une seule nouvelle tentative après un court délai
    # suffit dans la majorité des cas ; au-delà on retombe au niveau commune.
    for _ in range(2):
        try:
            resp = await client.get(WFS_BASE, params=params, timeout=8.0)
            resp.raise_for_status()
            return parse_gml_features(resp.text)
        except httpx.HTTPError:
            await asyncio.sleep(0.4)
    return None


async def resolve_per_building(
    client: httpx.AsyncClient,
    lon: float,
    lat: float,
) -> dict[str, dict[str, Any]]:
    """Teste le point de l'adresse contre chaque couche vecteur Géorisques.

    Retourne `{alea_code: {"present": bool|None, "count": int, "resolution": str}}`,
    plus une clé `"ppr_par_type"` : `{type: {"present": ..., "count": ...,
    "resolution": ...}}`, une résolution indépendante par type de PPR (inondation,
    mouvement de terrain, séisme, ...) — cf. `PPR_TYPE_LAYERS`.

    - `present=True`  → au moins une zone contient le point (ou est à proximité
      pour les couches points/lignes).
    - `present=False` → le WFS répond mais aucune zone ne touche le point :
      l'aléa existe dans la commune mais pas à cette adresse.
    - `present=None`  → WFS indisponible : on ne sait pas, retombe au niveau
      commune (`resolution="commune-level"`).
    """
    # Cache des features par couche : les 8 couches PPR sont réutilisées telles
    # quelles entre l'agrégat "ppr" et la ventilation "ppr_par_type" — un seul
    # appel réseau par couche, jamais deux.
    layer_cache: dict[str, list[dict[str, Any]] | None] = {}

    async def _fetch(type_name: str) -> list[dict[str, Any]] | None:
        if type_name not in layer_cache:
            layer_cache[type_name] = await fetch_wfs_layer(client, type_name, lon, lat)
        return layer_cache[type_name]

    async def _resolve(layers: list[str]) -> dict[str, Any]:
        present: bool = False
        wfs_ok = True
        total = 0
        for type_name in layers:
            features = await _fetch(type_name)
            if features is None:
                wfs_ok = False
                break
            total += len(features)
            if any(geometry_intersects_point(f, (lon, lat)) for f in features):
                present = True
        if not wfs_ok:
            # WFS indisponible : on ne peut pas trancher au bâtiment, on retombe
            # au niveau commune (le statut communal reste la source de vérité).
            return {"present": None, "count": 0, "resolution": "commune-level"}
        return {"present": present, "count": total, "resolution": "per-building"}

    resultat: dict[str, dict[str, Any]] = {}
    for code, layers in WFS_LAYER_MAP.items():
        resultat[code] = await _resolve(layers)

    resultat["ppr_par_type"] = {
        ppr_type: await _resolve(layers) for ppr_type, layers in PPR_TYPE_LAYERS.items()
    }
    return resultat
