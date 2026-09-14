"""Tests du connecteur Panoramax (photos terrain réelles — étape 2).

Aucun réseau : les réponses sont remplacées par des payloads qui reproduisent
la FORME RÉELLE de l'API Panoramax (`features[].geometry.coordinates` en
[lon, lat], `assets.thumb.href`, `properties.view:azimuth`, `datetimetz`,
`geovisio:producer`, `license`) — relevée en direct sur Paris 2e.

Ce qui est verrouillé ici, ce sont les deux décisions qui font qu'une carte
montre le bâtiment analysé et pas une façade d'en face :
  · la photo qui REGARDE le point est préférée, même un peu plus loin ;
  · à défaut, la plus proche est prise, et l'écart d'orientation est renvoyé.

Et le contrat du projet : jamais d'exception, jamais d'image de substitution.
"""

from __future__ import annotations

import pytest

import app.connectors.panoramax as pano
from app.connectors.panoramax import (
    PanoCandidate,
    angular_diff_deg,
    bearing_deg,
    fetch_site_photo,
    haversine_m,
    parse_feature,
    pick_best_photo,
)

SITE_LAT, SITE_LON = 48.8500, 2.3500


# ---------------------------------------------------------------------------
# Géométrie
# ---------------------------------------------------------------------------

def test_haversine_mesure_les_distances_courtes():
    # 0,001° de latitude ≈ 111 m partout.
    assert haversine_m(48.8500, 2.3500, 48.8510, 2.3500) == pytest.approx(111.2, abs=1.0)
    # Même écart en longitude à Paris : nettement plus court (cos 48,85°).
    assert haversine_m(48.8500, 2.3500, 48.8500, 2.3510) == pytest.approx(73.2, abs=1.0)
    assert haversine_m(48.85, 2.35, 48.85, 2.35) == 0.0


def test_bearing_cap_cardinal():
    assert bearing_deg(48.8500, 2.3500, 48.8510, 2.3500) == pytest.approx(0.0, abs=0.5)
    assert bearing_deg(48.8500, 2.3500, 48.8500, 2.3510) == pytest.approx(90.0, abs=0.5)
    assert bearing_deg(48.8500, 2.3500, 48.8490, 2.3500) == pytest.approx(180.0, abs=0.5)


def test_ecart_angulaire_passe_par_zero():
    assert angular_diff_deg(350.0, 10.0) == pytest.approx(20.0)
    assert angular_diff_deg(10.0, 350.0) == pytest.approx(20.0)
    assert angular_diff_deg(0.0, 180.0) == pytest.approx(180.0)
    assert angular_diff_deg(45.0, 45.0) == 0.0


# ---------------------------------------------------------------------------
# Lecture des features
# ---------------------------------------------------------------------------

def _feature(
    pid: str = "b34c9a28-0fda-4a4c-8217-61aed0e6a9a3",
    lon: float = 2.3510,
    lat: float = 48.8500,
    # 270° = objectif vers l'ouest : la caméra est à l'est du site, donc elle
    # REGARDE le point analysé (c'est le cas couvert par le fonds parisien).
    azimuth: float | None = 270.0,
    **overrides,
) -> dict:
    """Feature de la forme réelle renvoyée par /api/search."""
    assets = {
        "thumb": {"href": f"https://panoramax.ign.fr/api/pictures/{pid}/thumb.jpg"},
        "sd": {"href": f"https://panoramax.ign.fr/api/pictures/{pid}/sd.jpg"},
    }
    props = {
        "datetimetz": "2024-07-10T14:03:08.163000+02:00",
        "geovisio:producer": "immergis",
        "license": "etalab-2.0",
        "view:azimuth": azimuth,
    }
    feature = {
        "id": pid,
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "assets": assets,
        "properties": props,
    }
    feature.update(overrides)
    return feature


def test_parse_feature_lit_les_champs_reels():
    cand = parse_feature(_feature())

    assert cand is not None
    assert cand.id == "b34c9a28-0fda-4a4c-8217-61aed0e6a9a3"
    assert (cand.lat, cand.lon) == (48.8500, 2.3510)
    assert cand.azimuth == 270.0
    assert cand.thumb_url.endswith("/thumb.jpg")
    assert cand.producer == "immergis"
    assert cand.licence == "etalab-2.0"
    assert cand.captured_at.startswith("2024-07-10")
    assert cand.page_url.endswith(cand.id)


def test_parse_feature_ecarte_ce_qui_n_a_pas_de_provenance():
    assert parse_feature(_feature(geometry=None)) is None
    assert parse_feature(_feature(id="")) is None
    # Pas de vignette : une image sans provenance ne sert pas de support.
    assert parse_feature(_feature(assets={})) is None
    # Azimut illisible : le candidat reste utilisable, orientation inconnue.
    cand = parse_feature(_feature(azimuth="pas-un-nombre"))
    assert cand is not None and cand.azimuth is None


# ---------------------------------------------------------------------------
# Choix de la photo
# ---------------------------------------------------------------------------

def test_choisit_la_photo_qui_regarde_le_point_meme_plus_loin():
    # A : 12 m au nord du site, objectif vers le nord (donc dos au bâtiment).
    a = PanoCandidate(
        id="A", lat=SITE_LAT + 0.0001078, lon=SITE_LON, azimuth=0.0,
        thumb_url="a", sd_url="a", captured_at=None, producer=None, licence=None, page_url="a",
    )
    # B : 30 m à l'est, objectif vers l'ouest (donc vers le site).
    b = PanoCandidate(
        id="B", lat=SITE_LAT, lon=SITE_LON + 0.0004096, azimuth=270.0,
        thumb_url="b", sd_url="b", captured_at=None, producer=None, licence=None, page_url="b",
    )

    match = pick_best_photo([a, b], SITE_LAT, SITE_LON)

    assert match is not None
    assert match.candidate.id == "B"
    assert match.distance_m == pytest.approx(30.0, abs=1.5)
    assert match.facing_error_deg == pytest.approx(0.0, abs=1.0)


def test_entre_deux_photos_qui_regardent_prend_la_plus_proche():
    near = PanoCandidate(
        id="near", lat=SITE_LAT, lon=SITE_LON + 0.000150, azimuth=270.0,
        thumb_url="n", sd_url="n", captured_at=None, producer=None, licence=None, page_url="n",
    )
    far = PanoCandidate(
        id="far", lat=SITE_LAT, lon=SITE_LON + 0.0004096, azimuth=270.0,
        thumb_url="f", sd_url="f", captured_at=None, producer=None, licence=None, page_url="f",
    )

    match = pick_best_photo([far, near], SITE_LAT, SITE_LON)

    assert match is not None
    assert match.candidate.id == "near"
    assert match.distance_m == pytest.approx(11.0, abs=1.0)
    assert match.facing_error_deg == pytest.approx(0.0, abs=1.5)


def test_sans_orientation_prend_la_plus_proche_et_le_signale():
    # Repli : quand aucune photo ne déclare d'orientation, la proximité décide —
    # et l'écart vaut None (jamais une valeur inventée).
    near = PanoCandidate(
        id="near", lat=SITE_LAT + 0.000095, lon=SITE_LON, azimuth=None,
        thumb_url="n", sd_url="n", captured_at=None, producer=None, licence=None, page_url="n",
    )
    far = PanoCandidate(
        id="far", lat=SITE_LAT + 0.000450, lon=SITE_LON, azimuth=None,
        thumb_url="f", sd_url="f", captured_at=None, producer=None, licence=None, page_url="f",
    )

    match = pick_best_photo([far, near], SITE_LAT, SITE_LON)

    assert match is not None
    assert match.candidate.id == "near"
    assert match.facing_error_deg is None
    assert match.distance_m == pytest.approx(10.6, abs=1.0)


def test_aucun_candidat_ne_donne_aucun_choix():
    assert pick_best_photo([], SITE_LAT, SITE_LON) is None


def test_se_rabat_sur_la_plus_proche_quand_aucune_ne_regarde_le_point():
    # Les deux regardent ailleurs (dos au point) : on prend la plus proche et on
    # renvoie l'écart, pour que l'UI puisse dire que la façade peut être hors champ.
    near = PanoCandidate(
        id="near", lat=SITE_LAT + 0.000095, lon=SITE_LON, azimuth=0.0,
        thumb_url="n", sd_url="n", captured_at=None, producer=None, licence=None, page_url="n",
    )
    far = PanoCandidate(
        id="far", lat=SITE_LAT + 0.000450, lon=SITE_LON, azimuth=0.0,
        thumb_url="f", sd_url="f", captured_at=None, producer=None, licence=None, page_url="f",
    )

    match = pick_best_photo([far, near], SITE_LAT, SITE_LON)

    assert match is not None
    assert match.candidate.id == "near"
    assert match.facing_error_deg == pytest.approx(180.0, abs=1.0)  # > tolérance


# ---------------------------------------------------------------------------
# Contrat de route : jamais d'exception, jamais d'image inventée
# ---------------------------------------------------------------------------

class _FakeResponse:
    def __init__(self, payload: dict, status: int = 200):
        self._payload = payload
        self.status_code = status

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self) -> dict:
        return self._payload


class _FakeClient:
    payload: dict = {"features": []}

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, params=None):  # noqa: ARG002 — signature httpx
        return _FakeResponse(type(self).payload)


@pytest.fixture
def offline(monkeypatch):
    """Remplace le client HTTP du connecteur (aucun réseau)."""
    monkeypatch.setattr(pano.httpx, "AsyncClient", _FakeClient)
    return _FakeClient


async def test_fetch_site_photo_forme_reelle(offline):
    offline.payload = {"features": [_feature()]}

    photo = await fetch_site_photo(SITE_LAT, SITE_LON)

    assert photo["available"] is True
    assert photo["reason"] is None
    assert photo["candidates"] == 1
    assert photo["thumb_url"].startswith("https://panoramax.ign.fr/api/pictures/")
    assert photo["distance_m"] == pytest.approx(73.2, abs=1.5)
    assert photo["facing_ok"] is True
    assert photo["facing_error_deg"] == pytest.approx(0.0, abs=1.5)
    assert photo["producer"] == "immergis"
    assert photo["licence"] == "etalab-2.0"
    assert "Panoramax" in photo["source"]


async def test_fetch_site_photo_sans_couverture_ne_substitue_rien(offline):
    offline.payload = {"features": []}

    photo = await fetch_site_photo(SITE_LAT, SITE_LON)

    assert photo["available"] is False
    assert photo["reason"] == "no_coverage"
    assert photo["facing_ok"] is False
    assert photo["thumb_url"] is None and photo["sd_url"] is None and photo["page_url"] is None
    assert "Aucune photo" in (photo["label"] or "")


async def test_fetch_site_photo_ne_leve_jamais(monkeypatch):
    class Boom:
        def __init__(self, *a, **k):
            raise RuntimeError("boom")

    monkeypatch.setattr(pano.httpx, "AsyncClient", Boom)

    photo = await fetch_site_photo(SITE_LAT, SITE_LON)

    assert photo["available"] is False
    assert photo["reason"] == "error"
    assert photo["thumb_url"] is None
    assert "indisponibles" in (photo["label"] or "")
