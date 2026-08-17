"""Test d'intégration LIVE contre le vrai CDS (Copernicus Climate Data Store).

Ne s'exécute JAMAIS dans une suite normale : ce test télécharge réellement des
données CDS (potentiellement plusieurs gigaoctets la première fois) et
consomme le quota du compte configuré dans `.env`. Il est sauté par défaut ;
pour le lancer explicitement, avec un réseau qui n'est pas dans un
environnement sandbox bloquant cds.climate.copernicus.eu :

    RUN_LIVE_COPERNICUS_TEST=1 venv/Scripts/python.exe -m pytest \
        tests/test_copernicus_live.py -v -s

Objectif (roadmap production, Part 3) : convertir « le connecteur n'a jamais
tourné contre un vrai serveur » en quelque chose de re-vérifiable à la
demande, sans ralentir ni faire consommer de bande passante à chaque
`pytest -q` normal (tous les autres tests Copernicus mockent `cdsapi.Client`
ou fabriquent la forme de sortie du connecteur — cf. `test_copernicus_status.py`,
`test_trajectoire.py::_climat_copernicus_factice` — aucun n'appelle le vrai
service).
"""

from __future__ import annotations

import os

import pytest

from app.connectors import copernicus
from app.core.config import settings

pytestmark = pytest.mark.live_copernicus

_RUN = os.environ.get("RUN_LIVE_COPERNICUS_TEST") == "1"
_SKIP_REASON = (
    "test live désactivé par défaut — RUN_LIVE_COPERNICUS_TEST=1 pour l'exécuter "
    "(télécharge réellement des données CDS, consomme le quota du compte configuré)"
)


@pytest.mark.skipif(not _RUN, reason=_SKIP_REASON)
def test_copernicus_live_download_and_read():
    if not (settings.cdsapi_url and settings.cdsapi_key):
        pytest.skip("CDSAPI_URL / CDSAPI_KEY non configurés (.env)")

    cache_dir = copernicus.ensure_dataset_downloaded()
    assert cache_dir.exists()

    nc_files = list(cache_dir.glob("*.nc"))
    assert nc_files, (
        f"aucun fichier .nc dans {cache_dir} après téléchargement — vérifier "
        "l'hypothèse zip-vs-fichier-unique dans ensure_dataset_downloaded"
    )

    # Adresse de démo (docs/demo-insurer.md) : 14 Avenue des Palmiers, Nice.
    indicateurs = copernicus.read_indicators_at_point(lat=43.7102, lon=7.2620)
    assert indicateurs, "read_indicators_at_point n'a rien retourné pour un point réel"

    for scenario in copernicus.SCENARIOS_CDS:
        assert copernicus.scenario_available(indicateurs, scenario), (
            f"scénario {scenario} absent des données téléchargées — vérifier "
            "_REQUEST (experiment: [rcp4_5, rcp8_5])"
        )

    status = copernicus.copernicus_status()
    assert status["download_complete"] is True
