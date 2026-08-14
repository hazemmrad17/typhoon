"""
Contrats Pydantic de la Typhoon Partner API.

Volontairement distincts des dicts internes de `app.scoring.risk_model` :
ce module est le contrat public versionne consomme par les projets tiers,
il ne doit pas bouger juste parce qu'un champ interne de tracability
(_sources, _f_score, _v_score...) change cote moteur de scoring. La
traduction dict interne -> ce schema se fait dans `service.py`.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class AnalyzeRequest(BaseModel):
    address: str = Field(..., min_length=3, description="Adresse postale complete du bien a analyser")


class Address(BaseModel):
    input: str = Field(..., description="Adresse telle qu'envoyee dans la requete")
    label: str = Field(..., description="Adresse normalisee par le geocodeur")
    citycode: str
    postcode: str
    city: str
    lat: float
    lon: float


class Confidence(BaseModel):
    score: int = Field(..., description="0-100, independant du score de risque")
    niveau: str
    n_sources_disponibles: int
    n_sources_total: int


class Zone(BaseModel):
    risque: int = Field(..., description="0-100")
    niveau: str
    alea_principal: str
    justification: str
    recommandations: list[dict[str, Any]] = Field(default_factory=list)


class Hazard(BaseModel):
    label: str
    risque: int
    niveau: str
    justification: str


class RiskPeriod(BaseModel):
    score_global: int
    niveau_global: str
    zones: dict[str, Zone]
    risques_par_alea: dict[str, Hazard]


class TrajectoirePoint(BaseModel):
    horizon: int = Field(..., description="2026 (observe) / 2050 (projete) / 2100")
    type: str = Field(..., description="observe | projete | indisponible")
    scenario: str | None = Field(None, description="Etiquette RCP/SSP quand connue (ex. rcp8_5), sinon None")
    valeur: int | None = Field(None, description="Variable brute F 0-100, jamais combinee avec V ni avec d'autres perils")
    unite: str
    resolution: str | None = Field(None, description="per-building | commune-level | grid-cell")
    confiance: str | None = Field(None, description="elevee | moyenne | faible | None")
    source: str | None
    date_source: str | None = Field(None, description="Date de generation des donnees source, quand disponible")


class TrajectoirePeril(BaseModel):
    label: str
    points: list[TrajectoirePoint]


class Trajectoire(BaseModel):
    """Variables brutes par peril et par horizon — jamais combinees.

    C'est le contrat que l'actuaire attend (Phase 1 item 5) : il veut les
    variables d'alea F elles-memes, propres et etiquetees (horizon, scenario,
    resolution, provenance), pas un score composite. 2100 est expose comme
    "indisponible" tant que Copernicus CDS est desactive — jamais simule.
    """

    horizons: list[int]
    note: str
    perils: dict[str, TrajectoirePeril]


class AnalyzeResponse(BaseModel):
    adresse: Address
    score_global: int
    niveau_global: str
    confidence: Confidence
    zones: dict[str, Zone]
    risques_par_alea: dict[str, Hazard]
    projection_2050: RiskPeriod
    trajectoire: Trajectoire | None = Field(
        default=None,
        description="Variables brutes F par peril et par horizon (observe 2026 / projete 2050 / indisponible 2100), avec provenance",
    )
    erreurs_sources: list[dict[str, Any]] = Field(
        default_factory=list,
        description="Sources de collecte en erreur ou indisponibles pour cette adresse (ne bloque pas l'analyse)",
    )
    genere_le: str
