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
    batiment_ppr: dict | None = None,
    ppr_commune: bool = False,
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
            # Résolution WFS au bâtiment (georisques["batiment"]["ppr"]) :
            # present=False = le point de l'adresse n'est dans AUCUN périmètre
            # PPR, même si la commune en a un.
            **(
                {"batiment": {"ppr": batiment_ppr}}
                if batiment_ppr is not None
                else {}
            ),
            # PPRI prescrit au niveau commune (liste REST gaspar/pprn) — la
            # forme paginée Spring que _data_list sait lire.
            **(
                {
                    "ppr": {
                        "content": [
                            {
                                "modeleProcedure": "R.123-3 PPRI",
                                "libPpr": "PPRI de la plaine",
                                "zonageReglementaire": {
                                    "listTypeReg": [{"code": "03"}]  # rouge
                                },
                            }
                        ]
                    }
                }
                if ppr_commune
                else {}
            ),
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


def _climat_copernicus_factice(
    heatwave_days: float = 12.0, precip_freq: float = 0.12, scenario: str = "rcp8_5"
) -> dict:
    """Reproduit la forme stockee par le collecteur : cles `{stem}__{var}`
    par scenario, chaque serie annuelle couvrant la fenetre 2090-2100
    (_series_value_2100 moyenne les 11 dernieres annees, donc on fournit
    11 valeurs terminant sur la cible)."""
    return {
        f"{scenario}__yearly__heatwave_days": [heatwave_days] * 11,
        f"{scenario}__yearly__frequency_of_extreme_precipitation": [precip_freq] * 11,
    }


def test_trajectoire_2100_copernicus():
    """Avec des donnees CDS telechargees, 2100 cesse d'etre indisponible pour
    les perils pilotés par le climat — et reste honnetement indisponible pour
    les perils statiques (jamais de valeur dupliquee depuis 2050)."""
    data = _building_data_factice(alerte_argiles="moyen")
    data["climat_copernicus"] = _climat_copernicus_factice()

    scores = compute_risk_scores(data)
    traj = scores["trajectoire"]["perils"]

    # Canicule : 12 j/an -> bande 80, source taggee Copernicus, resolution grille
    canicule_2100 = traj["canicule"]["points"][2]
    assert canicule_2100["type"] == "projete"
    assert canicule_2100["horizon"] == 2100
    assert canicule_2100["valeur"] == 80
    assert canicule_2100["scenario"] == "rcp8_5"
    assert canicule_2100["source"] == "copernicus.cds.canicule"
    assert canicule_2100["resolution"] == "grid-cell"
    assert canicule_2100["confiance"] == "elevee"

    # Precipitation : frequence 0.12 -> bande 80, source Copernicus
    precip_2100 = traj["precipitation"]["points"][2]
    assert precip_2100["type"] == "projete"
    assert precip_2100["valeur"] == 80
    assert precip_2100["source"] == "copernicus.precipitation"
    assert precip_2100["resolution"] == "grid-cell"

    # Perils statiques : 2100 reste indisponible (pas de duplication 2050)
    for code in ("sismique", "radon", "mouvement_terrain", "inondation", "argile", "feu_foret"):
        pt = traj[code]["points"][2]
        assert pt["type"] == "indisponible", f"{code}: 2100 ne doit pas etre simule"
        assert pt["valeur"] is None
        assert pt["resolution"] is None

    # Les horizons 2026/2050 ne bougent pas quand Copernicus est actif
    assert traj["inondation"]["points"][0]["valeur"] == 15  # 0 CATNAT (repli)


def test_trajectoire_2100_sans_copernicus():
    """Sans donnees CDS, le bloc 2100 reste indisponible pour tous les perils
    (source copernicus.cds taggee quand le flag est active, sinon None)."""
    scores = compute_risk_scores(_building_data_factice(alerte_argiles="moyen"))
    traj = scores["trajectoire"]["perils"]
    for code, p in traj.items():
        pt = p["points"][2]
        assert pt["type"] == "indisponible"
        assert pt["valeur"] is None
        assert pt["source"] is None  # flag Copernicus desactive
        assert pt["scenario"] is None


def test_trajectoire_2100_comparaison_scenarios():
    """Les deux RCP telecharges (rcp4_5 + rcp8_5) sont exposes en comparaison
    sur chaque point 2100 projete (`scenarios`) ; `scenario` et `valeur`
    suivent la selection primaire sans relancer le calcul."""
    data = _building_data_factice(alerte_argiles="moyen")
    # rcp4_5 : 8 j/an -> bande 60 ; rcp8_5 : 16 j/an -> bande 80
    data["climat_copernicus"] = {
        **_climat_copernicus_factice(heatwave_days=8.0, precip_freq=0.06, scenario="rcp4_5"),
        **_climat_copernicus_factice(heatwave_days=16.0, precip_freq=0.16, scenario="rcp8_5"),
    }

    # Selection primaire rcp8_5 (defaut)
    scores = compute_risk_scores(data)
    canicule_2100 = scores["trajectoire"]["perils"]["canicule"]["points"][2]
    assert canicule_2100["type"] == "projete"
    assert canicule_2100["scenario"] == "rcp8_5"
    assert canicule_2100["valeur"] == 80
    assert canicule_2100["scenarios"] == {"rcp4_5": 60, "rcp8_5": 80}

    # Selection primaire rcp4_5 : la valeur affichee bascule, la comparaison reste
    scores45 = compute_risk_scores(data, scenario="rcp4_5")
    pt45 = scores45["trajectoire"]["perils"]["canicule"]["points"][2]
    assert pt45["scenario"] == "rcp4_5"
    assert pt45["valeur"] == 60
    assert pt45["scenarios"] == {"rcp4_5": 60, "rcp8_5": 80}

    # La comparaison ne concerne que les perils pilotes par Copernicus :
    # un peril statique reste indisponible, sans carte `scenarios`
    sismique_2100 = scores["trajectoire"]["perils"]["sismique"]["points"][2]
    assert sismique_2100["type"] == "indisponible"
    assert "scenarios" not in sismique_2100


def test_trajectoire_inondation_resolution_batiment():
    """Phase 1 item 4 (per-building) : quand le WFS a tranché que le point de
    l'adresse n'est dans AUCUN périmètre PPR, la surcote PPRI communale ne
    s'applique plus — et le point porte la résolution honnête « per-building »."""
    # Commune avec PPRI rouge prescrit + WFS qui dit « bâtiment hors périmètre »
    data = _building_data_factice(
        nb_catnat_inondation=3,
        ppr_commune=True,
        batiment_ppr={"present": False, "resolution": "per-building"},
    )
    scores = compute_risk_scores(data)
    inondation_2026 = scores["trajectoire"]["perils"]["inondation"]["points"][0]

    # 3 CATNAT -> base 55 ; SANS la surcote PPRI (qui pousserait à 60) puisque
    # le point est hors périmètre malgré le PPRI communal.
    assert inondation_2026["valeur"] == 55
    assert inondation_2026["resolution"] == "per-building"  # WFS a tranché
    assert inondation_2026["source"] == "georisques.inondation"
    # La mention « hors périmètre » est portée par la justification du péril.
    assert "hors périmètre PPR" in scores["risques_par_alea"]["inondation"]["justification"]

    # Même commune, mais WFS indisponible (pas de batiment) : repli commune,
    # la surcote PPRI s'applique (valeur 60), résolution commune-level.
    data_commune = _building_data_factice(nb_catnat_inondation=3, ppr_commune=True)
    scores_commune = compute_risk_scores(data_commune)
    pt_commune = scores_commune["trajectoire"]["perils"]["inondation"]["points"][0]
    assert pt_commune["valeur"] == 60
    assert pt_commune["resolution"] == "commune-level"

    # Bâtiment DANS un périmètre PPR (present=True) : la surcote s'applique,
    # la résolution reste per-building et le détail de zonage est conservé.
    data_dans = _building_data_factice(
        nb_catnat_inondation=3,
        ppr_commune=True,
        batiment_ppr={"present": True, "resolution": "per-building"},
    )
    scores_dans = compute_risk_scores(data_dans)
    pt_dans = scores_dans["trajectoire"]["perils"]["inondation"]["points"][0]
    assert pt_dans["valeur"] == 60
    assert pt_dans["resolution"] == "per-building"
    assert "zone rouge" in scores_dans["risques_par_alea"]["inondation"]["justification"]

    # La résolution per-building est conservée à l'horizon 2050 aussi
    # (le bâtiment ne bouge pas : la vérification WFS reste valide).
    assert scores["trajectoire"]["perils"]["inondation"]["points"][1]["resolution"] == "per-building"
