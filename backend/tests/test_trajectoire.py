"""
Tests de la trajectoire (Phase 1 — variables brutes F par peril et par horizon).

Independant de test_scoring.py : ce fichier n'importe que
`app.scoring.risk_model` (pas zone_scoring/promoteur_report, modules absents
de l'arbre courant depuis le rewrite). Roadmap production item 5 (variables
brutes, jamais combinees), item 6 (provenance/resolution) et item 7
(regression : valeurs gelees sur une adresse de reference).

Adresse fictive de reference : 10 Rue Test, 75000 Paris (48.8566, 2.3522).
"""

from __future__ import annotations

from app.scoring.risk_model import compute_risk_scores


def _building_data_factice(
    zone_sismique: str | None = "1",
    alerte_argiles: str | None = None,
    nb_catnat_inondation: int = 0,
    annee_construction: int | None = 1990,
    jours_chaleur: float | None = 5.0,
    precip_proj: float | None = 700.0,
) -> dict:
    # Le champ reel du collecteur est `libelle_risque_jo` (cf.
    # typhon_risk_engine/tests/fixtures/nice_06088.json et _count_catnat dans
    # risk_model) : on le reproduit exactement pour que le comptage marche.
    catnat_data = [
        {"libelle_risque_jo": "Inondations et/ou Coulées de Boue"}
        for _ in range(nb_catnat_inondation)
    ]
    bdnb_base = {}
    if annee_construction is not None:
        bdnb_base["annee_construction"] = annee_construction
    # L'alea RGA au niveau du BÂTIMENT est un champ BDNB (`alea_argile`),
    # pas un champ Georisques communal — cf. _argile_subscore.
    if alerte_argiles:
        bdnb_base["alea_argile"] = alerte_argiles

    return {
        "adresse": {
            "label": "10 Rue Test, 75000 Paris",
            "lat": 48.8566,
            "lon": 2.3522,
            "citycode": "75056",
        },
        "altitude_m": 25.0,
        "bdnb": {"batiment": bdnb_base, "cle_interop_adr": "75056_001_00010"},
        "georisques": {
            # Zone sismique lue via risques_commune.data[].risques_detail[]
            # (meme forme que tests/test_api_diagnostic_offline.py).
            "risques_commune": {"data": [{"risques_detail": [{"zone_sismicite": zone_sismique}]}]}
            if zone_sismique
            else {},
            "catnat": {"data": catnat_data},
            "zonage_sismique": None,
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


def test_trajectoire_shape():
    """La trajectoire expose 3 horizons par peril, jamais combines avec V."""
    scores = compute_risk_scores(_building_data_factice(alerte_argiles="moyen"))
    traj = scores["trajectoire"]
    assert traj["horizons"] == [2026, 2050, 2100]
    perils = traj["perils"]
    assert set(perils) == {
        "argile", "inondation", "mouvement_terrain", "sismique", "radon",
        "canicule", "precipitation", "feu_foret",
    }
    for code, p in perils.items():
        assert len(p["points"]) == 3, f"{code}: attendu 3 horizons"
        assert [pt["horizon"] for pt in p["points"]] == [2026, 2050, 2100]
        assert p["points"][0]["type"] == "observe"
        assert p["points"][1]["type"] == "projete"
        assert p["points"][2]["type"] == "indisponible"
        # 2100 jamais simule : valeur nulle, resolution nulle
        assert p["points"][2]["valeur"] is None
        assert p["points"][2]["resolution"] is None


def test_trajectoire_valeurs_gelees():
    """Regression (roadmap item 7) : valeurs de reference gelees a chaque horizon.

    Adresse de reference : 10 Rue Test, Paris — zone sismique 1, alea argile
    moyen (BDNB), 3 CATNAT inondation, construction 1990, 20 j/an chaleur
    extreme en reference, 30 j/an projete. Si une valeur bouge sans revue
    explicite, ce test echoue.
    """
    data = _building_data_factice(
        zone_sismique="1",
        alerte_argiles="moyen",
        nb_catnat_inondation=3,
        annee_construction=1990,
        jours_chaleur=5.0,
        precip_proj=700.0,
    )
    scores = compute_risk_scores(data)
    traj = scores["trajectoire"]["perils"]

    # Horizon 2026 (observe) — valeurs F brutes gelees
    assert traj["inondation"]["points"][0]["valeur"] == 55  # 3 CATNAT inondation
    assert traj["argile"]["points"][0]["valeur"] == 50  # alea argile moyen (BDNB)
    assert traj["sismique"]["points"][0]["valeur"] == 15  # zone 1 (mapping {0:5, 1:15, ...})
    assert traj["radon"]["points"][0]["valeur"] == 15  # classe non determinee (repli)

    # Horizon 2050 (projete) — la canicule augmente, jamais combinee
    # Seuils de _canicule_subscore : <3 -> 20, <6 -> 40, <10 -> 60, sinon 80.
    # 5 j/an (reference) -> 40 ; 7.5 j/an projete -> 60.
    canicule_2026 = traj["canicule"]["points"][0]["valeur"]
    canicule_2050 = traj["canicule"]["points"][1]["valeur"]
    assert canicule_2026 == 40
    assert canicule_2050 == 60

    # Provenance / resolution honnete
    inondation_2026 = traj["inondation"]["points"][0]
    assert inondation_2026["source"] == "georisques.inondation"
    assert inondation_2026["resolution"] == "commune-level"  # requete par code_insee
    assert inondation_2026["confiance"] == "elevee"
    argile_2026 = traj["argile"]["points"][0]
    assert argile_2026["source"] == "bdnb.alea_argile"
    assert argile_2026["resolution"] == "per-building"  # champ BDNB au niveau du batiment


def test_trajectoire_jamais_combinee():
    """Les variables F sont brutes : la trajectoire ne contient aucun score combine."""
    scores = compute_risk_scores(
        _building_data_factice(alerte_argiles="fort", zone_sismique="5", nb_catnat_inondation=3)
    )
    traj = scores["trajectoire"]
    for code, p in traj["perils"].items():
        for pt in p["points"]:
            for banned in ("score_global", "niveau_global", "risque_global"):
                assert banned not in pt, f"{code}: {banned} ne doit pas apparaitre"
    # Un peril absent (feu de foret non recense) a quand meme ses 3 points
    assert traj["perils"]["feu_foret"]["points"][0]["type"] == "observe"
