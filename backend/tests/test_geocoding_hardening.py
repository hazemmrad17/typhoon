# =============================================================================
#   T006 — Géocodage : composant produit de première classe (FR-02..FR-05)
#
#   Comportements observables :
#     - translation arrondissement -> commune parente (Paris/Lyon/Marseille)
#     - 429 upstream honoré UNE fois via retry-after, puis échec
#     - entrée "lat,lon" -> géocodage inverse, jamais le forward
# =============================================================================

from __future__ import annotations

import httpx
import pytest

from app.connectors.georisques import _commune_code


# ---------------------------------------------------------------------------
# FR-02 — translation des arrondissements
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("citycode", "expected"),
    [
        ("75101", "75056"),   # Paris 1er
        ("75120", "75056"),   # Paris 20e (borne haute)
        ("75056", "75056"),   # déjà la commune
        ("69381", "69123"),   # Lyon 1er
        ("69389", "69123"),   # Lyon 9e
        ("69123", "69123"),
        ("13201", "13055"),   # Marseille 1er
        ("13216", "13055"),   # Marseille 16e
        ("13055", "13055"),
    ],
)
def test_arrondissement_translation_paris_lyon_marseille(citycode, expected):
    assert _commune_code(citycode) == expected


@pytest.mark.parametrize("outside", ["75057", "75121", "69390", "13217", "abc", "", "97100"])
def test_non_arrondissement_codes_pass_through(outside):
    assert _commune_code(outside) == outside


# ---------------------------------------------------------------------------
# FR-04 — saturation du géocodeur : 429 honoré une fois, puis échec
# ---------------------------------------------------------------------------


def _client_with_responses(responder) -> httpx.AsyncClient:
    transport = httpx.MockTransport(responder)
    return httpx.AsyncClient(transport=transport)


@pytest.mark.asyncio
async def test_geocoder_429_retry_once_then_success(monkeypatch):
    """Premier 429 -> attente retry-after -> deuxième appel aboutit."""
    calls = {"n": 0}
    sleeps: list[float] = []

    async def fake_sleep(delay):
        sleeps.append(delay)

    monkeypatch.setattr("app.connectors.geocoding.asyncio.sleep", fake_sleep)

    def responder(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, headers={"Retry-After": "0"})
        return httpx.Response(
            200,
            json={"features": [{
                "properties": {"label": "10 Rue de Rivoli 75004 Paris",
                               "citycode": "75056", "postcode": "75004",
                               "city": "Paris", "score": 0.95},
                "geometry": {"coordinates": [2.3522, 48.8566]},
            }]},
        )

    from app.connectors.geocoding import geocode_address

    async with _client_with_responses(responder) as client:
        geo = await geocode_address(client, "10 rue de Rivoli, 75004 Paris")

    assert calls["n"] == 2
    assert geo.citycode == "75056"
    assert sleeps  # l'attente retry-after a bien été honorée


@pytest.mark.asyncio
async def test_geocoder_429_twice_raises(monkeypatch):
    """429 persistant -> échec après exactement deux appels (pas de boucle)."""
    calls = {"n": 0}

    async def fake_sleep(delay):
        pass

    monkeypatch.setattr("app.connectors.geocoding.asyncio.sleep", fake_sleep)

    def responder(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(429, headers={"Retry-After": "0"})

    from app.connectors.geocoding import geocode_address

    async with _client_with_responses(responder) as client:
        with pytest.raises(httpx.HTTPError):
            await geocode_address(client, "10 rue de Rivoli")

    assert calls["n"] == 2


# ---------------------------------------------------------------------------
# FR-05 — entrée "lat,lon" : géocodage inverse uniquement
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_latlon_input_skips_forward_geocode():
    from app.services import canonical

    calls = {"forward": 0, "reverse": 0}

    async def fake_forward(client, address):
        calls["forward"] += 1
        raise AssertionError("le forward ne doit pas être appelé pour lat,lon")

    async def fake_reverse(client, lat, lon):
        calls["reverse"] += 1
        from app.connectors.geocoding import GeocodeResult
        return GeocodeResult(label="43.7102,7.2620", citycode="06088",
                             postcode="06000", city="Nice", score=1.0,
                             lat=43.7102, lon=7.2620)

    async def fake_raw(client, citycode, lat, lon):
        return {"erreurs": []}

    async def fake_bdnb(client, address, label_ban=""):
        return None

    canonical.geocode_address = fake_forward
    canonical.reverse_geocode = fake_reverse
    canonical.fetch_georisques_raw = fake_raw
    canonical._fetch_bdnb_avec_repli = fake_bdnb

    record = await canonical.build_diagnostic_record("43.7102,7.2620")

    assert calls["forward"] == 0
    assert calls["reverse"] == 1
    assert record.adresse.citycode == "06088"


@pytest.mark.asyncio
async def test_text_address_never_calls_reverse(monkeypatch):
    from app.services import canonical

    async def fake_reverse(client, lat, lon):
        raise AssertionError("le reverse ne doit pas être appelé pour du texte")

    async def fake_forward(client, address):
        from app.connectors.geocoding import GeocodeResult
        return GeocodeResult(label="x", citycode="75056", postcode="", city="P",
                             score=0.95, lat=48.85, lon=2.35)

    monkeypatch.setattr(canonical, "geocode_address", fake_forward)
    monkeypatch.setattr(canonical, "reverse_geocode", fake_reverse)
