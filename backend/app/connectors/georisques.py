"""
Connecteur Géorisques v1 — appel brut + normalisation vers RisqueReport.

API : https://www.georisques.gouv.fr/api/v1 (BRGM / MTE)
Publique, gratuite, sans clé. Limite : 1000 req/min/IP.

Chaque sous-appel est isolé dans son propre try/except :
si une route est indisponible, le reste du rapport continue
et l'erreur remonte dans erreurs_partielles (jamais un 500 global).

Règle clé : aucune valeur inventée si la source est absente.
Un aléa absent = present=None + erreur explicite dans AleaDetail.erreur.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any

import httpx

from app.connectors.georisques_wfs import resolve_per_building
from app.core.config import settings
from app.schemas.risque_report import AleaDetail, NiveauRisque, RisqueReport

_BASE = settings.georisques_base_url


# ---------------------------------------------------------------------------
# Appel HTTP bas niveau
# ---------------------------------------------------------------------------

async def _get(client: httpx.AsyncClient, path: str, params: dict) -> dict | list | None:
    response = await client.get(f"{_BASE}/{path}", params=params, timeout=8.0)
    response.raise_for_status()
    return response.json()


# ---------------------------------------------------------------------------
# Collecte brute des données Géorisques
# ---------------------------------------------------------------------------

# Codes INSEE des communes à arrondissements : le géocodeur BAN/IGN renvoie
# l'arrondissement (75102…, 69381…, 13201…), mais les données communales de
# Géorisques (gaspar/risques, catnat) sont stockées sous la commune (Paris
# 75056, Lyon 69123, Marseille 13055). Sans cette translation, un diagnostic
# sur Paris/Lyon/Marseille voyait « aucune donnée » là où la commune en a
# (vérifié en direct sur l'API : gaspar/risques renvoie les aléas pour 75056,
# rien pour 75102).
_ARRONDISSEMENTS_COMMUNE: dict[tuple[int, int], str] = {
    (75101, 75120): "75056",  # Paris 1er-20e
    (69381, 69389): "69123",  # Lyon 1er-9e
    (13201, 13216): "13055",  # Marseille 1er-16e
}


def _commune_code(citycode: str) -> str:
    """Code INSEE de la commune pour un citycode d'arrondissement (sinon lui-même)."""
    if citycode.isdigit():
        num = int(citycode)
        for (lo, hi), commune in _ARRONDISSEMENTS_COMMUNE.items():
            if lo <= num <= hi:
                return commune
    return citycode


def _payload_non_empty(payload: dict | list | None) -> bool:
    """Vrai si la réponse contient des données exploitables.

    Les réponses paginées Spring vides (`{"data": []}` / `{"content": []}`)
    comptent comme vides : on bascule alors vers l'autre code INSEE (commune
    vs arrondissement). Un objet sans enveloppe-liste (ex. zonage sismique
    `{"code_zone": "1", …}`) compte comme non vide.
    """
    if isinstance(payload, list):
        return len(payload) > 0
    if isinstance(payload, dict):
        for key in ("data", "content", "results"):
            if key in payload:
                v = payload[key]
                return isinstance(v, list) and len(v) > 0
        return True
    return bool(payload)


async def fetch_georisques_raw(
    client: httpx.AsyncClient,
    citycode: str,
    lat: float,
    lon: float,
    rayon_m: int = 1000,
) -> dict:
    """
    Interroge les endpoints Géorisques pour une adresse.

    Retourne un dict avec une clé par sous-source + "erreurs" (liste).
    Ne lève jamais d'exception : les erreurs partielles sont consignées.

    Codes INSEE : les endpoints communaux (gaspar/risques, catnat, azi, ssp)
    sont interrogés avec la commune d'abord puis l'arrondissement en repli ;
    les endpoints par arrondissement (sismique, radon) avec l'arrondissement
    d'abord. Les sources à filtre géographique latlon+rayon (cavités, mvt) et
    l'ICPE sont inchangées dans leur mode d'interrogation — `code_insee` est
    ignoré par `installations_classees` (liste nationale systématiquement
    renvoyée, vérifié en direct), seul `latlon` y est fiable.

    `gaspar/pprn` et `gaspar/pprt` ne sont volontairement PLUS interrogés :
    leur filtre `code_insee` (comme `latlon`) est ignoré par le service, qui
    renvoie toujours la liste nationale complète (6 589 PPR, triés par
    département — le 75 n'apparaît pas dans la première page). La présence
    PPR est résolue au bâtiment via le WFS (`batiment.ppr` /
    `batiment.ppr_par_type`, point-in-polygon contre les périmètres réels).
    """
    resultat: dict = {"erreurs": []}
    latlon = f"{lon},{lat}"

    # Résolution au bâtiment (WFS vecteur) : le point de l'adresse est testé
    # contre les géométries réelles (point-in-polygon / proximité) pour les
    # aléas qui ont une couche vecteur. Si le WFS est indisponible, chaque aléa
    # retombe au niveau commune (resolution="commune-level").
    #
    # Client dédié : la passerelle de georisques.gouv.fr lie une connexion
    # keep-alive à un seul backend — mélanger l'API REST (`/api/v1`) et le WFS
    # (`/services`) sur le même AsyncClient fait 404 « no Route matched » sur
    # toutes les requêtes suivantes. On isole donc le WFS sur sa propre connexion.
    try:
        async with httpx.AsyncClient(timeout=10.0) as wfs_client:
            resultat["batiment"] = await resolve_per_building(wfs_client, lon, lat)
    except Exception:
        # Ne doit jamais faire échouer le diagnostic : repli commune.
        resultat["batiment"] = {}

    commune_code = _commune_code(citycode)
    codes_commune_first = list(dict.fromkeys([commune_code, citycode]))
    codes_arrondissement_first = list(dict.fromkeys([citycode, commune_code]))

    # Endpoints qui renvoient légitimement 404 quand la commune n'a pas de donnée.
    _404_ok = {"zones_inondables", "ssp"}

    async def _fetch_commune(path: str, extra: dict, codes: list[str], cle: str) -> None:
        """Interroge chaque code INSEE et garde la première réponse non vide."""
        resultat[cle] = None
        for code in codes:
            try:
                payload = await _get(client, path, {**extra, "code_insee": code})
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code == 404 and cle in _404_ok:
                    continue  # pas de donnée pour ce code → code suivant
                resultat["erreurs"].append({
                    "source": f"georisques.{cle}",
                    "erreur": str(exc),
                })
                return
            except httpx.HTTPError as exc:
                resultat["erreurs"].append({
                    "source": f"georisques.{cle}",
                    "erreur": str(exc),
                })
                return
            if _payload_non_empty(payload):
                resultat[cle] = payload
                return

    # Données communales — code commune en priorité (Paris 75056, Lyon 69123, …).
    for cle, path in [
        ("risques_commune", "gaspar/risques"),
        ("catnat", "gaspar/catnat"),
        ("zones_inondables", "azi"),
        ("ssp", "ssp"),
    ]:
        await _fetch_commune(path, {}, codes_commune_first, cle)

    # Données par arrondissement — code arrondissement en priorité.
    for cle, path in [("zonage_sismique", "zonage_sismique"), ("radon", "radon")]:
        await _fetch_commune(path, {}, codes_arrondissement_first, cle)

    # Sources à filtre géographique latlon+rayon (aucun code INSEE).
    for cle, path in [("cavites", "cavites"), ("mouvements_terrain", "mvt")]:
        try:
            resultat[cle] = await _get(client, path, {"latlon": latlon, "rayon": rayon_m})
        except httpx.HTTPError as exc:
            resultat[cle] = None
            resultat["erreurs"].append({
                "source": f"georisques.{cle}",
                "erreur": str(exc),
            })

    # ICPE : `code_insee` est ignoré par l'API (liste nationale) → latlon+rayon.
    try:
        resultat["icpe"] = await _get(
            client,
            "installations_classees",
            {"latlon": latlon, "rayon": rayon_m, "pageSize": 100},
        )
    except httpx.HTTPStatusError as exc:
        resultat["icpe"] = None
        if exc.response.status_code != 404:
            resultat["erreurs"].append({
                "source": "georisques.icpe",
                "erreur": str(exc),
            })
    except httpx.HTTPError as exc:
        resultat["icpe"] = None
        resultat["erreurs"].append({
            "source": "georisques.icpe",
            "erreur": str(exc),
        })

    return resultat


# ---------------------------------------------------------------------------
# Helpers d'extraction
# ---------------------------------------------------------------------------

def _data_list(raw: dict, key: str) -> list:
    val = (raw or {}).get(key)
    if isinstance(val, list):
        return val
    if isinstance(val, dict):
        # Deux formes selon l'endpoint : `data` (gaspar/risques, catnat…) ou
        # `content` (gaspar/pprn, gaspar/pprt — réponse paginée Spring).
        d = val.get("data")
        if not isinstance(d, list):
            d = val.get("content")
        return d if isinstance(d, list) else []
    return []


def _risques_commune_entries(raw: dict) -> list[dict]:
    """Entrées du référentiel communal Géorisques (`gaspar/risques`)."""
    rc = (raw or {}).get("risques_commune") or {}
    data = rc.get("data") if isinstance(rc, dict) else None
    if not isinstance(data, list):
        return []
    return [e for e in data if isinstance(e, dict)]


def _has_hazard_keyword(raw: dict, keyword: str) -> bool:
    kw = keyword.lower()
    for entry in _risques_commune_entries(raw):
        for detail in (entry.get("risques_detail") or []):
            if kw in (detail.get("libelle_risque_long") or "").lower():
                return True
    return False


def _zone_sismique(raw: dict) -> int | None:
    """Zone sismique nationale (1-5) — priorité au détail du référentiel
    communal, repli sur l'endpoint `zonage_sismique`."""
    zone: Any = None
    for entry in _risques_commune_entries(raw):
        for detail in (entry.get("risques_detail") or []):
            if detail.get("zone_sismicite") is not None:
                zone = detail["zone_sismicite"]
                break
        if zone is not None:
            break
    if zone is None:
        zonage = _data_list(raw, "zonage_sismique")
        if zonage and isinstance(zonage[0], dict):
            zone = zonage[0].get("zone_sismicite")
    if zone is None:
        return None
    if isinstance(zone, (int, float)):
        return int(zone)
    match = re.search(r"\d+", str(zone))
    return int(match.group(0)) if match else None


def _is_source_failed(raw: dict, cle: str) -> bool:
    return any(
        cle in (e.get("source") or "")
        for e in (raw.get("erreurs") or [])
    )


def _batiment_status(raw: dict, code: str) -> tuple[bool | None, str]:
    """Statut au bâtiment + niveau de résolution pour un aléa donné.

    Retourne (present, resolution) :
    - present=True/False quand le WFS a pu trancher au bâtiment,
    - present=None quand le WFS était indisponible (repli commune,
      resolution="commune-level").
    """
    info = ((raw or {}).get("batiment") or {}).get(code)
    if not info:
        return None, "commune-level"
    return info.get("present"), info.get("resolution", "commune-level")


def _batiment_ppr_type_status(raw: dict, ppr_type: str) -> tuple[bool | None, str]:
    """Statut au bâtiment pour un TYPE de PPR (inondation, mouvement_terrain,
    seisme, feu_foret, avalanche…) via `batiment.ppr_par_type` (WFS).
    L'agrégat `batiment.ppr` mélange les 8 types — ne jamais l'utiliser pour
    un péril précis."""
    info = (((raw or {}).get("batiment") or {}).get("ppr_par_type") or {}).get(ppr_type)
    if not info:
        return None, "commune-level"
    return info.get("present"), info.get("resolution", "commune-level")

# ---------------------------------------------------------------------------
# Normalisation aléa par aléa
# ---------------------------------------------------------------------------

def _alea_icpe(raw: dict) -> AleaDetail:
    """Installations classées (ICPE) — dont Seveso."""
    failed = _is_source_failed(raw, "icpe")
    if failed:
        return AleaDetail(
            code="icpe", libelle="Installations industrielles (ICPE)",
            present=None, present_commune=None, niveau=None,
            erreur="source Géorisques indisponible",
            url_detail="https://www.georisques.gouv.fr/risques/installations-classees-pour-la-protection-de-lenvironnement-icpe",
        )
    icpe_list = _data_list(raw, "icpe")
    n = len(icpe_list)
    seveso = any(
        (
            "seveso" in str(e.get("statut_seveso", "") or "").lower()
            or "seveso" in str(e.get("lib_statut_seveso", "") or "").lower()
        )
        for e in icpe_list
        if isinstance(e, dict)
    )
    base = 10
    if seveso: base = 80
    elif n >= 10: base = 65
    elif n >= 3: base = 45
    elif n >= 1: base = 30
    return AleaDetail(
        code="icpe", libelle="Installations industrielles (ICPE)",
        present=(n > 0),
        present_commune=(n > 0),
        niveau=_score_to_niveau(base),
        zonage=(f"{n} installation(s) classée(s)" + (" dont Seveso" if seveso else "")) if n > 0 else None,
        url_detail="https://www.georisques.gouv.fr/risques/installations-classees-pour-la-protection-de-lenvironnement-icpe",
    )


def _alea_canalisations(raw: dict) -> AleaDetail:
    """Réseaux et canalisations de matières dangereuses (GASPAR)."""
    failed = _is_source_failed(raw, "risques_commune")
    if failed:
        return AleaDetail(
            code="canalisations", libelle="Réseaux et canalisations",
            present=None, present_commune=None, niveau=None,
            erreur="source Géorisques indisponible",
            url_detail="https://www.georisques.gouv.fr/risques/transport-de-matieres-dangereuses",
        )
    hazard = (
        _has_hazard_keyword(raw, "canalisation")
        or _has_hazard_keyword(raw, "matières dangereuses")
        or _has_hazard_keyword(raw, "transport de marchandises dangereuses")
        or _has_hazard_keyword(raw, "tmd")
    )
    score = 45 if hazard else 5
    present_bat, resolution = _batiment_status(raw, "canalisations")
    present = present_bat if present_bat is not None else hazard
    return AleaDetail(
        code="canalisations", libelle="Réseaux et canalisations",
        present=present,
        present_commune=hazard,
        niveau=_score_to_niveau(score),
        resolution="per-building, polygon-checked" if resolution == "per-building" else "commune-level estimate",
        url_detail="https://www.georisques.gouv.fr/risques/transport-de-matieres-dangereuses",
    )


def _alea_vent_cyclonique(raw: dict) -> AleaDetail:
    """Vents cycloniques — pertinent essentiellement pour les DOM-TOM."""
    failed = _is_source_failed(raw, "risques_commune")
    if failed:
        return AleaDetail(
            code="vent_cyclonique", libelle="Vents cycloniques",
            present=None, present_commune=None, niveau=None,
            erreur="source Géorisques indisponible",
            url_detail="https://www.georisques.gouv.fr/risques/cyclones",
        )
    hazard = (
        _has_hazard_keyword(raw, "cyclone")
        or _has_hazard_keyword(raw, "vent cyclonique")
        or _has_hazard_keyword(raw, "phénomène météorologique")
        or _has_hazard_keyword(raw, "phenomene meteorologique")
    )
    score = 60 if hazard else 5
    return AleaDetail(
        code="vent_cyclonique", libelle="Vents cycloniques",
        present=hazard,
        present_commune=hazard,
        niveau=_score_to_niveau(score),
        url_detail="https://www.georisques.gouv.fr/risques/cyclones",
    )


def _alea_inondation(raw: dict) -> AleaDetail:
    """Inondation — PPRI / PPR inondation résolus au bâtiment (WFS, type
    "inondation" de `batiment.ppr_par_type`), atlas AZI (`zones_inondables`)
    et référentiel communal en repli / précision."""
    binfo = (((raw or {}).get("batiment") or {}).get("ppr_par_type") or {}).get("inondation") or {}
    wfs_ok = binfo.get("resolution") == "per-building"
    failed = (
        _is_source_failed(raw, "risques_commune")
        and _is_source_failed(raw, "zones_inondables")
        and not wfs_ok
    )
    if failed:
        return AleaDetail(
            code="inondation", libelle="Inondation",
            present=None, present_commune=None, niveau=None,
            erreur="source Géorisques indisponible",
            url_detail="https://www.georisques.gouv.fr/risques/inondations",
        )
    keyword = _has_hazard_keyword(raw, "inondation")
    n_azi = len(_data_list(raw, "zones_inondables"))
    commune_present = keyword or n_azi > 0
    present_bat, resolution = _batiment_ppr_type_status(raw, "inondation")
    present = present_bat if present_bat is not None else commune_present
    if present_bat is True:
        score = 65
        zonage = "Dans un périmètre PPR inondation" + (f" ({n_azi} zone(s) inondable(s) en atlas)" if n_azi else "")
    elif present_bat is False:
        score = 10
        zonage = "Hors périmètre PPR inondation" + (" — aléa recensé dans la commune" if commune_present else "")
    else:
        score = 45 if commune_present else 5
        zonage = "Inondation recensée dans la commune" if commune_present else "Aucune zone inondable recensée"
    return AleaDetail(
        code="inondation", libelle="Inondation",
        present=present,
        present_commune=commune_present or (present_bat is True),
        niveau=_score_to_niveau(score),
        zonage=zonage,
        resolution="per-building, polygon-checked" if resolution == "per-building" else "commune-level estimate",
        url_detail="https://www.georisques.gouv.fr/risques/inondations",
    )


def _alea_sismicite(raw: dict) -> AleaDetail:
    """Séisme — zonage sismique national (5 zones par commune, décret
    n°2010-1255). Classification communale par nature : pas de résolution
    au bâtiment (le PPRS reste un signal annexe)."""
    failed = _is_source_failed(raw, "zonage_sismique")
    if failed:
        return AleaDetail(
            code="sismicite", libelle="Séisme",
            present=None, present_commune=None, niveau=None,
            erreur="source Géorisques indisponible",
            url_detail="https://www.georisques.gouv.fr/risques/seismes",
        )
    zone = _zone_sismique(raw)
    if zone is None:
        return AleaDetail(
            code="sismicite", libelle="Séisme",
            present=None, present_commune=None, niveau=None,
            erreur="zonage sismique non fourni par Géorisques",
            url_detail="https://www.georisques.gouv.fr/risques/seismes",
        )
    score = {1: 5, 2: 25, 3: 45, 4: 65, 5: 85}.get(zone, 5)
    label = {1: "très faible", 2: "faible", 3: "modérée", 4: "forte", 5: "très forte"}.get(zone, "")
    return AleaDetail(
        code="sismicite", libelle="Séisme",
        present=True, present_commune=True,
        niveau=_score_to_niveau(score),
        zonage=f"Zone sismique {zone} — sismicité {label}",
        zone_sismique=str(zone),
        url_detail="https://www.georisques.gouv.fr/risques/seismes",
    )


def _alea_mouvement_terrain(raw: dict) -> AleaDetail:
    """Mouvements de terrain — événements recensés à proximité de l'adresse
    (latlon+rayon) + périmètre PPR mouvement de terrain résolu au bâtiment."""
    binfo = (((raw or {}).get("batiment") or {}).get("ppr_par_type") or {}).get("mouvement_terrain") or {}
    wfs_ok = binfo.get("resolution") == "per-building"
    failed = _is_source_failed(raw, "mouvements_terrain")
    if failed and not wfs_ok:
        return AleaDetail(
            code="mouvement_terrain", libelle="Mouvements de terrain",
            present=None, present_commune=None, niveau=None,
            erreur="source Géorisques indisponible",
            url_detail="https://www.georisques.gouv.fr/risques/mouvements-de-terrain",
        )
    n_mvt = len(_data_list(raw, "mouvements_terrain"))
    present_bat, resolution = _batiment_ppr_type_status(raw, "mouvement_terrain")
    present = present_bat if present_bat is not None else (n_mvt > 0)
    if present_bat is True:
        score = 60
        zonage = "Dans un périmètre PPR mouvement de terrain"
    elif present_bat is False:
        score = 10
        zonage = "Hors périmètre PPR mouvement de terrain" + (f" — {n_mvt} mouvement(s) à proximité" if n_mvt else "")
    else:
        score = 5
        if n_mvt >= 3:
            score = 50
        elif n_mvt >= 1:
            score = 30
        zonage = f"{n_mvt} mouvement(s) de terrain recensé(s) à proximité" if n_mvt else "Aucun mouvement de terrain recensé"
    return AleaDetail(
        code="mouvement_terrain", libelle="Mouvements de terrain",
        present=present,
        present_commune=(n_mvt > 0) or (present_bat is True),
        niveau=_score_to_niveau(score),
        zonage=zonage,
        resolution="per-building, polygon-checked" if resolution == "per-building" else "commune-level estimate",
        url_detail="https://www.georisques.gouv.fr/risques/mouvements-de-terrain",
    )


def _alea_radon(raw: dict) -> AleaDetail:
    """Radon — potentiel IRSN, classification communale (classe 1 à 3)."""
    failed = _is_source_failed(raw, "radon")
    if failed:
        return AleaDetail(
            code="radon", libelle="Radon",
            present=None, present_commune=None, niveau=None,
            erreur="source Géorisques indisponible",
            url_detail="https://www.georisques.gouv.fr/risques/radon",
        )
    radon = _data_list(raw, "radon")
    potentiel = radon[0].get("classe_potentiel") if radon and isinstance(radon[0], dict) else None
    try:
        classe = int(potentiel)
    except (TypeError, ValueError):
        classe = None
    if classe not in (1, 2, 3):
        return AleaDetail(
            code="radon", libelle="Radon",
            present=None, present_commune=None, niveau=None,
            erreur="potentiel radon non fourni par Géorisques",
            url_detail="https://www.georisques.gouv.fr/risques/radon",
        )
    score = {1: 10, 2: 35, 3: 65}[classe]
    label = {1: "faible", 2: "moyen", 3: "significatif"}[classe]
    return AleaDetail(
        code="radon", libelle="Radon",
        present=True, present_commune=True,
        niveau=_score_to_niveau(score),
        zonage=f"Potentiel radon : classe {classe}/3 ({label})",
        url_detail="https://www.georisques.gouv.fr/risques/radon",
    )


def _alea_rga(raw: dict) -> AleaDetail:
    """Retrait-gonflement des argiles — aléa recensé dans le référentiel communal."""
    failed = _is_source_failed(raw, "risques_commune")
    if failed:
        return AleaDetail(
            code="rga", libelle="Retrait-gonflement des argiles",
            present=None, present_commune=None, niveau=None,
            erreur="source Géorisques indisponible",
            url_detail="https://www.georisques.gouv.fr/risques/retrait-gonflement-des-argiles",
        )
    hazard = _has_hazard_keyword(raw, "argile")
    return AleaDetail(
        code="rga", libelle="Retrait-gonflement des argiles",
        present=hazard, present_commune=hazard,
        niveau=_score_to_niveau(30 if hazard else 5),
        zonage=(
            "Aléa retrait-gonflement des argiles recensé dans la commune"
            if hazard else "Aléa non recensé"
        ),
        url_detail="https://www.georisques.gouv.fr/risques/retrait-gonflement-des-argiles",
    )


def _alea_cavite(raw: dict) -> AleaDetail:
    """Cavités souterraines — cavités recensées à proximité de l'adresse (latlon+rayon)."""
    failed = _is_source_failed(raw, "cavites")
    if failed:
        return AleaDetail(
            code="cavite", libelle="Cavités souterraines",
            present=None, present_commune=None, niveau=None,
            erreur="source Géorisques indisponible",
            url_detail="https://www.georisques.gouv.fr/risques/cavites-souterraines",
        )
    n = len(_data_list(raw, "cavites"))
    score = 5
    if n >= 5:
        score = 60
    elif n >= 2:
        score = 45
    elif n >= 1:
        score = 30
    return AleaDetail(
        code="cavite", libelle="Cavités souterraines",
        present=(n > 0), present_commune=(n > 0),
        niveau=_score_to_niveau(score),
        zonage=f"{n} cavité(s) souterraine(s) recensée(s) à proximité" if n else "Aucune cavité recensée",
        url_detail="https://www.georisques.gouv.fr/risques/cavites-souterraines",
    )


def _alea_feu_foret(raw: dict) -> AleaDetail:
    """Feux de forêt — périmètre PPR résolu au bâtiment + référentiel communal."""
    binfo = (((raw or {}).get("batiment") or {}).get("ppr_par_type") or {}).get("feu_foret") or {}
    wfs_ok = binfo.get("resolution") == "per-building"
    failed = _is_source_failed(raw, "risques_commune")
    if failed and not wfs_ok:
        return AleaDetail(
            code="feu_foret", libelle="Feux de forêt",
            present=None, present_commune=None, niveau=None,
            erreur="source Géorisques indisponible",
            url_detail="https://www.georisques.gouv.fr/risques/feux-de-foret",
        )
    keyword = _has_hazard_keyword(raw, "feu de forêt") or _has_hazard_keyword(raw, "feu de foret")
    present_bat, resolution = _batiment_ppr_type_status(raw, "feu_foret")
    present = present_bat if present_bat is not None else keyword
    if present_bat is True:
        score = 60
        zonage = "Dans un périmètre PPR feu de forêt"
    elif present_bat is False:
        score = 10
        zonage = "Hors périmètre PPR feu de forêt" + (" — feu de forêt recensé dans la commune" if keyword else "")
    else:
        score = 40 if keyword else 5
        zonage = "Feu de forêt recensé dans la commune" if keyword else "Aucun feu de forêt recensé"
    return AleaDetail(
        code="feu_foret", libelle="Feux de forêt",
        present=present,
        present_commune=keyword or (present_bat is True),
        niveau=_score_to_niveau(score),
        zonage=zonage,
        resolution="per-building, polygon-checked" if resolution == "per-building" else "commune-level estimate",
        url_detail="https://www.georisques.gouv.fr/risques/feux-de-foret",
    )


def _alea_avalanche(raw: dict) -> AleaDetail:
    """Avalanches — périmètre PPR résolu au bâtiment + référentiel communal."""
    binfo = (((raw or {}).get("batiment") or {}).get("ppr_par_type") or {}).get("avalanche") or {}
    wfs_ok = binfo.get("resolution") == "per-building"
    failed = _is_source_failed(raw, "risques_commune")
    if failed and not wfs_ok:
        return AleaDetail(
            code="avalanche", libelle="Avalanches",
            present=None, present_commune=None, niveau=None,
            erreur="source Géorisques indisponible",
            url_detail="https://www.georisques.gouv.fr/risques/avalanches",
        )
    keyword = _has_hazard_keyword(raw, "avalanche")
    present_bat, resolution = _batiment_ppr_type_status(raw, "avalanche")
    present = present_bat if present_bat is not None else keyword
    if present_bat is True:
        score = 55
        zonage = "Dans un périmètre PPR avalanche"
    elif present_bat is False:
        score = 10
        zonage = "Hors périmètre PPR avalanche" + (" — avalanche recensée dans la commune" if keyword else "")
    else:
        score = 40 if keyword else 5
        zonage = "Avalanche recensée dans la commune" if keyword else "Aucune avalanche recensée"
    return AleaDetail(
        code="avalanche", libelle="Avalanches",
        present=present,
        present_commune=keyword or (present_bat is True),
        niveau=_score_to_niveau(score),
        zonage=zonage,
        resolution="per-building, polygon-checked" if resolution == "per-building" else "commune-level estimate",
        url_detail="https://www.georisques.gouv.fr/risques/avalanches",
    )


def _alea_ppr(raw: dict) -> AleaDetail:
    """Plans de Prévention des Risques (PPRN + PPRT fusionnés).

    La présence est résolue au bâtiment par le WFS (`batiment.ppr`, point-in-
    polygon contre les périmètres réels) : `gaspar/pprn` est inexploitable
    (le service ignore `code_insee` et renvoie la liste nationale complète).
    Le comptage REST ne sert donc qu'en repli commune quand le WFS est
    indisponible.
    """
    binfo = ((raw or {}).get("batiment") or {}).get("ppr") or {}
    wfs_ok = binfo.get("resolution") == "per-building"
    failed = _is_source_failed(raw, "ppr")
    if failed and not wfs_ok:
        return AleaDetail(
            code="ppr", libelle="Plan de Prévention des Risques (PPR)",
            present=None, present_commune=None, niveau=None,
            erreur="source Géorisques indisponible",
            url_detail="https://www.georisques.gouv.fr/risques/plans-de-prevention-des-risques",
        )
    ppr_list = _data_list(raw, "ppr")
    pprt_list = _data_list(raw, "pprt")
    count_wfs = binfo.get("count") or 0
    n_ppr = count_wfs if wfs_ok else (len(ppr_list) + len(pprt_list))
    present_bat, resolution = _batiment_status(raw, "ppr")
    present = present_bat if present_bat is not None else (n_ppr > 0)
    # Score piloté par la résolution WFS quand elle a tranché : dans un
    # périmètre → signal fort ; hors périmètre → faible (le voisinage de
    # périmètres ne rend pas l'adresse exposée — le point a été testé contre
    # les géométries réelles). Sans WFS, repli sur le comptage REST communal
    # (estimation, pas une résolution au bâtiment : jamais "Dans un périmètre").
    # NB : les branches sont pilotées par present_bat (verdict WFS), pas par
    # `present` (qui vaut True dès que la commune recense un PPR en repli) —
    # sinon le repli communal passerait à tort par le "signal fort".
    if present_bat is True:
        score = 75 if n_ppr >= 3 else 60
    elif present_bat is False:
        score = 10
    else:
        score = 10
        if n_ppr >= 3: score = 75
        elif n_ppr >= 1: score = 50
    if present_bat is True:
        zonage = f"Dans un périmètre PPR ({n_ppr} périmètre(s) dans le secteur)" if n_ppr > 1 else "Dans un périmètre PPR"
    elif present_bat is False:
        zonage = f"Hors périmètre PPR ({n_ppr} périmètre(s) dans le secteur)" if n_ppr > 0 else "Hors périmètre PPR"
    else:
        zonage = f"{n_ppr} PPR recensé(s)" if n_ppr > 0 else "Aucun PPR prescrit"
    return AleaDetail(
        code="ppr", libelle="Plan de Prévention des Risques (PPR)",
        present=present,
        present_commune=(n_ppr > 0),
        niveau=_score_to_niveau(score),
        zonage=zonage,
        resolution="per-building, polygon-checked" if resolution == "per-building" else "commune-level estimate",
        url_detail="https://www.georisques.gouv.fr/risques/plans-de-prevention-des-risques",
    )


def _alea_ssp(raw: dict) -> AleaDetail:
    """Sites et Sols Pollués (BASOL / CASIAS / SIS).

    Le REST `ssp` renvoie souvent vide là où le WFS trouve des SIS (vérifié
    pour Paris : `ssp?code_insee=75056` → 0, alors que la couche vecteur
    `SSP_CLASSIF_SIS_GE` contient un site à proximité de l'adresse). La
    présence est donc résolue au bâtiment par le WFS (`batiment.ssp`, point
    ou proximité), le REST ne servant qu'en repli commune.
    """
    binfo = ((raw or {}).get("batiment") or {}).get("ssp") or {}
    wfs_ok = binfo.get("resolution") == "per-building"
    failed = _is_source_failed(raw, "ssp")
    if failed and not wfs_ok:
        return AleaDetail(
            code="ssp", libelle="Sites et sols pollués (SSP)",
            present=None, present_commune=None, niveau=None,
            erreur="source Géorisques indisponible",
            url_detail="https://www.georisques.gouv.fr/risques/sites-et-sols-pollues",
        )
    ssp_list = _data_list(raw, "ssp")
    count_wfs = binfo.get("count") or 0
    n_ssp = count_wfs if wfs_ok else len(ssp_list)
    score = 10
    if n_ssp >= 5: score = 70
    elif n_ssp >= 1: score = 40
    present_bat, resolution = _batiment_status(raw, "ssp")
    present = present_bat if present_bat is not None else (n_ssp > 0)
    return AleaDetail(
        code="ssp", libelle="Sites et sols pollués (SSP)",
        present=present,
        present_commune=(n_ssp > 0),
        niveau=_score_to_niveau(score),
        zonage=f"{n_ssp} site(s) ou sol(s) pollué(s) à proximité" if wfs_ok and n_ssp > 0 else (f"{n_ssp} site(s) ou sol(s) pollué(s)" if n_ssp > 0 else "Aucun site recensé"),
        resolution="per-building, polygon-checked" if resolution == "per-building" else "commune-level estimate",
        url_detail="https://www.georisques.gouv.fr/risques/sites-et-sols-pollues",
    )


def _score_to_niveau(score: int) -> NiveauRisque:
    if score < 20: return NiveauRisque.TRES_FAIBLE
    if score < 40: return NiveauRisque.FAIBLE
    if score < 60: return NiveauRisque.MODERE
    if score < 80: return NiveauRisque.ELEVE
    return NiveauRisque.CRITIQUE


# ---------------------------------------------------------------------------
# Point d'entrée principal : normalise le brut en RisqueReport
# ---------------------------------------------------------------------------

async def get_risque_report(
    client: httpx.AsyncClient,
    adresse_saisie: str,
    adresse_normalisee: str,
    lat: float,
    lon: float,
    code_insee: str,
) -> RisqueReport:
    """
    Orchestre les appels Géorisques et retourne un RisqueReport normalisé.
    Ne lève jamais d'exception réseau (erreurs_partielles à la place).
    Couvre l'ensemble des aléas du référentiel Géorisques : ICPE, inondation,
    séisme, mouvements de terrain, radon, retrait-gonflement des argiles,
    cavités souterraines, feux de forêt, avalanches, canalisations TMD, vents
    cycloniques, PPR et sites et sols pollués.
    """
    raw = await fetch_georisques_raw(client, code_insee, lat, lon)

    aleas = [
        _alea_icpe(raw),
        _alea_inondation(raw),
        _alea_sismicite(raw),
        _alea_mouvement_terrain(raw),
        _alea_radon(raw),
        _alea_rga(raw),
        _alea_cavite(raw),
        _alea_feu_foret(raw),
        _alea_avalanche(raw),
        _alea_canalisations(raw),
        _alea_vent_cyclonique(raw),
        _alea_ppr(raw),
        _alea_ssp(raw),
    ]

    erreurs_partielles = [
        f"{e['source']}: {e['erreur']}"
        for e in (raw.get("erreurs") or [])
    ]
    alea_count = sum(1 for a in aleas if a.present is True)

    return RisqueReport(
        adresse_saisie=adresse_saisie,
        adresse_normalisee=adresse_normalisee,
        lat=lat,
        lon=lon,
        code_insee=code_insee,
        date_generation=date.today(),
        alea_count=alea_count,
        aleas=aleas,
        erreurs_partielles=erreurs_partielles,
    )
