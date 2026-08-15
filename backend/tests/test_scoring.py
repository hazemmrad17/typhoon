"""
Tests unitaires pour le moteur de scoring (risk_model), avec données mockées.

Inspirés de test_collector_offline.py : pas d'appels réseau réels,
que des données synthétiques calquées sur les formats réels.

Note (2026-08-14) : les tests `zone_scoring` / `promoteur_report` ont été
supprimés — ces modules (l'ancien backend zone en grille) ont été délibérément
supprimés dans 499b53a au profit du flux adresse->BAN->Géorisques->RisqueReport.
"""

from __future__ import annotations

from app.scoring.risk_model import ZONE_NAMES, _niveau, compute_risk_scores


# ---------------------------------------------------------------------------
#   Données mockées
# ---------------------------------------------------------------------------

def _building_data_factice(
    altitude: float | None = 25.0,
    zone_sismique: str | None = "1",
    alerte_argiles: str | None = None,
    alerte_inondation: str | None = None,
    nb_catnat_inondation: int = 0,
    annee_construction: int | None = 1990,
    materiau_structure: str | None = "beton",
    jours_chaleur: float | None = 20.0,
    precip_proj: float | None = 700.0,
    nb_niveau_sous_sol: int = 0,
) -> dict:
    """Génère un building_data factice pour les tests."""
    catnat_data = []
    for i in range(nb_catnat_inondation):
        catnat_data.append({"libelle_catnat": f"Inondation #{i} crue"})

    risques_commune = {}
    if alerte_argiles:
        risques_commune["argiles"] = {"alerte": alerte_argiles}
    if alerte_inondation:
        risques_commune["gazella"] = {"alerte": alerte_inondation}

    bdnb_base = {}
    if annee_construction is not None:
        bdnb_base["annee_construction"] = annee_construction
    if materiau_structure is not None:
        bdnb_base["materiau_structure"] = materiau_structure
    bdnb_base["nb_niveau_sous_sol"] = nb_niveau_sous_sol

    return {
        "adresse": {
            "label": "10 Rue Test, 75000 Paris",
            "lat": 48.8566,
            "lon": 2.3522,
            "citycode": "75056",
        },
        "altitude_m": altitude,
        "bdnb": {"batiment": bdnb_base, "cle_interop_adr": "75056_001_00010"},
        "georisques": {
            "risques_commune": risques_commune,
            "catnat": {"data": catnat_data},
            "zonage_sismique": {"zone_sismique": zone_sismique} if zone_sismique else {},
            "cavites": None,
        },
        "climat_open_meteo": {
            "reference_2015_2024": {
                "temperature_max_moyenne_c": 18.5,
                "jours_chaleur_extreme_par_an": jours_chaleur,
            },
            "projection_2041_2050": {
                "temperature_max_moyenne_c": 22.1,
                "jours_chaleur_extreme_par_an": jours_chaleur * 1.5 if jours_chaleur else None,
                "precipitation_annuelle_moyenne_mm": precip_proj,
            },
        },
        "departement": "75",
        "dans_perimetre_paca": False,
    }


# ---------------------------------------------------------------------------
#   Tests _niveau
# ---------------------------------------------------------------------------

def test_niveau():
    # D03 : cinq bandes alignees sur le Risk Engine (rules/_common.yaml)
    assert _niveau(0) == "tres faible"
    assert _niveau(19) == "tres faible"
    assert _niveau(20) == "faible"
    assert _niveau(39) == "faible"
    assert _niveau(40) == "modere"
    assert _niveau(59) == "modere"
    assert _niveau(60) == "eleve"
    assert _niveau(79) == "eleve"
    assert _niveau(80) == "tres eleve"
    assert _niveau(100) == "tres eleve"
    print("test_niveau OK")


# ---------------------------------------------------------------------------
#   Tests compute_risk_scores
# ---------------------------------------------------------------------------

def test_score_bas():
    """Score minimal : aucune donnee de risque, zone sismique 1, altitude 25m."""
    data = _building_data_factice(altitude=25.0, zone_sismique="1", jours_chaleur=10.0, precip_proj=600.0)
    scores = compute_risk_scores(data)
    assert scores["score_global"] < 50
    assert set(scores["zones"]) == set(ZONE_NAMES)
    assert scores["zones"]["sous_sol"]["niveau"] in ("faible", "modere")


def test_score_eleve_inondation():
    """Inondation maximale : alerte forte + CATNAT + altitude < 5m + sous-sol."""
    data = _building_data_factice(
        altitude=3.0,
        alerte_inondation="fort",
        nb_catnat_inondation=3,
        nb_niveau_sous_sol=1,
    )
    scores = compute_risk_scores(data)
    sous_sol = scores["zones"]["sous_sol"]
    assert 0 <= sous_sol["risque"] <= 100
    assert "Inondation" in sous_sol["alea_principal"]


def test_score_eleve_rga():
    """RGA maximal : alerte forte + construction ancienne + canicule projetee."""
    data = _building_data_factice(
        alerte_argiles="fort",
        annee_construction=1960,
        jours_chaleur=65.0,
    )
    scores = compute_risk_scores(data)
    fondations = scores["zones"]["fondations"]
    assert 0 <= fondations["risque"] <= 100
    assert "argiles" in fondations["alea_principal"].lower()


def test_score_seisme_fort():
    """Seisme zone 5."""
    data = _building_data_factice(zone_sismique="5")
    faible = compute_risk_scores(_building_data_factice(zone_sismique="1"))
    fort = compute_risk_scores(data)
    assert fort["zones"]["fondations"]["risque"] >= faible["zones"]["fondations"]["risque"]


def test_land_only():
    """Le scoring accepte aussi des donnees sans bloc BDNB."""
    data = _building_data_factice(alerte_argiles="moyen", alerte_inondation="moyen")
    data["bdnb"] = None
    scores = compute_risk_scores(data)
    assert 0 <= scores["score_global"] <= 100


def test_score_ponderation():
    """Le score global reste borne pour les deux periodes."""
    scores = compute_risk_scores(_building_data_factice())
    assert 0 <= scores["score_global"] <= 100
    assert 0 <= scores["projection_2050"]["score_global"] <= 100


def test_dict_serialization():
    """Verifie que le resultat est directement serialisable."""
    data = _building_data_factice(alerte_argiles="fort", alerte_inondation="moyen")
    scores = compute_risk_scores(data)
    assert "score_global" in scores
    assert "zones" in scores
    assert "projection_2050" in scores
    assert "trajectoire" in scores


# ---------------------------------------------------------------------------
#   Execution
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    test_niveau()
    test_score_bas()
    test_score_eleve_inondation()
    test_score_eleve_rga()
    test_score_seisme_fort()
    test_land_only()
    test_score_ponderation()
    test_dict_serialization()
    print("\n=== TOUS LES TESTS DE SCORING PASSENT ===")
