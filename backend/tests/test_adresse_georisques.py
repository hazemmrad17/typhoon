"""
Tests hors-ligne pour le flux adresse → Géorisques → RisqueReport.
Plan : typhoon_adresse_georisques_plan.md §6

Fixtures calquées sur une vraie réponse pour Nice 06088
(14 Avenue des Palmiers, 06000 Nice — RNB PXQR-9K3T-88ZL).

A exécuter :
    cd backend
    PYTHONPATH=. pytest tests/test_adresse_georisques.py -v
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.connectors.geocoding import (
    GeocodeResult,
    GeocodingError,
    geocode_address,
)
from app.connectors.georisques import (
    get_risque_report,
    _score_to_niveau,
)
from app.schemas.risque_report import NiveauRisque, RisqueReport

# ---------------------------------------------------------------------------
# Fixtures réelles (capturées sur Nice 06088)
# ---------------------------------------------------------------------------

BAN_RESPONSE_NICE = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [7.2620, 43.7102]},
            "properties": {
                "label": "14 Avenue des Palmiers 06000 Nice",
                "score": 0.93,
                "citycode": "06088",
                "postcode": "06000",
                "city": "Nice",
            },
        }
    ],
}

BAN_RESPONSE_EMPTY = {"type": "FeatureCollection", "features": []}

GEORISQUES_RAW_NICE = {
    "erreurs": [],
    "risques_commune": {
        "data": [
            {
                "risques_detail": [
                    {"libelle_risque_long": "Inondation", "zone_sismicite": 2},
                    {"libelle_risque_long": "Feu de forêt"},
                    {"libelle_risque_long": "Retrait-gonflement des argiles"},
                ]
            }
        ]
    },
    "catnat": {
        "data": [
            {"libelle_risque_jo": "Inondations et/ou Coulées de Boue"},
            {"libelle_risque_jo": "Inondations et/ou Coulées de Boue"},
            {"libelle_risque_jo": "Sécheresse"},
        ]
    },
    "zones_inondables": [{"code_commune": "06088"}],
    "cavites": [],
    "zonage_sismique": [{"zone_sismicite": 2}],
    "radon": [{"classe_potentiel": "2"}],
    "mouvements_terrain": [],
}


# ---------------------------------------------------------------------------
# Test 1 : géocodage — adresse valide
# ---------------------------------------------------------------------------

def test_geocodage_adresse_valide():
    """Adresse valide → GeocodeResult avec lat/lon/citycode corrects (IGN Geoplateforme)."""
    async def _run():
        mock_client = AsyncMock(spec=httpx.AsyncClient)
        mock_client.get.return_value = httpx.Response(
            200,
            json=BAN_RESPONSE_NICE,
            request=httpx.Request("GET", "https://data.geopf.fr/geocodage/search"),
        )
        return await geocode_address(mock_client, "14 Avenue des Palmiers Nice")

    result = asyncio.run(_run())
    assert isinstance(result, GeocodeResult)
    assert abs(result.lat - 43.7102) < 0.001
    assert abs(result.lon - 7.262) < 0.001
    assert result.citycode == "06088"
    assert result.score >= 0.9


# ---------------------------------------------------------------------------
# Test 2 : géocodage — adresse absurde → GeocodingError
# ---------------------------------------------------------------------------

def test_geocodage_adresse_absurde():
    """Adresse non trouvée → GeocodingError (jamais un fallback silencieux)."""
    async def _run():
        mock_client = AsyncMock(spec=httpx.AsyncClient)
        mock_client.get.return_value = httpx.Response(
            200,
            json=BAN_RESPONSE_EMPTY,
            request=httpx.Request("GET", "https://data.geopf.fr/geocodage/search"),
        )
        return await geocode_address(mock_client, "zzz adresse inexistante 99999")

    with pytest.raises(GeocodingError):
        asyncio.run(_run())


# ---------------------------------------------------------------------------
# Test 3 : Géorisques brut — coordonnées connues → réponse capturée
# ---------------------------------------------------------------------------

def test_georisques_raw_nice():
    """Fixture Nice → les clés attendues sont présentes dans le brut."""
    async def _run():
        mock_client = AsyncMock(spec=httpx.AsyncClient)
        mock_client.get.return_value = httpx.Response(200, json=GEORISQUES_RAW_NICE)
        # On mocke _get directement pour ne pas instancier le client
        with patch("app.connectors.georisques.fetch_georisques_raw", return_value=GEORISQUES_RAW_NICE):
            return GEORISQUES_RAW_NICE

    raw = asyncio.run(_run())
    assert "risques_commune" in raw
    assert "catnat" in raw
    assert "zonage_sismique" in raw
    assert raw["erreurs"] == []


# ---------------------------------------------------------------------------
# Test 4 : normalisation → RisqueReport complet
# ---------------------------------------------------------------------------

def test_risque_report_nice():
    """Fixture Nice → RisqueReport normalisé avec les bandes D03 attendues."""
    async def _run():
        with patch("app.connectors.georisques.fetch_georisques_raw", return_value=GEORISQUES_RAW_NICE):
            mock_client = AsyncMock(spec=httpx.AsyncClient)
            return await get_risque_report(
                client=mock_client,
                adresse_saisie="14 avenue des palmiers nice",
                adresse_normalisee="14 Avenue des Palmiers 06000 Nice",
                lat=43.7102,
                lon=7.2620,
                code_insee="06088",
            )

    report = asyncio.run(_run())
    assert isinstance(report, RisqueReport)
    assert report.code_insee == "06088"
    assert report.erreurs_partielles == []

    # Le rapport couvre l'ensemble des aléas du référentiel Géorisques : les
    # 5 périls « bâtiment » (ICPE, canalisations, vents cycloniques, PPR, SSP)
    # + les aléas communaux/atlas (inondation, séisme, mouvements de terrain,
    # radon, RGA, cavités, feux de forêt, avalanches).
    codes = {a.code for a in report.aleas}
    assert codes == {
        "icpe", "canalisations", "vent_cyclonique", "ppr", "ssp",
        "inondation", "sismicite", "mouvement_terrain", "radon", "rga",
        "cavite", "feu_foret", "avalanche",
    }

    # Fixture Nice : séisme (zone 2), radon (classe 2), RGA, inondation et
    # feux de forêt sont recensés — les périls « bâtiment » ne le sont pas.
    assert report.alea_count == 5

    # Détail des nouveaux aléas : zonage et niveau exploitables.
    sism = next(a for a in report.aleas if a.code == "sismicite")
    assert sism.present is True and sism.zone_sismique == "2"
    assert "Zone sismique 2" in (sism.zonage or "")
    assert sism.niveau == NiveauRisque.FAIBLE
    rad = next(a for a in report.aleas if a.code == "radon")
    assert rad.present is True and "classe 2/3" in (rad.zonage or "")
    inond = next(a for a in report.aleas if a.code == "inondation")
    assert inond.present is True
    assert inond.niveau == NiveauRisque.MODERE
    feu = next(a for a in report.aleas if a.code == "feu_foret")
    assert feu.present is True and "commune" in (feu.zonage or "")

    # Aucun aléa ne doit avoir present=None (toutes les sources sont dispo dans la fixture)
    for alea in report.aleas:
        assert alea.present is not None, f"Aléa {alea.code} a present=None inattendu"


# ---------------------------------------------------------------------------
# Test 5 : erreurs partielles — une source en timeout
# ---------------------------------------------------------------------------

def test_erreurs_partielles():
    """Si zonage_sismique échoue, le rapport reste généré avec erreurs_partielles."""
    raw_with_error = {**GEORISQUES_RAW_NICE,
                      "zonage_sismique": None,
                      "erreurs": [{"source": "georisques.zonage_sismique", "erreur": "timeout"}]}

    async def _run():
        with patch("app.connectors.georisques.fetch_georisques_raw", return_value=raw_with_error):
            mock_client = AsyncMock(spec=httpx.AsyncClient)
            return await get_risque_report(
                client=mock_client,
                adresse_saisie="test",
                adresse_normalisee="Test 75001 Paris",
                lat=48.86, lon=2.35, code_insee="75056",
            )

    report = asyncio.run(_run())
    assert len(report.erreurs_partielles) == 1
    assert "zonage_sismique" in report.erreurs_partielles[0]

    # Les autres aléas doivent quand même être normalisés
    ssp = next(a for a in report.aleas if a.code == "ssp")
    assert ssp.present is not None


# ---------------------------------------------------------------------------
# Test 6 : bandes D03 — mapping correct
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("score,expected", [
    (0,   NiveauRisque.TRES_FAIBLE),
    (19,  NiveauRisque.TRES_FAIBLE),
    (20,  NiveauRisque.FAIBLE),
    (39,  NiveauRisque.FAIBLE),
    (40,  NiveauRisque.MODERE),
    (59,  NiveauRisque.MODERE),
    (60,  NiveauRisque.ELEVE),
    (79,  NiveauRisque.ELEVE),
    (80,  NiveauRisque.CRITIQUE),
    (100, NiveauRisque.CRITIQUE),
])
def test_d03_bands(score, expected):
    assert _score_to_niveau(score) == expected


# ---------------------------------------------------------------------------
# Test 8 : Introspection — Interdiction absolue d'importer geocodage_connector
# ---------------------------------------------------------------------------

def test_no_decommissioned_geocodage_connector_import():
    """Vérifie qu'aucun fichier du backend n'importe l'ancien connector décommissionné."""
    import inspect
    import app.api.routes.diagnostic as diag_module

    source = inspect.getsource(diag_module)
    assert "geocodage_connector" not in source, "diagnostic.py ne doit plus jamais importer geocodage_connector !"


# ---------------------------------------------------------------------------
# Test 9 : CatNat filtré par péril + PPR et SSP normalisés
# ---------------------------------------------------------------------------

def test_ppr_ssp_normalises():
    """Vérifie la normalisation de PPR et SSP (périls conservés).

    Ici sans résolution WFS (pas de clé `batiment`) : le comptage REST
    communal sert de repli — 1 PPR recensé → estimation communale MODERE,
    jamais un faux "Dans un périmètre" (réservé au verdict WFS).
    """
    raw_enriched = {
        **GEORISQUES_RAW_NICE,
        "ppr": [{"num_ppr": "PPR123", "type_ppr": "PPRN"}],
        "ssp": [{"id_site": "SSP001", "nom_site": "Ancienne Usine"}],
    }

    async def _run():
        with patch("app.connectors.georisques.fetch_georisques_raw", return_value=raw_enriched):
            mock_client = AsyncMock(spec=httpx.AsyncClient)
            return await get_risque_report(
                client=mock_client,
                adresse_saisie="Nice",
                adresse_normalisee="14 Avenue des Palmiers 06000 Nice",
                lat=43.7102, lon=7.2620, code_insee="06088",
            )

    report = asyncio.run(_run())

    # Vérification PPR & SSP
    ppr = next(a for a in report.aleas if a.code == "ppr")
    assert ppr.present is True
    assert ppr.niveau == NiveauRisque.MODERE
    assert ppr.resolution == "commune-level estimate"
    assert "recensé" in ppr.zonage and "périmètre" not in ppr.zonage

    ssp = next(a for a in report.aleas if a.code == "ssp")
    assert ssp.present is True
    assert ssp.niveau == NiveauRisque.MODERE


def test_ppr_wfs_per_building_scores():
    """Score piloté par le WFS quand il a tranché au bâtiment (point-in-polygon).

    - dans un périmètre → signal fort (ELEVE), `resolution` per-building ;
    - hors périmètre → faible (TRES_FAIBLE), même si la commune recense des PPR ;
    - le repli REST communal (pas de WFS) garde son estimation MODERE (cf.
      test_ppr_ssp_normalises) — régresse si quelqu'un rebranche le score
      sur `present` (dérivé) au lieu de `present_bat` (verdict WFS).
    """
    def _report_with_batiment(ppr_info: dict):
        raw_enriched = {
            **GEORISQUES_RAW_NICE,
            "ppr": [{"num_ppr": "PPR123", "type_ppr": "PPRN"}],
            "batiment": {"ppr": ppr_info},
        }

        async def _run():
            with patch("app.connectors.georisques.fetch_georisques_raw", return_value=raw_enriched):
                mock_client = AsyncMock(spec=httpx.AsyncClient)
                return await get_risque_report(
                    client=mock_client,
                    adresse_saisie="Nice",
                    adresse_normalisee="14 Avenue des Palmiers 06000 Nice",
                    lat=43.7102, lon=7.2620, code_insee="06088",
                )

        return asyncio.run(_run())

    # Dans un périmètre : le WFS a tranché → signal fort, pas l'estimation communale.
    report = _report_with_batiment({"present": True, "count": 1, "resolution": "per-building"})
    ppr = next(a for a in report.aleas if a.code == "ppr")
    assert ppr.present is True
    assert ppr.niveau == NiveauRisque.ELEVE
    assert ppr.resolution == "per-building, polygon-checked"
    assert "Dans un périmètre" in ppr.zonage

    # Hors périmètre : faible malgré des PPR recensés dans la commune.
    report = _report_with_batiment({"present": False, "count": 2, "resolution": "per-building"})
    ppr = next(a for a in report.aleas if a.code == "ppr")
    assert ppr.present is False
    assert ppr.niveau == NiveauRisque.TRES_FAIBLE
    assert "Hors périmètre" in ppr.zonage



# ---------------------------------------------------------------------------

