"""Schémas du trajet de l'eau (étape 2) — contrat GET /api/hydro.

Deux natures de faits, deux routes, jamais confondues :

  · `GET /api/hydro`        — géographie RÉELLE du réseau hydrographique
                              (IGN BD TOPO) : accrochage, amont, aval, bassin
                              versant, profil en long, temps de propagation.
  · `GET /api/meteo`        — référence RÉELLE météo/hydrologique
                              (Open-Meteo / GloFAS) : pluie prévue, débit.

Tout champ est optionnel côté contenu : un service indisponible remplit
`unavailable_reason` / `unavailable_label` et laisse les sections nulles,
plutôt que d'inventer une valeur.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class HydroStopOut(BaseModel):
    """Pourquoi un parcours s'est arrêté (exutoire, perte, budget…)."""

    reason: str
    label: str
    node: str | None = None


class HydroProfilePointOut(BaseModel):
    km: float
    z_m: float


class HydroStretchOut(BaseModel):
    """Portion de cours d'eau reconstruite (amont ou aval)."""

    direction: str
    length_km: float
    segments: int
    geometry: dict | None = None
    profile: list[HydroProfilePointOut] = Field(default_factory=list)
    has_more: bool = False
    cursor: str | None = None
    requests: int = 0
    stop: HydroStopOut
    start_point: list[float] | None = None
    end_point: list[float] | None = None


class HydroBasinOut(BaseModel):
    """Bassin versant contributeur (une requête, polygone réel).

    Les bassins BD TOPO sont emboîtés : `libelle`/`toponyme` décrivent le
    bassin LOCAL (aire minimale contenante), `group_libelle` le rattachement
    hydrographique plus vaste (ex. « Seine-Normandie »).
    """

    libelle: str | None = None
    toponyme: str | None = None
    code: str | None = None
    area_km2: float | None = None
    group_libelle: str | None = None
    geometry: dict | None = None


class HydroArrivalOut(BaseModel):
    """Temps de propagation depuis l'amont — estimation cinématique bornée."""

    min_hours: float
    max_hours: float
    celerity_min_m_s: float
    celerity_max_m_s: float
    note: str


class HydroRouteOut(BaseModel):
    lat: float
    lon: float
    watercourse: str | None = None
    watercourse_importance: str | None = None
    snap_distance_m: float | None = None
    segments_nearby: int = 0
    basin: HydroBasinOut | None = None
    upstream: HydroStretchOut | None = None
    downstream: HydroStretchOut | None = None
    arrival: HydroArrivalOut | None = None
    sources: dict[str, str] = Field(default_factory=dict)
    retrieved_at: str | None = None
    unavailable_reason: str | None = None
    unavailable_label: str | None = None


class MeteoPointOut(BaseModel):
    t: str
    v: float | None = None


class DischargeOut(BaseModel):
    unit: str = "m³/s"
    series: list[MeteoPointOut] = Field(default_factory=list)
    mean: list[float | None] = Field(default_factory=list)
    max: list[float | None] = Field(default_factory=list)
    current: float | None = None
    peak: float | None = None
    peak_date: str | None = None
    elevation_m: float | None = None


class MeteoOut(BaseModel):
    lat: float
    lon: float
    rain_hourly: list[MeteoPointOut] = Field(default_factory=list)
    rain_total_mm: float | None = None
    rain_peak_mm_h: float | None = None
    dry: bool | None = None
    discharge: DischargeOut | None = None
    sources: dict[str, str] = Field(default_factory=dict)
    retrieved_at: str | None = None
    unavailable_reason: str | None = None
    unavailable_label: str | None = None
