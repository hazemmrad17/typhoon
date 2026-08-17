"""Régression : jeton de scénario dans le nom de fichier réel CDS.

Un appel live contre le vrai CDS (2026-08-17, voir docs/roadmapproduction.md)
a téléchargé un fichier NetCDF réel nommé avec un underscore entre le chiffre
et la décimale du scénario — `rcp_8_5` — alors que `SCENARIOS_CDS` et le
paramètre `experiment` de la requête utilisent `rcp8_5` (sans underscore).
Avant la correction, `scenario_available()`/`_pick_key()` cherchaient la
sous-chaîne exacte `"rcp8_5"` : elle n'apparaît jamais dans un nom de fichier
réel, donc `scenario_available()` renvoyait toujours False et `_pick_key`
retombait sur "n'importe quelle clé" — exactement le mélange de scénarios que
`scenario_available()` existe pour empêcher.

Ce fichier fige le nom réel observé pour que cette régression ne puisse pas
revenir silencieusement.
"""

from __future__ import annotations

from app.connectors.copernicus import _pick_key, scenario_available

# Nom de fichier réel (sans l'extension .nc), tel que retourné par CDS pour
# une requête experiment=rcp8_5 — capturé lors d'un appel live le 2026-08-17.
REAL_RCP85_STEM = (
    "06_hot_days-projections-yearly-35deg-rcp_8_5-wrf381p-ipsl_cm5a_mr-"
    "r1i1p1-grid-v2.0.area-subset.51.5.10.0.41.0.-5.5"
)
REAL_RCP45_STEM = REAL_RCP85_STEM.replace("rcp_8_5", "rcp_4_5")


def test_scenario_available_matches_real_cds_filename_format():
    climat = {f"{REAL_RCP85_STEM}__hot_days": [1.0] * 11}
    assert scenario_available(climat, "rcp8_5") is True
    assert scenario_available(climat, "rcp4_5") is False


def test_pick_key_selects_correct_scenario_from_real_filenames():
    climat = {
        f"{REAL_RCP45_STEM}__hot_days": [10.0] * 11,
        f"{REAL_RCP85_STEM}__hot_days": [20.0] * 11,
    }
    key_85 = _pick_key(climat, "hot_days", scenario="rcp8_5")
    key_45 = _pick_key(climat, "hot_days", scenario="rcp4_5")
    assert key_85 == f"{REAL_RCP85_STEM}__hot_days"
    assert key_45 == f"{REAL_RCP45_STEM}__hot_days"
    assert key_85 != key_45
