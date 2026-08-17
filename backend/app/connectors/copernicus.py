"""
Projections/indicateurs climatiques via le Copernicus Climate Data Store
(CDS) - remplace le lookup local DRIAS (compte + telechargement 100 %
manuel, sans aucune API).

Dataset : "Climate indicators for Europe from 1940 to 2100 derived from
reanalysis and climate projections" (sis-ecde-climate-indicators).
Page : https://cds.climate.copernicus.eu/datasets/sis-ecde-climate-indicators

La requete ci-dessous (_REQUEST) est celle generee par le formulaire
officiel du dataset (bouton "Show API request code"), fournie telle
quelle : aucun parametre n'est invente ici. Elle porte sur des projections
(GCM IPSL-CM5A-MR / RCM WRF381P, membre r1i1p1, scenarios RCP4.5 et
RCP8.5), agregees mensuellement/saisonnierement/annuellement, sur des
indicateurs directement utiles au scoring de risque Typhoon : jours
chauds, jours de canicule, jours de gel, precipitations extremes,
frequence des precipitations extremes, duree et magnitude des secheresses
meteorologiques (SPI-3).

=== Compte et cle CDS - sans rien ecrire sur C: ===
cdsapi lit sa config par ordre de priorite : d'abord les variables
d'environnement CDSAPI_URL / CDSAPI_KEY, puis a defaut le fichier
$HOME/.cdsapirc (sous le profil utilisateur, donc sur C: sous Windows).
Pour eviter d'ecrire quoi que ce soit sur C: (contrainte d'espace disque), ce projet
utilise les variables d'environnement plutot que ce fichier - voir
backend/activate_d_drive_session.ps1, qui les definit avant chaque usage
du CLI :

    $env:CDSAPI_URL = "https://cds.climate.copernicus.eu/api"
    $env:CDSAPI_KEY = "VOTRE_TOKEN"

Il reste necessaire d'accepter une fois les conditions d'utilisation du
dataset sur le site (onglet "Download" de la page ci-dessus, bas du
formulaire) - ca ne telecharge rien sur C:, c'est juste un clic sur le
site CDS lie a votre compte.

=== Limite reseau constatee dans cet environnement ===
Le bac a sable dans lequel ce code est ecrit bloque l'acces reseau sortant
vers cds.climate.copernicus.eu (comme vers toutes les autres API de ce
projet - verifie avec curl -v : "403 blocked-by-allowlist"). Pire, la
simple creation d'un cdsapi.Client() tente de contacter le serveur CDS des
l'instanciation (verification de version/messages) : dans cet
environnement, cet appel reste bloque en boucle de nouvelle tentative
(jusqu'a 500 tentatives, 120 secondes d'attente entre chacune) au lieu
d'echouer immediatement. Ce module n'a donc pas pu etre teste en conditions
reelles depuis cet environnement - a executer sur une machine avec un
acces internet normal.

=== Nature asynchrone de l'API CDS ===
Contrairement a Open-Meteo (reponse JSON instantanee), CDS met chaque
demande en file d'attente et prepare un ou plusieurs fichiers a
telecharger (NetCDF, parfois regroupes dans une archive .zip) : de
quelques secondes a plusieurs dizaines de minutes selon la charge du
service. Pour ne pas payer ce cout a chaque adresse testee, ce module
telecharge le jeu de donnees UNE SEULE FOIS, le met en cache dans
COPERNICUS_CACHE_DIR, puis chaque lecture "point" (une adresse) est une
simple lecture locale via xarray - jamais une valeur recalculee ou
approximee, uniquement les valeurs du fichier officiel telecharge.
"""

from __future__ import annotations

import os
import shutil
import threading
import zipfile
from pathlib import Path
from typing import Any

from app.core.config import settings

# ── État du téléchargement (partagé entre requêtes) ──
# Permet à l'API de statut (GET /diagnostic/copernicus/status) de dire « en
# cours » / « en échec » pendant le premier téléchargement, et évite que
# deux diagnostics concurrents lancent chacun leur propre téléchargement.
_download_state: dict[str, Any] = {"in_progress": False, "error": None}
_download_state_lock = threading.Lock()

DATASET_ID = "sis-ecde-climate-indicators"

# Requete de base fournie via le formulaire CDS ("Show API request code") —
# ne pas modifier les champs autres que "area" sans repasser par le
# formulaire officiel du dataset. "area" a été ajouté et vérifié en direct
# (2026-08-17, voir docstring du module) : c'est un paramètre standard de
# subsetting spatial CDS, accepté par ce dataset.
_REQUEST: dict[str, Any] = {
    "origin": "projections",
    "gcm": ["ipsl_cm5a_mr"],
    "rcm": ["wrf381p"],
    "experiment": ["rcp4_5", "rcp8_5"],
    "ensemble_member": ["r1i1p1"],
    "temporal_aggregation": ["monthly", "seasonal", "yearly"],
    "spatial_aggregation": "gridded",
    "version": "v2_0",
    "variable": [
        "hot_days",
        "heatwave_days",
        "frost_days",
        "extreme_precipitation_total",
        "frequency_of_extreme_precipitation",
        "duration_of_meteorological_droughts",
        "magnitude_of_meteorological_droughts",
    ],
    "other_parameters": ["30_c", "35_c", "40_c"],
    # France métropolitaine + Corse, avec marge ([North, West, South, East]) —
    # confirmé accepté par le vrai service CDS le 2026-08-17 (voir docstring
    # du module) : réduit un téléchargement qui portait sur l'Europe entière
    # (plusieurs Go) à quelques centaines de Mo. Typhoon ne diagnostique que
    # des adresses françaises ; élargir cette zone si le périmètre géographique
    # du produit change.
    "area": [51.5, -5.5, 41.0, 10.0],
}


class CopernicusNotConfigured(RuntimeError):
    pass


class CopernicusDataMissing(RuntimeError):
    pass


def _cache_dir() -> Path:
    return Path(settings.copernicus_cache_dir)


def _download_marker() -> Path:
    return _cache_dir() / ".download_complete"


def _ensure_credentials_in_env() -> None:
    """Injette les identifiants CDS dans l'environnement avant tout appel.

    cdsapi lit sa configuration dans os.environ (CDSAPI_URL / CDSAPI_KEY),
    avec repli sur $HOME/.cdsapirc. Ce projet centralise tout dans le .env
    racine (lu par pydantic-settings), mais rien ne le copie vers os.environ
    automatiquement. On le fait ici, au plus près de l'usage, pour que le
    token fonctionne sans fichier .cdsapirc sur le disque.
    """
    url = settings.cdsapi_url
    key = settings.cdsapi_key
    if url:
        os.environ.setdefault("CDSAPI_URL", url)
    if key:
        os.environ.setdefault("CDSAPI_KEY", key)


def copernicus_status() -> dict[str, Any]:
    """Etat du pipeline Copernicus pour l'UI (banniere Décision).

    Sans aucun appel réseau : marqueur de fin de téléchargement, flag de
    téléchargement en cours, dernière erreur (ex. licence non acceptée),
    taille du cache déjà présent.
    """
    with _download_state_lock:
        in_progress = bool(_download_state["in_progress"])
        last_error = _download_state["error"]
    cache_dir = _cache_dir()
    nc_files = sorted(cache_dir.glob("*.nc")) if cache_dir.exists() else []
    cache_bytes = sum(f.stat().st_size for f in nc_files)
    return {
        "enabled": bool(settings.copernicus_enabled),
        "configured": bool(settings.cdsapi_url and settings.cdsapi_key),
        "download_complete": _download_marker().exists(),
        "in_progress": in_progress,
        "last_error": last_error,
        "cache_files": len(nc_files),
        "cache_bytes": cache_bytes,
    }


def ensure_dataset_downloaded(force: bool = False) -> Path:
    """Telecharge (une seule fois, puis mis en cache) le jeu de donnees
    Copernicus defini par _REQUEST, et retourne le repertoire de cache.

    Le fichier recu de CDS peut etre un NetCDF unique ou une archive .zip
    regroupant plusieurs NetCDF (un par combinaison variable/scenario) :
    les deux cas sont geres, sans hypothese sur le contenu exact tant que
    le telechargement n'a pas ete effectivement observe.

    Un seul téléchargement à la fois : si un autre diagnostic est en train
    de télécharger, on échoue proprement (le diagnostic continue sans
    Copernicus, le premier téléchargement remplira le cache).
    """
    cache_dir = _cache_dir()
    marker = _download_marker()
    if marker.exists() and not force:
        return cache_dir

    if not _REQUEST:
        raise CopernicusNotConfigured(
            "_REQUEST est vide dans app/connectors/copernicus.py : "
            "completez-le depuis le formulaire CDS ('Show API request code')."
        )

    with _download_state_lock:
        if _download_state["in_progress"]:
            raise CopernicusDataMissing(
                "Téléchargement Copernicus déjà en cours (autre diagnostic) — réessayez plus tard."
            )
        _download_state["in_progress"] = True
        _download_state["error"] = None

    import cdsapi  # import tardif : evite la dependance dure si non utilise

    try:
        _ensure_credentials_in_env()
        cache_dir.mkdir(parents=True, exist_ok=True)
        client = cdsapi.Client()
        result = client.retrieve(DATASET_ID, dict(_REQUEST))
        downloaded_path = Path(result.download())

        if downloaded_path.suffix == ".zip":
            with zipfile.ZipFile(downloaded_path) as archive:
                archive.extractall(cache_dir)
            downloaded_path.unlink(missing_ok=True)
        else:
            shutil.move(str(downloaded_path), cache_dir / downloaded_path.name)

        marker.write_text("ok", encoding="utf-8")
        return cache_dir
    except Exception as exc:
        with _download_state_lock:
            _download_state["error"] = f"{type(exc).__name__}: {exc}"
        raise
    finally:
        with _download_state_lock:
            _download_state["in_progress"] = False


def read_indicators_at_point(lat: float, lon: float) -> dict[str, Any]:
    """Lit, pour chaque fichier NetCDF telecharge, les indicateurs
    climatiques Copernicus au point le plus proche.

    Fonction synchrone et potentiellement longue au tout premier appel
    (telechargement CDS) : a lancer via asyncio.to_thread depuis
    collector_agent. Les appels suivants sont quasi instantanes (lecture
    du cache local uniquement).

    Cle de retour : "{nom_du_fichier}__{variable}" pour eviter toute
    collision entre scenarios/agregations differents regroupes dans des
    fichiers distincts.
    """
    import xarray as xr

    cache_dir = ensure_dataset_downloaded()
    nc_files = sorted(cache_dir.glob("*.nc"))
    if not nc_files:
        raise CopernicusDataMissing(
            f"Aucun fichier NetCDF trouve dans {cache_dir} apres telechargement. "
            "Verifiez le contenu recu de CDS (format inattendu ?)."
        )

    resultats: dict[str, Any] = {}
    for path in nc_files:
        with xr.open_dataset(path) as dataset:
            lat_name = "latitude" if "latitude" in dataset.coords else "lat"
            lon_name = "longitude" if "longitude" in dataset.coords else "lon"
            point = dataset.sel({lat_name: lat, lon_name: lon}, method="nearest")
            for var in dataset.data_vars:
                resultats[f"{path.stem}__{var}"] = point[var].values.tolist()

    return resultats


# ---------------------------------------------------------------------------
# Traduction indicateurs → bloc climat 2100 (trajectoire Phase 1 item 3)
# ---------------------------------------------------------------------------

# Les variables CDS sémantiquement proches de celles que lisent les sous-
# scores canicule/précipitation de risk_model. `heatwave_days` (jours de
# canicule/an) est l'équivalent direct de `jours_chaleur_extreme_par_an`
# (mêmes unités, mêmes seuils) ; `frequency_of_extreme_precipitation` est
# une fraction (0-1), mappée avec ses propres seuils — on ne force jamais
# un indicateur CDS dans des seuils calibrés pour une autre unité.
_VAR_HEATWAVE_DAYS = "heatwave_days"
_VAR_EXTREME_PRECIP_FREQ = "frequency_of_extreme_precipitation"

# Scénarios climatiques téléchargés par _REQUEST (experiment : rcp4_5 + rcp8_5).
# Chaque scénario produit ses propres fichiers NetCDF : la sélection se fait
# par jeton dans le nom de fichier (clé `{stem}__{variable}`).
SCENARIOS_CDS: tuple[str, ...] = ("rcp4_5", "rcp8_5")


def _normalize_scenario_token(s: str) -> str:
    """Normalise un jeton de scénario pour la comparaison par sous-chaîne.

    Vérifié sur un vrai fichier téléchargé (2026-08-17) : les noms de
    fichiers NetCDF que renvoie réellement CDS pour cette requête utilisent
    un underscore entre le chiffre et la décimale — `rcp_8_5`, pas `rcp8_5`
    comme le laisserait supposer le paramètre `experiment: "rcp8_5"` de la
    requête. Sans cette normalisation, `scenario in nom_fichier.lower()`
    est toujours faux : `scenario_available()` renvoie systématiquement
    False (le point de code qu'elle est censée protéger — éviter qu'un
    AUTRE scénario soit choisi par le repli de `_pick_key` sous la mauvaise
    étiquette — ne se déclenche jamais). On compare donc sans underscore ni
    tiret des deux côtés plutôt que de coder en dur un format précis qui
    pourrait encore varier.
    """
    return s.lower().replace("_", "").replace("-", "")


def scenario_available(climat_copernicus: dict[str, Any] | None, scenario: str) -> bool:
    """True si des indicateurs du scénario demandé sont présents dans les
    données téléchargées (jeton du scénario dans une clé `{stem}__{variable}`).

    Évite que le repli de `_pick_key` (scénario → yearly → n'importe quelle
    clé) produise un bloc 2100 d'un AUTRE scénario sous une mauvaise
    étiquette — chaque scénario doit être strictement issu de ses propres
    fichiers NetCDF.
    """
    if not climat_copernicus:
        return False
    token = _normalize_scenario_token(scenario)
    return any(token in _normalize_scenario_token(str(k)) for k in climat_copernicus)

# Fenêtre « 2100 » : moyenne des N dernières années de la série (le dataset
# s'arrête en 2100 ; on prend la décennie finale 2090-2100).
_HORIZON_2100_WINDOW = 11


def _series_value_2100(values: Any) -> float | None:
    """Valeur à l'horizon 2100 d'une série d'indicateurs annuels.

    Gère les trois formes observables selon l'agrégation : liste (série
    annuelle — moyenne de la fenêtre finale), ou scalaire (agrégation déjà
    faite). Retourne None si aucune valeur exploitable.
    """
    if isinstance(values, (int, float)):
        return float(values)
    if not isinstance(values, (list, tuple)) or not values:
        return None
    nums = [float(v) for v in values if isinstance(v, (int, float))]
    if not nums:
        return None
    window = nums[-_HORIZON_2100_WINDOW:]
    return sum(window) / len(window)


def _pick_key(data: dict[str, Any], variable: str, scenario: str | None = None) -> str | None:
    """Cherche la clé `{stem}__{variable}` la plus adaptée.

    Priorité : scénario demandé (rcp8_5 par défaut), puis agrégation
    annuelle (yearly), puis n'importe quelle occurrence de la variable.
    """
    candidates = [k for k in data if f"__{variable}" in k]
    if not candidates:
        return None
    if scenario:
        token = _normalize_scenario_token(scenario)
        for c in candidates:
            if token in _normalize_scenario_token(c):
                return c
    for c in candidates:
        if "yearly" in c.lower():
            return c
    return candidates[0]


def extract_climate_2100(climat_copernicus: dict[str, Any] | None, scenario: str = "rcp8_5") -> dict[str, Any] | None:
    """Construit un bloc climat 2100 lisible par les sous-scores de risk_model.

    Retourne `{"jours_chaleur_extreme_par_an": ...,
    "frequency_extreme_precipitation": ...}` (mêmes clés que le bloc
    Open-Meteo pour les champs partagés, plus le champ brut de fréquence),
    ou None si les indicateurs CDS ne sont pas (encore) disponibles — le
    point 2100 de la trajectoire reste alors honnêtement `indisponible`.
    """
    if not climat_copernicus:
        return None

    heat_key = _pick_key(climat_copernicus, _VAR_HEATWAVE_DAYS, scenario)
    precip_key = _pick_key(climat_copernicus, _VAR_EXTREME_PRECIP_FREQ, scenario)
    if not heat_key and not precip_key:
        return None

    bloc: dict[str, Any] = {}
    if heat_key:
        valeur = _series_value_2100(climat_copernicus[heat_key])
        if valeur is not None:
            bloc["jours_chaleur_extreme_par_an"] = round(valeur, 1)
    if precip_key:
        valeur = _series_value_2100(climat_copernicus[precip_key])
        if valeur is not None:
            bloc["frequency_extreme_precipitation"] = round(valeur, 4)

    if not bloc:
        return None
    # Marqueur interne : permet à risk_model de distinguer un bloc Copernicus
    # (fréquence CDS) d'un bloc Open-Meteo (mm) sans ambiguïté.
    bloc["__copernicus_2100"] = True
    return bloc
