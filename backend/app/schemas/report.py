"""Schémas du rapport de risque (étape 3) — contrat POST /api/report.

L'entrée est la sortie structurée de l'étape 2 (DamageEstimate + scénario
sélectionné, calculés côté frontend par damageModel.ts) + l'identité du
secteur. La sortie est le rapport rendu (markdown + html) avec les niveaux
de risque par catégorie (déterministes) et les actions de mitigation retenues.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class RangeModel(BaseModel):
    """Estimation + fourchette d'incertitude (mêmes clés que damageModel.ts)."""

    v: float
    low: float
    high: float


class ScenarioModel(BaseModel):
    key: str
    pct: int
    risk: str
    windPeakKmh: float = 0.0
    rainPeakMmH: float = 0.0
    depthPeakM: float = 0.0


class DamageModel(BaseModel):
    brokenTrees: RangeModel
    damagedVehicles: RangeModel
    downedPowerLines: RangeModel
    floodedConduitM: RangeModel
    damagedBuildings: RangeModel
    damagedRoadsM: RangeModel
    waterLevelFt: RangeModel
    damageEUR: RangeModel
    damageUSD: RangeModel
    hp: RangeModel


class HydroBasinModel(BaseModel):
    """Bassin versant topographique (BD TOPO) — réel, jamais inventé."""

    libelle: str | None = None
    toponyme: str | None = None
    group_libelle: str | None = None
    area_km2: float | None = None


class HydroModel(BaseModel):
    """Trajet de l'eau RÉEL : parcours reconstruit sur le réseau
    hydrographique IGN BD TOPO (amont vers le bassin versant, aval vers
    l'exutoire).

    Ce bloc ne porte que des faits sourcés (nom du cours d'eau, distances
    parcourues, raison d'arrêt, fourchette d'arrivée cinématique) — aucune
    hydraulique n'est revendiquée. Absent → rapport identique à celui d'avant
    et clé de cache inchangée.
    """

    watercourse: str | None = Field(None, description="Nom du cours d'eau (cours_d_eau.toponyme)")
    snap_distance_m: float | None = Field(None, description="Distance du point diagnostiqué au segment")
    basin: HydroBasinModel | None = None
    upstream_km: float = 0.0
    downstream_km: float = 0.0
    upstream_stop: str | None = Field(None, description="Raison d'arrêt amont (ex. Exutoire)")
    downstream_stop: str | None = Field(None, description="Raison d'arrêt aval (ex. Perte)")
    arrival_min_hours: float | None = None
    arrival_max_hours: float | None = None
    sources: dict[str, str] = Field(default_factory=dict)


class ReportRequest(BaseModel):
    sector: str = Field(..., description="Nom de la zone / adresse diagnostiquée")
    scenario: ScenarioModel
    timestamp: str = Field(..., description="Instant t de l'évaluation (ISO 8601)")
    damage: DamageModel
    # Optionnel : trajet de l'eau réel (géographie IGN BD TOPO). Absent →
    # rapport identique à aujourd'hui (aucun événement hydro_* n'est émis, la
    # clé de cache ne change pas).
    hydro: HydroModel | None = None


class CategoryRiskOut(BaseModel):
    category: str
    label: str
    risk_level: str          # High | Moderate | Low
    value: float
    unit: str


class MitigationOut(BaseModel):
    id: str
    category: str
    text: str
    trigger: str


class ReportResponse(BaseModel):
    markdown: str
    html: str
    executive_summary: str
    category_risk_levels: list[CategoryRiskOut]
    mitigations: list[MitigationOut]
    cache_hit: bool
    fallback_used: bool
    meta: dict
    # Prose LLM validée, stockée pour rejouer les patches en flux (cache inclus).
    # Forme : {"executiveSummary": str, "categoryNarratives": {cat: str},
    #          "mitigationNarratives": {actionId: str}}
    narratives: dict = Field(default_factory=dict)


class ReportStreamEvent(BaseModel):
    """Événement SSE du flux de rapport (étape 3).

    type : header | summary | category | mitigations | confidence | appendix
           | patch | done
    data : dict payload propre à chaque type (sérialisé tel quel en JSON).
    """

    type: str
    data: dict