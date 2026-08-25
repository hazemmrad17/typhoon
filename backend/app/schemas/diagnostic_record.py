# =============================================================================
#   Contrat canonique du produit — DiagnosticRecord v1.0 (spec FR-17/FR-18)
#
#   Un enregistrement par bâtiment : aléas Géorisques × vulnérabilité BDNB,
#   avec provenance et résolution sur chaque fait. Faits uniquement :
#   aucun score, aucun niveau, aucune recommandation (constitution §2).
#
#   Garanties portées par le schéma lui-même :
#     - extra="forbid" : un champ interdit en entrée lève ValidationError
#     - résolution contrainte par code d'aléa (rga -> estimation communale ;
#       sismicite/radon -> communal décrétal)
#     - les optionnels d'un aléa sont TOUJOURS sérialisés (null) ; seule
#       exception explicite : `per_building`, absent sans test géométrique
# =============================================================================

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator
from typing_extensions import Annotated

SCHEMA_VERSION = "1.0"

AVERTISSEMENT_DEFAULT = (
    "Ce rapport agrège les données publiques Géorisques (BRGM / MTE). "
    "Il ne remplace pas l'État des Risques (ERRIAL) obligatoire à la vente/location."
)


class Resolution(str, Enum):
    """Qualité de résolution d'un fait — LE signal qualité du contrat."""

    PER_BUILDING = "per-building"
    COMMUNE_LEVEL = "commune-level"
    COMMUNE_LEVEL_ESTIMATE = "commune-level-estimate"


class PerBuildingMethod(str, Enum):
    POINT_IN_POLYGON = "point-in-polygon"
    PROXIMITY = "proximity"


class _Strict(BaseModel):
    """Base commune : tout champ inconnu est une erreur de contrat, pas un silence."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class PerBuilding(_Strict):
    """Résultat du test géométrique — présent uniquement si un test a eu lieu."""

    method: PerBuildingMethod
    radius_m: float | None = None
    count: int


class SourceProvenance(_Strict):
    """Bloc de provenance — satisfait l'obligation d'attribution LO 2.0
    (nom de la source + date de dernière mise à jour des données)."""

    provider: str
    url: str
    attribution: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
    recuperee_le: str


class AdresseBloc(_Strict):
    saisie: str
    normalisee: str
    citycode: str
    postcode: str | None = None
    city: str | None = None
    lat: float
    lon: float
    geocode_score: float | None = None


class AleaRecord(_Strict):
    """Un objet par aléa du référentiel Géorisques (13 au total)."""

    code: str
    libelle: str
    # FR-14 : true = test positif · false = test négatif · null = inconnu.
    # Jamais inféré depuis une source en échec.
    present: bool | None
    present_commune: bool | None = None
    zonage: str | None = None
    hauteur_eau_m: float | None = None
    zone_sismique: str | None = None
    catnat_historique: list[dict[str, Any]] | None = None
    per_building: PerBuilding | None = None
    source: str = "georisques"
    url_detail: str | None = None
    erreur: str | None = None
    resolution: Resolution

    @model_validator(mode="after")
    def _resolution_matches_code(self) -> "AleaRecord":
        # FR-12 : le RGA n'a pas de source vectorielle câblée en v1 —
        # toute autre valeur est un mensonge sur la résolution réelle.
        if self.code == "rga" and self.resolution is not Resolution.COMMUNE_LEVEL_ESTIMATE:
            raise ValueError(
                f"aléa 'rga' : resolution doit être 'commune-level-estimate' "
                f"(reçu '{self.resolution.value}')"
            )
        # FR-13 : zonages décrétaux, communaux par nature — pas un défaut.
        if self.code in {"sismicite", "radon"} and self.resolution is not Resolution.COMMUNE_LEVEL:
            raise ValueError(
                f"aléa '{self.code}' : resolution doit être 'commune-level' "
                f"(reçu '{self.resolution.value}')"
            )
        return self

    def model_dump(self, **kwargs: Any) -> dict[str, Any]:
        """Optionnels toujours présents (null) ; carve-out unique et explicite :
        `per_building` n'est sérialisé que si un test géométrique a eu lieu."""
        data = super().model_dump(**kwargs)
        if data.get("per_building") is None:
            data.pop("per_building", None)
        return data


class BdnbBloc(_Strict):
    """Passage verbatim de la fiche BDNB (FR-16) — jamais filtrée ni renommée.
    Sérialisée sous la clé `_source` (alias, convention du contrat)."""

    donnees: dict[str, Any]
    source: SourceProvenance = Field(validation_alias="_source", serialization_alias="_source")


class DiagnosticRecord(_Strict):
    """Le contrat. Huit clés racine, versionné, rien d'autre."""

    schema_version: str = SCHEMA_VERSION
    adresse: AdresseBloc
    aleas: list[AleaRecord]
    bdnb: BdnbBloc | None = None
    georisques_source: SourceProvenance
    erreurs_partielles: list[str] = []
    genere_le: str
    avertissement: str = AVERTISSEMENT_DEFAULT

    @field_validator("schema_version")
    @classmethod
    def _version_pinned(cls, value: str) -> str:
        if value != SCHEMA_VERSION:
            raise ValueError(f"schema_version supportée : {SCHEMA_VERSION} (reçu '{value}')")
        return value
