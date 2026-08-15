"""Tests du pipeline de statut Copernicus (banniere Décision).

- copernicus_status() : état sans appel réseau (marqueur, flag, erreur).
- ensure_dataset_downloaded() : un seul téléchargement à la fois (le second
  appelant échoue proprement au lieu de relancer un download concurrent).
"""

from __future__ import annotations

import threading

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


def test_copernicus_status_avant_telechargement():
    status = copernicus.copernicus_status()
    assert status["enabled"] is True
    assert status["configured"] is True
    assert status["download_complete"] is False
    assert status["in_progress"] is False
    assert status["cache_files"] == 0


def test_copernicus_status_apres_telechargement(tmp_path):
    """Le marqueur de fin suffit : plus de bannière côté front."""
    (tmp_path / ".download_complete").write_text("ok", encoding="utf-8")
    (tmp_path / "rcp8_5_yearly.nc").write_bytes(b"\x00" * 16)
    status = copernicus.copernicus_status()
    assert status["download_complete"] is True
    assert status["cache_files"] == 1
    assert status["cache_bytes"] == 16


def test_copernicus_status_config_absente(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "cdsapi_key", "")
    status = copernicus.copernicus_status()
    assert status["configured"] is False


def test_un_seul_telechargement_a_la_fois(monkeypatch: pytest.MonkeyPatch):
    """Le 2e appelant pendant un download en cours échoue proprement (fail-soft)."""
    entered = threading.Event()

    def _fake_retrieve(*args, **kwargs):
        entered.set()
        # on ne libère jamais le flag pendant le test : on simule un download long
        threading.Event().wait(0.05)
        raise RuntimeError("fini (test)")

    monkeypatch.setattr(copernicus, "_REQUEST", {"variable": ["hot_days"]})
    # import tardif : on patche le module réellement importé par la fonction
    import cdsapi as cdsapi_mod

    monkeypatch.setattr(cdsapi_mod, "Client", lambda: type("C", (), {"retrieve": _fake_retrieve})())

    # 1er appel : démarre le « download »
    t = threading.Thread(target=lambda: copernicus.ensure_dataset_downloaded())
    t.start()
    assert entered.wait(2.0), "le téléchargement n'a pas démarré"

    # 2e appel pendant que le 1er est « en cours » → échec propre
    with pytest.raises(copernicus.CopernicusDataMissing):
        copernicus.ensure_dataset_downloaded()

    t.join(timeout=2.0)
    # après la fin du 1er, le flag retombe à False
    with copernicus._download_state_lock:
        assert copernicus._download_state["in_progress"] is False


def test_route_copernicus_status():
    """GET /diagnostic/copernicus/status répond 200 avec la forme attendue."""
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as client:
        resp = client.get("/diagnostic/copernicus/status")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    for key in ("enabled", "configured", "download_complete", "in_progress", "cache_files", "cache_bytes"):
        assert key in body
