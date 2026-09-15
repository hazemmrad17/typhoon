"""Agent de rapport (étape 3) — déterministe, ancré sur les données du secteur.

Flux :
  DamageEstimate + scénario (JSON, étape 2) ─▶ pré-traitement déterministe
  (niveaux de risque par seuils fixes, actions de mitigation depuis la
  taxonomie) ─▶ rendu « template-first » qui part immédiatement en flux SSE
  (header, synthèse, catégories, recommandations, confiance, annexe) ─▶ appel
  Mistral optionnel en STREAM (mistral-large-latest, temp=0, seed fixe, JSON
  strict) dont chaque prose de champ est validée (nombres ancrés + IDs connus)
  avant d'être émise en événement « patch » ─▶ cache (hash secteur/scénario/
  instant/versions), rejoué à l'identique.

Le chemin « template-first » est le socle : tous les nombres, niveaux de
risque et actions sont calculés par du code déterministe. Mistral ne fait que
réécrire la synthèse et les narratifs par catégorie ; dès qu'un nombre n'est
pas ancré dans les données, on retombe sur la phrase template. Sans clé ou si
l'appel échoue, le rapport est complet mais sans prose LLM (fallback_used=True)
— jamais de contenu inventé.
"""

from __future__ import annotations

import hashlib
import html
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncIterator

from app.connectors.mistral import mistral_stream_json
from app.core.logging import get_logger
from app.schemas.report import (
    CategoryRiskOut,
    DamageModel,
    MitigationOut,
    ReportRequest,
    ReportResponse,
    ReportStreamEvent,
)
from app.services.report_taxonomy import (
    CATEGORY_RISK,
    mitigation_by_id,
    risk_level_for,
    select_mitigations,
)

logger = get_logger(__name__)

# ── Versions : changer l'un de ces numéros = nouveau namespace de cache ──
DATA_VERSION = "1"
PROMPT_VERSION = "5"  # + consigne de langue (prose en français, lecteur assureur FR)

CACHE_DIR = Path(__file__).resolve().parent.parent.parent / "app" / "cache" / "reports"

_NUM_RE = re.compile(r"\d+(?:[.,]\d+)?")

# Ordinaux français adossés à un nombre (« 12ᵉ », « 1er », « 2e », « 3ème ») :
# le nombre qui les porte n'est pas une donnée chiffrée du rapport.
_ORDINAL_RE = re.compile(r"\b\d+\s*(?:ᵉʳᵉ|ᵉʳ|ᵉ|ème|eme|ère|er|e)\b", re.IGNORECASE | re.UNICODE)


# ---------------------------------------------------------------------------
# Formatage des nombres (fr) — cohérent avec le panneau gauche
# ---------------------------------------------------------------------------

def _fmt_money_eur(v: float) -> str:
    if v >= 1_000_000:
        return f"{v / 1_000_000:.1f} M€"
    if v >= 1000:
        return f"{v / 1000:.0f} k€"
    return f"{v:.0f} €"


def _fmt(v: float) -> str:
    """Valeur arrondie à l'entier, séparateur de milliers français."""
    return f"{round(v):,}".replace(",", " ")


def _fmt_range(r) -> str:
    spread = max(1, round(r.high - r.v))
    return f"{_fmt(r.v)} ±{_fmt(spread)}"


def _fmt_ts(ts: str) -> str:
    try:
        return datetime.fromisoformat(ts).strftime("%d/%m/%Y à %H:%M")
    except ValueError:
        return ts


# ---------------------------------------------------------------------------
# Cache — hash(secteur, scénario, instant, data_version, prompt_version)
# ---------------------------------------------------------------------------

def _cache_key(req: ReportRequest) -> str:
    """Hash(secteur, scénario, instant, parcours hydro, versions) — le trajet
    de l'eau entre dans la clé : deux adresses (ou deux parcours) différentes
    ne partagent jamais une entrée de cache."""
    canonical = json.dumps(
        {
            "sector": req.sector,
            "scenario": req.scenario.model_dump(),
            "timestamp": req.timestamp,
            "hydro": req.hydro.model_dump() if req.hydro else None,
            "data_version": DATA_VERSION,
            "prompt_version": PROMPT_VERSION,
        },
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _cache_path(key: str) -> Path:
    return CACHE_DIR / f"{key}.json"


def _load_cache(key: str) -> ReportResponse | None:
    path = _cache_path(key)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return ReportResponse(**data)
    except (ValueError, TypeError) as exc:
        logger.warning("Cache rapport corrompu (%s) — ignoré : %s", key, exc)
        return None


def _save_cache(key: str, resp: ReportResponse) -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        _cache_path(key).write_text(resp.model_dump_json(), encoding="utf-8")
    except OSError as exc:
        logger.warning("Écriture cache rapport impossible : %s", exc)


# ---------------------------------------------------------------------------
# Pré-traitement déterministe (aucun LLM)
# ---------------------------------------------------------------------------

def _category_risks(damage: DamageModel | None) -> list[CategoryRiskOut]:
    out: list[CategoryRiskOut] = []
    if damage is None:
        return out
    for cat, spec in CATEGORY_RISK.items():
        field = getattr(damage, spec["field"])
        out.append(
            CategoryRiskOut(
                category=cat,
                label=spec["label"],
                risk_level=risk_level_for(cat, field.v),
                value=round(field.v, 2),
                unit=spec["unit"],
            )
        )
    return out


def _mitigations(damage: DamageModel | None) -> list[MitigationOut]:
    if damage is None:
        return []
    applied = select_mitigations(damage)
    return [
        MitigationOut(
            id=m.id,
            category=m.category,
            text=m.text,
            trigger=m.trigger_note,
        )
        for m in applied
    ]


def _hydro_stop_label(reason: str | None) -> str:
    """Traduit la raison d'arrêt du parcours en libellé de rapport."""
    if not reason:
        return "la limite du réseau cartographié"
    return {
        "exutoire": "l'exutoire du cours d'eau",
        "confluent": "un confluent",
        "perte": "une perte (cours d'eau busé ou souterrain)",
        "source": "la source du cours d'eau",
        "budget": "la limite de reconstruction demandée",
        "no_segment": "aucun tronçon hydrographique à proximité",
        "isolated_node": "un nœud hydrographique isolé",
    }.get(reason, reason)


def _hydro_summary_template(req: ReportRequest) -> str:
    """Phrase template de la section « trajet de l'eau » (repli inclus).

    Ne cite que des faits du parcours : nom du cours d'eau, distances
    parcourues, raisons d'arrêt, fourchette d'arrivée cinématique."""
    h = req.hydro
    if h is None:  # pragma: no cover - appelé uniquement avec parcours
        return ""
    parts: list[str] = []
    cours = f"« {h.watercourse} »" if h.watercourse else "un cours d'eau non nommé"
    snap = (
        f" à {_fmt(h.snap_distance_m)} m du tracé cartographié"
        if h.snap_distance_m is not None
        else ""
    )
    parts.append(
        f"Le point diagnostiqué se rattache à {cours}{snap} "
        "(réseau hydrographique IGN BD TOPO)."
    )
    if h.upstream_km > 0:
        parts.append(
            f"En amont, le parcours remonte {h.upstream_km:.1f} km jusqu'à "
            f"{_hydro_stop_label(h.upstream_stop)}."
        )
    if h.basin is not None and (h.basin.libelle or h.basin.toponyme):
        bassin = h.basin.libelle or h.basin.toponyme
        area = (
            f" ({_fmt(h.basin.area_km2)} km²)" if h.basin.area_km2 is not None else ""
        )
        parts.append(f"Bassin versant topographique de rattachement : {bassin}{area}.")
    if h.downstream_km > 0:
        parts.append(
            f"En aval, le parcours descend {h.downstream_km:.1f} km jusqu'à "
            f"{_hydro_stop_label(h.downstream_stop)}."
        )
    if h.arrival_min_hours is not None and h.arrival_max_hours is not None:
        parts.append(
            "Temps d'arrivée le long du tracé : entre "
            f"{h.arrival_min_hours:.1f} h et {h.arrival_max_hours:.1f} h "
            "(estimation cinématique de transport, pas une propagation hydraulique)."
        )
    parts.append(
        "Ces éléments sont des faits de géographie sourcés ; aucune emprise "
        "d'inondation n'est déduite du parcours."
    )
    return " ".join(parts)


def _class_phrase(req: ReportRequest) -> str:
    """Phrase d'ouverture sur la classe retenue — SANS jamais imprimer un
    « 0,0 m ».

    `depthPeakM == 0` signifie « aucune classe TRI cartographiée au point »,
    pas « profondeur nulle ». Écrire « pic d'eau 0,0 m » faisait passer une
    absence de donnée pour une mesure — c'est exactement ce qu'interdit
    l'invariant « faits + provenance » : ni valeur inventée, ni absence
    déguisée en chiffre.
    """
    s = req.scenario
    if s.depthPeakM > 0:
        return (
            f"Pour {req.sector}, la classe de crue retenue est {s.risk} "
            f"(pic d'eau {s.depthPeakM:.1f} m, classe TRI officielle). "
        )
    # `depthPeakM == 0` recouvre DEUX situations que le rapport ne doit pas
    # confondre (un quai peut être dans un TRI sans classe à cet endroit) :
    #   · point dans le périmètre TRI → l'exposition réglementaire existe,
    #     seule la hauteur n'est pas cartographiée ;
    #   · point hors TRI → aucune classe, et le rappel « hors TRI n'est pas
    #     jamais inondé » s'applique ;
    #   · non vérifié → on n'affirme ni l'un ni l'autre.
    if s.inTri is True:
        return (
            f"Pour {req.sector}, la classe de crue retenue est {s.risk}, mais "
            "AUCUNE classe de hauteur d'eau n'est cartographiée (TRI, Directive "
            "Inondation) à cet emplacement précis : aucune profondeur n'est donc "
            "affichée. Le point est en revanche DANS le périmètre d'un TRI — "
            "l'exposition réglementaire n'est pas nulle pour autant. "
        )
    if s.inTri is False:
        return (
            f"Pour {req.sector}, la classe de crue retenue est {s.risk}, mais "
            "AUCUNE classe de hauteur d'eau n'est cartographiée (TRI, Directive "
            "Inondation) au point analysé : aucune profondeur n'est donc affichée. "
            "Hors TRI n'équivaut pas à « jamais inondé ». "
        )
    return (
        f"Pour {req.sector}, la classe de crue retenue est {s.risk}, mais "
        "AUCUNE classe de hauteur d'eau n'est cartographiée (TRI, Directive "
        "Inondation) au point analysé : aucune profondeur n'est donc affichée. "
        "L'appartenance du point au périmètre d'un TRI n'a pas pu être vérifiée "
        "— hors TRI n'équivaut pas à « jamais inondé ». "
    )


def _exec_summary_template(req: ReportRequest) -> str:
    base = _class_phrase(req)
    if req.damage is None:
        return (
            base
            + "Aucune estimation de dommages n'est produite : les courbes de "
            "vulnérabilité synthétiques ont été retirées tant qu'un référentiel "
            "d'exposition réel n'est pas disponible. Le rapport se limite aux "
            "faits sourcés (aléas Géorisques, hydrographie IGN BD TOPO, météo)."
        )
    return (
        base
        + f"Les dommages estimés atteignent {_fmt_money_eur(req.damage.damageEUR.v)} "
        f"avec environ {_fmt(req.damage.hp.v)} habitations touchées. "
        f"La priorité porte sur le renforcement face à l'eau ({_fmt(req.damage.waterLevelFt.v)} ft) "
        "et la protection des réseaux et bâtiments exposés."
    )


def _category_narrative_template(cat: CategoryRiskOut, damage: DamageModel | None) -> str:
    if damage is None:
        return (
            f"Niveau {cat.risk_level} : {cat.label}. Aucune estimation chiffrée "
            "n'est produite tant qu'un référentiel d'exposition réel n'est pas disponible."
        )
    spec = CATEGORY_RISK[cat.category]
    field = getattr(damage, spec["field"])
    return (
        f"Niveau {cat.risk_level} : {cat.label} estimé à "
        f"{_fmt_range(field)} {cat.unit}."
    )


def _appendix_rows(req: ReportRequest) -> list[list[str]]:
    if req.damage is None:
        # Même règle que la synthèse : 0 n'est pas une mesure, c'est une
        # absence de classe cartographiée. On écrit l'absence, pas un zéro.
        peak = (
            f"{req.scenario.depthPeakM:.1f} m"
            if req.scenario.depthPeakM > 0
            else {
                True: "non cartographiée au point (dans un TRI, sans classe à cet emplacement)",
                False: "non cartographiée au point (hors TRI)",
                None: "non cartographiée au point (appartenance TRI non vérifiée)",
            }[req.scenario.inTri]
        )
        return [
            ["Pic d'eau de la classe TRI", peak],
            ["Classe retenue", req.scenario.risk],
        ]
    return [
        ["Arbres cassés", _fmt_range(req.damage.brokenTrees)],
        ["Véhicules endommagés", _fmt_range(req.damage.damagedVehicles)],
        ["Lignes coupées (km)", _fmt_range(req.damage.downedPowerLines)],
        ["Conduites inondées (m)", _fmt_range(req.damage.floodedConduitM)],
        ["Bâtiments touchés", _fmt_range(req.damage.damagedBuildings)],
        ["Voirie inondée (m)", _fmt_range(req.damage.damagedRoadsM)],
        ["Niveau d'eau (ft)", _fmt_range(req.damage.waterLevelFt)],
        ["Habitations touchées (HP)", _fmt_range(req.damage.hp)],
        ["Dommages estimés (€)", _fmt_range(req.damage.damageEUR)],
        ["Dommages estimés ($)", _fmt_range(req.damage.damageUSD)],
    ]


def _build_report_data(req: ReportRequest) -> dict:
    """Tout le déterministe, calculé une fois — partagé entre flux et cache.

    Le trajet de l'eau ne change rien aux estimations de dommages : c'est une
    section documentaire (géographie sourcée), pas un second moteur.
    """
    data: dict = {
        "risks": _category_risks(req.damage),
        "migs": _mitigations(req.damage),
        "exec_template": _exec_summary_template(req),
        "appendix_rows": _appendix_rows(req),
    }
    if req.hydro is not None:
        data["hydro"] = {
            "summary_template": _hydro_summary_template(req),
        }
    return data


# ---------------------------------------------------------------------------
# Validation de la prose LLM (ancrage des nombres + IDs d'action connus)
# ---------------------------------------------------------------------------

def _allowed_numbers(req: ReportRequest) -> set[int]:
    """Nombres légitimes pouvant apparaître dans la prose : toutes les
    valeurs v/low/high de l'estimation (si fournie) + intensité du scénario + année."""
    allowed: set[int] = set()
    if req.damage is not None:
        for field in type(req.damage).model_fields:
            r = getattr(req.damage, field)
            allowed.add(int(round(r.v)))
            allowed.add(int(round(r.low)))
            allowed.add(int(round(r.high)))
    # Les faits du parcours sont ancrés comme le scénario officiel : leurs
    # nombres sont légitimes dans la prose de la section « trajet de l'eau ».
    if req.hydro is not None:
        h = req.hydro
        raw_nums = [
            h.upstream_km,
            h.downstream_km,
            h.snap_distance_m,
            h.arrival_min_hours,
            h.arrival_max_hours,
            h.basin.area_km2 if h.basin else None,
        ]
        for v in raw_nums:
            if v is None:
                continue
            allowed.add(int(round(v)))
            allowed.add(int(round(v * 10)))
            allowed.add(int(round(v * 100)))
    s = req.scenario
    allowed.update(
        int(round(x))
        for x in (s.depthPeakM,)
        if x > 0
    )
    # Le nom du secteur (adresse diagnostiquée) fait partie des faits : les
    # nombres qu'il contient (numéro de rue, code postal, code INSEE) sont
    # légitimes dans la prose. Sans cet ancrage, toute phrase citant l'adresse
    # était rejetée (« 75019 » non autorisé) et le rapport retombait en
    # template — même quand le LLM avait répondu correctement.
    for n in _numbers_in(req.sector):
        allowed.add(int(round(n)))
    try:
        allowed.add(datetime.fromisoformat(req.timestamp).year)
    except ValueError:
        pass
    return allowed


def _numbers_in(text: str) -> list[float]:
    # 1. Ordinaux retirés AVANT l'extraction (« 12ᵉ arrondissement ») : ce sont
    #    des qualificatifs grammaticaux, pas des grandeurs. Sans ce nettoyage,
    #    un « 12ᵉ » déduit du code postal (75012) était lu comme le nombre 12,
    #    non ancré, et la phrase entière était rejetée.
    # 2. Séparateurs de milliers français réunis (« 408 700 » → « 408700 »)
    # 3. Virgule décimale française gérée par float() (« 0,5 » → 0.5).
    normalized = _ORDINAL_RE.sub(" ", text)
    normalized = re.sub(r"(?<=\d) (?=\d)", "", normalized)
    return [float(s.replace(",", ".")) for s in _NUM_RE.findall(normalized)]


def _grounded(text: str, allowed: set[int]) -> bool:
    for n in _numbers_in(text):
        if int(round(n)) not in allowed:
            return False
    return True


def _validated_llm(llm: dict | None, req: ReportRequest) -> dict:
    """Filtre la sortie Mistral : ne garde qu'une prose ancrée + des actions
    connues. Chaque champ non valide retombe sur son template."""
    allowed = _allowed_numbers(req)
    out: dict = {"executiveSummary": None, "categoryNarratives": {}, "mitigationNarratives": {}}
    if req.hydro is not None:
        out["hydroSummary"] = None

    if not isinstance(llm, dict):
        return out

    if req.hydro is not None:
        hydro_sum = llm.get("hydroSummary")
        if isinstance(hydro_sum, str) and hydro_sum.strip() and _grounded(hydro_sum, allowed):
            out["hydroSummary"] = hydro_sum.strip()

    exec_sum = llm.get("executiveSummary")
    if isinstance(exec_sum, str) and exec_sum.strip() and _grounded(exec_sum, allowed):
        out["executiveSummary"] = exec_sum.strip()

    cats = llm.get("categoryNarratives")
    if isinstance(cats, list):
        for item in cats:
            if not isinstance(item, dict):
                continue
            cat = item.get("category")
            narr = item.get("narrative")
            if (
                isinstance(cat, str)
                and cat in CATEGORY_RISK
                and isinstance(narr, str)
                and narr.strip()
                and _grounded(narr, allowed)
            ):
                out["categoryNarratives"][cat] = narr.strip()

    acts = llm.get("mitigationNarratives")
    if isinstance(acts, list):
        for item in acts:
            if not isinstance(item, dict):
                continue
            aid = item.get("actionId")
            narr = item.get("narrative")
            if (
                isinstance(aid, str)
                and mitigation_by_id(aid) is not None
                and isinstance(narr, str)
                and narr.strip()
                and _grounded(narr, allowed)
            ):
                out["mitigationNarratives"][aid] = narr.strip()
    return out


# ---------------------------------------------------------------------------
# Prompt / payload Mistral (commun stream & non-stream)
# ---------------------------------------------------------------------------

def _mistral_io(req: ReportRequest) -> tuple[str, str]:
    risks = _category_risks(req.damage)
    migs = _mitigations(req.damage)
    exec_stats = (
        {
            "damageEUR": _fmt_money_eur(req.damage.damageEUR.v),
            "damageRange": (
                f"{_fmt_money_eur(req.damage.damageEUR.low)} – "
                f"{_fmt_money_eur(req.damage.damageEUR.high)}"
            ),
            "hp": _fmt(req.damage.hp.v),
            "waterLevelFt": _fmt(req.damage.waterLevelFt.v),
        }
        if req.damage is not None
        else None
    )
    payload = {
        "sector": req.sector,
        "scenario": {
            "risk": req.scenario.risk,
            "depthPeakM": req.scenario.depthPeakM,
        },
        "executiveStats": exec_stats,
        "categoryRiskLevels": [
            {"category": c.category, "label": c.label, "riskLevel": c.risk_level, "value": c.value, "unit": c.unit}
            for c in risks
        ],
        "applicableActions": [m.model_dump() for m in migs],
    }
    if req.hydro is not None:
        h = req.hydro
        payload["hydro"] = {
            "watercourse": h.watercourse,
            "snapDistanceM": h.snap_distance_m,
            "upstreamKm": h.upstream_km,
            "upstreamStop": h.upstream_stop,
            "downstreamKm": h.downstream_km,
            "downstreamStop": h.downstream_stop,
            "arrivalHoursRange": (
                f"{h.arrival_min_hours:.1f} – {h.arrival_max_hours:.1f}"
                if h.arrival_min_hours is not None and h.arrival_max_hours is not None
                else None
            ),
            "catchment": (
                {
                    "label": (h.basin.libelle or h.basin.toponyme),
                    "group": h.basin.group_libelle,
                    "areaKm2": h.basin.area_km2,
                }
                if h.basin is not None
                else None
            ),
            "source": h.sources.get("network") or "IGN BD TOPO",
        }
    system = (
        "You are generating prose for a fixed-structure risk report section. "
        "You will be given a JSON payload of computed risk data and a list of "
        "pre-approved mitigation actions. Rephrase each item into one clear, "
        "professional sentence. Do not add any fact, number, or recommendation "
        "not present in the input. Do not include general commentary about "
        "climate, weather patterns, or disclaimers beyond what is provided. "
        "Output valid JSON matching this schema exactly: "
        '{"executiveSummary": string, "categoryNarratives": [{"category": string, '
        '"narrative": string}], "mitigationNarratives": [{"actionId": string, '
        '"narrative": string}]'
        + (
            ', "hydroSummary": string}'
            if req.hydro is not None
            else "}"
        )
        + ". "
        "Every number you write must appear in the input payload. "
        "Write ALL prose in French (fr-FR) — the reader is a French-speaking "
        "underwriter. Keep proper nouns, hazard codes and source labels as "
        "given in the payload; do not translate them."
        + (
            " The \"hydro\" payload describes the REAL watercourse the "
            "diagnosed point belongs to (French IGN BD TOPO network): write "
            "hydroSummary strictly from those facts. It is geography, not a "
            "forecast, and not a flood extent or water depth: never invent a "
            "water level, an inundation area, or a hydraulic propagation."
            if req.hydro is not None
            else ""
        )
    )
    return system, json.dumps(payload)


def _llm_fallbacks_used(llm: dict) -> bool:
    return not (
        llm.get("executiveSummary")
        or llm.get("categoryNarratives")
        or llm.get("mitigationNarratives")
        or llm.get("hydroSummary")
    )


# ---------------------------------------------------------------------------
# Flux SSE
# ---------------------------------------------------------------------------

def _sse(type_: str, data: dict) -> str:
    return ReportStreamEvent(type=type_, data=data).model_dump_json()


async def _patches_async(req: ReportRequest, llm: dict) -> AsyncIterator[str]:
    """Émet un événement « patch » par prose LLM validée."""
    if llm.get("executiveSummary"):
        yield _sse("patch", {"field": "exec", "value": llm["executiveSummary"]})
    for cat, narr in llm.get("categoryNarratives", {}).items():
        yield _sse("patch", {"field": "category", "category": cat, "value": narr})
    for aid, narr in llm.get("mitigationNarratives", {}).items():
        yield _sse("patch", {"field": "mitigation", "id": aid, "value": narr})
    if llm.get("hydroSummary"):
        yield _sse("patch", {"field": "hydro", "value": llm["hydroSummary"]})


async def stream_report(req: ReportRequest) -> AsyncIterator[str]:
    """Générateur SSE du rapport : sections déterministes immédiatement, puis
    prose LLM validée en « patch », puis « done ». Cache rejoué à l'identique."""
    key = _cache_key(req)
    cached = _load_cache(key)
    if cached is not None:
        data = _build_report_data(req)
        meta = {**cached.meta, "cache_hit": True}
        async for ev in _emit_all(req, data, cached.narratives, meta):
            yield ev
        return

    data = _build_report_data(req)
    async for ev in _emit_deterministic(req, data):
        yield ev

    # Prose Mistral en stream — jamais bloquante pour le rendu.
    system, user = _mistral_io(req)
    buf = ""
    try:
        async for frag in mistral_stream_json(system, user):
            buf += frag
    except Exception as exc:  # pragma: no cover - garde-fou large
        logger.warning("Stream Mistral indisponible pour le rapport : %s", exc)
        buf = ""

    llm = _validated_llm(json.loads(buf) if buf else None, req)
    async for ev in _patches_async(req, llm):
        yield ev

    fallback_used = _llm_fallbacks_used(llm)
    resp = _assemble(req, data, llm, key, fallback_used)
    _save_cache(key, resp)

    yield _sse(
        "done",
        {
            "fallback_used": fallback_used,
            "executive_summary": resp.executive_summary,
            "meta": resp.meta,
        },
    )


async def _emit_deterministic(req: ReportRequest, data: dict) -> AsyncIterator[str]:
    s = req.scenario
    yield _sse(
        "header",
        {
            "sector": req.sector,
            "scenario": s.risk,
            "timestamp": req.timestamp,
            "timestamp_label": _fmt_ts(req.timestamp),
        },
    )
    yield _sse(
        "summary",
        {
            "damageEUR": _fmt_money_eur(req.damage.damageEUR.v) if req.damage else None,
            "damageRange": (
                f"{_fmt_money_eur(req.damage.damageEUR.low)} – "
                f"{_fmt_money_eur(req.damage.damageEUR.high)}"
                if req.damage
                else None
            ),
            "hp": _fmt(req.damage.hp.v) if req.damage else None,
            "waterLevelFt": _fmt(req.damage.waterLevelFt.v) if req.damage else None,
            "executive_summary": data["exec_template"],
        },
    )
    for cat in data["risks"]:
        yield _sse(
            "category",
            {
                "category": cat.category,
                "label": cat.label,
                "risk_level": cat.risk_level,
                "value": cat.value,
                "unit": cat.unit,
                "estimate": (
                    _fmt_range(getattr(req.damage, CATEGORY_RISK[cat.category]["field"]))
                    if req.damage
                    else None
                ),
                "narrative": _category_narrative_template(cat, req.damage),
            },
        )
    yield _sse(
        "mitigations",
        {"items": [m.model_dump() for m in data["migs"]]},
    )
    yield _sse(
        "confidence",
        {
            "low": _fmt_money_eur(req.damage.damageEUR.low) if req.damage else None,
            "high": _fmt_money_eur(req.damage.damageEUR.high) if req.damage else None,
        },
    )
    yield _sse("appendix", {"rows": data["appendix_rows"]})

    # ── Section « trajet de l'eau » — géographie réelle (IGN BD TOPO). Émise
    #    uniquement si un parcours est fourni ; sinon le rapport est identique
    #    à celui d'avant (aucun événement hydro_*). ──
    hydro = req.hydro
    if hydro is not None:
        hydro_data = data.get("hydro") or {}
        yield _sse(
            "hydro_header",
            {
                "watercourse": hydro.watercourse,
                "basin_libelle": (hydro.basin.libelle or hydro.basin.toponyme)
                if hydro.basin is not None
                else None,
                "upstream_km": round(hydro.upstream_km, 2),
                "downstream_km": round(hydro.downstream_km, 2),
                "upstream_stop": hydro.upstream_stop,
                "downstream_stop": hydro.downstream_stop,
                "arrival_min_hours": hydro.arrival_min_hours,
                "arrival_max_hours": hydro.arrival_max_hours,
                "source": hydro.sources.get("network") or "IGN BD TOPO",
            },
        )
        yield _sse(
            "hydro_summary",
            {
                "summary": hydro_data.get("summary_template", ""),
                "snap_distance_m": hydro.snap_distance_m,
                "basin_area_km2": hydro.basin.area_km2 if hydro.basin is not None else None,
                "basin_group": hydro.basin.group_libelle if hydro.basin is not None else None,
            },
        )


async def _emit_all(req: ReportRequest, data: dict, narratives: dict, meta: dict) -> AsyncIterator[str]:
    """Rejoue intégralement le flux depuis un rapport en cache."""
    async for ev in _emit_deterministic(req, data):
        yield ev
    async for ev in _patches_async(req, narratives):
        yield ev
    yield _sse("done", {"fallback_used": False, "meta": meta})


# ---------------------------------------------------------------------------
# Assemblage du rapport complet (markdown + html) — pour cache & non-stream
# ---------------------------------------------------------------------------

def _assemble(req: ReportRequest, data: dict, llm: dict, key: str, fallback_used: bool) -> ReportResponse:
    exec_sum = llm.get("executiveSummary") or data["exec_template"]
    md = _render_markdown(req, llm, data)
    resp = ReportResponse(
        markdown=md,
        html=_md_to_html(md),
        executive_summary=exec_sum,
        category_risk_levels=data["risks"],
        mitigations=data["migs"],
        cache_hit=False,
        fallback_used=fallback_used,
        narratives={
            "executiveSummary": llm.get("executiveSummary"),
            "categoryNarratives": llm.get("categoryNarratives", {}),
            "mitigationNarratives": llm.get("mitigationNarratives", {}),
            "hydroSummary": llm.get("hydroSummary"),
        },
        meta={
            "data_version": DATA_VERSION,
            "prompt_version": PROMPT_VERSION,
            "model": "mistral-large-latest" if not fallback_used else "template-first",
            "cache_key": key,
            "cache_hit": False,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        },
    )
    return resp


# ---------------------------------------------------------------------------
# Rendu markdown + html (socle du rapport et de l'annexe)
# ---------------------------------------------------------------------------

def _render_markdown(req: ReportRequest, llm: dict, data: dict | None = None) -> str:
    data = data or _build_report_data(req)
    s = req.scenario
    risks = data["risks"]
    migs = data["migs"]

    exec_sum = llm.get("executiveSummary") or data["exec_template"]

    cat_blocks = []
    for cat in risks:
        narr = llm.get("categoryNarratives", {}).get(cat.category) or _category_narrative_template(cat, req.damage)
        est_line = (
            f"\n*Estimation : {_fmt_range(getattr(req.damage, CATEGORY_RISK[cat.category]['field']))} "
            f"{cat.unit}.*"
            if req.damage is not None
            else ""
        )
        cat_blocks.append(f"### {cat.label} — {cat.risk_level}\n{narr}{est_line}")

    mit_blocks = []
    for m in migs:
        narr = llm.get("mitigationNarratives", {}).get(m.id) or m.text
        mit_blocks.append(
            f"1. **{m.category.capitalize()}** — {narr} *(déclenché : {m.trigger})*"
        )

    appendix_rows = data["appendix_rows"]
    appendix = "\n".join(f"| {k} | {v} |" for k, v in appendix_rows)

    mito = "\n".join(mit_blocks) if mit_blocks else "_Aucune action de mitigation ne dépasse le seuil de déclenchement._"

    # ── Section « trajet de l'eau » — documentaire, présente uniquement si un
    #    parcours réel est fourni : sans lui le document est identique à celui
    #    d'avant (même numérotation d'annexe, même contenu). ──
    hydro = req.hydro
    hydro_block = ""
    annexe_no = 5
    if hydro is not None:
        hydro_data = data.get("hydro") or {}
        narr = llm.get("hydroSummary") or hydro_data.get("summary_template", "")
        titre_cours = hydro.watercourse or "cours d'eau non nommé"
        bassin = (
            (hydro.basin.libelle or hydro.basin.toponyme)
            if hydro.basin is not None
            else None
        )
        rows = [
            ("Cours d'eau de rattachement", titre_cours),
            (
                "Distance au tracé cartographié",
                f"{_fmt(hydro.snap_distance_m)} m"
                if hydro.snap_distance_m is not None
                else "—",
            ),
            ("Bassin versant topographique", bassin or "—"),
            ("Amont reconstruit", f"{hydro.upstream_km:.1f} km — {_hydro_stop_label(hydro.upstream_stop)}"),
            ("Aval reconstruit", f"{hydro.downstream_km:.1f} km — {_hydro_stop_label(hydro.downstream_stop)}"),
            (
                "Temps d'arrivée (cinématique)",
                f"{hydro.arrival_min_hours:.1f} – {hydro.arrival_max_hours:.1f} h"
                if hydro.arrival_min_hours is not None and hydro.arrival_max_hours is not None
                else "—",
            ),
        ]
        hydro_rows = "\n".join(f"| {k} | {v} |" for k, v in rows)
        hydro_block = f"""
## 5. Trajet de l'eau — {titre_cours}
{narr}

| Élément du parcours | Valeur |
|---|---|
{hydro_rows}

> Source : {hydro.sources.get("network") or "IGN BD TOPO"}. Ce parcours décrit la
> géographie du réseau hydrographique réel : il ne s'agit ni d'une hauteur d'eau,
> ni d'une emprise d'inondation, ni d'une propagation hydraulique.
"""
        annexe_no = 6

    exec_line = (
        f"> **Dommages estimés :** {_fmt_money_eur(req.damage.damageEUR.v)} · "
        f"**Habitations touchées :** {_fmt(req.damage.hp.v)}\n"
        if req.damage is not None
        else ""
    )
    confidence_block = (
        (
            "Estimation modélisée à partir des données météo du scénario, de l'exposition\n"
            "du secteur et de courbes de vulnérabilité (méthodologie de type HAZUS). Ce ne\n"
            "sont **pas des dommages observés**. Fourchette d'incertitude du modèle :\n"
            f"dommages estimés {_fmt_money_eur(req.damage.damageEUR.low)} – {_fmt_money_eur(req.damage.damageEUR.high)}.\n"
        )
        if req.damage is not None
        else (
            "Aucune estimation de dommages chiffrée : les courbes de vulnérabilité\n"
            "synthétiques (style HAZUS) ont été retirées tant qu'aucun référentiel réel\n"
            "d'exposition ne les soutient. Le rapport se limite aux faits sourcés.\n"
        )
    )
    return f"""# Rapport de risque — {req.sector}

> **Scénario :** {s.risk} — évaluation à {_fmt_ts(req.timestamp)}
{exec_line}
## 1. Synthèse
{exec_sum}

## 2. Risque par catégorie
{chr(10).join(cat_blocks)}

## 3. Recommandations de mitigation
{mito}

## 4. Confiance & limites
{confidence_block}{hydro_block}
## {annexe_no}. Annexe — données brutes
| Indicateur | Valeur |
|---|---|
{appendix}
"""


def _md_to_html(md: str) -> str:
    """Mini-convertisseur markdown → html (sous-ensemble nécessaire)."""
    lines = md.splitlines()
    out: list[str] = []
    in_table = False
    thead_done = False

    def _close_table() -> None:
        nonlocal in_table, thead_done
        if in_table:
            out.append("</tbody></table>")
        in_table = False
        thead_done = False

    def _row(cells: list[str], header: bool) -> str:
        tag = "th" if header else "td"
        return f"<tr>{''.join(f'<{tag}>{html.escape(c)}</{tag}>' for c in cells)}</tr>"

    for raw in lines:
        line = raw.rstrip()
        if line.startswith("# "):
            _close_table()
            out.append(f"<h1>{html.escape(line[2:])}</h1>")
        elif line.startswith("## "):
            _close_table()
            out.append(f"<h2>{html.escape(line[3:])}</h2>")
        elif line.startswith("### "):
            _close_table()
            out.append(f"<h3>{html.escape(line[4:])}</h3>")
        elif line.startswith("> "):
            _close_table()
            inner = html.escape(line[2:])
            inner = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", inner)
            out.append(f"<blockquote>{inner}</blockquote>")
        elif line.startswith("|"):
            cells = [c.strip() for c in line.strip("|").split("|")]
            # Ligne de séparateur |---|---| → on ferme l'en-tête, on ouvre le corps.
            if cells and all(re.fullmatch(r"[-—–:]+", c or "-") for c in cells):
                if in_table and not thead_done:
                    out.append("</thead><tbody>")
                    thead_done = True
                continue
            if not in_table:
                out.append("<table><thead>")
                in_table = True
                thead_done = False
            out.append(_row(cells, header=not thead_done))
        else:
            _close_table()
            if line.strip() == "":
                continue
            styled = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", line)
            out.append(f"<p>{styled}</p>")
    _close_table()
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Orchestration non-stream (compat & tests)
# ---------------------------------------------------------------------------

async def generate_report(req: ReportRequest) -> ReportResponse:
    key = _cache_key(req)
    cached = _load_cache(key)
    if cached is not None:
        cached.cache_hit = True
        cached.meta = {**cached.meta, "cache_hit": True}
        return cached

    data = _build_report_data(req)

    from app.connectors.mistral import mistral_structured_json

    system, user = _mistral_io(req)
    try:
        raw = await mistral_structured_json(system, user)
    except Exception as exc:  # pragma: no cover - garde-fou large
        logger.warning("Mistral indisponible pour le rapport : %s", exc)
        raw = None
    llm = _validated_llm(raw, req)
    fallback_used = _llm_fallbacks_used(llm)
    resp = _assemble(req, data, llm, key, fallback_used)
    _save_cache(key, resp)
    return resp