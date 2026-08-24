"""Production : téléchargement CDS explicite, jamais bloquant sur une requête.

- _REQUEST minimaliste : France + yearly + les 2 seules variables consommées
  (le fichier se compte en dizaines de Mo, pas en Go).
- start_download() : déclenche un thread daemon, idempotent (refuse si déjà
  en cours / déjà complet / non configuré).
- Cache signé par une empreinte de _REQUEST : une requête qui change invalide
  le cache et force un re-téléchargement (jamais de données périmées).
- read_indicators_at_point() ne déclenche JAMAIS de téléchargement implicite :
  fail-soft (CopernicusDataMissing) tant que le cache n'est pas prêt.
"""

from __future__ import annotations

import time

import pytest

from app.connectors import copernicus
from app.core.config import settings


@pytest.fixture(autouse=True)
def _reset_state(tmp_path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "copernicus_cache_dir", str(tmp_path))
    monkeypatch.setattr(settings, "copernicus_enabled", True)
    monkeypatch.setattr(settings, "cdsapi_url", "https://cds.climate.copernicus.eu/api")
    monkeypatch.setattr(settings, "cdsapi_key", "test-key")
    with copernicus._download_state_lock:
        copernicus._download_state["in_progress"] = False
        copernicus._download_state["error"] = None
    yield
    with copernicus._download_state_lock:
        copernicus._download_state["in_progress"] = False
        copernicus._download_state["error"] = None


def _fake_cdsapi(monkeypatch: pytest.MonkeyPatch, tmp_path) -> list:
    """Client cdsapi factice : retrieve() → download() → faux .nc local.

    Retourne la liste des appels retrieve(dataset, request) pour vérifier
    que le téléchargement a bien été déclenché.
    """
    import cdsapi as cdsapi_mod

    dl_dir = tmp_path / "dl"
    dl_dir.mkdir(exist_ok=True)
    calls: list = []

    class _FakeResult:
        def __init__(self, path):
            self._path = path

        def download(self):
            return str(self._path)

    class _FakeClient:
        def retrieve(self, dataset, request):
            calls.append((dataset, request))
            nc = dl_dir / (
                "06_heatwave_days-projections-yearly-rcp_8_5-wrf381p-"
                "ipsl_cm5a_mr-r1i1p1-grid-v2.0.area-subset.51.5.10.0.41.0.-5.5.nc"
            )
            nc.write_bytes(b"\x00" * 64)
            return _FakeResult(nc)

    monkeypatch.setattr(cdsapi_mod, "Client", _FakeClient)
    return calls


def test_requete_minimaliste_pour_la_production():
    """France + yearly + variables climatiques → fichier en dizaines de Mo, pas en Go."""
    req = copernicus._REQUEST
    assert req["temporal_aggregation"] == ["yearly"]
    assert "heatwave_days" in req["variable"]
    assert "frequency_of_extreme_precipitation" in req["variable"]
    assert req["area"] == [51.5, -5.5, 41.0, 10.0]
    assert "monthly" not in req["temporal_aggregation"]
    assert "seasonal" not in req["temporal_aggregation"]


def test_start_download_non_configure(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "cdsapi_key", "")
    assert copernicus.start_download() == {"started": False, "reason": "not_configured"}


def test_start_download_refuse_si_deja_complet(tmp_path):
    (tmp_path / ".download_complete").write_text(
        f"ok:{copernicus._request_signature()}", encoding="utf-8"
    )
    assert copernicus.start_download() == {"started": False, "reason": "already_complete"}


def test_start_download_refuse_si_en_cours():
    with copernicus._download_state_lock:
        copernicus._download_state["in_progress"] = True
    try:
        assert copernicus.start_download()["reason"] == "in_progress"
    finally:
        with copernicus._download_state_lock:
            copernicus._download_state["in_progress"] = False


def test_start_download_complete_en_arriere_plan(monkeypatch: pytest.MonkeyPatch, tmp_path):
    calls = _fake_cdsapi(monkeypatch, tmp_path)
    assert copernicus.start_download() == {"started": True, "reason": "started"}

    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        if copernicus._marker_valid(copernicus._download_marker()):
            break
        time.sleep(0.02)
    assert calls, "cdsapi.retrieve n'a jamais été appelé"
    assert copernicus._marker_valid(copernicus._download_marker()), "le marqueur n'est jamais apparu"
    status = copernicus.copernicus_status()
    assert status["download_complete"] is True
    assert status["cache_files"] == 1


def test_cache_perime_invalide_et_retelecharge(monkeypatch: pytest.MonkeyPatch, tmp_path):
    """Un marqueur d'une ancienne requête → invalide → re-téléchargement."""
    (tmp_path / ".download_complete").write_text("ok:ancien-hash", encoding="utf-8")
    calls = _fake_cdsapi(monkeypatch, tmp_path)
    copernicus.ensure_dataset_downloaded()
    assert calls
    assert copernicus._marker_valid(copernicus._download_marker())


def test_lecture_sans_cache_echec_fail_soft():
    """Aucun téléchargement implicite : le diagnostic continue sans Copernicus."""
    with pytest.raises(copernicus.CopernicusDataMissing):
        copernicus.read_indicators_at_point(43.7, 7.25)


# Noms de fichiers réels observés au téléchargement CDS (2026-08-17) : les
# variables internes sont `climatological_heatwave_days` (jours/an) et
# `extreme_precipitation_days` (jours/an), pas les noms du formulaire.
REAL_HEAT_STEM = (
    "09_heat_waves_climatological-projections-yearly-rcp_8_5-wrf381p-"
    "ipsl_cm5a_mr-r1i1p1-grid-v2.0.area-subset.51.5.10.0.41.0.-5.5"
)
REAL_PRECIP_STEM = (
    "15_frequency_of_extreme_precipitation-projections-yearly-rcp_8_5-wrf381p-"
    "ipsl_cm5a_mr-r1i1p1-grid-v2.0.area-subset.51.5.10.0.41.0.-5.5"
)


def test_extraction_depuis_vrais_noms_de_fichiers_cds():
    """La forme réellement téléchargée (noms internes réels + comptes de jours)
    doit produire un bloc 2100 — c'était le bug découvert au premier
    téléchargement live (extract_climate_2100 retournait None)."""
    climat = {
        f"{REAL_HEAT_STEM}__climatological_heatwave_days": [float(i) for i in range(150)],
        f"{REAL_PRECIP_STEM}__extreme_precipitation_days": [float(i) for i in range(150)],
    }
    bloc = copernicus.extract_climate_2100(climat, scenario="rcp8_5")
    assert bloc is not None
    assert bloc["__copernicus_2100"] is True
    # Fenêtre 2090-2100 = dernières 11 valeurs de range(150) = 139..149 → 144
    assert bloc["jours_chaleur_extreme_par_an"] == pytest.approx(144.0)
    # Jours/an → fraction (0-1) : 144/365
    assert bloc["frequency_extreme_precipitation"] == pytest.approx(round(144.0 / 365.0, 4))


def test_extraction_anciens_noms_encore_supportes():
    """Le repli sur les anciens noms (formulaire/fixtures) ne casse pas."""
    climat = {
        "rcp_8_5__yearly__heatwave_days": [12.0] * 11,
        "rcp_8_5__yearly__frequency_of_extreme_precipitation": [0.12] * 11,
    }
    bloc = copernicus.extract_climate_2100(climat, scenario="rcp8_5")
    assert bloc is not None
    assert bloc["jours_chaleur_extreme_par_an"] == 12.0
    # Déjà une fraction : aucune conversion jours→fraction appliquée.
    assert bloc["frequency_extreme_precipitation"] == 0.12


def test_route_download_demarre(monkeypatch: pytest.MonkeyPatch):
    from fastapi.testclient import TestClient

    from app.main import app

    monkeypatch.setattr(copernicus, "start_download", lambda force=False: {"started": True, "reason": "started"})
    with TestClient(app) as client:
        resp = client.post("/diagnostic/copernicus/download")
    assert resp.status_code == 200, resp.text
    assert resp.json()["started"] is True


def test_route_download_non_configure(monkeypatch: pytest.MonkeyPatch):
    from fastapi.testclient import TestClient

    from app.main import app

    monkeypatch.setattr(copernicus, "start_download", lambda force=False: {"started": False, "reason": "not_configured"})
    with TestClient(app) as client:
        resp = client.post("/diagnostic/copernicus/download")
    assert resp.status_code == 409, resp.text
