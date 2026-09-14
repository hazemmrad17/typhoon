"""Tests de l'étape 3 — agent de rapport (déterminisme, cache, ancrage, flux).

Couvre les exigences du plan :
  · mêmes entrées → sortie identique (cache + déterminisme) ;
  · prose LLM ancrée : nombre halluciné ou action inconnue → rejet / repli
    template (aucun contenu inventé) ;
  · estimation nulle → aucune action de mitigation (section « Aucune… ») ;
  · flux SSE : sections déterministes en premier, prose validée en « patch »,
    cache rejoué à l'identique.
"""

from __future__ import annotations

import json

import pytest

import app.connectors.mistral as mistral_conn
from app.schemas.report import (
    DamageModel,
    HydroBasinModel,
    HydroModel,
    RangeModel,
    ReportRequest,
    ScenarioModel,
)
from app.services import report_agent


def _range(v: float, spread: float = 0.28) -> RangeModel:
    return RangeModel(v=v, low=max(0.0, v * (1 - spread)), high=v * (1 + spread))


def _damage() -> DamageModel:
    return DamageModel(
        brokenTrees=_range(1.0),
        damagedVehicles=_range(4.0),
        downedPowerLines=_range(0.07),
        floodedConduitM=_range(295.0),
        damagedBuildings=_range(0.6),
        damagedRoadsM=_range(210.0),
        waterLevelFt=_range(2.6),
        damageEUR=_range(408_700.0),
        damageUSD=_range(441_396.0),
        hp=_range(3.0),
    )





def _request(sector: str = "8 Boulevard de Sébastopol 75004 Paris") -> ReportRequest:
    return ReportRequest(
        sector=sector,
        scenario=ScenarioModel(
            key="extreme",
            risk="EXTREME — ~500 ans",
            depthPeakM=1.1,
        ),
        timestamp="2026-09-09T15:00:00",
        damage=_damage(),
    )


def _hydro_request(sector: str = "8 Boulevard de Sébastopol 75004 Paris") -> ReportRequest:
    """Même secteur/scénario que _request, avec un trajet de l'eau réel."""
    req = _request(sector)
    req.hydro = HydroModel(
        watercourse="Bras de la Monnaie",
        snap_distance_m=91.0,
        basin=HydroBasinModel(
            libelle="La Seine du confluent de la Bièvre à la mer",
            toponyme="La Seine",
            group_libelle="Seine-Normandie",
            area_km2=48_900.0,
        ),
        upstream_km=1.4,
        downstream_km=39.0,
        upstream_stop="confluent",
        downstream_stop="exutoire",
        arrival_min_hours=4.5,
        arrival_max_hours=9.0,
        sources={"network": "IGN BD TOPO V3 (troncon_hydrographique)"},
    )
    return req


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    """Isolate le cache et l'appel Mistral pour tous les tests."""
    monkeypatch.setattr(report_agent, "CACHE_DIR", tmp_path)


@pytest.mark.asyncio
async def test_report_deterministic_and_cached(tmp_path, monkeypatch):
    """Deux appels identiques → sortie identique ; le second est servi par le cache."""
    llm = {
        "executiveSummary": "Risque élevé estimé à 408 700 € pour ce secteur.",
        "categoryNarratives": [],
        "mitigationNarratives": [],
    }

    async def _fake(_s, _u) -> dict | None:
        return llm

    monkeypatch.setattr(mistral_conn, "mistral_structured_json", _fake)
    r1 = await report_agent.generate_report(_request())
    r2 = await report_agent.generate_report(_request())

    assert r1.markdown == r2.markdown
    assert r1.html == r2.html
    assert r1.cache_hit is False
    assert r2.cache_hit is True
    assert r1.meta["cache_key"] == r2.meta["cache_key"]


@pytest.mark.asyncio
async def test_fallback_without_llm(tmp_path, monkeypatch):
    """Sans prose LLM (appel None) → rapport complet, template, fallback_used."""
    async def _none(_s, _u) -> dict | None:
        return None

    monkeypatch.setattr(mistral_conn, "mistral_structured_json", _none)
    resp = await report_agent.generate_report(_request())
    assert resp.fallback_used is True
    assert "Rapport de risque" in resp.markdown
    assert "1. Synthèse" in resp.markdown
    assert "409 k€" in resp.markdown  # dommages du payload (format compact)
    assert "3. Recommandations de mitigation" in resp.markdown
    assert "5. Annexe" in resp.markdown
    # Niveaux de risque déterministes : structure/route/conduite = Moderate, élec/végétation = Low
    levels = {c.category: c.risk_level for c in resp.category_risk_levels}
    assert levels["structural"] == "Moderate"
    assert levels["road"] == "Moderate"
    assert levels["conduit"] == "Moderate"
    assert levels["power"] == "Low"
    assert levels["vegetation"] == "Low"


@pytest.mark.asyncio
async def test_mitigation_selection_matches_thresholds(tmp_path, monkeypatch):
    """Les actions retenues correspondent exactement aux seuils franchis."""
    async def _none(_s, _u) -> dict | None:
        return None

    monkeypatch.setattr(mistral_conn, "mistral_structured_json", _none)
    resp = await report_agent.generate_report(_request())
    ids = {m.id for m in resp.mitigations}
    assert {"elevate_panels", "backflow_valves", "predeploy_pumps", "flood_barriers"} == ids
    assert "line_hardening" not in ids  # downedPowerLines (0.07) < 0.3
    assert "retrofit_review" not in ids  # damagedBuildings (0.6) < 1.5


@pytest.mark.asyncio
async def test_grounding_rejects_hallucinated_number(tmp_path, monkeypatch):
    """Un nombre absent du payload dans la prose LLM → narrative rejetée (repli template)."""
    llm = {
        "executiveSummary": "Les dommages atteignent 999 999 999 €, valeur absente des données.",
        "categoryNarratives": [],
        "mitigationNarratives": [],
    }

    async def _fake(_s, _u) -> dict | None:
        return llm

    monkeypatch.setattr(mistral_conn, "mistral_structured_json", _fake)
    resp = await report_agent.generate_report(_request())
    # Le 999 999 999 n'est pas ancré → synthèse template (qui contient 409 k€).
    assert "409 k€" in resp.executive_summary
    assert "999 999 999" not in resp.markdown


@pytest.mark.asyncio
async def test_unknown_action_rejected(tmp_path, monkeypatch):
    """Un actionId hors taxonomie dans la prose LLM est rejeté (n'apparaît nulle part)."""
    llm = {
        "executiveSummary": None,
        "categoryNarratives": [],
        "mitigationNarratives": [
            {"actionId": "not_a_real_action", "narrative": "Action inventée hors taxonomie."}
        ],
    }

    async def _fake(_s, _u) -> dict | None:
        return llm

    monkeypatch.setattr(mistral_conn, "mistral_structured_json", _fake)
    resp = await report_agent.generate_report(_request())
    ids = {m.id for m in resp.mitigations}
    assert "not_a_real_action" not in ids
    assert "Action inventée" not in resp.markdown


@pytest.mark.asyncio
async def test_zero_damage_no_mitigations(tmp_path, monkeypatch):
    """Estimation nulle → aucune action déclenchée, section « Aucune… » (rien d'inventé)."""
    zero = _request("Secteur vierge")
    zero.damage = DamageModel(
        brokenTrees=_range(0),
        damagedVehicles=_range(0),
        downedPowerLines=_range(0),
        floodedConduitM=_range(0),
        damagedBuildings=_range(0),
        damagedRoadsM=_range(0),
        waterLevelFt=_range(0),
        damageEUR=_range(0),
        damageUSD=_range(0),
        hp=_range(0),
    )

    async def _none(_s, _u) -> dict | None:
        return None

    monkeypatch.setattr(mistral_conn, "mistral_structured_json", _none)
    resp = await report_agent.generate_report(zero)
    assert resp.mitigations == []
    assert "Aucune action de mitigation" in resp.markdown
    assert all(c.risk_level == "Low" for c in resp.category_risk_levels)


# ---------------------------------------------------------------------------
# Flux SSE
# ---------------------------------------------------------------------------

async def _collect_stream(request: ReportRequest, monkeypatch, llm_fragments=None):
    # report_agent a lié mistral_stream_json à l'import → patcher la référence
    # du module, pas celle du connecteur. Valeur par défaut : aucun fragment
    # (utile pour tester le cache, qui ne rappelle jamais Mistral).
    fragments = llm_fragments if llm_fragments is not None else []

    async def _fake_stream(_s, _u):
        for frag in fragments:
            yield frag

    monkeypatch.setattr(report_agent, "mistral_stream_json", _fake_stream)
    events = []
    async for ev in report_agent.stream_report(request):
        events.append(json.loads(ev))
    return events


def _by_type(events: list[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for ev in events:
        out.setdefault(ev["type"], []).append(ev["data"])
    return out


@pytest.mark.asyncio
async def test_stream_emits_sections_then_done(tmp_path, monkeypatch):
    """Le flux émet toutes les sections déterministes + done, dans l'ordre attendu."""
    events = await _collect_stream(_request(), monkeypatch, llm_fragments=None)
    by_type = _by_type(events)
    order = [e["type"] for e in events]

    assert order[0] == "header"
    assert order[-1] == "done"
    assert "summary" in by_type
    assert len(by_type["category"]) == 5
    assert "mitigations" in by_type
    assert "confidence" in by_type
    assert "appendix" in by_type
    assert order.index("done") > order.index("appendix")
    assert by_type["done"][0]["fallback_used"] is True
    assert by_type["header"][0]["sector"] == _request().sector


@pytest.mark.asyncio
async def test_stream_patches_validated_llm(tmp_path, monkeypatch):
    """Avec une prose LLM ancrée, le flux émet des « patch » ; un nombre halluciné est rejeté."""
    grounded = json.dumps(
        {
            "executiveSummary": "Risque élevé : 408 700 € de dommages estimés.",
            "categoryNarratives": [],
            "mitigationNarratives": [],
        }
    )
    events = await _collect_stream(
        _request(), monkeypatch, llm_fragments=[grounded]
    )
    patches = [e["data"] for e in events if e["type"] == "patch"]
    assert any(p["field"] == "exec" for p in patches)

    # Fragments hallucinés → aucun patch.
    hallucinated = json.dumps(
        {
            "executiveSummary": "Dommages de 999 999 999 € totalement absents.",
            "categoryNarratives": [],
            "mitigationNarratives": [],
        }
    )
    # Secteur distinct pour éviter un hit de cache (sinon on rejouerait le patch ancré).
    events2 = await _collect_stream(
        _request("Secteur halluciné"), monkeypatch, llm_fragments=[hallucinated]
    )
    assert all(e["type"] != "patch" for e in events2)


@pytest.mark.asyncio
async def test_stream_cache_replay(tmp_path, monkeypatch):
    """Après un premier flux, un second flux (cache) rejoue des sections + done, pas de patch LLM."""
    grounded = json.dumps(
        {
            "executiveSummary": "Risque élevé : 408 700 € de dommages estimés.",
            "categoryNarratives": [],
            "mitigationNarratives": [],
        }
    )
    events1 = await _collect_stream(_request(), monkeypatch, llm_fragments=[grounded])
    # Le second appel devrait servir le cache (pas de nouvel appel Mistral).
    events2 = await _collect_stream(_request(), monkeypatch, llm_fragments=None)

    by_type1 = _by_type(events1)
    by_type2 = _by_type(events2)
    assert any(e["type"] == "patch" for e in events1)
    # Le cache rejoue la prose LLM validée sous forme de patch (narratives stockées).
    assert any(e["type"] == "patch" for e in events2)
    assert by_type2["done"][0]["meta"]["cache_hit"] is True
    # Contenu identique entre premier flux et rejeu.
    patch_vals1 = {p["value"] for p in by_type1["patch"]}
    patch_vals2 = {p["value"] for p in by_type2["patch"]}
    assert patch_vals1 == patch_vals2


# ---------------------------------------------------------------------------
# Trajet de l'eau (géographie réelle IGN BD TOPO) — étape 2 → rapport
# ---------------------------------------------------------------------------

async def _no_llm(monkeypatch) -> None:
    """Aucune prose LLM : le rapport reste complet en mode template."""

    async def _none(_s, _u) -> dict | None:
        return None

    monkeypatch.setattr(mistral_conn, "mistral_structured_json", _none)


@pytest.mark.asyncio
async def test_hydro_streams_its_own_sections(tmp_path, monkeypatch):
    """Un trajet ajoute ses sections déterministes, après l'annexe et avant
    « done », avec les faits de géographie tels quels (rien d'inventé)."""
    events = await _collect_stream(_hydro_request(), monkeypatch, llm_fragments=None)
    by_type = _by_type(events)
    order = [e["type"] for e in events]

    head = by_type["hydro_header"][0]
    assert head["watercourse"] == "Bras de la Monnaie"
    assert head["basin_libelle"] == "La Seine du confluent de la Bièvre à la mer"
    assert head["downstream_km"] == 39.0
    assert head["downstream_stop"] == "exutoire"
    assert head["source"].startswith("IGN BD TOPO")

    summary = by_type["hydro_summary"][0]
    assert "Bras de la Monnaie" in summary["summary"]
    assert summary["basin_area_km2"] == 48_900.0
    assert "91" in summary["summary"]

    # Aucun second moteur : les niveaux de risque et mitigations officiels
    # restent la seule vérité de dommages.
    assert "hydro_categories" not in by_type
    assert "hydro_mitigations" not in by_type
    assert order.index("appendix") < order.index("hydro_header") < order.index("done")


@pytest.mark.asyncio
async def test_without_hydro_nothing_changes(tmp_path, monkeypatch):
    """Sans trajet : aucun événement hydro_*, numérotation et contenu
    inchangés (non-régression stricte)."""
    await _no_llm(monkeypatch)

    events = await _collect_stream(_request("Secteur témoin"), monkeypatch)
    assert not any(e["type"].startswith("hydro_") for e in events)

    resp = await report_agent.generate_report(_request("Secteur témoin"))
    assert "5. Annexe" in resp.markdown
    assert "6. Annexe" not in resp.markdown
    assert "Trajet de l'eau" not in resp.markdown
    assert "| Indicateur | Valeur |" in resp.markdown
    # Déterminisme : même requête → même document.
    again = await report_agent.generate_report(_request("Secteur témoin"))
    assert again.markdown == resp.markdown
    assert again.html == resp.html


@pytest.mark.asyncio
async def test_hydro_markdown_and_cache_isolation(tmp_path, monkeypatch):
    """Le trajet entre dans la clé de cache et produit sa propre section ;
    le rapport officiel du même secteur n'est pas contaminé."""
    await _no_llm(monkeypatch)

    plain = await report_agent.generate_report(_request("Secteur A"))
    hydro = await report_agent.generate_report(_hydro_request("Secteur A"))

    assert plain.meta["cache_key"] != hydro.meta["cache_key"]
    assert "5. Trajet de l'eau — Bras de la Monnaie" in hydro.markdown
    assert "6. Annexe" in hydro.markdown
    assert "l'exutoire du cours d'eau" in hydro.markdown
    assert "Trajet de l'eau" not in plain.markdown

    # Deux lectures identiques du trajet → servi par le cache, à l'identique.
    hydro2 = await report_agent.generate_report(_hydro_request("Secteur A"))
    assert hydro2.cache_hit is True
    assert hydro2.markdown == hydro.markdown


@pytest.mark.asyncio
async def test_hydro_summary_rejects_hallucinated_number(tmp_path, monkeypatch):
    """La prose de la section trajet est ancrée comme les autres : un nombre
    absent du payload est rejeté, et le template reprend la main."""
    grounded = json.dumps(
        {
            "executiveSummary": None,
            "categoryNarratives": [],
            "mitigationNarratives": [],
            "hydroSummary": (
                "Le point se rattache au Bras de la Monnaie, à 91 m du tracé "
                "cartographié, dont le parcours aval descend 39 km."
            ),
        }
    )
    events = await _collect_stream(
        _hydro_request("Secteur ancré"), monkeypatch, llm_fragments=[grounded]
    )
    hydro_patches = [
        e["data"]
        for e in events
        if e["type"] == "patch" and e["data"]["field"] == "hydro"
    ]
    assert len(hydro_patches) == 1
    assert "Bras de la Monnaie" in hydro_patches[0]["value"]

    hallucinated = json.dumps(
        {
            "executiveSummary": None,
            "categoryNarratives": [],
            "mitigationNarratives": [],
            "hydroSummary": "Le cours d'eau traverse 9 999 999 km jusqu'à la mer.",
        }
    )
    events2 = await _collect_stream(
        _hydro_request("Secteur halluciné"), monkeypatch, llm_fragments=[hallucinated]
    )
    assert not any(
        e["type"] == "patch" and e["data"]["field"] == "hydro" for e in events2
    )
    # Le repli template est ancré sur la même donnée (39 km en aval).
    summary = [e["data"] for e in events2 if e["type"] == "hydro_summary"][0]
    assert "39" in summary["summary"]

# ---------------------------------------------------------------------------
# Absence de classe TRI ≠ « pic d'eau 0,0 m »
#
# `depthPeakM == 0` signifie « aucune classe cartographiée au point ». Imprimer
# « 0,0 m » faisait passer une absence de donnée pour une mesure — ce que
# l'invariant « faits + provenance » interdit dans les deux sens (ni chiffre
# inventé, ni absence déguisée en chiffre).
# ---------------------------------------------------------------------------


def _request_without_tri_class() -> ReportRequest:
    req = _request()
    req.scenario = ScenarioModel(
        key="extreme",
        risk="EXTREME — ~500 ans",
        depthPeakM=0.0,
    )
    req.damage = None
    return req


def test_unmapped_class_never_prints_zero_depth():
    req = _request_without_tri_class()
    summary = report_agent._exec_summary_template(req)
    appendix = report_agent._appendix_rows(req)

    assert "0.0 m" not in summary
    assert "0,0 m" not in summary
    assert "AUCUNE classe de hauteur d'eau n'est cartographiée" in summary
    # Le garde-fou de sens est explicite : hors TRI ≠ jamais inondé.
    assert "jamais inondé" in summary

    flat = [f"{k} : {v}" for k, v in appendix]
    assert not any("0.0 m" in row for row in flat)
    assert any("non cartographiée au point" in row for row in flat)


def test_unmapped_class_says_dans_un_tri_when_the_point_is_in_one():
    """Mesuré à Orléans (3 quai du Châtelet) et Lyon (10 quai Victor Augagneur) :
    le point est DANS le périmètre d'un TRI, sans classe de hauteur à cet
    emplacement. Le rapport ne doit pas lui coller « hors TRI »."""
    req = _request_without_tri_class()
    req.scenario = ScenarioModel(
        key="extreme", risk="EXTREME — ~500 ans", depthPeakM=0.0, inTri=True
    )
    summary = report_agent._exec_summary_template(req)
    appendix = report_agent._appendix_rows(req)

    assert "DANS le périmètre d'un TRI" in summary
    assert "hors TRI" not in summary
    assert any("dans un TRI" in row for row in [f"{k} : {v}" for k, v in appendix])


def test_unmapped_class_says_hors_tri_only_when_it_is_true():
    req = _request_without_tri_class()
    req.scenario = ScenarioModel(
        key="extreme", risk="EXTREME — ~500 ans", depthPeakM=0.0, inTri=False
    )
    summary = report_agent._exec_summary_template(req)
    appendix = report_agent._appendix_rows(req)

    assert "Hors TRI n'équivaut pas" in summary
    assert "DANS le périmètre d'un TRI" not in summary
    assert any("(hors TRI)" in row for row in [f"{k} : {v}" for k, v in appendix])


def test_unmapped_class_with_unknown_perimeter_does_not_claim_hors_tri():
    """Sans vérification du périmètre, ni « hors TRI » ni « dans un TRI »."""
    req = _request_without_tri_class()
    summary = report_agent._exec_summary_template(req)
    appendix = report_agent._appendix_rows(req)

    assert "n'a pas pu être vérifiée" in summary
    assert "DANS le périmètre d'un TRI" not in summary
    assert any("non vérifiée" in row for row in [f"{k} : {v}" for k, v in appendix])


def test_mapped_class_still_prints_its_depth():
    req = _hydro_request()
    req.damage = None
    summary = report_agent._exec_summary_template(req)
    appendix = report_agent._appendix_rows(req)

    assert "1.1 m" in summary
    assert any("1.1 m" in v for _, v in appendix)
