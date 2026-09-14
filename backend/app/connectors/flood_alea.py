"""Aléa d'inondation TRI — profondeur d'eau par scénario au point analysé.

Équivalent français du « depth by probability » de Flood Factor (First Street
Foundation) : la Directive Inondation (2007/60/CE) cartographie, pour chaque
Territoire à Risque Important d'inondation (TRI), les surfaces inondables par
SCÉNARIO —

  · Fréquent    (01Fre, ~10 ans)   — crue de référence fréquente ;
  · Moyen       (02Moy, ~100 ans)  — crue de référence ;
  · Extrême     (03Ext, ~500 ans / situation historique) ;
  · Faible      (04Fai)            — scénario faible (grand étiage, débit
                                     exceptionnellement bas) — cote défavorable
                                     pour la qualité de l'eau, non cartographiée
                                     partout ; traité comme scénario distinct.

et, dans chaque scénario, des CLASSES DE HAUTEUR D'EAU officielles
(`ht_min` / `ht_max`, en mètres, bornes Fermées / Ouvertes : 0-0,5 ; 0,5-1 ;
1-2 ; ≥2). La couche `ISO_HT_{typ}_{classe}_{territoire}` du WFS Géorisques
porte ces polygones ; le point analysé y est testé par point-in-polygon —
même grammaire que la résolution PPR (`georisques_wfs.py`).

Sources vérifiées en direct (GetCapabilities 2026-09-14) :
  · 11 couches méropole FXX : typ 01 (4 classes) + typ 02 (3 — pas de 03MCC)
    + typ 03 (4) ; variantes GLP / GUY / MTQ / MYT / REU pour les DROM ;
  · l'attribut `scenario` (`01Fre` / `02Moy` / `03Ext` / `04Fai`) porte le
    scénario réel du polygone — le suffixe du nom de couche ne fait que
    pré-filtrer ; on lit TOUJOURS l'attribut ;
  · `ht_max = 9999` = bande ouverte « ≥ ht_min » (replié en `max_m = null`) ;
  · `datsortie` non vide = zone sortie de la cartographie (remplacée) : ignorée ;
  · le service accepte plusieurs TYPENAMES en liste (une requête par territoire,
    jamais 11) — mesuré : `numberReturned=6` sur 3 couches jointes ;
  · GML 3.2, axes (lat, lon) sous `srsName=urn:...EPSG::4326`, srsDimension 2
    sur ces couches (BD TOPO hydro porte du 3D : ne jamais supposer).

Honnêteté du contrat : cette profondeur est la CLASSE OFFICIELLE de la
cartographie réglementaire — elle borne le scénario statique (crue de
référence), elle ne simule pas un événement horodaté. Sans zone TRI au point
(`available=False`), la réponse le dit : hors TRI cartographié n'est pas
« jamais inondé ». Aucun échec réseau ne lève : réponse typée « indisponible ».
"""

from __future__ import annotations

import asyncio
import re
from datetime import datetime, timezone
from typing import Any

import httpx

from app.core.logging import get_logger
from app.connectors.georisques_wfs import parse_gml_features, point_in_polygon

logger = get_logger(__name__)

WFS_BASE = "https://www.georisques.gouv.fr/services"
SOURCE_NAME = "Géorisques — cartographie TRI (Directive Inondation)"
SOURCE_URL = "https://www.georisques.gouv.fr/glossaire/1180#sink_doc_s228"

SCENARIO_LABELS: dict[str, str] = {
    "frequent": "Fréquent (~10 ans)",
    "moyen": "Moyen (~100 ans)",
    "extreme": "Extrême (~500 ans)",
    "faiable": "Faible (scénario faible)",
}

# Requêtes par GROUPE DE SCÉNARIO — une requête par scénario (4 au total),
# jamais une seule requête jointe : mesuré en direct, les polygones « 04Fai »
# (scénario faible, spatialement énormes) remplissent le cap de features et
# masquent silencieusement les autres scénarios (500/500 à Avignon).
# Le suffixe de couche pré-filtre la classe ; l'attribut `scenario` du
# polygone reste la vérité re-contrôlée (les zones sont re-classées par
# attribut après parse — un polygone mal étiqueté ne peut pas être perdu).
# ---------------------------------------------------------------------------
# MARGIN DU BBOX — pourquoi il est MINUSCULE (correctif 2026-09-14)
#
# Ce connecteur interrogeait le WFS avec un BBOX de ±0,02° (~2 km) et
# `count=400`. Or ces couches sont des MILLIERS de lanières (la classe 04Fai
# seule en compte des centaines par TRI) : la réponse est une PAGE arbitraire
# tronquée au `count`, pas l'intersection du BBOX. Le polygone qui contient
# réellement l'adresse peut donc être absent de la page — et le test
# point-dans-polygone conclut « hors TRI » à tort.
#
# Mesuré sur 2 quai de la Fosse, Nantes (47.211932, -1.559613) :
#   · ±0,02° / 400 → frequent 400z, moyen 400z, faiable 400z (cap atteint)
#                    → AUCUNE classe trouvée, soit « hors TRI » affiché ;
#   · ±0,0005° / 50 → faiable 0–1 m trouvé.
#
# Un BBOX à l'échelle du POINT est aussi exact qu'un grand : tout polygone
# contenant le point coupe une boîte centrée sur lui, si petite soit-elle.
# Le réduire ne perd donc aucun résultat utile et supprime la troncature.
POINT_MARGIN_DEG = 0.0005  # ~55 m — échelle du bâti, pas du quartier
POINT_COUNT = 200

# Enveloppe du TRI (ms:LIMITETRI_FXX) — couche SANS ht_min/ht_max : elle dit
# « ce point est-il dans le périmètre d'un TRI ? », pas la hauteur. Elle sépare
# deux vérités que le connecteur confondait :
#   · « hors TRI »                       → le point n'est dans aucun TRI ;
#   · « dans un TRI, aucune classe »     → le point EST dans un TRI, mais
#                                          aucune classe de hauteur n'y est
#                                          cartographiée.
# Mesuré : 3 quai du Châtelet, Orléans et 10 quai Victor Augagneur, Lyon sont
# DANS un TRI d'après cette couche, alors que le connecteur répondait « hors
# TRI » (aucune classe ne les couvre).
TRI_ENVELOPE_LAYERS: list[str] = ["ms:LIMITETRI_FXX"]

SCENARIO_QUERY: dict[str, list[str]] = {
    "frequent": [
        "ms:ISO_HT_01_01FOR_FXX", "ms:ISO_HT_02_01FOR_FXX", "ms:ISO_HT_03_01FOR_FXX",
    ],
    "moyen": [
        "ms:ISO_HT_01_02MOY_FXX", "ms:ISO_HT_02_02MOY_FXX", "ms:ISO_HT_03_02MOY_FXX",
    ],
    "extreme": ["ms:ISO_HT_01_03MCC_FXX", "ms:ISO_HT_03_03MCC_FXX"],
    "faiable": [
        "ms:ISO_HT_01_04FAI_FXX", "ms:ISO_HT_02_04FAI_FXX", "ms:ISO_HT_03_04FAI_FXX",
    ],
}

# Affichage par scénario (la classe d'aléa 03 « MCC » et 04 « FAI » se
# rencontrent dans les scénarios moyen/extrême selon les TRI).
SCENARIO_KEYS = ("frequent", "moyen", "extreme", "faiable")

_HT_MAX_SENTINEL = 9999.0

# `scenario` = « 0XMoy » / « 0YExt »… — les 2 premiers caractères sont le TYPE
# d'inondation, le code scénario est le suffixe. Vérifié en direct : les
# suffixes réels sont Fre/For (fréquent), Moy, Ext/Mcc (crue maximale connue),
# Fai — p.ex. « 01For », « 03Mcc » à Paris (mesuré 2026-09-14).
_SCENARIO_RE = re.compile(r"^\d{2}(Fre|For|Moy|Ext|Mcc|Fai)$", re.IGNORECASE)


def scenario_key_of(scenario_attr: str) -> str | None:
    """`02Moy` → « moyen » ; inconnu → None (zone ignorée, jamais mal rangée)."""
    m = _SCENARIO_RE.match((scenario_attr or "").strip())
    if not m:
        return None
    code = m.group(1).lower()
    return {
        "fre": "frequent",
        "for": "frequent",  # « fortement fréquent » ? — scénario fréquent mesuré
        "moy": "moyen",
        "ext": "extreme",
        "mcc": "extreme",  # « crue maximale connue » — scénario extrême
        "fai": "faiable",
    }[code]  # type: ignore[no-any-return]


# ---------------------------------------------------------------------------
# Parse GML → zones TRI
# ---------------------------------------------------------------------------

def _local(el, name: str):
    for child in el:
        if child.tag.rsplit("}", 1)[-1] == name:
            return child
    return None


def _descendant(el, name: str):
    """Premier descendant (largeur) au nom local donné — les attributs ms:*
    vivent sous l'élément feature (`wfs:member > ms:ISO_HT_* > ms:ht_min`),
    pas directement sous `wfs:member`."""
    for sub in el.iter():
        if sub is not el and sub.tag.rsplit("}", 1)[-1] == name:
            return sub
    return None


def _text_of(el, name: str) -> str:
    child = _descendant(el, name)
    return (child.text or "").strip() if child is not None else ""


def _parse_poslist_2d(el, inherited_srs: str | None) -> list[tuple[float, float]]:
    """posList → (lon, lat). Gère (lat, lon) URN et une éventuelle 3e dim."""
    text = (el.text or "").strip()
    nums = [float(x) for x in text.split() if x]
    srs = el.get("srsName") or inherited_srs or ""
    lat_lon = srs.startswith("urn:") and "4326" in srs
    pts: list[tuple[float, float]] = []
    step = 3 if el.get("srsDimension") == "3" else 2
    for i in range(0, len(nums) - 1, step):
        a, b = nums[i], nums[i + 1]
        pts.append((b, a) if lat_lon else (a, b))
    return pts


def _rings_of(polygon_el, inherited_srs: str | None) -> list[list[tuple[float, float]]]:
    srs = polygon_el.get("srsName") or inherited_srs
    rings: list[list[tuple[float, float]]] = []
    exterior = _local(polygon_el, "exterior")
    if exterior is not None:
        ring = _local(exterior, "LinearRing")
        if ring is not None:
            poslist = _local(ring, "posList")
            if poslist is not None:
                rings.append(_parse_poslist_2d(poslist, srs))
    for interior in [c for c in polygon_el if c.tag.rsplit("}", 1)[-1] == "interior"]:
        ring = _local(interior, "LinearRing")
        if ring is None:
            continue
        poslist = _local(ring, "posList")
        if poslist is not None:
            rings.append(_parse_poslist_2d(poslist, srs))
    return rings


def _polygon_geometry(member) -> dict[str, Any] | None:
    """Premier Polygon/MultiSurface du membre → {type, coordinates} (lon, lat).

    Le srsName URN (axes lat, lon) peut porter sur l'`Envelope` du membre ou la
    `MultiSurface` SANS se répéter sur chaque `Polygon` (mesuré sur ISO_HT) :
    il faut donc l'hériter, sinon les coordonnées restent (lat, lon) et le
    point-in-polygon ne matche jamais — bug silencieux « hors TRI partout ».
    """
    member_srs = next(
        (e.get("srsName") for e in member.iter() if e.get("srsName")), None
    )
    for el in member.iter():
        kind = el.tag.rsplit("}", 1)[-1]
        if kind == "Polygon":
            rings = _rings_of(el, el.get("srsName") or member_srs)
            if rings:
                return {"type": "Polygon", "coordinates": rings}
        if kind == "MultiSurface":
            polys: list[list[list[tuple[float, float]]]] = []
            srs = el.get("srsName") or member_srs
            # surfaceMember est l'usage GML canonique, mais le service sert
            # aussi des Polygon DIRECTEMENT sous MultiSurface (mesuré ISO_HT) :
            # parcourir les deux, sans jamais traiter deux fois un Polygon.
            for sm in [c for c in el if c.tag.rsplit("}", 1)[-1] in ("surfaceMember", "Polygon")]:
                poly = sm if sm.tag.rsplit("}", 1)[-1] == "Polygon" else _local(sm, "Polygon")
                if poly is not None:
                    rings = _rings_of(poly, poly.get("srsName") or srs)
                    if rings:
                        polys.append(rings)
            if polys:
                return {"type": "MultiPolygon", "coordinates": polys}
    return None


def parse_iso_ht(xml_text: str) -> list[dict[str, Any]]:
    """GetFeature ISO_HT → zones TRI [{ht_min, ht_max, scenario, datsortie,
    cours_deau, id_tri, id_zone, geometry}] — robuste à un payload vide/tronqué."""
    if not xml_text or "<" not in xml_text:
        return []
    from xml.etree import ElementTree as ET

    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []
    out: list[dict[str, Any]] = []
    for member in root.iter():
        if member.tag.rsplit("}", 1)[-1] != "member":
            continue
        geom = _polygon_geometry(member)
        if geom is None:
            continue
        ht_min_s, ht_max_s = _text_of(member, "ht_min"), _text_of(member, "ht_max")
        if not ht_min_s or not ht_max_s:
            continue
        try:
            ht_min, ht_max = float(ht_min_s), float(ht_max_s)
        except ValueError:
            continue
        out.append({
            "ht_min": ht_min,
            "ht_max": ht_max,
            "scenario": _text_of(member, "scenario"),
            "datsortie": _text_of(member, "datsortie"),
            "cours_deau": _text_of(member, "cours_deau") or None,
            "id_tri": _text_of(member, "id_tri") or None,
            "id_zone": _text_of(member, "id_zone") or None,
            "geometry": geom,
        })
    return out


# ---------------------------------------------------------------------------
# Sélection de bande au point
# ---------------------------------------------------------------------------

def select_zone(
    zones: list[dict[str, Any]],
    lat: float,
    lon: float,
) -> dict[str, Any] | None:
    """Zone TRI contenant le point (bande la plus haute en cas d'ambiguïté).

    Une zone `datsortie` non vide est retirée de la cartographie : ignorée.
    """
    pt = (lon, lat)
    best: dict[str, Any] | None = None
    for z in zones:
        if (z.get("datsortie") or "").strip():
            continue
        geom = z.get("geometry") or {}
        if not point_in_polygon(pt, geom):
            continue
        if best is None or z["ht_min"] > best["ht_min"]:
            best = z
    return best


# ---------------------------------------------------------------------------
# Résolution au point
# ---------------------------------------------------------------------------

def _band_out(ht_min: float, ht_max: float) -> dict[str, Any]:
    out: dict[str, Any] = {"min_m": ht_min, "max_m": None if ht_max >= _HT_MAX_SENTINEL else ht_max}
    out["label"] = (
        f"≥ {ht_min:g} m" if out["max_m"] is None else f"{ht_min:g} – {ht_max:g} m"
    )
    return out


def _empty_scenario(key: str, present: bool | None, reason_zone: dict[str, Any] | None) -> dict[str, Any]:
    return {
        "key": key,
        "label": SCENARIO_LABELS[key],
        "present": present,
        "depth_band": None if reason_zone is None else _band_out(reason_zone["ht_min"], reason_zone["ht_max"]),
        "cours_deau": reason_zone.get("cours_deau") if reason_zone else None,
        "id_tri": reason_zone.get("id_tri") if reason_zone else None,
    }


async def _point_in_envelope(client: httpx.AsyncClient | None, lat: float, lon: float) -> bool | None:
    """Le point est-il dans le PÉRIMÈTRE d'un TRI (ms:LIMITETRI_FXX) ?

    `None` = couche indisponible → on ne tranche pas (jamais de faux « hors
    TRI » fabriqué à partir d'une panne, cf. §2 : une panne n'est pas une
    absence de risque).
    """
    params = {
        "SERVICE": "WFS",
        "VERSION": "2.0.0",
        "REQUEST": "GetFeature",
        "TYPENAMES": ",".join(TRI_ENVELOPE_LAYERS),
        "outputFormat": "text/xml; subtype=gml/3.2.1",
        "count": str(POINT_COUNT),
        "BBOX": f"{lat - POINT_MARGIN_DEG},{lon - POINT_MARGIN_DEG},{lat + POINT_MARGIN_DEG},{lon + POINT_MARGIN_DEG},urn:ogc:def:crs:EPSG::4326",
    }
    for attempt in range(2):
        try:
            if client is None:
                async with httpx.AsyncClient() as own:
                    resp = await own.get(WFS_BASE, params=params, timeout=8.0)
            else:
                resp = await client.get(WFS_BASE, params=params, timeout=8.0)
            resp.raise_for_status()
            # Parser GÉNÉRIQUE : cette couche n'a ni ht_min ni ht_max, donc
            # `parse_iso_ht` (spécifique aux classes) la rejetterait entièrement.
            features = parse_gml_features(resp.text)
            if features or attempt == 1:
                return any(
                    point_in_polygon((lon, lat), f)
                    for f in features
                    if f.get("type") in ("Polygon", "MultiPolygon")
                )
        except Exception:  # httpx, timeout, 5xx — ne jamais remonter
            pass
        await asyncio.sleep(0.4)
    return None


async def resolve_flood_alea(
    lat: float,
    lon: float,
    margin_deg: float = POINT_MARGIN_DEG,
    client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    """Profondeur d'eau TRI par scénario au point (lat, lon) — ne lève jamais.

    `available=True`  : le point tombe dans au moins une classe TRI ;
    `available=False` + `in_tri=True`  : le point est dans un TRI, mais aucune
                      classe de hauteur d'eau n'y est cartographiée ;
    `available=False` + `in_tri=False` : le point n'est dans aucun TRI ;
    `present=None`    : service indisponible — on ne sait pas.

    La distinction `in_tri` est essentielle : « hors TRI » et « dans un TRI
    sans classe à cet endroit » ne disent pas la même chose à l'utilisateur.
    """
    retrieved_at = datetime.now(timezone.utc).isoformat()
    base = {
        "resolution": "per-building",
        "source": SOURCE_NAME,
        "source_url": SOURCE_URL,
        "retrieved_at": retrieved_at,
    }

    # Une requête par GROUPE DE SCÉNARIO (cf. SCENARIO_QUERY) : le suffixe de
    # couche pré-filtre la classe, l'attribut `scenario` re-contrôle ensuite.
    async def _fetch_group(type_names: list[str]) -> list[dict[str, Any]] | None:
        params = {
            "SERVICE": "WFS",
            "VERSION": "2.0.0",
            "REQUEST": "GetFeature",
            "TYPENAMES": ",".join(type_names),
            "outputFormat": "text/xml; subtype=gml/3.2.1",
            "count": str(POINT_COUNT),
            # Ordre d'axes URN EPSG::4326 = (lat, lon) — comme `fetch_wfs_layer` :
            # south, west, north, east. Une BBOX lon-first renvoie silencieusement 0.
            "BBOX": f"{lat - margin_deg},{lon - margin_deg},{lat + margin_deg},{lon + margin_deg},urn:ogc:def:crs:EPSG::4326",
        }
        for attempt in range(2):
            try:
                if client is None:
                    async with httpx.AsyncClient() as own:
                        resp = await own.get(WFS_BASE, params=params, timeout=8.0)
                else:
                    resp = await client.get(WFS_BASE, params=params, timeout=8.0)
                resp.raise_for_status()
                zones = parse_iso_ht(resp.text)
                # Piège mesuré en direct : le service répond parfois HTTP 200
                # avec 0 feature pour une requête qui en rendait 2 minutes
                # avant (hoquet MapServer, cf. AGENTS.md). Une réponse vide
                # est donc AMBIGUË — on la rejoue une fois avant de conclure.
                if zones or attempt == 1:
                    return zones
            except Exception:  # httpx, timeout, 5xx — ne jamais remonter
                pass
            await asyncio.sleep(0.4)
        return None

    results = await asyncio.gather(
        *(_fetch_group(layers) for layers in SCENARIO_QUERY.values())
    )

    by_scenario: dict[str, list[dict[str, Any]]] = {}
    degraded = False
    for (key, _layers), zones in zip(SCENARIO_QUERY.items(), results):
        if zones is None:
            degraded = True
            continue
        for z in zones:
            # Re-contrôle par attribut : le polygone reste rangé dans son
            # scénario réel même si la couche de provenance diffère.
            attr_key = scenario_key_of(z["scenario"])
            if attr_key is None:
                continue
            by_scenario.setdefault(attr_key, []).append(z)

    if degraded:
        logger.info("flood-alea: WFS TRI partiellement indisponible (lat=%.5f lon=%.5f)", lat, lon)
        return {
            **base,
            "available": False,
            # Service en panne ⇒ on ne prétend PAS savoir s'il y a un TRI ici.
            "in_tri": None,
            "reason": "Service WFS Géorisques indisponible (les zones TRI n'ont pas pu être vérifiées)",
            "scenarios": [_empty_scenario(k, None, None) for k in SCENARIO_KEYS],
        }

    for k in SCENARIO_KEYS:
        by_scenario.setdefault(k, [])

    scenarios: list[dict[str, Any]] = []
    any_hit = False
    for key in SCENARIO_KEYS:
        hit = select_zone(by_scenario[key], lat, lon)
        if hit is not None:
            any_hit = True
        scenarios.append(_empty_scenario(key, hit is not None, hit))

    if not any_hit:
        # Aucune CLASSE au point — mais le point peut tout de même être dans le
        # PÉRIMÈTRE d'un TRI (aucune hauteur cartographiée à cet endroit précis).
        # Deux situations, deux messages : les confondre faisait dire « hors
        # TRI » à des adresses de quai réellement situées dans un TRI.
        in_tri = await _point_in_envelope(client, lat, lon)
        if in_tri is True:
            reason = (
                "Point dans le périmètre d'un TRI, mais aucune classe de hauteur "
                "d'eau n'y est cartographiée : le repère réglementaire de crue "
                "n'est pas disponible à cette adresse précise."
            )
        elif in_tri is False:
            reason = "Aucune zone TRI cartographiée à ce point (hors TRI n'est pas « jamais inondé »)"
        else:
            reason = (
                "Aucune classe de hauteur d'eau TRI cartographiée à ce point ; "
                "l'appartenance au périmètre TRI n'a pas pu être vérifiée "
                "(service indisponible) — hors TRI n'est pas « jamais inondé »."
            )
        return {
            **base,
            "available": False,
            "in_tri": in_tri,
            "reason": reason,
            "scenarios": scenarios,
        }
    return {**base, "available": True, "in_tri": True, "reason": None, "scenarios": scenarios}
