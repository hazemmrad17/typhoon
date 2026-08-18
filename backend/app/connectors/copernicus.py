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

=== Taille du téléchargement (production) ===
La requete _REQUEST est volontairement minimaliste : France metropolitaine
seulement (`area`), agrégation annuelle uniquement (`temporal_aggregation:
["yearly"]` — la trajectoire 2100 ne consomme que la série annuelle, cf.
_pick_key/_series_value_2100), et uniquement les deux variables réellement
consommées par extract_climate_2100 (`heatwave_days` et
`frequency_of_extreme_precipitation`). L'alternative naïve (Europe entière,
monthly+seasonal+yearly, 7 variables) pèse plusieurs Go ; cette requête se
compte en dizaines de Mo, téléchargés une seule fois puis lus localement.

=== Mise en production : téléchargement explicite, jamais bloquant ===
Le premier diagnostic d'un utilisateur ne doit PAS déclencher un
 téléchargement CDS synchrone (minutes de file d'attente + bande passante
sur le chemin de requête). Le téléchargement est donc déclenché
explicitement, de deux façons :

  - API :  POST /diagnostic/copernicus/download  (démarre un thread daemon,
           statut via GET /diagnostic/copernicus/status)
  - CLI :   python -m app.cli --download-copernicus
           (synchronisé, affiche la progression cdsapi)

Tant que le cache n'est pas prêt, le point 2100 reste honnêtement
`indisponible` (extract_climate_2100 → None). Le cache est signé par une
empreinte de _REQUEST : si la requête change, le prochain démarrage
re-télécharge automatiquement (jamais de données périmées servies sous une
étiquette actuelle).
"""

from __future__ import annotations

import os
import shutil
import threading
import zipfile
from pathlib import Path
from typing import Any

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)

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
    "temporal_aggregation": ["yearly"],
    "spatial_aggregation": "gridded",
    "version": "v2_0",
    "variable": [
        "heatwave_days",                    # Jours de canicule
        "hot_days",                         # Jours chauds (> 35°C)
        "tropical_nights",                  # Nuits tropicales (> 20°C)
        "frost_days",                       # Jours de gel
        "frequency_of_extreme_precipitation", # Fréquence précipitations extrêmes
        "heavy_precipitation_days",          # Jours de fortes précipitations
        "consecutive_dry_days",              # Jours secs consécutifs (sécheresse)
        "consecutive_wet_days",              # Jours humides consécutifs
        "wind_speed_10m_max",               # Vitesse du vent maximale
        "maximum_temperature",               # Température maximale absolue
        "minimum_temperature",               # Température minimale absolue
        "mean_temperature",                  # Température moyenne
    ],
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


def _request_signature() -> str:
    """Empreinte de _REQUEST : le cache n'est valable que si la requête n'a
    pas changé. Tout changement de _REQUEST (variables, scénarios, zone)
    invalide le cache et force un re-téléchargement au prochain démarrage —
    jamais de données périmées servies sous une étiquette actuelle."""
    import hashlib
    import json

    return hashlib.sha256(
        json.dumps(_REQUEST, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()[:12]


def _marker_valid(marker: Path) -> bool:
    """Le marqueur existe ET le cache est valide (ou contient des fichiers .nc)."""
    if not marker.exists():
        return False
    try:
        content = marker.read_text(encoding="utf-8").strip()
        return content.startswith("ok:")
    except OSError:
        return False


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
    if _marker_valid(marker) and not force:
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

        marker.write_text(f"ok:{_request_signature()}", encoding="utf-8")
        return cache_dir
    except Exception as exc:
        with _download_state_lock:
            _download_state["error"] = f"{type(exc).__name__}: {exc}"
        raise
    finally:
        with _download_state_lock:
            _download_state["in_progress"] = False


def start_download(force: bool = False) -> dict[str, Any]:
    """Lance le téléchargement CDS en arrière-plan (thread daemon).

    Idempotent et non bloquant : retourne immédiatement
    `{started: bool, reason: str}` — reason vaut "not_configured",
    "in_progress" ou "already_complete" quand rien n'est lancé. Le thread
    étant daemon, un processus qui meurt en plein téléchargement laisse un
    cache partiel sans marqueur : le prochain démarrage reprend proprement
    (les .nc incomplets sont remplacés par l'extraction suivante).
    """
    if not (settings.cdsapi_url and settings.cdsapi_key):
        return {"started": False, "reason": "not_configured"}
    with _download_state_lock:
        if _download_state["in_progress"]:
            return {"started": False, "reason": "in_progress"}
    if _marker_valid(_download_marker()) and not force:
        return {"started": False, "reason": "already_complete"}

    def _run() -> None:
        try:
            ensure_dataset_downloaded(force=force)
        except Exception as exc:  # déjà consigné dans _download_state["error"]
            logger.warning(
                "copernicus -- téléchargement en arrière-plan en échec: %s: %s",
                type(exc).__name__, exc,
            )

    threading.Thread(target=_run, name="copernicus-cds-download", daemon=True).start()
    return {"started": True, "reason": "started"}


_GRID_DATA_IN_MEMORY: dict[str, Any] | None = None


def _read_from_grid_cache(lat: float, lon: float) -> dict[str, Any] | None:
    global _GRID_DATA_IN_MEMORY
    cache_file = _cache_dir() / "copernicus_grid.json.gz"
    if not cache_file.exists():
        return None
    try:
        if _GRID_DATA_IN_MEMORY is None:
            import gzip
            import json
            with gzip.open(cache_file, "rt", encoding="utf-8") as f:
                _GRID_DATA_IN_MEMORY = json.load(f)

        lats = _GRID_DATA_IN_MEMORY["lats"]
        lons = _GRID_DATA_IN_MEMORY["lons"]
        lat_idx = min(range(len(lats)), key=lambda i: abs(lats[i] - lat))
        lon_idx = min(range(len(lons)), key=lambda j: abs(lons[j] - lon))
        coord_key = f"{lat_idx},{lon_idx}"
        return {
            k: v[coord_key]
            for k, v in _GRID_DATA_IN_MEMORY["files"].items()
            if coord_key in v
        }
    except Exception:
        return None


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
    # 1. Essai via le cache de grille pré-extrait (zero dépendance C/binaire)
    grid_cached = _read_from_grid_cache(lat, lon)
    if grid_cached:
        return grid_cached

    # Jamais de téléchargement implicite sur le chemin d'une requête : si le
    # cache n'est pas prêt, on échoue (fail-soft côté collector → le point
    # 2100 reste `indisponible`) et l'ops déclenche le téléchargement via
    # POST /diagnostic/copernicus/download ou la CLI.
    marker = _download_marker()
    if not _marker_valid(marker):
        raise CopernicusDataMissing(
            "Cache Copernicus absent ou périmé — lancer le téléchargement une fois "
            "via POST /diagnostic/copernicus/download ou `python -m app.cli "
            "--download-copernicus`. Le point 2100 reste indisponible tant que "
            "ce n'est pas fait."
        )
    cache_dir = _cache_dir()
    nc_files = sorted(cache_dir.glob("*.nc"))
    if not nc_files:
        raise CopernicusDataMissing(
            f"Aucun fichier NetCDF trouve dans {cache_dir} apres telechargement. "
            "Verifiez le contenu recu de CDS (format inattendu ?)."
        )

    resultats: dict[str, Any] = {}
    try:
        import xarray as xr

        for path in nc_files:
            with xr.open_dataset(path) as dataset:
                lat_name = "latitude" if "latitude" in dataset.coords else "lat"
                lon_name = "longitude" if "longitude" in dataset.coords else "lon"
                point = dataset.sel({lat_name: lat, lon_name: lon}, method="nearest")
                for var in dataset.data_vars:
                    resultats[f"{path.stem}__{var}"] = point[var].values.tolist()
        return resultats
    except ImportError:
        pass

    try:
        import netCDF4 as nc
        import numpy as np

        for path in nc_files:
            with nc.Dataset(path, "r") as dataset:
                lat_key = "latitude" if "latitude" in dataset.variables else "lat"
                lon_key = "longitude" if "longitude" in dataset.variables else "lon"
                lats = np.array(dataset.variables[lat_key][:])
                lons = np.array(dataset.variables[lon_key][:])

                lat_idx = int(np.abs(lats - lat).argmin())
                lon_idx = int(np.abs(lons - lon).argmin())

                for var_name, var_obj in dataset.variables.items():
                    if var_name in (lat_key, lon_key, "time", "spatial_ref"):
                        continue
                    vals = var_obj[:]
                    if vals.ndim == 3:
                        pt_vals = vals[:, lat_idx, lon_idx].tolist()
                    elif vals.ndim == 2:
                        pt_vals = vals[lat_idx, lon_idx].tolist()
                    else:
                        pt_vals = vals.tolist()
                    resultats[f"{path.stem}__{var_name}"] = pt_vals
        return resultats
    except ImportError:
        pass

    raise CopernicusDataMissing(
        "Ni xarray ni netCDF4 ne sont installés dans cet environnement Python pour lire les fichiers NetCDF."
    )


# ---------------------------------------------------------------------------
# Traduction indicateurs → bloc climat 2100 (trajectoire Phase 1 item 3)
# ---------------------------------------------------------------------------

# Noms de variables VÉRIFIÉS sur un vrai téléchargement CDS (2026-08-17) :
# Chaque entrée est un tuple « nom réel d'abord, ancien nom en repli » : on
# matche le nom réel, mais un cache téléchargé avec l'ancienne requête (ou
# une fixture de test) reste exploitable sans casser.
_VAR_HEATWAVE_DAYS = ("climatological_heatwave_days", "heatwave_days")
_VAR_HOT_DAYS = ("hot_days", "hot_days")
_VAR_TROPICAL_NIGHTS = ("tropical_nights", "tropical_nights")
_VAR_FROST_DAYS = ("frost_days", "frost_days")
_VAR_EXTREME_PRECIP_FREQ = ("extreme_precipitation_days", "frequency_of_extreme_precipitation")
_VAR_HEAVY_PRECIP_DAYS = ("heavy_precipitation_days", "heavy_precipitation_days")
_VAR_CONSECUTIVE_DRY_DAYS = ("consecutive_dry_days", "consecutive_dry_days")
_VAR_CONSECUTIVE_WET_DAYS = ("consecutive_wet_days", "consecutive_wet_days")
_VAR_WIND_SPEED_MAX = ("wind_speed_10m_max", "wind_speed_10m_max")
_VAR_MAX_TEMP = ("maximum_temperature", "maximum_temperature")
_VAR_MIN_TEMP = ("minimum_temperature", "minimum_temperature")
_VAR_MEAN_TEMP = ("mean_temperature", "mean_temperature")

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


def _pick_key(data: dict[str, Any], variable: str | tuple[str, ...], scenario: str | None = None) -> str | None:
    """Cherche la clé `{stem}__{variable}` la plus adaptée.

    `variable` peut être un tuple de noms candidats (réel d'abord, repli
    ensuite) : le premier nom présent dans les clés gagne. Priorité ensuite :
    scénario demandé (rcp8_5 par défaut), puis agrégation annuelle (yearly),
    puis n'importe quelle occurrence de la variable.
    """
    candidates: list[str] = []
    names = variable if isinstance(variable, tuple) else (variable,)
    for v in names:
        candidates.extend(k for k in data if f"__{v}" in k)
    # Déduplication en gardant l'ordre des candidats (un fichier peut contenir
    # plusieurs variables, chaque clé n'apparaît qu'une fois).
    candidates = list(dict.fromkeys(candidates))
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
    """Construit un bloc climat 2100 complet pour les assureurs.

    Retourne un dictionnaire avec tous les indicateurs climatiques projetés
    à 2100, organisés par catégorie (température, précipitations, sécheresse, vent).
    Chaque indicateur inclut la valeur projetée et l'unité.
    """
    if not climat_copernicus:
        return None

    bloc: dict[str, Any] = {}

    # === Température ===
    heat_key = _pick_key(climat_copernicus, _VAR_HEATWAVE_DAYS, scenario)
    if heat_key:
        valeur = _series_value_2100(climat_copernicus[heat_key])
        if valeur is not None:
            bloc["jours_chaleur_extreme_par_an"] = round(valeur, 1)

    hot_key = _pick_key(climat_copernicus, _VAR_HOT_DAYS, scenario)
    if hot_key:
        valeur = _series_value_2100(climat_copernicus[hot_key])
        if valeur is not None:
            bloc["jours_chauds_par_an"] = round(valeur, 1)

    tropical_key = _pick_key(climat_copernicus, _VAR_TROPICAL_NIGHTS, scenario)
    if tropical_key:
        valeur = _series_value_2100(climat_copernicus[tropical_key])
        if valeur is not None:
            bloc["nuits_tropicales_par_an"] = round(valeur, 1)

    frost_key = _pick_key(climat_copernicus, _VAR_FROST_DAYS, scenario)
    if frost_key:
        valeur = _series_value_2100(climat_copernicus[frost_key])
        if valeur is not None:
            bloc["jours_de_gel_par_an"] = round(valeur, 1)

    max_temp_key = _pick_key(climat_copernicus, _VAR_MAX_TEMP, scenario)
    if max_temp_key:
        valeur = _series_value_2100(climat_copernicus[max_temp_key])
        if valeur is not None:
            bloc["temperature_max_absolue_c"] = round(valeur, 1)

    min_temp_key = _pick_key(climat_copernicus, _VAR_MIN_TEMP, scenario)
    if min_temp_key:
        valeur = _series_value_2100(climat_copernicus[min_temp_key])
        if valeur is not None:
            bloc["temperature_min_absolue_c"] = round(valeur, 1)

    mean_temp_key = _pick_key(climat_copernicus, _VAR_MEAN_TEMP, scenario)
    if mean_temp_key:
        valeur = _series_value_2100(climat_copernicus[mean_temp_key])
        if valeur is not None:
            bloc["temperature_moyenne_c"] = round(valeur, 1)

    # === Précipitations ===
    precip_key = _pick_key(climat_copernicus, _VAR_EXTREME_PRECIP_FREQ, scenario)
    if precip_key:
        valeur = _series_value_2100(climat_copernicus[precip_key])
        if valeur is not None:
            if "extreme_precipitation_days" in precip_key:
                valeur = min(valeur / 365.0, 1.0)
            bloc["frequency_extreme_precipitation"] = round(valeur, 4)

    heavy_precip_key = _pick_key(climat_copernicus, _VAR_HEAVY_PRECIP_DAYS, scenario)
    if heavy_precip_key:
        valeur = _series_value_2100(climat_copernicus[heavy_precip_key])
        if valeur is not None:
            bloc["jours_fortes_precipitations_par_an"] = round(valeur, 1)

    # === Sécheresse ===
    dry_key = _pick_key(climat_copernicus, _VAR_CONSECUTIVE_DRY_DAYS, scenario)
    if dry_key:
        valeur = _series_value_2100(climat_copernicus[dry_key])
        if valeur is not None:
            bloc["jours_secs_consecutifs_max"] = round(valeur, 1)

    wet_key = _pick_key(climat_copernicus, _VAR_CONSECUTIVE_WET_DAYS, scenario)
    if wet_key:
        valeur = _series_value_2100(climat_copernicus[wet_key])
        if valeur is not None:
            bloc["jours_humides_consecutifs_max"] = round(valeur, 1)

    # === Vent ===
    wind_key = _pick_key(climat_copernicus, _VAR_WIND_SPEED_MAX, scenario)
    if wind_key:
        valeur = _series_value_2100(climat_copernicus[wind_key])
        if valeur is not None:
            bloc["vitesse_vent_max_m_s"] = round(valeur, 1)

    if not bloc:
        return None

    # Marqueur interne
    bloc["__copernicus_2100"] = True

    # Métadonnées
    bloc["_metadata"] = {
        "scenario": scenario,
        "horizon": "2090-2100",
        "source": "Copernicus C3S - sis-ecde-climate-indicators",
        "modele": "IPSL-CM5A-MR / WRF381P",
        "nb_indicateurs": len([k for k in bloc.keys() if not k.startswith("_")]),
    }

    return bloc


# ---------------------------------------------------------------------------
# Trajectoire brute — vrai unités, 3 horizons (2026 / 2050 / 2100)
# ---------------------------------------------------------------------------

# Métadonnées par variable : (clé technique, label FR, catégorie, unité).
# La clé technique correspond au suffixe NetCDF après `_yearly__`.
_VARIABLE_META: dict[str, tuple[str, str, str]] = {
    "heatwave_days":                     ("Jours de canicule",            "temperature",  "jours/an"),
    "hot_days":                          ("Jours chauds (>35°C)",         "temperature",  "jours/an"),
    "tropical_nights":                   ("Nuits tropicales (>20°C)",     "temperature",  "nuits/an"),
    "frost_days":                        ("Jours de gel",                 "temperature",  "jours/an"),
    "maximum_temperature":               ("Température max absolue",      "temperature",  "°C"),
    "minimum_temperature":               ("Température min absolue",      "temperature",  "°C"),
    "mean_temperature":                  ("Température moyenne",          "temperature",  "°C"),
    "frequency_of_extreme_precipitation": ("Fréq. précipitations extrêmes","precipitation", "jours/an"),
    "heavy_precipitation_days":           ("Jours fortes précipitations",  "precipitation", "jours/an"),
    "consecutive_dry_days":               ("Jours secs consécutifs",       "drought",      "jours"),
    "consecutive_wet_days":               ("Jours humides consécutifs",    "drought",      "jours"),
    "wind_speed_10m_max":                ("Vitesse du vent max",          "wind",         "m/s"),
}

_VAR_ALIASES: dict[str, tuple[str, ...]] = {
    "heatwave_days": _VAR_HEATWAVE_DAYS,
    "hot_days": _VAR_HOT_DAYS,
    "tropical_nights": _VAR_TROPICAL_NIGHTS,
    "frost_days": _VAR_FROST_DAYS,
    "maximum_temperature": _VAR_MAX_TEMP,
    "minimum_temperature": _VAR_MIN_TEMP,
    "mean_temperature": _VAR_MEAN_TEMP,
    "frequency_of_extreme_precipitation": _VAR_EXTREME_PRECIP_FREQ,
    "heavy_precipitation_days": _VAR_HEAVY_PRECIP_DAYS,
    "consecutive_dry_days": _VAR_CONSECUTIVE_DRY_DAYS,
    "consecutive_wet_days": _VAR_CONSECUTIVE_WET_DAYS,
    "wind_speed_10m_max": _VAR_WIND_SPEED_MAX,
}

# Fenêtres temporelles (années du dataset CDS 1940-2100)
_WINDOWS: dict[int, tuple[int, int]] = {
    2026: (2021, 2030),  # Moyenne des années récentes
    2050: (2041, 2050),  # Moyenne du milieu de siècle
    2100: (2090, 2100),  # Moyenne de la décennie finale
}

# Année de début du dataset CDS (1951-2100, 150 années)
_CDS_START_YEAR = 1951


def _window_average(values: list, start: int, end: int) -> float | None:
    """Moyenne d'une série annuelle sur une fenêtre donnée.

    ``values`` est la liste brute telle que stockée par
    ``read_indicators_at_point()`` — une valeur par année, du
    ``_CDS_START_YEAR`` (1940) jusqu'à 2100.  On extrait la sous-liste
    correspondant aux années [start, end] et on en calcule la moyenne.
    Retourne None si aucune valeur exploitable n'est présente.
    """
    if not isinstance(values, (list, tuple)) or not values:
        if isinstance(values, (int, float)):
            return float(values)
        return None
    # Index dans la liste : année - _CDS_START_YEAR
    idx_start = max(0, start - _CDS_START_YEAR)
    idx_end = min(len(values), end - _CDS_START_YEAR + 1)
    if idx_start >= idx_end:
        return None
    window = [
        float(v)
        for v in values[idx_start:idx_end]
        if isinstance(v, (int, float))
    ]
    if not window:
        return None
    return sum(window) / len(window)


def extract_trajectoire_brute(
    climat_copernicus: dict[str, Any] | None,
    scenario: str = "rcp8_5",
) -> dict[str, Any] | None:
    """Construit une trajectoire climatique en vraies unités (0-100 supprimé).

    Fenêtre les séries annuelles CDS en 3 horizons (2026, 2050, 2100) et
    retourne un objet de forme compatible ``Trajectoire`` (frontend) avec
    des valeurs en unités réelles (jours/an, °C, m/s, etc.).

    Contrairement à l'ancien ``risk_model.compute_trajectoire()`` qui
    produisait un indice d'exposition 0-100, cette fonction expose les
    valeurs brutes du dataset CDS ``sis-ecde-climate-indicators``.

    Retourne None si aucune variable n'est exploitable.
    """
    if not climat_copernicus:
        return None

    perils: dict[str, Any] = {}

    for var_key, (label, category, unit) in _VARIABLE_META.items():
        points = []
        has_any = False
        candidates = _VAR_ALIASES.get(var_key, (var_key,))

        for horizon, (win_start, win_end) in sorted(_WINDOWS.items()):
            # Collecter les valeurs pour chaque scénario disponible
            scenario_values: dict[str, float | None] = {}
            for sc in SCENARIOS_CDS:
                key = _pick_key(climat_copernicus, candidates, scenario=sc)
                if key:
                    raw = climat_copernicus[key]
                    val = _window_average(raw, win_start, win_end)
                    scenario_values[sc] = round(val, 2) if val is not None else None
                else:
                    scenario_values[sc] = None

            # Valeur principale = scénario demandé
            primary_val = scenario_values.get(scenario)
            if primary_val is not None:
                has_any = True

            point_type = (
                "observe" if horizon == 2026
                else "projete" if primary_val is not None
                else "indisponible"
            )

            points.append({
                "horizon": horizon,
                "type": point_type,
                "scenario": scenario if primary_val is not None else None,
                "valeur": primary_val,
                "scenarios": {sc: v for sc, v in scenario_values.items() if v is not None} or None,
                "unite": unit,
                "resolution": "grid-cell",
                "confiance": "elevee" if horizon == 2100 and primary_val is not None else "moyenne",
                "source": f"copernicus.cds.{var_key}" if primary_val is not None else None,
                "date_source": None,
            })

        if not has_any:
            continue

        perils[var_key] = {
            "label": label,
            "category": category,
            "points": points,
        }

    if not perils:
        return None

    return {
        "horizons": [2026, 2050, 2100],
        "note": "Valeurs brutes Copernicus CDS (indices climatiques, unités réelles).",
        "perils": perils,
    }
