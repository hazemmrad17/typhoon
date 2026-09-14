"""Hydrographie réelle (IGN BD TOPO) — reconstruction du « trajet de l'eau ».

Le même pari que River Runner aux États-Unis (flowlines USGS + NLDI) : au lieu
de dessiner une surface d'eau inventée, on suit le RÉSEAU HYDROGRAPHIQUE RÉEL.
On part de l'adresse diagnostiquée, on s'accroche au tronçon de cours d'eau le
plus proche, puis on remonte/descend la topologie réelle :

  · `BDTOPO_V3:troncon_hydrographique` porte le graphe orienté :
      - `sens_de_l_ecoulement` (« Sens direct » = le tracé va de l'amont vers
        l'aval ; « Sens inverse » = l'inverse), et surtout
      - `lien_vers_noeud_hydrographique_ini` / `_fin` — les liens explicites
        vers les nœuds d'extrémité. C'est ce qui permet de chaîner les
        tronçons sans jamais deviner par la géométrie.
  · `BDTOPO_V3:noeud_hydrographique` type les nœuds (`Confluent`,
    `Diffluent`, `Jonction linéaire`, `Exutoire`, `Source`, `Perte`) : la
    catégorie dit POURQUOI un parcours s'arrête.
  · `BDTOPO_V3:cours_d_eau` donne le nom réel (`toponyme`) du cours d'eau.
  · `BDTOPO_V3:bassin_versant_topographique` donne le bassin versant
    contributeur en UNE requête (`libelle_du_bassin_hydrographique`).

Trois contraintes mesurées en direct, qui expliquent la forme du code :

1. Le service IGN GÉOPLATEFORME n'accepte PAS le `outputFormat=text/xml;
   subtype=gml/3.2.1` qu'exige le WFS Géorisques (HTTP 400) : on n'envoie
   jamais ce paramètre (le GML 3.2 est le format par défaut).
2. L'ordre d'axes de l'URN EPSG:4326 est (lat, lon) — en requête (`BBOX`)
   comme en réponse (`posList`). On lit `srsName` pour le savoir.
3. Le GML est en `srsDimension="3"` : `posList` contient des TRIPLETS
   (lat, lon, altitude), et l'attribut est porté par l'élément GÉOMÉTRIE
   (`gml:LineString`), pas par `posList`. Ne jamais supposer 2 dimensions :
   une lecture naïve par paires produit des coordonnées absurdes (mesuré :
   un tronçon de 188 909 km).

Le parcours d'un réseau est coûteux (une requête par nœud, ~1 s) : on ne
requête donc pas nœud par nœud. On charge une FENÊTRE de tronçons autour de la
tête de parcours, on marche dans le cache local sans requête, et on ne recharge
une fenêtre que lorsque la tête en sort. Le parcours est en outre TOUJOURS borné
(budget de tronçons + budget de requêtes), avec un curseur qui permet de
poursuivre à la demande.

Règle de contrat (identique au reste du projet) : aucun échec réseau ne doit
casser l'UI. Toute erreur produit un résultat typé « indisponible » avec sa
raison, jamais une exception.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from xml.etree import ElementTree as ET

import httpx

WFS_BASE = "https://data.geopf.fr/wfs/ows"

LAYER_TRONCON = "BDTOPO_V3:troncon_hydrographique"
LAYER_NOEUD = "BDTOPO_V3:noeud_hydrographique"
LAYER_COURS = "BDTOPO_V3:cours_d_eau"
LAYER_BASSIN = "BDTOPO_V3:bassin_versant_topographique"

SOURCE_BDTOPO = "IGN BD TOPO V3 (Géoplateforme)"

SENS_DIRECT = "Sens direct"
SENS_INVERSE = "Sens inverse"

# Catégories de nœuds qui terminent un parcours, avec la raison lisible.
TERMINAL_CATEGORIES: dict[str, str] = {
    "Exutoire": "exutoire — le cours d'eau rejoint son exutoire (confluence majeure, mer ou plan d'eau)",
    "Perte": "perte — le cours d'eau disparaît (infiltration, passage souterrain)",
    "Source": "source — origine du cours d'eau",
}

# Budgets : bornent explicitement la latence du endpoint.
# Mesuré en direct sur Paris 2e : 25 tronçons ≈ 39 km en aval, 23 km en amont,
# 5,4 s et 25 requêtes. 60 tronçons (74 km) coûtent 8,4 s : on garde donc un
# premier tracé court et net, que le frontend PROLONGE à la demande.
DEFAULT_BUDGET = 25
MAX_BUDGET = 400
MAX_REQUESTS = 40
WINDOW_HALF_DEG = 0.02  # ≈ 2,2 km
WINDOW_COUNT = 200
SNAP_HALF_DEG = 0.012  # ≈ 1,3 km autour de l'adresse
SNAP_COUNT = 120
TIMEOUT_S = 14.0

GML_GEOMETRY_NAMES = {
    "Point",
    "LineString",
    "Curve",
    "Polygon",
    "Surface",
    "MultiPoint",
    "MultiLineString",
    "MultiCurve",
    "MultiPolygon",
    "MultiSurface",
}

# Célérité d'une onde de crue le long d'un cours d'eau — BANDE DOCUMENTÉE, pas
# une sortie de modèle hydraulique. Elle sert à donner un ORDRE DE GRANDEUR du
# temps de propagation depuis l'amont, jamais une prédiction.
CELERITY_MIN_M_S = 1.0
CELERITY_MAX_M_S = 2.5


# ---------------------------------------------------------------------------
# Utilitaires géométriques
# ---------------------------------------------------------------------------

def haversine_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))


def _point_in_ring(lon: float, lat: float, ring: list[tuple[float, float]]) -> bool:
    """Ray casting — l'anneau est en (lon, lat)."""
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        if (y1 > lat) != (y2 > lat):
            xin = (x2 - x1) * (lat - y1) / (y2 - y1) + x1
            if lon < xin:
                inside = not inside
    return inside


# ---------------------------------------------------------------------------
# Lecture GML 3.2 (dimension héritée de l'élément géométrie)
# ---------------------------------------------------------------------------

def _localname(tag: Any) -> str:
    return str(tag).rsplit("}", 1)[-1]


def _axis_latlon(srs_name: str | None) -> bool:
    """True si l'ordre d'axes est (lat, lon) — cas des URN OGC EPSG:4326."""
    return bool(srs_name) and srs_name.startswith("urn:") and "4326" in srs_name


def _coords_from_poslist(
    el: ET.Element,
    inherited_srs: str | None = None,
    inherited_dim: str | None = None,
) -> list[tuple[float, float, float | None]]:
    """Coordonnées d'un `gml:posList`, en tenant compte de `srsDimension` et de
    l'ordre d'axes.

    `srsDimension` ET `srsName` sont portés par l'ÉLÉMENT GÉOMÉTRIE
    (`gml:LineString`, `gml:Surface`…), pas par `posList`, et pas non plus par
    les `gml:LinearRing` imbriqués. On hérite donc des deux depuis la géométrie
    porteuse : sans cette héritage, un anneau lu sous un `gml:Surface` reste en
    (lat, lon) et le test d'appartenance au bassin échoue silencieusement.
    """
    poslist = None
    for child in el.iter():
        if _localname(child.tag) == "posList":
            poslist = child
            break
    if poslist is None or not (poslist.text or "").strip():
        return []

    dim_raw = poslist.get("srsDimension") or el.get("srsDimension") or inherited_dim
    if dim_raw is None:
        for candidate in el.iter():
            d = candidate.get("srsDimension")
            if d:
                dim_raw = d
                break
    try:
        dim = int(dim_raw) if dim_raw else 2
    except ValueError:
        dim = 2
    if dim not in (2, 3):
        dim = 2

    srs = poslist.get("srsName") or el.get("srsName") or inherited_srs
    swap = _axis_latlon(srs)
    try:
        values = [float(v) for v in (poslist.text or "").split()]
    except ValueError:
        return []

    out: list[tuple[float, float, float | None]] = []
    for i in range(0, len(values) - dim + 1, dim):
        a, b = values[i], values[i + 1]
        z = values[i + 2] if dim == 3 else None
        lon, lat = (b, a) if swap else (a, b)
        out.append((lon, lat, _valid_z(z)))
    return out


# Altitude « pas de Z » de BD TOPO : sentinelles -1000 / 9999 (vérifié en
# direct : le profil publiait -1000 m pour des tronçons non cotés).
_Z_MIN, _Z_MAX = -450.0, 4900.0


def _valid_z(z: float | None) -> float | None:
    if z is None:
        return None
    return z if _Z_MIN <= z <= _Z_MAX else None


def _rings_of(feature: ET.Element) -> list[list[tuple[float, float, float | None]]]:
    """Tous les anneaux/lignes d'une feature, quel que soit le type GML."""
    geom = None
    for el in feature.iter():
        if _localname(el.tag) in GML_GEOMETRY_NAMES:
            geom = el
            break
    if geom is None:
        return []

    geom_srs = geom.get("srsName")
    geom_dim = geom.get("srsDimension")
    name = _localname(geom.tag)
    if name == "Point":
        coords = _coords_from_poslist(geom, geom_srs, geom_dim)
        return [coords] if coords else []
    if name in ("LineString", "Curve"):
        coords = _coords_from_poslist(geom, geom_srs, geom_dim)
        return [coords] if coords else []

    # Polygon / Surface / Multi* : un anneau par LinearRing, chacun héritant de
    # l'ordre d'axes et de la dimension de la géométrie porteuse.
    rings: list[list[tuple[float, float, float | None]]] = []
    for el in geom.iter():
        if _localname(el.tag) == "LinearRing":
            coords = _coords_from_poslist(el, geom_srs, geom_dim)
            if len(coords) >= 3:
                rings.append(coords)
    if rings:
        return rings
    coords = _coords_from_poslist(geom, geom_srs, geom_dim)
    return [coords] if len(coords) >= 3 else []


def _props_of(feature: ET.Element) -> dict[str, str]:
    """Propriétés scalaires directes de la feature (hors géométrie/boundedBy)."""
    props: dict[str, str] = {}
    for child in feature:
        name = _localname(child.tag)
        if name in ("boundedBy", "geometrie") or name in GML_GEOMETRY_NAMES:
            continue
        if list(child):
            continue  # type complexe : inutile ici
        text = (child.text or "").strip()
        if text:
            props[name] = text
    return props


def parse_features(xml_text: str) -> list[tuple[str, dict[str, str], list[list[tuple[float, float, float | None]]]]]:
    """WFS GetFeature (GML 3.2) → [(type_local, propriétés, anneaux)]."""
    if not xml_text or "ExceptionReport" in xml_text[:600]:
        return []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []

    out: list[tuple[str, dict[str, str], list[list[tuple[float, float, float | None]]]]] = []
    for member in root.iter():
        if _localname(member.tag) not in ("member", "featureMember"):
            continue
        feature = next(iter(member), None)
        if feature is None:
            continue
        out.append((_localname(feature.tag), _props_of(feature), _rings_of(feature)))
    return out


# ---------------------------------------------------------------------------
# Modèle de tronçon
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class Segment:
    cleabs: str
    sens: str | None
    ini: str | None
    fin: str | None
    code: str | None
    ordre: int | None
    principal: bool
    width_rank: float
    points: list[tuple[float, float, float | None]] = field(default_factory=list)

    @property
    def routable(self) -> bool:
        """Un tronçon n'est orientable que si son sens est explicite.

        « Double sens » et « Sans objet » existent dans BD TOPO (bras, plans
        d'eau) : on refuse de deviner, donc on ne sait pas le parcourir.
        """
        return self.sens in (SENS_DIRECT, SENS_INVERSE)

    @property
    def entry_node(self) -> str | None:
        """Nœud d'entrée géographique (indépendant du sens d'écoulement)."""
        return self.ini

    @property
    def exit_node(self) -> str | None:
        return self.fin

    def downstream_node(self) -> str | None:
        """Nœud de sortie AVAL (par où l'eau quitte le tronçon)."""
        if self.sens == SENS_DIRECT:
            return self.fin
        if self.sens == SENS_INVERSE:
            return self.ini
        return None

    def upstream_node(self) -> str | None:
        """Nœud d'entrée AMONT (par où l'eau arrive)."""
        if self.sens == SENS_DIRECT:
            return self.ini
        if self.sens == SENS_INVERSE:
            return self.fin
        return None

    def length_m(self) -> float:
        pts = self.points
        return sum(
            haversine_m(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])
            for i in range(len(pts) - 1)
        )

    def start_alt(self) -> float | None:
        for p in self.points:
            if p[2] is not None:
                return p[2]
        return None

    def end_alt(self) -> float | None:
        for p in reversed(self.points):
            if p[2] is not None:
                return p[2]
        return None


def _width_rank(label: str | None) -> float:
    """Rang de largeur depuis `classe_de_largeur` (« 5 à 10 m » → 10)."""
    if not label:
        return 0.0
    numbers: list[float] = []
    for token in label.replace(",", ".").split():
        try:
            numbers.append(float(token))
        except ValueError:
            continue
    return max(numbers) if numbers else 0.0


def _segment_from(props: dict[str, str], rings) -> Segment | None:
    cleabs = props.get("cleabs")
    if not cleabs:
        return None
    points: list[tuple[float, float, float | None]] = []
    for ring in rings:
        if ring:
            points = ring
            break
    if len(points) < 2:
        return None
    ordre: int | None
    try:
        ordre = int(props["numero_d_ordre"]) if props.get("numero_d_ordre") else None
    except ValueError:
        ordre = None
    return Segment(
        cleabs=cleabs,
        sens=props.get("sens_de_l_ecoulement"),
        ini=props.get("lien_vers_noeud_hydrographique_ini"),
        fin=props.get("lien_vers_noeud_hydrographique_fin"),
        code=props.get("code_hydrographique"),
        ordre=ordre,
        principal=(props.get("reseau_principal_coulant", "").lower() == "true"),
        width_rank=_width_rank(props.get("classe_de_largeur")),
        points=points,
    )


def _bbox(lon: float, lat: float, half: float) -> str:
    """BBOX en ordre d'axes URN EPSG:4326 → (lat, lon, lat, lon)."""
    return f"{lat - half},{lon - half},{lat + half},{lon + half},urn:ogc:def:crs:EPSG::4326"


# ---------------------------------------------------------------------------
# Accès réseau
# ---------------------------------------------------------------------------

async def _get(client: httpx.AsyncClient, params: dict[str, str]) -> str | None:
    query = {
        "SERVICE": "WFS",
        "VERSION": "2.0.0",
        "REQUEST": "GetFeature",
        # Jamais d'outputFormat ici : le service IGN rejette l'en-tête GML 3.2
        # du WFS Géorisques avec un HTTP 400 (vérifié en direct).
        **params,
    }
    for attempt in range(2):
        try:
            resp = await client.get(WFS_BASE, params=query, timeout=TIMEOUT_S)
            if resp.status_code != 200:
                continue
            return resp.text
        except (httpx.HTTPError, httpx.TimeoutException):
            continue
    return None


async def fetch_segments(
    client: httpx.AsyncClient, *, lon: float, lat: float, half: float = WINDOW_HALF_DEG
) -> list[Segment]:
    """Tronçons d'une fenêtre autour d'un point."""
    xml = await _get(
        client,
        {"TYPENAMES": LAYER_TRONCON, "COUNT": str(WINDOW_COUNT), "BBOX": _bbox(lon, lat, half)},
    )
    if not xml:
        return []
    return [s for s in (_segment_from(p, r) for _, p, r in parse_features(xml)) if s]


async def fetch_node_category(client: httpx.AsyncClient, cleabs: str) -> str | None:
    xml = await _get(
        client,
        {"TYPENAMES": LAYER_NOEUD, "COUNT": "1", "CQL_FILTER": f"cleabs='{cleabs}'"},
    )
    if not xml:
        return None
    for _, props, _ in parse_features(xml):
        return props.get("categorie")
    return None


def _ring_area_m2(ring: list[tuple[float, float]]) -> float:
    """Aire approchée (m²) d'un anneau (lon, lat) — sert à choisir le bassin
    le PLUS LOCAL parmi des bassins emboîtés."""
    if len(ring) < 3:
        return 0.0
    lat0 = sum(p[1] for p in ring) / len(ring)
    kx = 111320.0 * math.cos(math.radians(lat0))
    ky = 110540.0
    area = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i][0] * kx, ring[i][1] * ky
        x2, y2 = ring[(i + 1) % n][0] * kx, ring[(i + 1) % n][1] * ky
        area += x1 * y2 - x2 * y1
    return abs(area) / 2.0


async def fetch_catchment(
    client: httpx.AsyncClient, *, lon: float, lat: float
) -> dict[str, Any] | None:
    """Bassin versant contributeur contenant le point (UNE requête).

    `bassin_versant_topographique` est HIÉRARCHIQUE : plusieurs polygones
    emboîtés contiennent le même point (du bassin local au grand ensemble
    hydrographique). On retient le plus local (aire minimale) comme bassin
    contributeur, et on publie le libellé du plus vaste comme rattachement
    (« Seine-Normandie »).
    """
    xml = await _get(
        client,
        {
            "TYPENAMES": LAYER_BASSIN,
            "COUNT": "40",
            "BBOX": _bbox(lon, lat, 0.03),
        },
    )
    if not xml:
        return None

    containing: list[tuple[float, dict[str, Any], list[tuple[float, float]]]] = []
    group: str | None = None
    for _, props, rings in parse_features(xml):
        libelle = props.get("libelle_du_bassin_hydrographique")
        if libelle:
            group = group or libelle
        for ring in rings:
            flat = [(p[0], p[1]) for p in ring]
            if len(flat) < 3 or not _point_in_ring(lon, lat, flat):
                continue
            containing.append(
                (
                    _ring_area_m2(flat),
                    {
                        "libelle": libelle,
                        "toponyme": props.get("toponyme"),
                        "code": props.get("code_hydrographique"),
                    },
                    flat,
                )
            )
    if not containing:
        return None

    containing.sort(key=lambda item: item[0])
    area, props, ring = containing[0]
    return {
        **props,
        "area_km2": round(area / 1e6, 1),
        # Le plus vaste des bassins contenants = rattachement hydrographique.
        "group_libelle": max(
            (c[0], c[1].get("libelle")) for c in containing if c[1].get("libelle")
        )[1]
        if any(c[1].get("libelle") for c in containing)
        else group,
        "ring": ring,
    }


async def fetch_watercourse_name(
    client: httpx.AsyncClient, *, lon: float, lat: float, half: float
) -> tuple[str | None, str | None]:
    """Nom du cours d'eau réel le plus proche de la tête (« La Seine », …).

    Renvoie (toponyme, importance) — l'important est de nommer, pas de classer.
    """
    xml = await _get(
        client,
        {"TYPENAMES": LAYER_COURS, "COUNT": "30", "BBOX": _bbox(lon, lat, half)},
    )
    if not xml:
        return None, None

    best: tuple[float, str, str | None] | None = None
    for _, props, rings in parse_features(xml):
        name = props.get("toponyme")
        if not name:
            continue
        for ring in rings:
            pts = [(p[0], p[1]) for p in ring]
            if not pts:
                continue
            d = min(haversine_m(lon, lat, x, y) for x, y in pts)
            if best is None or d < best[0]:
                best = (d, name, props.get("importance"))
    if best is None:
        return None, None
    return best[1], best[2]


# ---------------------------------------------------------------------------
# Parcours du réseau, borné et à curseur
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class Walker:
    """Marche dans le réseau avec cache de fenêtre (une requête ≈ 2 km).

    Requêter nœud par nœud coûte ~1 s par tronçon (BD TOPO segmente à ~150 m
    en ville) : on charge donc tous les tronçons d'une fenêtre, on marche
    localement, et on ne recharge que si la tête sort de la fenêtre.
    """

    client: httpx.AsyncClient
    requests: int = 0
    cache: dict[str, Segment] = field(default_factory=dict)
    _window: tuple[float, float] | None = None

    async def load_window(self, lon: float, lat: float) -> None:
        if self.requests >= MAX_REQUESTS:
            return
        self.requests += 1
        segs = await fetch_segments(self.client, lon=lon, lat=lat)
        for s in segs:
            self.cache.setdefault(s.cleabs, s)
        self._window = (lon, lat)

    def candidates(self, node: str, direction: str) -> list[Segment]:
        """Tronçons du cache qui prolongent le parcours depuis `node`."""
        out: list[Segment] = []
        for s in self.cache.values():
            if not s.routable:
                continue
            if direction == "down":
                # L'eau quitte node : (direct & ini==node) ou (inverse & fin==node)
                if (s.sens == SENS_DIRECT and s.ini == node) or (s.sens == SENS_INVERSE and s.fin == node):
                    out.append(s)
            else:
                # L'eau arrive à node : (direct & fin==node) ou (inverse & ini==node)
                if (s.sens == SENS_DIRECT and s.fin == node) or (s.sens == SENS_INVERSE and s.ini == node):
                    out.append(s)
        return out


def _alt_at_end_nearest(
    segment: Segment, lon: float, lat: float
) -> float | None:
    """Altitude du tronçon à l'extrémité la plus proche d'une position.

    Indispensable : `points[0]` n'est pas forcément l'extrémité par laquelle on
    RACCORDE le tronçon. Comparer la mauvaise extrémité compare deux altitudes
    sans rapport (une source d'amont contre un exutoire d'aval).
    """
    pts = segment.points
    if not pts:
        return None
    head_d = haversine_m(lon, lat, pts[0][0], pts[0][1])
    tail_d = haversine_m(lon, lat, pts[-1][0], pts[-1][1])
    return pts[0][2] if head_d <= tail_d else pts[-1][2]


def _pick(
    candidates: list[Segment],
    ref_alt: float | None,
    at_lon: float,
    at_lat: float,
) -> Segment:
    """Choix déterministe au point de branchement.

    Priorité : rester sur le réseau principal coulant, puis le bras le plus
    large, puis la continuité du lit (altitude la plus proche de celle qu'on
    quitte, mesurée à l'extrémité de raccordement). Trois critères explicites
    plutôt qu'un choix arbitraire.
    """

    def key(s: Segment) -> tuple:
        alt = _alt_at_end_nearest(s, at_lon, at_lat)
        dz = abs(alt - ref_alt) if (alt is not None and ref_alt is not None) else 9999.0
        return (0 if s.principal else 1, -s.width_rank, dz, s.cleabs)

    return sorted(candidates, key=key)[0]


def _orient(segment: Segment, from_lon: float, from_lat: float) -> list[tuple[float, float, float | None]]:
    """Ordonne les points du tronçon depuis l'extrémité où l'on se trouve.

    On ne suppose jamais que `points[0]` correspond à `ini` : on choisit
    l'orientation géométriquement (extrémité la plus proche de la position
    courante). C'est robuste aux deux conventions de tracé.
    """
    pts = segment.points
    if len(pts) < 2:
        return pts
    head_d = haversine_m(from_lon, from_lat, pts[0][0], pts[0][1])
    tail_d = haversine_m(from_lon, from_lat, pts[-1][0], pts[-1][1])
    return pts if head_d <= tail_d else list(reversed(pts))


@dataclass(slots=True)
class Stretch:
    direction: str
    points: list[tuple[float, float, float | None]] = field(default_factory=list)
    segments: int = 0
    length_m: float = 0.0
    has_more: bool = False
    cursor: str | None = None
    stop_reason: str = "unknown"
    stop_label: str = ""
    stop_node: str | None = None
    # Nombre de requêtes réellement émises — observable, donc vérifiable.
    requests: int = 0


async def walk_stretch(
    client: httpx.AsyncClient,
    *,
    start: Segment,
    direction: str,
    budget: int = DEFAULT_BUDGET,
    cursor: str | None = None,
) -> Stretch:
    """Parcours borné depuis un tronçon, en amont (`up`) ou en aval (`down`)."""
    st = Stretch(direction=direction)

    if not start.routable:
        st.stop_reason = "not_routable"
        st.stop_label = (
            "sens d'écoulement non renseigné sur ce tronçon "
            f"(« {start.sens or 'inconnu'} ») : le parcours n'est pas orientable"
        )
        return st

    walker = Walker(client=client)
    # Première fenêtre : autour du tronçon de départ.
    seed = start.points[len(start.points) // 2]
    await walker.load_window(seed[0], seed[1])

    current = start
    node = current.downstream_node() if direction == "down" else current.upstream_node()

    # Le tronçon de départ est parcouru DEPUIS l'adresse : on entre par le nœud
    # correspondant au sens du parcours.
    entry = (current.upstream_node(), current.downstream_node()) if direction == "down" else (
        current.downstream_node(),
        current.upstream_node(),
    )
    entry_lon, entry_lat = (
        (start.points[0][0], start.points[0][1])
        if entry[0] == start.ini
        else (start.points[-1][0], start.points[-1][1])
    )
    st.points.extend(_orient(current, entry_lon, entry_lat))
    st.segments = 1
    st.length_m = current.length_m()

    while node and st.segments < budget:
        cands = walker.candidates(node, direction)
        if not cands:
            if walker.requests < MAX_REQUESTS:
                # La tête a peut-être quitté la fenêtre : on recharge autour d'elle.
                await walker.load_window(st.points[-1][0], st.points[-1][1])
                cands = walker.candidates(node, direction)
        if not cands:
            st.stop_node = node
            if walker.requests >= MAX_REQUESTS:
                # Budget de REQUÊTES épuisé : le réseau ne s'arrête pas ici, on
                # ne peut simplement plus le suivre sans dépasser la latence
                # qu'on s'autorise. Le dire est la seule réponse honnête.
                st.has_more = True
                tail = st.points[-1]
                ref = _alt_at_end_nearest(current, tail[0], tail[1])
                st.cursor = f"{direction}|{node}|{ref if ref is not None else ''}"
                st.stop_reason = "request_budget"
                st.stop_label = (
                    "parcours interrompu par le budget de requêtes (le cours d'eau "
                    "continue en aval)"
                )
                st.requests = walker.requests
                return st
            # Fin de réseau : on demande au nœud POURQUOI (exutoire, perte…).
            category = await fetch_node_category(client, node)
            walker.requests += 1
            if category in TERMINAL_CATEGORIES:
                st.stop_reason = category.lower()
                st.stop_label = TERMINAL_CATEGORIES[category]
            else:
                st.stop_reason = "no_next"
                label = f" (nœud « {category} »)" if category else ""
                st.stop_label = f"aucun tronçon ne prolonge le parcours{label}"
            st.requests = walker.requests
            return st

        tail = st.points[-1]
        # Continuité du lit : on compare l'altitude du candidat À L'EXTRÉMITÉ
        # par laquelle il se raccorde à notre position courante.
        ref_alt = _alt_at_end_nearest(current, tail[0], tail[1])
        nxt = _pick(cands, ref_alt, tail[0], tail[1])
        oriented = _orient(nxt, tail[0], tail[1])
        st.points.extend(oriented)
        st.length_m += nxt.length_m()
        st.segments += 1
        current = nxt
        node = nxt.downstream_node() if direction == "down" else nxt.upstream_node()

        # Fenêtre rechargée quand la tête s'éloigne du centre courant.
        if walker._window:
            wlon, wlat = walker._window
            if haversine_m(tail[0], tail[1], wlon, wlat) > WINDOW_HALF_DEG * 111000 * 0.55:
                await walker.load_window(tail[0], tail[1])

    st.has_more = bool(node)
    if st.has_more:
        tail = st.points[-1]
        ref = _alt_at_end_nearest(current, tail[0], tail[1])
        st.cursor = f"{direction}|{node}|{ref if ref is not None else ''}"
        st.stop_node = node
        st.stop_reason = "budget"
        st.stop_label = "parcours borné — la suite est disponible à la demande"
    st.requests = walker.requests
    return st


# ---------------------------------------------------------------------------
# Assemblage du contrat
# ---------------------------------------------------------------------------

def _to_linestring(points: list[tuple[float, float, float | None]]) -> dict[str, Any]:
    # GeoJSON : [lon, lat] (on ne publie que la planimétrie ; l'altitude sert
    # au profil en long, pas au tracé).
    coords = [[round(p[0], 7), round(p[1], 7)] for p in points]
    return {"type": "LineString", "coordinates": coords}


def _profile(points: list[tuple[float, float, float | None]], step_m: float = 100.0) -> list[dict[str, Any]]:
    """Profil en long réel (distance cumulée → altitude).

    L'altitude est absente sur certains tronçons BD TOPO
    (`mode_d_obtention_de_l_altitude = « Pas de Z »`) : on ne comble JAMAIS un
    trou par interpolation, on publie les points réellement cotés.
    """
    out: list[dict[str, Any]] = []
    dist = 0.0
    last_emit = -1e9
    for i, p in enumerate(points):
        if i:
            prev = points[i - 1]
            dist += haversine_m(prev[0], prev[1], p[0], p[1])
        if p[2] is None:
            continue
        if dist - last_emit < step_m and i != len(points) - 1:
            continue
        last_emit = dist
        out.append({"km": round(dist / 1000, 3), "z_m": round(p[2], 1)})
    return out


def _arrival(upstream_len_m: float) -> dict[str, Any] | None:
    if upstream_len_m <= 0:
        return None
    return {
        "min_hours": round(upstream_len_m / CELERITY_MAX_M_S / 3600, 1),
        "max_hours": round(upstream_len_m / CELERITY_MIN_M_S / 3600, 1),
        "celerity_min_m_s": CELERITY_MIN_M_S,
        "celerity_max_m_s": CELERITY_MAX_M_S,
        "note": (
            "Estimation cinématique (bande de célérité "
            f"{CELERITY_MIN_M_S}–{CELERITY_MAX_M_S} m/s) sur la longueur de cours "
            "d'eau réellement reconstruite en amont — pas un modèle hydraulique."
        ),
    }


def _stretch_out(st: Stretch | None) -> dict[str, Any] | None:
    if st is None or st.segments == 0:
        return None
    return {
        "direction": st.direction,
        "length_km": round(st.length_m / 1000, 3),
        "segments": st.segments,
        "geometry": _to_linestring(st.points),
        "profile": _profile(st.points),
        "has_more": st.has_more,
        "cursor": st.cursor,
        "requests": st.requests,
        "stop": {
            "reason": st.stop_reason,
            "label": st.stop_label,
            "node": st.stop_node,
        },
        "start_point": [round(st.points[0][0], 7), round(st.points[0][1], 7)],
        "end_point": [round(st.points[-1][0], 7), round(st.points[-1][1], 7)],
    }


async def build_hydro(lat: float, lon: float, budget: int = DEFAULT_BUDGET) -> dict[str, Any]:
    """Construit le « trajet de l'eau » réel pour un point.

    Ne lève jamais : en cas d'échec, renvoie `unavailable_reason` renseigné et
    des sections nulles — l'UI dégrade proprement au lieu de casser.
    """
    budget = max(1, min(int(budget or DEFAULT_BUDGET), MAX_BUDGET))
    out: dict[str, Any] = {
        "lat": lat,
        "lon": lon,
        "watercourse": None,
        "watercourse_importance": None,
        "snap_distance_m": None,
        "basin": None,
        "upstream": None,
        "downstream": None,
        "arrival": None,
        "segments_nearby": 0,
        "sources": {
            "network": SOURCE_BDTOPO,
            "catchment": SOURCE_BDTOPO,
            "watercourse": SOURCE_BDTOPO,
            "profile": "altitudes BD TOPO (profil en long réel)",
        },
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
        "unavailable_reason": None,
        "unavailable_label": None,
    }

    try:
        async with httpx.AsyncClient(follow_redirects=True) as client:
            segments = await fetch_segments(client, lon=lon, lat=lat, half=SNAP_HALF_DEG)
            out["segments_nearby"] = len(segments)
            if not segments:
                out["unavailable_reason"] = "no_network"
                out["unavailable_label"] = (
                    "Aucun tronçon de cours d'eau BD TOPO dans un rayon de 1,3 km : "
                    "aucun trajet d'eau n'est reconstituable ici (aucun tracé n'est inventé)."
                )
                return out

            # Accrochage : point le plus proche du réseau réel.
            best: tuple[float, Segment] | None = None
            for seg in segments:
                d = min(haversine_m(lon, lat, p[0], p[1]) for p in seg.points)
                if best is None or d < best[0]:
                    best = (d, seg)
            assert best is not None
            snap_d, start = best
            out["snap_distance_m"] = round(snap_d, 1)

            name, importance = await fetch_watercourse_name(
                client, lon=start.points[0][0], lat=start.points[0][1], half=0.02
            )
            out["watercourse"] = name
            out["watercourse_importance"] = importance

            catchment = await fetch_catchment(client, lon=lon, lat=lat)
            if catchment:
                ring = catchment.pop("ring")
                out["basin"] = {
                    **catchment,
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [[[round(p[0], 6), round(p[1], 6)] for p in ring]],
                    },
                }

            down = await walk_stretch(client, start=start, direction="down", budget=budget)
            up = await walk_stretch(client, start=start, direction="up", budget=budget)

            out["downstream"] = _stretch_out(down)
            out["upstream"] = _stretch_out(up)
            out["arrival"] = _arrival(up.length_m if up else 0.0)

            if out["downstream"] is None and out["upstream"] is None:
                reason = down.stop_reason if down else "unknown"
                out["unavailable_reason"] = reason
                out["unavailable_label"] = (
                    down.stop_label if down and down.stop_label else
                    "le parcours n'a pas pu être reconstitué sur ce tronçon"
                )
    except Exception as exc:  # noqa: BLE001 — contrat « ne casse jamais l'UI »
        out["unavailable_reason"] = "error"
        out["unavailable_label"] = f"réseau hydrographique indisponible ({type(exc).__name__})"
    return out


async def extend_stretch(cursor: str, budget: int = DEFAULT_BUDGET) -> dict[str, Any]:
    """Poursuit un parcours borné depuis un curseur `direction|noeud|alt`.

    Le curseur est auto-suffisant (aucun état serveur) : la direction, le nœud
    de reprise et l'altitude de référence du lit y sont encodés.
    """
    try:
        direction, node, alt_raw = cursor.split("|", 2)
    except ValueError:
        return {"direction": None, "segments": 0, "has_more": False, "cursor": None,
                "stop": {"reason": "bad_cursor", "label": "curseur invalide", "node": None},
                "geometry": None, "profile": [], "length_km": 0.0,
                "start_point": None, "end_point": None}
    budget = max(1, min(int(budget or DEFAULT_BUDGET), MAX_BUDGET))
    ref_alt: float | None
    try:
        ref_alt = float(alt_raw) if alt_raw not in ("", "None") else None
    except ValueError:
        ref_alt = None

    try:
        async with httpx.AsyncClient(follow_redirects=True) as client:
            walker = Walker(client=client)
            # Reprise : on recharge la fenêtre autour du nœud via un tronçon qui
            # le touche (le nœud seul n'a pas de géométrie exploitable ici).
            xml = await _get(
                client,
                {
                    "TYPENAMES": LAYER_TRONCON,
                    "COUNT": "4",
                    "CQL_FILTER": (
                        f"lien_vers_noeud_hydrographique_ini='{node}' OR "
                        f"lien_vers_noeud_hydrographique_fin='{node}'"
                    ),
                },
            )
            walker.requests += 1
            seeds = [s for s in (_segment_from(p, r) for _, p, r in parse_features(xml or "")) if s]
            if not seeds:
                return {"direction": direction, "segments": 0, "has_more": False, "cursor": None,
                        "stop": {"reason": "no_next", "label": "aucun tronçon ne prolonge le parcours",
                                 "node": node},
                        "geometry": None, "profile": [], "length_km": 0.0,
                        "start_point": None, "end_point": None}

            seed_pos = seeds[0].points[0]
            nxt = _pick(seeds, ref_alt, seed_pos[0], seed_pos[1])
            await walker.load_window(nxt.points[0][0], nxt.points[0][1])
            tail_node = nxt.downstream_node() if direction == "down" else nxt.upstream_node()

            st = Stretch(direction=direction)
            st.points.extend(nxt.points)
            st.segments = 1
            st.length_m = nxt.length_m()
            current = nxt
            node_cur = tail_node
            while node_cur and st.segments < budget:
                cands = walker.candidates(node_cur, direction)
                if not cands and walker.requests < MAX_REQUESTS:
                    await walker.load_window(st.points[-1][0], st.points[-1][1])
                    cands = walker.candidates(node_cur, direction)
                if not cands:
                    st.stop_node = node_cur
                    if walker.requests >= MAX_REQUESTS:
                        st.has_more = True
                        ref = _alt_at_end_nearest(current, st.points[-1][0], st.points[-1][1])
                        st.cursor = f"{direction}|{node_cur}|{ref if ref is not None else ''}"
                        st.stop_reason = "request_budget"
                        st.stop_label = (
                            "parcours interrompu par le budget de requêtes (le cours "
                            "d'eau continue en aval)"
                        )
                        break
                    category = await fetch_node_category(client, node_cur)
                    walker.requests += 1
                    if category in TERMINAL_CATEGORIES:
                        st.stop_reason = category.lower()
                        st.stop_label = TERMINAL_CATEGORIES[category]
                    else:
                        st.stop_reason = "no_next"
                        st.stop_label = "aucun tronçon ne prolonge le parcours"
                    break
                tail = st.points[-1]
                ref = _alt_at_end_nearest(current, tail[0], tail[1])
                follow = _pick(cands, ref, tail[0], tail[1])
                st.points.extend(_orient(follow, tail[0], tail[1]))
                st.length_m += follow.length_m()
                st.segments += 1
                current = follow
                node_cur = follow.downstream_node() if direction == "down" else follow.upstream_node()
            else:
                if node_cur:
                    ref = _alt_at_end_nearest(current, st.points[-1][0], st.points[-1][1])
                    st.has_more = True
                    st.cursor = f"{direction}|{node_cur}|{ref if ref is not None else ''}"
                    st.stop_node = node_cur
                    st.stop_reason = "budget"
                    st.stop_label = "parcours borné — la suite est disponible à la demande"
            return _stretch_out(st)
    except Exception as exc:  # noqa: BLE001
        return {"direction": None, "segments": 0, "has_more": False, "cursor": None,
                "stop": {"reason": "error", "label": f"réseau indisponible ({type(exc).__name__})",
                         "node": None},
                "geometry": None, "profile": [], "length_km": 0.0,
                "start_point": None, "end_point": None}
