"""Tests du middleware de limitation de débit (app/core/rate_limit.py).

Utilise une mini-app Starlette avec des routes factices (pas le vrai
/diagnostic, pour ne déclencher aucun appel externe réel) — seule la logique
de comptage/fenêtre/429 est testée ici.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core import rate_limit as rl
from app.core.config import settings
from app.core.rate_limit import RateLimitMiddleware


def _make_app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(RateLimitMiddleware)

    @app.post("/diagnostic/batch")
    async def batch() -> dict:
        return {"ok": True}

    @app.get("/health")
    async def health() -> dict:
        return {"ok": True}

    return app


def test_requests_under_limit_pass(monkeypatch):
    monkeypatch.setattr(settings, "rate_limit_requests", 3)
    monkeypatch.setattr(settings, "rate_limit_window_seconds", 60.0)
    client = TestClient(_make_app())
    for _ in range(3):
        resp = client.post("/diagnostic/batch")
        assert resp.status_code == 200


def test_requests_over_limit_get_429(monkeypatch):
    monkeypatch.setattr(settings, "rate_limit_requests", 2)
    monkeypatch.setattr(settings, "rate_limit_window_seconds", 60.0)
    client = TestClient(_make_app())
    assert client.post("/diagnostic/batch").status_code == 200
    assert client.post("/diagnostic/batch").status_code == 200
    resp = client.post("/diagnostic/batch")
    assert resp.status_code == 429
    assert "Retry-After" in resp.headers


def test_unlimited_routes_never_throttled(monkeypatch):
    monkeypatch.setattr(settings, "rate_limit_requests", 1)
    monkeypatch.setattr(settings, "rate_limit_window_seconds", 60.0)
    client = TestClient(_make_app())
    for _ in range(10):
        assert client.get("/health").status_code == 200


def test_limit_is_per_route_key(monkeypatch):
    """(méthode, chemin) exact — un chemin non listé dans _LIMITED_ROUTES
    n'est jamais throttlé, même s'il ressemble à une route limitée."""
    assert ("POST", "/diagnostic") not in rl._LIMITED_ROUTES
    assert ("POST", "/diagnostic/batch") in rl._LIMITED_ROUTES
    assert ("GET", "/diagnostic/adresse") in rl._LIMITED_ROUTES
