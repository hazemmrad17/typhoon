"""Tests des sondes de santé (/health, /health/detailed)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app


def test_health_ok():
    with TestClient(app) as client:
        resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_health_detailed_reports_dependency_config():
    with TestClient(app) as client:
        resp = client.get("/health/detailed")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    for dep in ("bdnb", "georisques"):
        assert dep in body["dependencies"]
    assert "cors_allowed_origins" in body
    assert "rate_limit" in body
