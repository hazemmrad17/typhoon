"""Schéma de l'aléa d'inondation TRI (étape 2) — contrat GET /api/flood-alea.

Le contrat sépare strictement trois natures d'information :

  · `available = True`        — le point tombe dans une CLASSE OFFICIELLE de
                                hauteur d'eau de la cartographie TRI (Directive
                                Inondation) : c'est un fait réglementaire ;
  · `available = False`       — aucune zone TRI au point. Hors TRI n'est PAS
                                « jamais inondé » : `reason` le dit, l'UI
                                retransmet ;
  · `scenario.present = null` — service indisponible : on ne sait pas, et la
                                raison est explicite.

Chaque scénario porte la bande [min_m, max_m[ de la classe (max_m = null pour
la bande ouverte « ≥ min »), le cours d'eau et l'identifiant TRI de la zone —
la provenance est sur chaque fait, la source (WFS Géorisques, Licence Ouverte
2.0) est citée au niveau racine.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class DepthBandOut(BaseModel):
    """Classe officielle de hauteur d'eau [min_m, max_m[ en mètres."""

    min_m: float = Field(..., ge=0, description="Borne basse, incluse")
    max_m: float | None = Field(None, ge=0, description="Borne haute, exclue (null = bande ouverte « ≥ min »)")
    label: str = Field(..., description="Libellé affichable, ex. « 0,5 – 1 m »")


class FloodScenarioOut(BaseModel):
    """État d'un scénario de la Directive Inondation au point analysé."""

    key: str = Field(..., description="frequent | moyen | extreme | faiable")
    label: str = Field(..., description="Libellé officiel, ex. « Moyen (~100 ans) »")
    present: bool | None = Field(..., description="True = classe TRI au point ; False = rien ; null = inconnu (service)")
    depth_band: DepthBandOut | None = None
    cours_deau: str | None = None
    id_tri: str | None = None


class FloodAleaOut(BaseModel):
    """Réponse GET /api/flood-alea — repère réglementaire de la simulation."""

    available: bool
    reason: str | None = None
    # Le point est-il dans le PÉRIMÈTRE d'un TRI (couche ms:LIMITETRI) ?
    #   True  — dans un TRI, mais aucune classe de hauteur à cet endroit ;
    #   False — dans aucun TRI ;
    #   None  — indéterminé (couche indisponible) : jamais présenté comme un
    #           « hors TRI » acquis.
    # Deux absences différentes, jamais confondues (cf. `reason`).
    in_tri: bool | None = Field(
        None,
        description="Appartenance au périmètre TRI : True/False/None (indéterminé)",
    )
    resolution: str = Field("per-building", description="Toujours per-building : test polygonal au point")
    scenarios: list[FloodScenarioOut] = Field(default_factory=list)
    source: str
    source_url: str | None = None
    retrieved_at: str
