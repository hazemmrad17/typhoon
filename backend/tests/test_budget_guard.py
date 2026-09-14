# =============================================================================
#   T012 — Garde du budget mensuel BDNB (FR-28)
#
#   - compteur mensuel, reset automatique au changement de mois
#   - lot rejeté 429 budget_epuise quand l'enveloppe ne couvre pas le lot
#   - la requête unitaire interactive n'est JAMAIS bloquée par le garde
# =============================================================================

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.services import budget


def test_consume_within_budget():
    budget.reset("2026-08")
    assert budget.consume(2) is True
    assert budget.consumed() == 2


def test_consume_beyond_budget_refused(monkeypatch):
    monkeypatch.setattr("app.core.config.settings.bdnb_monthly_budget", 3)
    budget.reset("2026-08")
    assert budget.consume(3) is True
    assert budget.consume(1) is False
    assert budget.consumed() == 3  # pas de crédit négatif


def test_month_rollover_resets(monkeypatch):
    monkeypatch.setattr("app.core.config.settings.bdnb_monthly_budget", 3)
    monkeypatch.setattr(budget, "_current_month", lambda: "2026-07")
    budget.reset()
    budget.consume(3)
    # le mois bascule : le prochain accès réinitialise l'état
    monkeypatch.setattr(budget, "_current_month", lambda: "2026-08")
    assert budget.remaining(3) == 3
    assert budget.consumed() == 0


def test_batch_rejected_when_budget_exhausted_single_unaffected(monkeypatch):
    """Budget épuisé -> lot refusé 429 ; la requête unitaire passe."""
    from app.connectors.geocoding import GeocodeResult

    monkeypatch.setattr("app.core.config.settings.bdnb_monthly_budget", 0)

    async def fake_geo(client, address):
        return GeocodeResult(label="Rivoli", citycode="75056", postcode="", city="P",
                             score=0.95, lat=48.85, lon=2.35)

    async def fake_raw(client, cc, la, lo):
        return {"erreurs": [], "batiment": {}}

    async def fake_bdnb(client, address, label_ban=""):
        return {"batiment": {}, "autres_batiments_meme_adresse": []}

    monkeypatch.setattr("app.services.canonical.geocode_address", fake_geo)
    monkeypatch.setattr("app.services.canonical.fetch_georisques_raw", fake_raw)
    monkeypatch.setattr("app.services.canonical._fetch_bdnb_avec_repli", fake_bdnb)

    with TestClient(app) as client:
        resp_batch = client.post("/diagnostic/batch",
                                 json={"addresses": ["a", "b"]})
        resp_single = client.post("/diagnostic/adresse",
                                  json={"adresse": "10 rue de Rivoli"})

    assert resp_batch.status_code == 429
    assert resp_batch.json()["detail"]["error"] == "budget_epuise"
    assert resp_single.status_code == 200
