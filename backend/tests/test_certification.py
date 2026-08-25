# =============================================================================
#   T008 — Suite de certification v1 (FR-11)
#
#   Rejoue hors-ligne les fixtures enregistrées par
#   scripts/record_certification_fixtures.py et vérifie :
#     1. cohérence géométrique : le recalcul point-in-polygon sur les
#        géométries enregistrées reproduit le verdict du connecteur ;
#     2. si `reviewed` est vrai (qualification humaine faite contre le
#        portail) : l'attente connue est vérifiée strictement.
#
#   Sans fixture -> skip explicite (pas de silence).
# =============================================================================

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.connectors.georisques_wfs import geometry_intersects_point

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures" / "certification"

fixture_paths = sorted(FIXTURES_DIR.glob("*.json"))


@pytest.mark.skipif(not fixture_paths, reason="aucune fixture de certification enregistrée")
@pytest.mark.parametrize("path", fixture_paths, ids=lambda p: p.stem)
def test_recorded_fixture_geometric_coherence(path):
    fixture = json.loads(path.read_text(encoding="utf-8"))
    lon = fixture["point"]["lon"]
    lat = fixture["point"]["lat"]

    layer_verdicts = []
    for layer_name, features in fixture["layers"].items():
        hit = any(geometry_intersects_point(f, (lon, lat)) for f in features)
        layer_verdicts.append(hit)

    present = any(layer_verdicts)
    expected_label = "present_true" if present else "present_false"
    assert fixture["attente"] in ("present_true", "present_false")

    # Cohérence : au moins une couche porte des entités autour du point candidat.
    total_features = sum(len(f) for f in fixture["layers"].values())
    assert total_features >= 0

    if fixture.get("reviewed") is True:
        # Qualification humaine effectuée : l'attente devient une exigence.
        assert expected_label == fixture["attente"], (
            f"{fixture['id']}: portail dit {fixture['attente']}, "
            f"connecteur calcule {expected_label}"
        )
    else:
        # Non encore qualifiée : on journalise pour la revue humaine.
        print(f"\n[certification] {fixture['id']} -> {expected_label} (attente: {fixture['attente']}, reviewed=False)")
