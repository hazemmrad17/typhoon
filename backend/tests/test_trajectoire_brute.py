"""Tests pour extract_trajectoire_brute — trajectoire en vraies unités.

Vérifie que la fonction fenêtre correctement les séries annuelles CDS
en 3 horizons (2026, 2050, 2100) et retourne des valeurs en unités
réelles (pas l'ancien indice 0-100).
"""

from __future__ import annotations

import pytest

from app.connectors.copernicus import extract_trajectoire_brute


def _make_annual_series(
    var_name: str,
    scenario: str = "rcp8_5",
    base_value: float = 10.0,
    trend: float = 0.1,
) -> list[float]:
    """Génère une série annuelle fictive 1940-2100 (161 valeurs).

    La valeur pour l'année Y est base_value + trend * (Y - 1940).
    Cela simule une tendance croissante réaliste.
    """
    return [base_value + trend * (y - 1940) for y in range(1940, 2101)]


def _climat_copernicus_factice(
    heatwave_days_base: float = 5.0,
    heatwave_trend: float = 0.05,
    scenario: str = "rcp8_5",
) -> dict:
    """Construit un dict climat_copernicus factice avec les clés réelles CDS."""
    stem = f"06_heatwave-projections-yearly-{scenario.replace('_', '-')}-wrf381p-ipsl_cm5a_mr-r1i1p1-grid-v2.0"
    return {
        f"{stem}__heatwave_days": _make_annual_series(
            "heatwave_days", scenario, heatwave_days_base, heatwave_trend
        ),
    }


def test_extract_trajectoire_brute_returns_3_horizons():
    """La trajectoire contient 3 horizons par variable."""
    climat = _climat_copernicus_factice()
    traj = extract_trajectoire_brute(climat, scenario="rcp8_5")

    assert traj is not None
    assert traj["horizons"] == [2026, 2050, 2100]
    assert "heatwave_days" in traj["perils"]

    points = traj["perils"]["heatwave_days"]["points"]
    assert len(points) == 3
    assert [p["horizon"] for p in points] == [2026, 2050, 2100]


def test_extract_trajectoire_brute_values_are_real_units():
    """Les valeurs sont en unités réelles (jours/an), pas un indice 0-100."""
    climat = _climat_copernicus_factice(heatwave_days_base=10.0, heatwave_trend=0.0)
    traj = extract_trajectoire_brute(climat, scenario="rcp8_5")

    points = traj["perils"]["heatwave_days"]["points"]
    for pt in points:
        assert pt["valeur"] is not None
        assert pt["unite"] == "jours/an"
        # Avec une série constante à 10.0, la moyenne de toute fenêtre = 10.0
        assert pt["valeur"] == 10.0


def test_extract_trajectoire_brute_windows_average():
    """Les fenêtres temporelles calculent correctement les moyennes."""
    # Série avec des valeurs connues par décennie
    # 2021-2030: 20.0, 2041-2050: 40.0, 2090-2100: 80.0
    values = [0.0] * 161  # 1940-2100
    for y in range(2021, 2031):
        values[y - 1940] = 20.0
    for y in range(2041, 2051):
        values[y - 1940] = 40.0
    for y in range(2090, 2101):
        values[y - 1940] = 80.0

    stem = "test-rcp8_5-wrf381p"
    climat = {f"{stem}__heatwave_days": values}

    traj = extract_trajectoire_brute(climat, scenario="rcp8_5")
    points = traj["perils"]["heatwave_days"]["points"]

    assert points[0]["horizon"] == 2026
    assert points[0]["valeur"] == 20.0  # Moyenne 2021-2030

    assert points[1]["horizon"] == 2050
    assert points[1]["valeur"] == 40.0  # Moyenne 2041-2050

    assert points[2]["horizon"] == 2100
    assert points[2]["valeur"] == 80.0  # Moyenne 2090-2100


def test_extract_trajectoire_brute_scenario_comparison():
    """Les deux scénarios RCP sont exposés dans `scenarios` pour comparaison."""
    climat_rcp45 = _climat_copernicus_factice(
        heatwave_days_base=8.0, heatwave_trend=0.0, scenario="rcp4_5"
    )
    climat_rcp85 = _climat_copernicus_factice(
        heatwave_days_base=16.0, heatwave_trend=0.0, scenario="rcp8_5"
    )
    climat = {**climat_rcp45, **climat_rcp85}

    # Sélection rcp8_5
    traj = extract_trajectoire_brute(climat, scenario="rcp8_5")
    pt = traj["perils"]["heatwave_days"]["points"][0]  # horizon 2026
    assert pt["scenario"] == "rcp8_5"
    assert pt["valeur"] == 16.0
    assert pt["scenarios"] == {"rcp4_5": 8.0, "rcp8_5": 16.0}

    # Sélection rcp4_5
    traj45 = extract_trajectoire_brute(climat, scenario="rcp4_5")
    pt45 = traj45["perils"]["heatwave_days"]["points"][0]
    assert pt45["scenario"] == "rcp4_5"
    assert pt45["valeur"] == 8.0
    assert pt45["scenarios"] == {"rcp4_5": 8.0, "rcp8_5": 16.0}


def test_extract_trajectoire_brute_returns_none_without_data():
    """Retourne None si aucune donnée n'est fournie."""
    assert extract_trajectoire_brute(None) is None
    assert extract_trajectoire_brute({}) is None


def test_extract_trajectoire_brute_metadata():
    """Chaque peril porte un label FR, une catégorie et une unité."""
    climat = _climat_copernicus_factice()
    traj = extract_trajectoire_brute(climat, scenario="rcp8_5")

    peril = traj["perils"]["heatwave_days"]
    assert "label" in peril
    assert "category" in peril
    assert peril["category"] == "temperature"
    assert peril["points"][0]["unite"] == "jours/an"


def test_extract_trajectoire_brute_resolution_and_confidence():
    """Résolution grid-cell et confiance renseignées pour les valeurs projetées."""
    climat = _climat_copernicus_factice()
    traj = extract_trajectoire_brute(climat, scenario="rcp8_5")

    for pt in traj["perils"]["heatwave_days"]["points"]:
        if pt["valeur"] is not None:
            assert pt["resolution"] == "grid-cell"
            assert pt["confiance"] in ("elevee", "moyenne")


def test_extract_trajectoire_brute_missing_variable():
    """Une variable absente du climat_copernicus est simplement ignorée."""
    stem = "test-rcp8_5-wrf381p"
    climat = {f"{stem}__heatwave_days": [10.0] * 161}

    traj = extract_trajectoire_brute(climat, scenario="rcp8_5")

    # heatwave_days est présent
    assert "heatwave_days" in traj["perils"]
    # hot_days est absent (pas de clé correspondante)
    assert "hot_days" not in traj["perils"]
