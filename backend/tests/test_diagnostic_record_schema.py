# =============================================================================
#   T003 — Schéma du contrat canonique DiagnosticRecord (spec FR-17 / FR-18)
#
#   Tests de COMPORTEMENT uniquement : ce que le schéma accepte, rejette et
#   sérialise. Aucune assertion sur l'implémentation interne.
#
#   Règles encodées (constitution §2) :
#     - faits + provenance seulement : aucun champ interdit ne passe
#     - les optionnels aléas sont TOUJOURS présents (null), jamais absents
#     - exception explicite : `per_building` n'apparaît que si test géométrique
#     - résolution contrainte par aléa : rga -> commune-level-estimate ;
#       sismicite/radon -> commune-level (décrétal)
# =============================================================================

from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from app.schemas.diagnostic_record import (
    SCHEMA_VERSION,
    AleaRecord,
    DiagnosticRecord,
)

FORBIDDEN_KEYS = ["niveau", "score", "recommandations", "copernicus"]

PROVENANCE = {
    "provider": "Géorisques",
    "url": "https://www.georisques.gouv.fr",
    "attribution": "Source Géorisques (BRGM / MTE) — données à jour au 2026-07-01",
    "recuperee_le": "2026-08-25T10:00:00+00:00",
}

BDNB_SOURCE = {
    "provider": "BDNB",
    "url": "https://api.bdnb.io",
    "attribution": "Source BDNB (CSTB) — données à jour au 2026-07-01",
    "recuperee_le": "2026-08-25T10:00:00+00:00",
}


def _alea(**overrides) -> dict:
    base = {
        "code": "inondation",
        "libelle": "Inondation",
        "present": True,
        "resolution": "per-building",
    }
    base.update(overrides)
    return base


def _record(**overrides) -> dict:
    base = {
        "adresse": {
            "saisie": "10 rue de Rivoli, 75004 Paris",
            "normalisee": "10 Rue de Rivoli 75004 Paris",
            "citycode": "75056",
            "postcode": "75004",
            "city": "Paris",
            "lat": 48.8566,
            "lon": 2.3522,
            "geocode_score": 0.95,
        },
        "aleas": [_alea()],
        "georisques_source": dict(PROVENANCE),
        "genere_le": "2026-08-25T10:00:01+00:00",
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# FR-18 — champs interdits
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("key", FORBIDDEN_KEYS)
def test_forbidden_key_rejected_on_record(key):
    """Un score/niveau/recommandations/copernicus en entrée est refusé, pas ignoré."""
    payload = _record()
    payload[key] = "eleve"
    with pytest.raises(ValidationError):
        DiagnosticRecord.model_validate(payload)


@pytest.mark.parametrize("key", FORBIDDEN_KEYS)
def test_forbidden_key_rejected_on_alea(key):
    payload = _alea()
    payload[key] = "eleve"
    with pytest.raises(ValidationError):
        AleaRecord.model_validate(payload)


def test_dump_carries_no_forbidden_keys():
    """La sortie sérialisée ne contient aucun champ interdit — au niveau racine
    ni dans un objet aléa. NB : le bloc BDNB est verbatim (FR-16), il peut donc
    légitimement contenir des clés étrangères ; la grille porte sur les
    emplacements structurés connus."""
    record = DiagnosticRecord.model_validate(
        _record(bdnb={"donnees": {"niveau_confort": "B"}, "_source": dict(BDNB_SOURCE)})
    )
    data = record.model_dump(by_alias=True)
    assert not (set(FORBIDDEN_KEYS) & set(data.keys()))
    for alea in data["aleas"]:
        assert not (set(FORBIDDEN_KEYS) & set(alea.keys()))


# ---------------------------------------------------------------------------
# Règle de sérialisation — optionnels toujours présents / carve-out
# ---------------------------------------------------------------------------

OPTIONAL_ALAEA_KEYS = [
    "present_commune",
    "zonage",
    "hauteur_eau_m",
    "zone_sismique",
    "catnat_historique",
    "erreur",
]


def test_hazard_optionals_always_present_as_null():
    """Un aléa minimal sérialise TOUS ses optionnels — null, jamais absents."""
    data = AleaRecord.model_validate(_alea()).model_dump()
    for key in OPTIONAL_ALAEA_KEYS:
        assert key in data, f"clé optionnelle manquante : {key}"
        assert data[key] is None


def test_per_building_absent_when_communal_only():
    """Carve-out explicite : pas de test géométrique -> pas de clé per_building."""
    data = AleaRecord.model_validate(_alea(resolution="commune-level")).model_dump()
    assert "per_building" not in data


def test_per_building_present_when_geometrically_checked():
    payload = _alea(
        per_building={"method": "proximity", "radius_m": 200.0, "count": 1}
    )
    data = AleaRecord.model_validate(payload).model_dump()
    assert data["per_building"] == {"method": "proximity", "radius_m": 200.0, "count": 1}


def test_per_building_radius_null_when_point_in_polygon():
    payload = _alea(
        per_building={"method": "point-in-polygon", "radius_m": None, "count": 2}
    )
    data = AleaRecord.model_validate(payload).model_dump()
    assert data["per_building"]["method"] == "point-in-polygon"
    assert data["per_building"]["radius_m"] is None


# ---------------------------------------------------------------------------
# Résolution — énumération + contraintes par code d'aléa (FR-12 / FR-13)
# ---------------------------------------------------------------------------


def test_invalid_resolution_value_rejected():
    with pytest.raises(ValidationError):
        AleaRecord.model_validate(_alea(resolution="batiment"))


@pytest.mark.parametrize("bad", ["per-building", "commune-level"])
def test_rga_resolution_forced_to_estimate(bad):
    """RGA ne peut pas sérialiser autre chose que commune-level-estimate."""
    with pytest.raises(ValidationError):
        AleaRecord.model_validate(_alea(code="rga", resolution=bad))


def test_rga_accepts_estimate():
    alea = AleaRecord.model_validate(_alea(code="rga", resolution="commune-level-estimate"))
    assert alea.resolution.value == "commune-level-estimate"


@pytest.mark.parametrize("code", ["sismicite", "radon"])
@pytest.mark.parametrize("bad", ["per-building", "commune-level-estimate"])
def test_decree_communal_hazards_forced_to_commune_level(code, bad):
    """Zonages décrétaux : jamais de résolution bâtiment, même si une source le prétend."""
    with pytest.raises(ValidationError):
        AleaRecord.model_validate(_alea(code=code, resolution=bad))


@pytest.mark.parametrize("code", ["sismicite", "radon"])
def test_decree_communal_accepts_commune_level(code):
    AleaRecord.model_validate(_alea(code=code, resolution="commune-level"))


# ---------------------------------------------------------------------------
# Provenance (FR-17) — attribution LO 2.0 obligatoire
# ---------------------------------------------------------------------------


def test_empty_attribution_rejected():
    src = dict(PROVENANCE, attribution="")
    with pytest.raises(ValidationError):
        DiagnosticRecord.model_validate(_record(georisques_source=src))


def test_bdnb_source_block_round_trips_under_alias():
    record = DiagnosticRecord.model_validate(
        _record(bdnb={"donnees": {"mat_mur_txt": "pierre"}, "_source": dict(BDNB_SOURCE)})
    )
    data = record.model_dump(by_alias=True)
    assert data["bdnb"]["_source"]["attribution"] == BDNB_SOURCE["attribution"]
    assert data["bdnb"]["donnees"] == {"mat_mur_txt": "pierre"}


# ---------------------------------------------------------------------------
# Forme racine (FR-17) — huit clés exactement, versionnée
# ---------------------------------------------------------------------------


def test_top_level_shape_and_version():
    record = DiagnosticRecord.model_validate(
        _record(bdnb={"donnees": {}, "_source": dict(BDNB_SOURCE)})
    )
    data = record.model_dump(by_alias=True)
    assert set(data.keys()) == {
        "schema_version",
        "adresse",
        "aleas",
        "bdnb",
        "georisques_source",
        "erreurs_partielles",
        "genere_le",
        "avertissement",
    }
    assert data["schema_version"] == SCHEMA_VERSION == "1.0"


def test_record_is_json_serializable():
    record = DiagnosticRecord.model_validate(
        _record(bdnb={"donnees": {"annee_construction": 1920}, "_source": dict(BDNB_SOURCE)})
    )
    parsed = json.loads(record.model_dump_json(by_alias=True))
    assert parsed["aleas"][0]["code"] == "inondation"
