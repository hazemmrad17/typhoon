"""
Test hors-ligne de la route GET /diagnostic/zone/building : fiche complète
par batiment_groupe_id (story A2 — clic sur une géométrie de la carte) +
risques bâtiment (story D2), réseau mocké.

Les tests précédents (end_to_end, gltf_builder, rapport_narratif) ont été
supprimés car ils dépendaient de modules supprimés lors du recentrage du
produit (scoring, digital_twin, recommandations).
"""

from __future__ import annotations

from unittest.mock import patch

import httpx

from app.main import app


# --- Données mockées ---

BDNB_BUILDING_BY_ID = {
    "batiment_groupe_id": "bdnb-bg-37031-ABCD-0001",
    "cle_interop_adr": "37031_1591_00026",
    "libelle_adr_principale_ban": "26 Rue Victor Hugo 37140 Bourgueil",
    "annee_construction": 1850,
    "nb_niveau": 2,
    "hauteur_mean": 5,
    "mat_mur_txt": "MEULIERE",
    "mat_toit_txt": "ARDOISES",
    "alea_argile": "Moyen",
    "classe_bilan_dpe": "F",
    "conso_5_usages_ep_m2": 420.0,
    "emission_ges_5_usages_m2": 55.2,
    "identifiant_dpe": "2301E000001",
    "date_reception_dpe": "2023-05-04",
    "nb_classe_bilan_dpe_e": 1,
    "nb_classe_bilan_dpe_f": 2,
}
BDNB_BUILDING_RISQUES = {
    "batiment_groupe_id": "bdnb-bg-37031-ABCD-0001",
    "alea_argile": "Moyen",
    "alea_radon": "Moyen",
    "alea_sismique": "Faible",
    "code_departement_insee": "37",
}


def _mock_handler(request: httpx.Request) -> httpx.Response:
    path = request.url.path
    if path.endswith("/v1/bdnb/donnees/batiment_groupe_complet"):
        requested = request.url.params.get("batiment_groupe_id", "")
        if requested and requested != "eq.bdnb-bg-37031-ABCD-0001":
            return httpx.Response(200, json=[])  # id inconnu -> 404 côté route
        return httpx.Response(200, json=[BDNB_BUILDING_BY_ID])
    if path.endswith("/v1/bdnb/donnees/batiment_groupe_risques"):
        return httpx.Response(200, json=[BDNB_BUILDING_RISQUES])
    raise AssertionError(f"URL non geree par le mock : {request.url}")


def test_diagnostic_zone_building():
    """GET /diagnostic/zone/building : fiche complète par batiment_groupe_id
    (story A2 — clic sur une géométrie de la carte) — batiment_groupe_complet
    + risques bâtiment argile/radon/sismique (story D2), réseau mocké."""
    from fastapi.testclient import TestClient

    real_async_client = httpx.AsyncClient

    def patched_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(_mock_handler)
        return real_async_client(*args, **kwargs)

    with patch(
        "app.api.routes.diagnostic.httpx.AsyncClient", side_effect=patched_client
    ):
        with TestClient(app) as client:
            resp = client.get(
                "/diagnostic/zone/building",
                params={"id": "bdnb-bg-37031-ABCD-0001"},
            )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["batiment"]["batiment_groupe_id"] == "bdnb-bg-37031-ABCD-0001"
    # La fiche contient de quoi alimenter le panneau (identité + DPE officiel C4)
    assert body["batiment"]["identifiant_dpe"] == "2301E000001"
    assert body["batiment"]["nb_classe_bilan_dpe_f"] == 2
    # Niveaux de risque bâtiment (story D2)
    assert body["risques"]["alea_argile"] == "Moyen"
    assert body["risques"]["alea_radon"] == "Moyen"
    assert body["risques"]["alea_sismique"] == "Faible"

    # Identifiant inconnu -> 404 structuré (jamais de plantage côté carte)
    with patch(
        "app.api.routes.diagnostic.httpx.AsyncClient", side_effect=patched_client
    ):
        with TestClient(app) as client:
            resp = client.get(
                "/diagnostic/zone/building",
                params={"id": "bdnb-bg-0000-0000-0000"},
            )
    assert resp.status_code == 404, resp.text
