"""
scoring_agent — calcul déterministe du score de risque par aléa et par
partie du bâtiment.

Améliorations intégrées depuis le Typhon Risk Engine v2 (collègue) :
  - D01 : Statuts explicites de source (AVAILABLE / SOURCE_ERROR / …)
    → une API en erreur 404 n'est plus traitée comme « pas de risque »
  - D02 : Score de confiance (0-100) indépendant du score de risque
  - D03 : Cinq bandes de risque alignées sur les classes du Risk Engine
  - D04 : Traçabilité des sources utilisées dans chaque zone
  - D05 : Séparation F (aléa) / V (vulnérabilité) + combinaison par
    moyenne géométrique non-compensatoire : R = 100 × (F/100)^0.5 × (V/100)^0.5
  - D06 : Projection 2050 intégrée (choix délibéré pour le jumeau 3D,
    contrairement au Risk Engine qui l'exclut de F/V/R)

Aucun LLM ici : chaque sous-score est une fonction pure d'un champ réel de
`building_data` (sortie de collector_agent), avec une justification texte
qui cite explicitement la donnée utilisée.

Sources utilisées :
  - georisques.risques_commune / catnat / cavites / mouvements_de_terrain /
    zonage_sismique / radon  (aléas officiels + historique de sinistres)
  - bdnb.alea_argile (aléa RGA précalculé au niveau du bâtiment)
  - bdnb.annee_construction (vulnérabilité structurelle)
  - climat_open_meteo.reference_2015_2024 / projection_2041_2050
    (canicule, précipitations)
"""

from __future__ import annotations

import math
import re
from enum import Enum
from typing import Any

from app.connectors.copernicus import (
    SCENARIOS_CDS,
    extract_climate_2100,
    scenario_available,
)
from app.core.logging import get_logger

logger = get_logger(__name__)

ZONE_NAMES = ["fondations", "murs_nord", "murs_sud", "murs_est", "murs_ouest", "toiture", "sous_sol"]

# ---------------------------------------------------------------------------
# D01 : Statuts explicites de source
# ---------------------------------------------------------------------------


class SourceStatus(str, Enum):
    """Statut d'une source de données. Sept cas non interchangeables.

    AVAILABLE : donnée présente et exploitable
    NO_FEATURE_FOUND : requête OK, zéro objet retourné (≠ « risque nul »)
    SOURCE_ERROR : API en erreur (404, 429, 5xx…) → ne prouve PAS l'absence
    NOT_CONFIGURED : source non paramétrée
    NOT_COLLECTED : le pipeline ne demande pas ce champ
    NOT_APPLICABLE : sans objet pour ce bien
    DEFAULT_VALUE : valeur de repli arbitraire
    """

    AVAILABLE = "AVAILABLE"
    NO_FEATURE_FOUND = "NO_FEATURE_FOUND"
    SOURCE_ERROR = "SOURCE_ERROR"
    NOT_CONFIGURED = "NOT_CONFIGURED"
    NOT_COLLECTED = "NOT_COLLECTED"
    NOT_APPLICABLE = "NOT_APPLICABLE"
    DEFAULT_VALUE = "DEFAULT_VALUE"


def _qualite_source(nom_source: str) -> float:
    """Qualité de base par source (1.0 = meilleure). Utilisée par la confiance."""
    qualites = {
        "bdnb.alea_argile": 1.0,
        "bdnb.annee_construction": 0.95,
        "bdnb.batiment": 0.95,
        "ign.altitude": 1.0,
        "georisques.risques_commune": 0.70,
        "georisques.catnat": 0.70,
        "georisques.zonage_sismique": 0.70,
        "georisques.zones_inondables": 0.70,
        "georisques.radon": 0.65,
        "georisques.cavites": 0.65,
        "georisques.mouvements_de_terrain": 0.65,
        "georisques.feu_foret": 0.70,
        "open_meteo.reference": 0.50,
        "open_meteo.projection": 0.40,
        "fallback.catnat": 0.25,
        "default": 0.10,
    }
    return qualites.get(nom_source, 0.30)


# ---------------------------------------------------------------------------
# Helpers bas niveau
# ---------------------------------------------------------------------------


def _clamp(v: float, lo: float = 0, hi: float = 100) -> int:
    return int(round(max(lo, min(hi, v))))


def _niveau(risque: int) -> str:
    """D03 : Cinq bandes de risque alignées sur le Risk Engine.

    0-19  : très faible
    20-39 : faible
    40-59 : modéré
    60-79 : élevé
    80-100: très élevé
    """
    if risque < 20:
        return "tres faible"
    if risque < 40:
        return "faible"
    if risque < 60:
        return "modere"
    if risque < 80:
        return "eleve"
    return "tres eleve"


def _combine_risk(f_score: float, v_score: float) -> float:
    """D05 : Combinaison F × V par moyenne géométrique non-compensatoire.

    R = 100 × (F/100)^0.5 × (V/100)^0.5

    Propriétés :
      - F = 0 ⇒ R = 0 (pas d'aléa = pas de risque)
      - Monotone en F et V
      - Bornée dans [0, 100]
    """
    if f_score <= 0:
        return 0.0
    v = max(float(v_score), 0.0)
    return 100.0 * math.sqrt(f_score / 100.0) * math.sqrt(v / 100.0)


def _niveau_d03(risque: int) -> str:
    """Clés D03 exposées au frontend (frontend/src/zone/config.ts) :
    tres_faible | faible | modere | eleve | critique.

    Identique à `_niveau` (mêmes bornes 0-19/20-39/40-59/60-79/80-100), mais
    avec le vocabulaire de la légende frontend pour un `bandForKey` direct
    (le backend `_niveau` renvoie « tres eleve », que le frontend ne connaît
    pas).
    """
    if risque < 20:
        return "tres_faible"
    if risque < 40:
        return "faible"
    if risque < 60:
        return "modere"
    if risque < 80:
        return "eleve"
    return "critique"


def _data_list(georisques: dict[str, Any] | None, key: str) -> list:
    """Extrait la liste d'un sous-champ Géorisques paginé.

    Deux formes selon l'endpoint : `data` (gaspar/risques, catnat…) ou
    `content` (gaspar/pprn, gaspar/pprt — reponse paginee Spring).
    """
    valeur = (georisques or {}).get(key)
    if isinstance(valeur, list):
        return valeur
    if isinstance(valeur, dict):
        data = valeur.get("data")
        if not isinstance(data, list):
            data = valeur.get("content")
        if isinstance(data, list):
            return data
    return []


def _truthy_hazard_flag(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, dict):
        data = value.get("data")
        if isinstance(data, list):
            return len(data) > 0
        return bool(value)
    if isinstance(value, list):
        return len(value) > 0
    return bool(value)


def _parse_zone_sismicite(zone: Any) -> int | None:
    if zone is None:
        return None
    if isinstance(zone, (int, float)):
        return int(zone)
    match = re.match(r"\s*(\d+)", str(zone))
    return int(match.group(1)) if match else None


def _count_catnat(georisques: dict[str, Any] | None, keyword: str) -> int:
    catnat = (georisques or {}).get("catnat") or {}
    data = catnat.get("data") if isinstance(catnat, dict) else None
    if not data:
        return 0
    keyword = keyword.lower()
    return sum(1 for a in data if keyword in (a.get("libelle_risque_jo") or "").lower())


def _has_hazard(georisques: dict[str, Any] | None, keyword: str) -> bool:
    rc = (georisques or {}).get("risques_commune") or {}
    data = rc.get("data") if isinstance(rc, dict) else None
    if not data:
        return False
    keyword = keyword.lower()
    for entry in data:
        for detail in entry.get("risques_detail") or []:
            if keyword in (detail.get("libelle_risque_long") or "").lower():
                return True
    return False


def _source_en_erreur(georisques: dict[str, Any] | None, nom_source: str) -> bool:
    erreurs = (georisques or {}).get("erreurs") or []
    # Erreurs peuvent être des dicts (forme normale) OU des chaînes brutes
    # (ex. "georisques totalement indisponible" quand la source a totalement
    # échoué) : on ignore les entrées non structurées au lieu de planter.
    return any(
        nom_source in (e.get("source") or "")
        for e in erreurs
        if isinstance(e, dict)
    )


def _vulnerabilite_batiment(bdnb: dict[str, Any] | None) -> tuple[float, str, dict[str, Any]]:
    """D05 : Calcule l'indice de vulnérabilité V (0-100) du bâtiment à partir
    de ses caractéristiques structurelles.

    Utilise l'année de construction comme principal indicateur :
    plus le bâtiment est ancien, plus il est vulnérable (normes moins récentes,
    matériaux moins résistants, vétusté).
    """
    batiment = (bdnb or {}).get("batiment") if isinstance(bdnb, dict) else (bdnb or {})
    if isinstance(batiment, dict):
        annee = batiment.get("annee_construction")
    else:
        annee = None

    tracking = {
        "source": "bdnb.annee_construction",
        "statut": SourceStatus.AVAILABLE.value if annee else SourceStatus.NOT_COLLECTED.value,
        "annee": annee,
    }

    if not annee or not isinstance(annee, (int, float)):
        return 50.0, "vulnérabilité du bâti non déterminée (année de construction inconnue) — valeur neutre par défaut", tracking

    if annee < 1949:
        base = 70
        raison = "antérieur à 1949 : construction ancienne, normes parasismiques absentes, vétusté probable"
    elif annee < 1975:
        base = 55
        raison = "1949-1974 : construction d'après-guerre, normes limitées"
    elif annee < 2000:
        base = 40
        raison = "1975-2000 : construction récente, premières normes thermiques et parasismiques"
    elif annee < 2012:
        base = 30
        raison = "2001-2011 : construction moderne, RT2000/RT2005"
    else:
        base = 25
        raison = "2012 ou après : construction récente aux normes EC8 et RT2012"

    return float(base), raison, tracking


# ---------------------------------------------------------------------------
# Sous-scores F (aléa) — chaque fonction retourne (score_0_100, source_text, tracking_dict)
# ---------------------------------------------------------------------------


def _secheresse_catnat_subscore(georisques: dict[str, Any] | None) -> tuple[int, str]:
    """Sous-score « sécheresse » à partir de l'historique CATNAT de la commune.

    C'est le même signal que le repli de `_argile_subscore` quand la BDNB ne
    fournit pas d'aléa argile : chaque arrêté « sécheresse » fait monter le
    score (20 + 12 × n, plafonné à 65). Il alimente le risque « Sécheresse »
    distinct de l'aléa RGA au niveau du bâtiment.
    """
    secheresses = _count_catnat(georisques, "sécheresse") or _count_catnat(georisques, "secheresse")
    base = min(20 + secheresses * 12, 65)
    source = f"{secheresses} arrêté(s) CATNAT « sécheresse » recensé(s) sur la commune"
    return base, source


def _argile_subscore(
    bdnb: dict[str, Any] | None,
    georisques: dict[str, Any] | None,
    aggravation_2050: bool = False,
) -> tuple[int, str, dict[str, Any]]:
    alea = None
    batiment = (bdnb or {}).get("batiment") if isinstance(bdnb, dict) else None
    if isinstance(batiment, dict):
        alea = batiment.get("alea_argile")
    if alea is None and isinstance(bdnb, dict):
        alea = bdnb.get("alea_argile")

    if alea:
        base = {"faible": 15, "moyen": 50, "fort": 82}.get(str(alea).strip().lower(), 40)
        source = f"aléa retrait-gonflement des argiles = « {alea} » (BDNB, au niveau du bâtiment)"
        tracking = {"source": "bdnb.alea_argile", "statut": SourceStatus.AVAILABLE.value, "valeur": str(alea)}
    else:
        base, src_secheresse = _secheresse_catnat_subscore(georisques)
        secheresses = _count_catnat(georisques, "sécheresse") or _count_catnat(georisques, "secheresse")
        source = (
            f"aléa argile non fourni par la BDNB pour ce bâtiment ; {src_secheresse} "
            "(indicateur de repli)"
        )
        tracking = {"source": "fallback.catnat", "statut": SourceStatus.NO_FEATURE_FOUND.value, "fallback": True, "nb_catnat_secheresse": secheresses}

    if aggravation_2050:
        base = min(base + 12, 100)
        source += " ; +12 pts pour horizon projeté (sécheresses plus fréquentes, cf. BRGM/CCR)"

    return _clamp(base), source, tracking


def _batiment_status_ppr_type(georisques: dict[str, Any] | None, ppr_type: str) -> dict[str, Any] | None:
    """Statut WFS au bâtiment pour un TYPE de PPR précis
    (`georisques["batiment"]["ppr_par_type"][ppr_type]`) — cf.
    `georisques_wfs.PPR_TYPE_LAYERS`. Ventilé par type (et non l'agrégat "ppr")
    car un bâtiment peut être dans un périmètre PPR sismique sans être dans un
    périmètre PPR inondation : le score d'un péril donné ne doit se fier qu'à
    son propre type, jamais à "un PPR quelconque touche ce point".

    Retourne `{"present": bool|None, "resolution": str}` si la résolution au
    bâtiment a été tentée pour ce type, sinon None (WFS jamais appelé).
    present=False signifie que le WFS a répondu et que le point de l'adresse
    n'est dans AUCUN périmètre de ce type — même si la commune en a un.
    """
    if not isinstance(georisques, dict):
        return None
    batiment = georisques.get("batiment")
    if not isinstance(batiment, dict):
        return None
    par_type = batiment.get("ppr_par_type")
    if not isinstance(par_type, dict):
        return None
    info = par_type.get(ppr_type)
    if not isinstance(info, dict):
        return None
    return info


def _ppr_inondation(georisques: dict[str, Any] | None) -> tuple[bool, float | None, str | None, str]:
    """(ppri_present, hauteur_eau_m, zone_ppr, resolution) depuis les PPR.

    Résolution au bâtiment d'abord (WFS, type "inondation" de
    `georisques["batiment"]["ppr_par_type"]` — jamais l'agrégat "ppr", qui
    mélangerait un périmètre sismique/minier/etc. avec le périmètre inondation) :
    si le point de l'adresse a été testé contre les périmètres réels et n'est
    dans aucun, le bâtiment n'est pas exposé — `ppri=False` même si la commune
    a un PPRI prescrit (c'est tout l'intérêt du per-building). Si le point EST
    dans un périmètre, on garde la lecture communale pour le détail de zonage
    (rouge/bleue) mais la résolution reste per-building. Sans résultat WFS,
    repli commune (comportement historique).

    Phase 6 : hauteur reelle derivee du zonage reglementaire du PPRI
    (rouge = interdiction -> bande 1.5-3 m, bleue = prescriptions -> 0.5-1.5 m).
    """
    bat = _batiment_status_ppr_type(georisques, "inondation")
    if bat is not None and bat.get("resolution") == "per-building":
        if bat.get("present") is False:
            return False, None, None, "per-building"
        # present=True : le point est dans un périmètre — détail de zonage depuis
        # la liste communale, mais résolution au bâtiment.
        ppri, hauteur, zone = _ppr_inondation_commune(georisques)
        return ppri, hauteur, zone, "per-building"
    ppri, hauteur, zone = _ppr_inondation_commune(georisques)
    return ppri, hauteur, zone, "commune-level"


def _ppr_inondation_commune(georisques: dict[str, Any] | None) -> tuple[bool, float | None, str | None]:
    """(ppri_present, hauteur_eau_m, zone_ppr) depuis les PPR bruts communaux."""
    pprs = _data_list(georisques, "ppr")
    if not pprs:
        return False, None, None
    has_rouge = False
    has_bleue = False
    ppri = False
    for ppr in pprs:
        if not isinstance(ppr, dict):
            continue
        modele = (ppr.get("modeleProcedure") or "").lower()
        lib = (ppr.get("libPpr") or "").lower()
        if "inondation" in modele or "inondation" in lib or "ppri" in lib:
            ppri = True
        reg = ppr.get("zonageReglementaire") or {}
        for lt in (reg.get("listTypeReg") or []):
            code = (lt.get("code") or "").lower()
            if code in ("03", "r"):
                has_rouge = True
            elif code in ("02", "b"):
                has_bleue = True
    if not (ppri and (has_rouge or has_bleue)):
        return ppri, None, None
    if has_rouge:
        return True, 2.0, "rouge"
    return True, 1.0, "bleue"


def _inondation_subscore(
    georisques: dict[str, Any] | None,
    precip_delta_pct: float = 0.0,
) -> tuple[int, str, dict[str, Any]]:
    inondations = _count_catnat(georisques, "inondation")
    hazard_present = _has_hazard(georisques, "inondation")
    zones_inondables = _truthy_hazard_flag((georisques or {}).get("zones_inondables"))
    zones_en_erreur = _source_en_erreur(georisques, "zones_inondables")
    ppri, hauteur_eau_m, zone_ppr, resolution_ppr = _ppr_inondation(georisques)

    base = 15
    if inondations >= 6:
        base = 75
    elif inondations >= 3:
        base = 55
    elif inondations >= 1:
        base = 35
    if hazard_present:
        base += 8
    if zones_inondables:
        base += 12
    base += precip_delta_pct * 0.4

    source = f"{inondations} arrêté(s) CATNAT inondation recensé(s) sur la commune"
    if hazard_present:
        source += " ; aléa inondation présent dans le référentiel Géorisques communal"
    if zones_inondables:
        source += " ; parcelle en zone inondable connue (atlas Géorisques)"
    elif zones_en_erreur:
        source += " ; atlas zones inondables indisponible (API en erreur) — non pris en compte"
    if ppri:
        source += " ; PPRI prescrit sur la commune" + (f" (zone {zone_ppr})" if zone_ppr else "")
        base = max(base, 60)
    elif resolution_ppr == "per-building":
        # Le WFS a tranché : le point de l'adresse n'est dans aucun périmètre
        # PPR, même si la commune a un PPRI prescrit — pas de surcote PPRI ici.
        source += " ; point hors périmètre PPR (vérification WFS au bâtiment)"

    tracking: dict[str, Any] = {
        "source": "georisques.inondation",
        "statut": SourceStatus.AVAILABLE.value,
        "nb_catnat": inondations,
        "zones_inondables": zones_inondables,
        "zones_inondables_en_erreur": zones_en_erreur,
        "ppri_present": ppri,
        "hauteur_eau_m": hauteur_eau_m,
        "zone_ppr": zone_ppr,
        "resolution": resolution_ppr,
    }
    if zones_en_erreur:
        tracking["statut"] = SourceStatus.SOURCE_ERROR.value
        tracking["erreur"] = "api_azi_404"

    return _clamp(base), source, tracking


def _mouvement_terrain_subscore(georisques: dict[str, Any] | None) -> tuple[int, str, dict[str, Any]]:
    cavites = _data_list(georisques, "cavites")
    mvt = _data_list(georisques, "mouvements_de_terrain")
    mvt_catnat = _count_catnat(georisques, "mouvement de terrain")
    n_cavites, n_mvt = len(cavites), len(mvt)
    base = 15 + min(n_cavites, 3) * 12 + min(n_mvt, 3) * 10 + min(mvt_catnat, 3) * 8
    source = f"{n_cavites} cavité(s), {n_mvt} mouvement(s) de terrain, {mvt_catnat} arrêté(s) CATNAT"

    # Résolution au bâtiment via le type PPR "mouvement_terrain" (WFS
    # PPRN_PERIMETRE_MVT) — même schéma que _ppr_inondation.
    resolution = "commune-level"
    bat = _batiment_status_ppr_type(georisques, "mouvement_terrain")
    if bat is not None and bat.get("resolution") == "per-building":
        resolution = "per-building"
        if bat.get("present") is True:
            base = max(base, 45)
            source += " ; point dans un périmètre PPR mouvement de terrain (vérification WFS au bâtiment)"
        elif bat.get("present") is False:
            source += " ; point hors périmètre PPR mouvement de terrain (vérification WFS au bâtiment)"

    tracking = {
        "source": "georisques.mouvement_terrain",
        "statut": SourceStatus.AVAILABLE.value,
        "nb_cavites": n_cavites,
        "nb_mouvements": n_mvt,
        "resolution": resolution,
    }
    return _clamp(base), source, tracking


def _sismique_subscore(georisques: dict[str, Any] | None) -> tuple[int, str, dict[str, Any]]:
    risques_commune = (georisques or {}).get("risques_commune") or {}
    data = risques_commune.get("data") if isinstance(risques_commune, dict) else None
    zone = None
    if data:
        for entry in data:
            for detail in entry.get("risques_detail") or []:
                if detail.get("zone_sismicite") is not None:
                    zone = detail["zone_sismicite"]
    if zone is None:
        zonage = _data_list(georisques, "zonage_sismique")
        if zonage:
            zone = zonage[0].get("zone_sismicite") if isinstance(zonage[0], dict) else None
    mapping = {0: 5, 1: 15, 2: 30, 3: 50, 4: 70, 5: 88}
    zone_int = _parse_zone_sismicite(zone)
    tracking = {"source": "georisques.zonage_sismique", "statut": SourceStatus.AVAILABLE.value if zone_int is not None else SourceStatus.NO_FEATURE_FOUND.value, "zone": zone_int}
    # Le zonage sismique national est fixé par DÉCRET, par COMMUNE, sans
    # résolution plus fine possible — la résolution reste "commune-level" (repli
    # par défaut de _resolution_flag) même quand un PPRS (plan de prévention des
    # risques sismiques, site-spécifique, cf. PPR_TYPE_LAYERS) existe à
    # proximité : ce sont deux instruments juridiques distincts. Le PPRS n'est
    # donc qu'un signal annexe ici, jamais une requalification "per-building" du
    # zonage national.
    bat_pprs = _batiment_status_ppr_type(georisques, "seisme")
    if bat_pprs is not None and bat_pprs.get("resolution") == "per-building":
        tracking["pprs_present"] = bat_pprs.get("present")
    if zone_int is not None and zone_int in mapping:
        return mapping[zone_int], f"zone de sismicité {zone_int} (Géorisques)", tracking
    return 20, "zone de sismicité non déterminée (valeur de repli faible)", tracking


def _radon_subscore(georisques: dict[str, Any] | None) -> tuple[int, str, dict[str, Any]]:
    # Le potentiel radon (IRSN) est une classification COMMUNALE par nature —
    # aucune couche WFS bâtiment n'existe pour cet aléa (contrainte de la
    # source, pas un gap technique ; cf. PPR_TYPE_LAYERS).
    radon = _data_list(georisques, "radon")
    potentiel = radon[0].get("classe_potentiel") if radon and isinstance(radon[0], dict) else None
    try:
        potentiel_int = int(potentiel)
    except (TypeError, ValueError):
        potentiel_int = None
    tracking = {"source": "georisques.radon", "statut": SourceStatus.AVAILABLE.value if potentiel_int is not None else SourceStatus.NO_FEATURE_FOUND.value, "classe": potentiel_int}
    mapping = {1: 10, 2: 35, 3: 65}
    if potentiel_int in mapping:
        return mapping[potentiel_int], f"potentiel radon classe {potentiel_int}/3 (Géorisques)", tracking
    return 15, "potentiel radon non déterminé (valeur de repli faible)", tracking


def _feu_foret_subscore(georisques: dict[str, Any] | None) -> tuple[int, str, dict[str, Any]]:
    present_commune = _has_hazard(georisques, "feu de forêt") or _has_hazard(georisques, "feu de foret")
    base = 55 if present_commune else 10
    source = (
        "aléa feu de forêt présent dans le référentiel Géorisques communal"
        if present_commune
        else "aucun aléa feu de forêt recensé par Géorisques"
    )

    # Résolution au bâtiment via le type PPR "feu_foret" (WFS
    # PPRN_PERIMETRE_FEU) — même schéma que _ppr_inondation.
    resolution = "commune-level"
    bat = _batiment_status_ppr_type(georisques, "feu_foret")
    if bat is not None and bat.get("resolution") == "per-building":
        resolution = "per-building"
        if bat.get("present") is True:
            base = max(base, 55)
            source += " ; point dans un périmètre PPR feu de forêt (vérification WFS au bâtiment)"
        elif bat.get("present") is False:
            source += " ; point hors périmètre PPR feu de forêt (vérification WFS au bâtiment)"

    tracking = {
        "source": "georisques.feu_foret",
        "statut": SourceStatus.AVAILABLE.value if present_commune else SourceStatus.NO_FEATURE_FOUND.value,
        "resolution": resolution,
    }
    return base, source, tracking


def _canicule_subscore(climat_block: dict[str, Any] | None, source: str = "open_meteo.canicule") -> tuple[int, str, dict[str, Any]]:
    jours = (climat_block or {}).get("jours_chaleur_extreme_par_an")
    tracking = {"source": source, "statut": SourceStatus.AVAILABLE.value if jours is not None else SourceStatus.NOT_COLLECTED.value}
    if jours is None:
        return 30, "jours de chaleur extrême non disponibles", tracking
    if jours < 3:
        base = 20
    elif jours < 6:
        base = 40
    elif jours < 10:
        base = 60
    else:
        base = 80
    provenance = "Copernicus CDS" if source.startswith("copernicus.") else "Open-Meteo"
    return _clamp(base), f"{jours:.1f} j de chaleur extrême/an ({provenance})", tracking


def _precipitation_subscore(climat_block: dict[str, Any] | None) -> tuple[int, str, dict[str, Any]]:
    mm = (climat_block or {}).get("precipitation_annuelle_moyenne_mm")
    tracking = {"source": "open_meteo.precipitation", "statut": SourceStatus.AVAILABLE.value if mm is not None else SourceStatus.NOT_COLLECTED.value}
    if mm is None:
        return 30, "précipitations annuelles non disponibles (Open-Meteo)", tracking
    if mm < 600:
        base = 20
    elif mm < 800:
        base = 35
    elif mm < 1000:
        base = 50
    else:
        base = 65
    return _clamp(base), f"{mm:.0f} mm/an de précipitations (Open-Meteo)", tracking


def _precipitation_frequency_subscore(climat_block: dict[str, Any] | None) -> tuple[int, str, dict[str, Any]]:
    """Sous-score précipitations intenses à partir de la FRÉQUENCE des
    épisodes extrêmes (Copernicus `frequency_of_extreme_precipitation`, 0-1).

    Unité différente de `precipitation_annuelle_moyenne_mm` (Open-Meteo) :
    on ne force pas cette valeur dans les seuils calibrés pour les mm — elle
    a ses propres seuils, calibrés sur la fréquence (fraction d'épisodes
    extrêmes par an). Même grille D03, même honnêteté de provenance.
    """
    freq = (climat_block or {}).get("frequency_extreme_precipitation")
    tracking = {
        "source": "copernicus.precipitation",
        "statut": SourceStatus.AVAILABLE.value if freq is not None else SourceStatus.NOT_COLLECTED.value,
    }
    if freq is None:
        return 30, "fréquence de précipitations extrêmes non disponible (Copernicus CDS)", tracking
    if freq < 0.02:
        base = 20
    elif freq < 0.05:
        base = 40
    elif freq < 0.10:
        base = 60
    else:
        base = 80
    return _clamp(base), f"fréquence d'épisodes de précipitations extrêmes = {freq:.3f} (Copernicus CDS)", tracking


# ---------------------------------------------------------------------------
# D02 : Score de confiance (indépendant du risque)
# ---------------------------------------------------------------------------


def _compute_confidence(sources_tracking: list[dict[str, Any]]) -> dict[str, Any]:
    """Calcule un score de confiance (0-100) basé sur :
      1. Couverture des sources (poids 0.40)
      2. Qualité des sources disponibles (poids 0.30)
      3. Absence d'erreur API (poids 0.15)
      4. Absence de repli/fallback (poids 0.10)
      5. Données de projection disponibles (poids 0.05)

    La confiance est STRICTEMENT indépendante du score de risque (D02).
    """
    total = len(sources_tracking)
    if total == 0:
        return {"score": 0, "niveau": "indetermine", "composantes": {}, "independent_of_risk": True}

    disponibles = sum(1 for s in sources_tracking if s.get("statut") == SourceStatus.AVAILABLE.value)
    en_erreur = sum(1 for s in sources_tracking if s.get("statut") == SourceStatus.SOURCE_ERROR.value)
    en_repli = sum(1 for s in sources_tracking if s.get("fallback"))
    projection_dispo = sum(1 for s in sources_tracking if s.get("source", "").startswith("open_meteo"))

    # 1. Couverture
    couverture = disponibles / max(total, 1)

    # 2. Qualité moyenne
    qualite_moyenne = 0.0
    if disponibles:
        qualite_moyenne = (
            sum(_qualite_source(s.get("source", "default")) for s in sources_tracking if s.get("statut") == SourceStatus.AVAILABLE.value)
            / disponibles
        )

    # 3. Pénalité erreur API
    penalite_erreur = max(0.0, 1.0 - en_erreur / max(total, 1))

    # 4. Pénalité repli
    penalite_repli = max(0.0, 1.0 - en_repli / max(total, 1) * 0.3)

    # 5. Bonus projection
    bonus_projection = min(1.0, projection_dispo * 0.1)

    score = _clamp(couverture * 40.0 + qualite_moyenne * 30.0 + penalite_erreur * 15.0 + penalite_repli * 10.0 + bonus_projection * 5.0)

    if score >= 80:
        niveau_conf = "elevee"
    elif score >= 60:
        niveau_conf = "bonne"
    elif score >= 40:
        niveau_conf = "moyenne"
    elif score >= 20:
        niveau_conf = "faible"
    else:
        niveau_conf = "tres faible"

    return {
        "score": score,
        "niveau": niveau_conf,
        "composantes": {
            "couverture": round(couverture, 3),
            "qualite_sources": round(qualite_moyenne, 3),
            "absence_erreurs": round(penalite_erreur, 3),
            "absence_replis": round(penalite_repli, 3),
            "bonus_projection": round(bonus_projection, 3),
        },
        "independent_of_risk": True,
        "n_sources_disponibles": disponibles,
        "n_sources_total": total,
        "n_sources_erreur": en_erreur,
    }


# ---------------------------------------------------------------------------
# D05 : Assemblage F/V par zone
# ---------------------------------------------------------------------------


def _build_zone(
    risque: int,
    alea_principal: str,
    justifications: list[str],
    f_score: float | None = None,
    v_score: float | None = None,
    sources: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Assemble une zone du contrat avec justification en puces et traçabilité."""
    puces = []
    for texte in justifications:
        texte = (texte or "").strip()
        if not texte:
            continue
        texte = texte[0].upper() + texte[1:]
        if not texte.endswith((".", "!", "?")):
            texte += "."
        puces.append(texte)

    zone: dict[str, Any] = {
        "risque": risque,
        "niveau": _niveau(risque),
        "alea_principal": alea_principal,
        "justification": "\n".join(f"• {p}" for p in puces),
        "recommandations": [],
    }
    if sources:
        zone["_sources"] = sources
    if f_score is not None:
        zone["_f_score"] = round(f_score, 1)
    if v_score is not None:
        zone["_v_score"] = round(v_score, 1)
    return zone


# Périls suivis par la trajectoire, dans un ordre stable, avec libellé et
# unité. Chaque point de la trajectoire porte son F brut (indice d'aléa
# 0-100, avant combinaison avec V), sa provenance (source, statut, résolution)
# et son étiquette d'horizon — 2026 est OBSERVÉ (données actuelles
# Géorisques/BDNB), 2050 est MODÉLISÉ (projection climatique), 2100 reste
# indisponible tant que Copernicus CDS n'est pas activé.
PERILS_TRAJECTOIRE: list[tuple[str, str, str]] = [
    ("argile", "Retrait-gonflement des argiles", "indice 0-100"),
    ("inondation", "Inondation", "indice 0-100"),
    ("mouvement_terrain", "Mouvement de terrain", "indice 0-100"),
    ("sismique", "Sismicité", "indice 0-100"),
    ("radon", "Radon", "indice 0-100"),
    ("canicule", "Canicule / stress thermique", "indice 0-100"),
    ("precipitation", "Précipitations intenses", "indice 0-100"),
    ("feu_foret", "Feu de forêt", "indice 0-100"),
]

# Résolution géographique honnête par source : un champ BDNB est au niveau du
# BÂTIMENT, un champ Géorisques au niveau de la COMMUNE (requête par
# code_insee), une projection climatique au niveau de la GRILLE (cellule
# météo, ~10-25 km). C'est le drapeau de résolution que l'actuaire attend
# pour ne pas confondre « per-building » et « commune-level ».
def _resolution_flag(source: str) -> str:
    if source.startswith("bdnb."):
        return "per-building"
    if source.startswith(("open_meteo.", "copernicus.")):
        return "grid-cell"
    return "commune-level"


def _point_resolution(tracking: dict[str, Any] | None, source: str) -> str:
    """Résolution d'un point de trajectoire.

    Priorité au drapeau porté par le tracking quand la résolution au bâtiment
    a réellement réussi (WFS `georisques["batiment"]` → "per-building") — c'est
    l'information honnête par point, pas une inférence sur le nom de la source.
    Sinon, repli sur la règle par source (`_resolution_flag`).
    """
    if isinstance(tracking, dict) and tracking.get("resolution") in ("per-building", "commune-level", "grid-cell"):
        return tracking["resolution"]
    return _resolution_flag(source)


def _confidence_from_status(statut: str | None) -> str | None:
    if statut == SourceStatus.AVAILABLE.value:
        return "elevee"
    if statut == SourceStatus.NO_FEATURE_FOUND.value:
        return "moyenne"
    if statut == SourceStatus.SOURCE_ERROR.value:
        return "faible"
    return None


def _compute_zones_for_period(
    building_data: dict[str, Any],
    climat_block: dict[str, Any] | None,
    is_projection: bool,
) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]], dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    """Calcule les zones pour une période.

    D05 : chaque zone calcule F (aléa) et V (vulnérabilité) séparément,
    puis combine via moyenne géométrique : R = 100 × (F/100)^0.5 × (V/100)^0.5

    Horizon 2100 : quand `climat_block` porte les clés Copernicus
    (`frequency_extreme_precipitation`, `jours_chaleur_extreme_par_an`
    issus de CDS), la canicule lit le bloc comme d'habitude et les
    précipitations basculent sur le sous-score de fréquence (même grille
    D03, unité CDS différente).
    """
    georisques = building_data.get("georisques")
    bdnb = building_data.get("bdnb")

    ref_block = (building_data.get("climat_open_meteo") or {}).get("reference_2015_2024")
    precip_ref = (ref_block or {}).get("precipitation_annuelle_moyenne_mm")
    precip_now = (climat_block or {}).get("precipitation_annuelle_moyenne_mm")
    precip_delta_pct = 0.0
    if is_projection and precip_ref and precip_now:
        precip_delta_pct = max(0.0, (precip_now - precip_ref) / precip_ref * 100)

    # Bloc 2100 Copernicus : la précipitation s'exprime en fréquence (CDS),
    # pas en mm annuels — on utilise le sous-score dédié, jamais les seuils
    # calibrés pour l'unité Open-Meteo. Le marqueur `__copernicus_2100` est
    # posé par extract_climate_2100 (les blocs Open-Meteo ne l'ont pas).
    copernicus_2100 = bool(climat_block) and climat_block.get("__copernicus_2100") is True

    # --- Tous les sous-scores F (aléas) ---
    argile_score, argile_src, argile_t = _argile_subscore(bdnb, georisques, aggravation_2050=is_projection)
    inondation_score, inondation_src, inondation_t = _inondation_subscore(georisques, precip_delta_pct)
    mvt_score, mvt_src, mvt_t = _mouvement_terrain_subscore(georisques)
    sismique_score, sismique_src, sismique_t = _sismique_subscore(georisques)
    radon_score, radon_src, radon_t = _radon_subscore(georisques)
    canicule_score, canicule_src, canicule_t = _canicule_subscore(
        climat_block, source="copernicus.cds.canicule" if copernicus_2100 else "open_meteo.canicule"
    )
    if copernicus_2100:
        precip_score, precip_src, precip_t = _precipitation_frequency_subscore(climat_block)
    else:
        precip_score, precip_src, precip_t = _precipitation_subscore(climat_block)
    feu_foret_score, feu_foret_src, feu_foret_t = _feu_foret_subscore(georisques)

    # --- V (vulnérabilité du bâtiment) ---
    v_base, v_raison, v_tracking = _vulnerabilite_batiment(bdnb)

    # Toiture : bonus âge toiture (si < 1970)
    batiment = (bdnb or {}).get("batiment") if isinstance(bdnb, dict) else (bdnb or {})
    if isinstance(batiment, dict):
        annee = batiment.get("annee_construction")
    else:
        annee = None
    roof_age_bonus = 10 if isinstance(annee, (int, float)) and annee < 1970 else 0
    v_toiture = min(v_base + roof_age_bonus, 100)
    if roof_age_bonus:
        v_raison_toit = v_raison + " ; toiture antérieure à 1970 : +10 pts"
    else:
        v_raison_toit = v_raison

    # Tracking des sources
    sources_tracking = [
        argile_t, inondation_t, mvt_t, sismique_t, radon_t,
        canicule_t, precip_t, feu_foret_t, v_tracking,
    ]

    zones: dict[str, dict[str, Any]] = {}

    # --- Fondations ---
    f_fondations = argile_score * 0.55 + mvt_score * 0.25 + sismique_score * 0.20
    # V fondations = V bâtiment (pas de données spécifiques fondations)
    risque_fondations = _clamp(_combine_risk(f_fondations, v_base))
    zones["fondations"] = _build_zone(
        risque_fondations,
        "Retrait-gonflement des argiles" if argile_score >= mvt_score else "Mouvement de terrain",
        [argile_src, mvt_src, sismique_src, v_raison],
        f_score=f_fondations, v_score=v_base,
        sources=[argile_t, mvt_t, sismique_t, v_tracking],
    )
    # Phase 6 : zone sismique reglementaire reelle (decret n°2010-1255) —
    # sert au viewer pour declencher un effet de secousse quand zone >= 4.
    if isinstance(sismique_t, dict) and sismique_t.get("zone") is not None:
        zones["fondations"]["zone_sismique"] = str(sismique_t["zone"])

    # --- Murs (4 façades) ---
    f_murs = precip_score * 0.5 + sismique_score * 0.3 + canicule_score * 0.2
    risque_murs = _clamp(_combine_risk(f_murs, v_base))
    murs_justifs = [precip_src, canicule_src, sismique_src, v_raison]
    murs_sources_list = [precip_t, canicule_t, sismique_t, v_tracking]
    for zone_name in ["murs_nord", "murs_sud", "murs_est", "murs_ouest"]:
        zones[zone_name] = _build_zone(
            risque_murs, "Exposition climatique (façade)", murs_justifs,
            f_score=f_murs, v_score=v_base, sources=murs_sources_list,
        )

    # --- Toiture ---
    f_toiture = canicule_score * 0.45 + precip_score * 0.15 + feu_foret_score * 0.40
    risque_toiture = _clamp(_combine_risk(f_toiture, v_toiture))
    toiture_justifs = [canicule_src, precip_src, feu_foret_src, v_raison_toit]
    toiture_sources = [canicule_t, precip_t, feu_foret_t, v_tracking]
    zones["toiture"] = _build_zone(
        risque_toiture,
        "Feu de forêt" if feu_foret_score >= canicule_score else "Canicule / stress thermique",
        toiture_justifs,
        f_score=f_toiture, v_score=v_toiture, sources=toiture_sources,
    )

    # --- Sous-sol ---
    f_sous_sol = inondation_score * 0.8 + radon_score * 0.2
    # V sous-sol = V bâtiment (pas de données spécifiques sous-sol)
    risque_sous_sol = _clamp(_combine_risk(f_sous_sol, v_base))
    zones["sous_sol"] = _build_zone(
        risque_sous_sol,
        "Inondation / remontée de nappe",
        [inondation_src, radon_src, v_raison],
        f_score=f_sous_sol, v_score=v_base,
        sources=[inondation_t, radon_t, v_tracking],
    )
    # Phase 6 : hauteur d'eau reelle (fourchette PPRI) — le viewer l'utilise
    # en priorite pour animer la montee des eaux (au lieu du ratio derive du
    # score).
    if isinstance(inondation_t, dict) and inondation_t.get("hauteur_eau_m") is not None:
        zones["sous_sol"]["hauteur_eau_m"] = inondation_t["hauteur_eau_m"]
        if inondation_t.get("zone_ppr"):
            zones["sous_sol"]["zone_ppr"] = inondation_t["zone_ppr"]

    for zone_name in ZONE_NAMES:
        z = zones[zone_name]
        logger.info("  [%s] risque=%d (%s) | F=%.1f V=%.1f", zone_name, z["risque"], z["niveau"], z.get("_f_score", 0), z.get("_v_score", 0))

    # --- Risques par aléa (niveau bâtiment, pas par zone) ---------------
    # Les 8 sous-scores F ci-dessus sont déjà calculés une fois pour tout le
    # bâtiment (RGA, inondation... ne dépendent pas de la façade regardée) :
    # on les expose tels quels plutôt que de les recalculer, pour un radar
    # "par aléa" (incendie, inondation, RGA, sismique...) séparé du radar
    # "par zone" existant. Aucun changement au calcul F/V/R des zones.
    risques_par_alea = {
        "argile": {
            "label": "Retrait-gonflement des argiles",
            "risque": argile_score, "niveau": _niveau(argile_score), "justification": argile_src,
        },
        "inondation": {
            "label": "Inondation",
            "risque": inondation_score, "niveau": _niveau(inondation_score), "justification": inondation_src,
        },
        "mouvement_terrain": {
            "label": "Mouvement de terrain",
            "risque": mvt_score, "niveau": _niveau(mvt_score), "justification": mvt_src,
        },
        "sismique": {
            "label": "Sismique",
            "risque": sismique_score, "niveau": _niveau(sismique_score), "justification": sismique_src,
        },
        "radon": {
            "label": "Radon",
            "risque": radon_score, "niveau": _niveau(radon_score), "justification": radon_src,
        },
        "canicule": {
            "label": "Canicule / stress thermique",
            "risque": canicule_score, "niveau": _niveau(canicule_score), "justification": canicule_src,
        },
        "precipitation": {
            "label": "Précipitations intenses",
            "risque": precip_score, "niveau": _niveau(precip_score), "justification": precip_src,
        },
        "feu_foret": {
            "label": "Feu de forêt",
            "risque": feu_foret_score, "niveau": _niveau(feu_foret_score), "justification": feu_foret_src,
        },
    }

    # Traçabilité par péril (provenance) : chaque F brut est associé à son
    # tracking (source, statut, valeurs brutes). Consommé par la trajectoire.
    peril_tracking = {
        "argile": argile_t,
        "inondation": inondation_t,
        "mouvement_terrain": mvt_t,
        "sismique": sismique_t,
        "radon": radon_t,
        "canicule": canicule_t,
        "precipitation": precip_t,
        "feu_foret": feu_foret_t,
    }

    return zones, sources_tracking, risques_par_alea, peril_tracking


def _score_global(zones: dict[str, dict[str, Any]]) -> int:
    murs_moyenne = sum(zones[z]["risque"] for z in ("murs_nord", "murs_sud", "murs_est", "murs_ouest")) / 4
    total = (
        zones["fondations"]["risque"] * 0.25
        + zones["toiture"]["risque"] * 0.15
        + zones["sous_sol"]["risque"] * 0.20
        + murs_moyenne * 0.40
    )
    return _clamp(total)


# ---------------------------------------------------------------------------
# Risques par aléa (top-N consommé par « Comprendre les risques »)
# ---------------------------------------------------------------------------

# Aléas suivis par le moteur, avec leur vocabulaire frontend (codes ALEA_ICONS
# de zone/config.ts) et la fonction F qui les alimente. `rga` porte l'aléa
# retrait-gonflement au niveau du bâtiment (BDNB) ; `secheresse` porte
# l'historique CATNAT « sécheresse » de la commune (signal distinct, cf.
# _secheresse_catnat_subscore).
def _alea_candidats(
    bdnb: dict[str, Any] | None,
    georisques: dict[str, Any] | None,
    reference: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    """Calcule les sous-scores F de tous les aléas et les expose en candidats."""
    argile_score, argile_src, _ = _argile_subscore(bdnb, georisques)
    inondation_score, inondation_src, _ = _inondation_subscore(georisques)
    mvt_score, mvt_src, _ = _mouvement_terrain_subscore(georisques)
    sismique_score, sismique_src, _ = _sismique_subscore(georisques)
    radon_score, radon_src, _ = _radon_subscore(georisques)
    canicule_score, canicule_src, _ = _canicule_subscore(reference)
    feu_foret_score, feu_foret_src, _ = _feu_foret_subscore(georisques)

    candidats = [
        {"code": "rga", "libelle": "Retrait-gonflement des argiles", "f_score": argile_score, "justification": argile_src},
        {"code": "inondation", "libelle": "Inondation / remontée de nappe", "f_score": inondation_score, "justification": inondation_src},
        {"code": "mouvement_terrain", "libelle": "Mouvement de terrain", "f_score": mvt_score, "justification": mvt_src},
        {"code": "sismicite", "libelle": "Sismicité", "f_score": sismique_score, "justification": sismique_src},
        {"code": "radon", "libelle": "Radon", "f_score": radon_score, "justification": radon_src},
        {"code": "canicule", "libelle": "Canicule / stress thermique", "f_score": canicule_score, "justification": canicule_src},
        {"code": "feu_foret", "libelle": "Feu de forêt", "f_score": feu_foret_score, "justification": feu_foret_src},
    ]

    # La « Sécheresse » (historique CATNAT de la commune) n'est un signal
    # DISTINCT du RGA que lorsque la BDNB fournit un aléa argile au niveau du
    # bâtiment. Sinon, `rga` retombe déjà sur ce même repli CATNAT → deux
    # candidats avec le même score se dupliqueraient dans le top 3.
    batiment = (bdnb or {}).get("batiment") if isinstance(bdnb, dict) else None
    alea_argile = batiment.get("alea_argile") if isinstance(batiment, dict) else None
    if alea_argile is None and isinstance(bdnb, dict):
        alea_argile = bdnb.get("alea_argile")
    if alea_argile:
        secheresse_score, secheresse_src = _secheresse_catnat_subscore(georisques)
        candidats.append(
            {"code": "secheresse", "libelle": "Sécheresse", "f_score": secheresse_score, "justification": secheresse_src}
        )

    return candidats


def compute_alea_risks(building_data: dict[str, Any]) -> list[dict[str, Any]]:
    """Score de risque par aléa (déterministe), trié du plus exposé au moins exposé.

    Même méthodologie que les zones (D05) : R = 100 × (F/100)^0.5 × (V/100)^0.5,
    où F est le sous-score d'aléa et V la vulnérabilité du bâtiment. Les aléas
    sans signal réel (F < 20 : absent ou très faible) sont écartés pour ne pas
    polluer le classement — un aléa « feu de forêt non recensé » (F=10) ne doit
    jamais apparaître comme un risque du bien.

    Chaque entrée : {code, libelle, score, niveau (clé D03 frontend),
    justification, _f_score, _v_score}.

    Consommé par `app.agents.risques_principaux` (synthèse LLM du top 3).
    """
    georisques = building_data.get("georisques")
    bdnb = building_data.get("bdnb")
    climat = building_data.get("climat_open_meteo") or {}
    reference = climat.get("reference_2015_2024")
    projection = climat.get("projection_2041_2050")

    v_base, _, _ = _vulnerabilite_batiment(bdnb)

    risques = []
    for candidat in _alea_candidats(bdnb, georisques, reference):
        f = float(candidat["f_score"])
        if f < 20:
            continue  # aléa absent / très faible : aucun signal exploitable
        score = _clamp(_combine_risk(f, v_base))
        if score < 20:
            continue
        risques.append(
            {
                "code": candidat["code"],
                "libelle": candidat["libelle"],
                "score": score,
                "niveau": _niveau_d03(score),
                "justification": candidat["justification"],
                "_f_score": round(f, 1),
                "_v_score": round(v_base, 1),
            }
        )

    risques.sort(key=lambda r: r["score"], reverse=True)
    return risques



# ---------------------------------------------------------------------------
# Trajectoire — raw variables par péril, par horizon (jamais combinées)
# ---------------------------------------------------------------------------


def compute_trajectoire(
    building_data: dict[str, Any],
    risques_2025: dict[str, dict[str, Any]],
    tracking_2025: dict[str, dict[str, Any]],
    risques_2050: dict[str, dict[str, Any]],
    tracking_2050: dict[str, dict[str, Any]],
    risques_2100: dict[str, dict[str, Any]] | None = None,
    tracking_2100: dict[str, dict[str, Any]] | None = None,
    scenarios_2100: dict[str, dict[str, dict[str, Any]]] | None = None,
    tracking_2100_by_scenario: dict[str, dict[str, dict[str, Any]]] | None = None,
    scenario: str = "rcp8_5",
) -> dict[str, Any]:
    """Expose les variables brutes F par péril, par horizon, avec provenance.

    C'est la réponse directe à la Phase 1 item 5 du roadmap : l'actuaire ne
    veut PAS « notre score » — il veut les variables d'aléa par péril, par
    horizon et par scénario, propres et étiquetées, pour faire tourner ses
    propres formules. Rien n'est combiné ici : chaque point porte son F brut
    (0-100, avant la moyenne géométrique avec V), son scénario (RCP/SSP),
    sa résolution (per-building / commune-level / grid-cell) et sa source.

    Horizons:
      - 2026 : OBSERVÉ — données actuelles Géorisques/BDNB/Open-Meteo
        (référence 2015-2024). Ce n'est pas une projection, c'est le présent.
      - 2050 : MODÉLISÉ — projection climatique (Open-Meteo 2041-2050 ;
        Copernicus CDS une fois activé), scénario RCP taggé quand connu.
      - 2100 : NON DISPONIBLE tant que Copernicus n'est pas activé — exposé
        explicitement comme tel plutôt que simulé (jamais de stub).
    """
    copernicus_actif = bool(building_data.get("climat_copernicus"))
    # Copernicus effectivement exploité pour 2100 : le bloc a pu être extrait
    # (indicateurs heatwave_days / frequency_of_extreme_precipitation au point).
    copernicus_2100 = bool(risques_2100)
    # Scénario sélectionné (rcp4_5 / rcp8_5) — celui qui pilote `valeur` ; les
    # autres restent disponibles dans `scenarios` pour comparaison.
    scenario = scenario if scenario in SCENARIOS_CDS else SCENARIOS_CDS[-1]

    perils: dict[str, Any] = {}
    for code, label, unite in PERILS_TRAJECTOIRE:
        r2025 = risques_2025.get(code) or {}
        r2050 = risques_2050.get(code) or {}
        t2025 = tracking_2025.get(code) or {}
        t2050 = tracking_2050.get(code) or {}
        r2100 = (risques_2100 or {}).get(code) or {}
        t2100 = (tracking_2100 or {}).get(code) or {}

        f2025 = r2025.get("risque")
        f2050 = r2050.get("risque")
        f2100 = r2100.get("risque") if copernicus_2100 else None

        points: list[dict[str, Any]] = []

        # --- 2026 : observé ---
        points.append(
            {
                "horizon": 2026,
                "type": "observe",
                "scenario": None,
                "valeur": f2025,
                "unite": unite,
                "resolution": _point_resolution(t2025, t2025.get("source", "")),
                "confiance": _confidence_from_status(t2025.get("statut")),
                "source": t2025.get("source"),
                "date_source": building_data.get("date_generation"),
            }
        )

        # --- 2050 : modélisé ---
        points.append(
            {
                "horizon": 2050,
                "type": "projete",
                "scenario": scenario if copernicus_actif else None,
                "valeur": f2050,
                "unite": unite,
                "resolution": _point_resolution(t2050, t2050.get("source", "")),
                "confiance": _confidence_from_status(t2050.get("statut")),
                "source": t2050.get("source"),
                "date_source": building_data.get("date_generation"),
            }
        )

        # --- 2100 : projeté (Copernicus CDS) ou explicitement indisponible ---
        # Périmètre honnête : seuls les périls dont le F 2100 provient
        # réellement de Copernicus (source taggée `copernicus.*`) reçoivent
        # un point projeté. Un péril statique (sismique, radon...) n'a pas
        # de projection 2100 — on le déclare indisponible, jamais on ne
        # duplique la valeur 2050 (pas de stub).
        source_2100 = t2100.get("source", "") if isinstance(t2100, dict) else ""
        if copernicus_2100 and f2100 is not None and source_2100.startswith("copernicus."):
            point_2100: dict[str, Any] = {
                "horizon": 2100,
                "type": "projete",
                "scenario": scenario,
                "valeur": f2100,
                "unite": unite,
                "resolution": _point_resolution(t2100, source_2100),
                "confiance": _confidence_from_status(t2100.get("statut")),
                "source": source_2100,
                "date_source": building_data.get("date_generation"),
            }
            # Comparaison de scénarios : F brut du même péril sous chaque RCP
            # téléchargé (rcp4_5 / rcp8_5), pour que l'assureur et l'actuaire
            # comparent sans relancer le diagnostic. Seuls les périls dont le F
            # provient réellement de Copernicus y figurent.
            per_scenario: dict[str, int] = {}
            for sc, risques_sc in (scenarios_2100 or {}).items():
                r_sc = (risques_sc or {}).get(code) or {}
                t_sc = ((tracking_2100_by_scenario or {}).get(sc) or {}).get(code) or {}
                src_sc = t_sc.get("source", "") if isinstance(t_sc, dict) else ""
                if r_sc.get("risque") is not None and src_sc.startswith("copernicus."):
                    per_scenario[sc] = int(r_sc["risque"])
            if per_scenario:
                point_2100["scenarios"] = per_scenario
            points.append(point_2100)
        else:
            points.append(
                {
                    "horizon": 2100,
                    "type": "indisponible",
                    "scenario": None,
                    "valeur": None,
                    "unite": unite,
                    "resolution": None,
                    "confiance": None,
                    "source": "copernicus.cds" if copernicus_actif else None,
                    "date_source": None,
                }
            )

        perils[code] = {
            "label": label,
            "points": points,
        }

    note = (
        "Variables brutes d'aléa F (0-100) par péril et par horizon — jamais "
        "combinées entre elles ni avec la vulnérabilité. 2026 = observé "
        "(données actuelles), 2050 = modélisé (projection climatique). "
    )
    if copernicus_2100:
        dispo = sorted(scenarios_2100 or {scenario})
        note += (
            f"2100 = projeté (Copernicus CDS, scénario {scenario} — "
            f"comparaison {' / '.join(dispo)}, fenêtre 2090-2100)."
        )
    else:
        note += "2100 = non disponible tant que Copernicus CDS n'est pas activé."

    return {
        "horizons": [2026, 2050, 2100],
        "note": note,
        "perils": perils,
    }


def compute_risk_scores(building_data: dict[str, Any], scenario: str = "rcp8_5") -> dict[str, Any]:
    """Point d'entrée du scoring_agent.

    `scenario` (rcp4_5 / rcp8_5) désigne le scénario climatique qui pilote
    les points projetés de la trajectoire. Le téléchargement CDS contient les
    DEUX scénarios : chaque point 2100 projeté porte donc aussi la valeur F
    sous l'autre RCP (champ `scenarios`) pour comparaison immédiate, sans
    relancer le diagnostic.

    Retourne un dict avec :
      - score_global : int (0-100)
      - zones : dict[str, dict] (7 zones, chaque zone contient risque/niveau/...)
      - projection_2050 : {score_global, zones}
      - confidence : dict (D02, score de confiance 0-100)
      - sources : list[dict] (D04, traçabilité des sources)

    Compatible avec tous les consommateurs existants :
      - diagnostic_builder lit score_global / zones / projection_2050
      - interpretation_agent lit score_global / zones / projection_2050
      - zone_scoring lit score_global / zones
      - property_id lit score_global / projection_2050
    """
    logger.info("scoring_agent -- calcul des scores F/V (période courante + projection 2050)")

    climat = building_data.get("climat_open_meteo") or {}
    reference = climat.get("reference_2015_2024")
    projection = climat.get("projection_2041_2050")

    logger.info("période référence (2025) :")
    zones_2025, sources_2025, risques_par_alea_2025, peril_tracking_2025 = _compute_zones_for_period(building_data, reference, is_projection=False)
    score_2025 = _score_global(zones_2025)
    logger.info("  -> score_global = %d", score_2025)

    logger.info("période projection (2050) :")
    zones_2050, sources_2050, risques_par_alea_2050, peril_tracking_2050 = _compute_zones_for_period(building_data, projection or reference, is_projection=True)
    score_2050 = _score_global(zones_2050)
    logger.info("  -> score_global = %d", score_2050)

    # --- Horizon 2100 : Copernicus CDS (une fois la licence acceptée et le
    # téléchargement effectué). Sans données CDS, les périls 2100 restent
    # honnêtement `indisponible` dans la trajectoire. Le téléchargement
    # contient les DEUX scénarios (_REQUEST : rcp4_5 + rcp8_5) : on calcule
    # chaque passe pour que le frontend et l'actuaire comparent les RCP sans
    # relancer le diagnostic. `scenario` désigne la sélection primaire
    # (pilote `valeur` des points 2100).
    if scenario not in SCENARIOS_CDS:
        scenario = SCENARIOS_CDS[-1]
    climat_copernicus = building_data.get("climat_copernicus")
    scenarios_2100: dict[str, dict[str, dict[str, Any]]] = {}
    tracking_2100_by_scenario: dict[str, dict[str, dict[str, Any]]] = {}
    for sc in SCENARIOS_CDS:
        if not scenario_available(climat_copernicus, sc):
            continue
        climat_2100 = extract_climate_2100(climat_copernicus, scenario=sc)
        if not climat_2100:
            continue
        logger.info("période projection (2100, Copernicus CDS, scénario %s) :", sc)
        (
            _zones_2100,
            _sources_2100,
            risques_par_alea_2100_sc,
            peril_tracking_2100_sc,
        ) = _compute_zones_for_period(building_data, climat_2100, is_projection=True)
        scenarios_2100[sc] = risques_par_alea_2100_sc
        tracking_2100_by_scenario[sc] = peril_tracking_2100_sc

    risques_par_alea_2100 = scenarios_2100.get(scenario)
    peril_tracking_2100 = tracking_2100_by_scenario.get(scenario)

    confidence = _compute_confidence(sources_2025)
    logger.info("  -> confiance = %d (%s)", confidence["score"], confidence["niveau"])

    trajectoire = compute_trajectoire(
        building_data,
        risques_par_alea_2025,
        peril_tracking_2025,
        risques_par_alea_2050,
        peril_tracking_2050,
        risques_2100=risques_par_alea_2100,
        tracking_2100=peril_tracking_2100,
        scenarios_2100=scenarios_2100,
        tracking_2100_by_scenario=tracking_2100_by_scenario,
        scenario=scenario,
    )

    return {
        "score_global": score_2025,
        "zones": zones_2025,
        "risques_par_alea": risques_par_alea_2025,
        "projection_2050": {
            "score_global": score_2050,
            "zones": zones_2050,
            "risques_par_alea": risques_par_alea_2050,
        },
        "trajectoire": trajectoire,
        "confidence": confidence,
        "sources": sources_2025,
    }
