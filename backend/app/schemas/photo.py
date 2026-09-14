"""Schéma des photos terrain (étape 2) — contrat GET /api/photo.

Une seule nature de fait ici, mais deux choses à ne jamais confondre :

  · `available = True`  — une photo RÉELLE du secteur existe : elle est
                          géolocalisée, datée, son producteur et sa licence sont
                          renvoyés pour être affichés (etalab-2.0) ;
  · `available = False` — le fonds ne couvre pas le point (ou le service est
                          indisponible) : `reason` / `label` le disent, et
                          AUCUNE image de remplacement n'est fournie.

`distance_m` et `facing_error_deg` sont les deux mesures qui rendent le choix
vérifiable : à quelle distance la photo a été prise, et de combien son
orientation s'écarte du point analysé (None = orientation inconnue).
`facing_ok` résume la seconde : False = c'est la photo la plus PROCHE, pas
celle qui regarde le point — l'UI le dit au lieu de le laisser croire.
"""

from __future__ import annotations

from pydantic import BaseModel


class SitePhotoOut(BaseModel):
    """Photo Panoramax la plus représentative d'un point (ou son absence)."""

    available: bool
    reason: str | None = None
    label: str | None = None
    candidates: int = 0
    id: str | None = None
    distance_m: float | None = None
    facing_ok: bool = False
    facing_error_deg: float | None = None
    view_azimuth: float | None = None
    captured_at: str | None = None
    thumb_url: str | None = None
    sd_url: str | None = None
    page_url: str | None = None
    producer: str | None = None
    licence: str | None = None
    source: str
    retrieved_at: str
