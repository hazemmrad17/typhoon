# Typhoon 2 (Bastion) — Technical Spec

> ⚠️ **SUPERSEDED — 2026-08-25.** This document is retained as historical reference only. The authoritative specification is `docs/workflow/spec.md`, constrained by `constitution.md`. Where they disagree, the newer documents win. Known resolutions: D03 `niveau` is **not** part of the canonical contract (display-layer only); Copernicus, Open-Meteo, Mistral recommendations, and 3D extrusions are **deleted**, not "kept but not sold" (decisions OQ-4/OQ-5); the bulk/portfolio endpoint is a post-v1 derivative.

> Version 3.0 — 2026-08-24
> The product is the **join** between two public datasets at per-building
> resolution. Nothing else.

---

## 0. What This Product Actually Is

Géorisques is a public portal. It shows you hazard zone maps at commune
and sector level. It does **not** answer: "is *this specific building*
inside the flood polygon?"

BDNB is a public API. It gives you building materials, construction
year, DPE, geometry. It does **not** answer: "is *this building* exposed
to landslide risk?"

No government tool, no insurer, no startup currently links these two
facts at building level. You go to Géorisques, you get a zone map. You
go to BDNB, you get a building spec sheet. They don't talk to each other.

**Bastion is the join.**

For a given building address, we:

1. Geocode it (IGN/BAN) → lat/lon + commune code
2. Query Géorisques WFS with that lat/lon → test the building's
   coordinates against real hazard polygon geometries via
   point-in-polygon. "Is this building inside the flood PPR? Yes/No."
3. Query BDNB with that address → 139 vulnerability attributes
   (materials, year, DPE, height, reliability indicators)
4. Return the two results joined on the same building, with provenance
   on every field

That's the product. The unique value is steps 2–4 together. Any step in
isolation is something the buyer can get from the source directly.

### What we are NOT

| What we built | What it actually is | Verdict |
|---|---|---|
| Copernicus climate panel | Free CDS data at ~10km grid resolution, reproduced | **Decoration.** Same data, same resolution, same portal |
| Open-Meteo dashboard | Free API weather data, reproduced | **Decoration.** Fire/flood/heat/wind/seasonal — already available for free |
| WMS map overlays | Géorisques/BRGM raster maps, re-rendered | **Decoration.** Same map, same resolution |
| 3D building extrusions | BDNB geometry + height, visualized | **Decoration.** Pretty but not data product |
| Risk scoring / D03 bands | Internal display labels, not auditable by insurers | **Liability.** Insurers can't use third-party scores under Solvency II |
| Mistral AI recommendations | LLM narrative over raw data | **Liability.** Hallucination risk on regulatory documents |

~~None of these are cut from the codebase — they stay as UI features or
are repositioned (see §7).~~ **Update 2026-08-25:** superseded by decision
OQ-4/OQ-5 — these are deleted from the codebase (see `docs/workflow/spec.md` FR-24/FR-25). But they are not the product. The product is
the join.

---

## 1. The Join — Per-Building Data Contract

### 1.1 Endpoint

```
POST /diagnostic/adresse
Body: { "adresse": "10 rue de Rivoli, 75004 Paris" }
```

### 1.2 Response structure

```jsonc
{
  // ─── Geocoding ─────────────────────────────────────────────────
  "adresse": {
    "label": "10 Rue de Rivoli 75004 Paris",
    "citycode": "75056",
    "postcode": "75004",
    "city": "Paris",
    "lat": 48.8566,
    "lon": 2.3522,
    "score": 0.95
  },

  // ─── THE JOIN: hazard exposure × vulnerability ──────────────────
  // This is the product. Two sections, same building, provenance on each.
  "georisques": {
    "donnees": { /* 13 hazard objects (§2) */ },
    "batiment": { /* WFS per-building results (§3) */ },
    "_source": {
      "provider": "Géorisques",
      "url": "https://www.georisques.gouv.fr",
      "recuperee_le": "2026-08-24T10:00:00+00:00"
    }
  },
  "bdnb": {
    "donnees": {
      "cle_interop_adr": "75056_0100_00010",
      "batiment": { /* 139-field building object (§4) */ },
      "autres_batiments_meme_adresse": []
    },
    "_source": {
      "provider": "BDNB",
      "url": "https://api.bdnb.io",
      "recuperee_le": "2026-08-24T10:00:00+00:00"
    }
  },

  // ─── Errors ────────────────────────────────────────────────────
  "erreurs_sources": [],
  "genere_le": "2026-08-24T10:00:00+00:00"
}
```

**No scoring. No composite. No multiplier. No recommendations.**

The insurer receives two facts about the same building:
- "Is it in a hazard zone?" (Géorisques WFS, per-building)
- "What is it made of?" (BDNB, 139 fields)

Their actuaries decide what to do with that information.

---

## 2. Hazard Exposure (Géorisques WFS — the differentiator)

### 2.1 Why this is unique

The Géorisques REST API answers: "Is this commune affected by flood
risk?" The WFS answers: "Is this specific building's centroid inside
this specific polygon?"

The WFS is the only way to get a building-level verdict. There is no
alternative API, no faster way, no "go look at the map" equivalent. The
Géorisques portal itself does not perform point-in-polygon tests for
arbitrary coordinates — it only shows raster overlays at sector level.

### 2.2 Hazards resolved

| Hazard | WFS layers | Method |
|---|---|---|
| Inondation (flood) | `PPRN_PERIMETRE_INOND`, `PPRN_PERIMETRE_SUBMAR` | Point-in-polygon |
| Mouvement de terrain | `PPRN_PERIMETRE_MVT` | Point-in-polygon |
| Séisme (PPRS only) | `PPRN_PERIMETRE_SEISME` | Point-in-polygon |
| Avalanche | `PPRN_PERIMETRE_AVALANCHE` | Point-in-polygon |
| Feu de forêt | `PPRN_PERIMETRE_FEU` | Point-in-polygon |
| SSP (contaminated sites) | `SSP_CLASSIF_SIS_GE` | Point-in-polygon + 200m proximity |
| Canalisations (TMD) | `C_GAZ`, `C_HYDROCARBURES`, `C_PRODUITS_CHIM` | Point-in-polygon + 200m proximity |
| PPRT (industrial risk) | `PPRT_PERIMETRE_RISQIND` | Point-in-polygon |
| Mines | `PPRM_PERIMETRE_MINIER` | Point-in-polygon |

### 2.3 Per-hazard output

```jsonc
{
  "code": "inondation",
  "libelle": "Inondation",
  "present": true,          // true = inside polygon; false = outside; null = WFS failed
  "present_commune": true,  // commune-level (always populated if commune data succeeded)
  "resolution": "per-building, polygon-checked",  // THE key field for insurers
  // ⚠️ 2026-08-25: the "niveau" field shown below in the original draft was
  // REMOVED from the canonical contract — D03 bands are display-layer only
  // (constitution §2). See docs/workflow/spec.md FR-18.
  "zonage": "Dans un périmètre PPR inondation",
  "hauteur_eau_m": 1.5,     // real flood depth from PPRI (if available)
  "zone_sismique": "3",     // seismic zone 1-5 (if applicable)
  "catnat_historique": [...],// official CatNat declarations
  "source": "georisques",
  "url_detail": "https://www.georisques.gouv.fr/risques/inondations",
  "erreur": null
}
```

**The `resolution` field is critical.** An actuary must know whether
"present" means "this building is inside the polygon" or "this hazard
exists somewhere in the commune, possibly 800m away." These are
fundamentally different facts.

### 2.4 Communal fallback

When the WFS is unavailable (5xx, timeout), or when the hazard has no
vector layer (seismic zoning is decree-based by commune, radon potential
is communal), `resolution` falls back to `"commune-level estimate"` and
`present` reflects whether the hazard was found in INSEE commune data.

**This is not a lesser version of the same thing.** It is a different
fact: "the commune is affected" vs. "the building is affected." An
actuary must never conflate them.

### 2.5 WFS implementation detail

The WFS service (`georisques.gouv.fr/services`) only serves GML 3.2 —
no JSON. The connector parses GML via `xml.etree.ElementTree`,
implements ray-casting point-in-polygon, and handles EPSG:4326 axis
order (lat/lon in GML vs. lon/lat in our schema).

The WFS must run on a **dedicated httpx.AsyncClient** — the Géorisques
gateway binds keep-alive to one backend per connection. Mixing REST
(`/api/v1`) and WFS (`/services`) on the same client causes 404 on all
subsequent requests.

### 2.6 Paris / Lyon / Marseille

IGN geocoder returns arrondissement codes (75101–75120), but Géorisques
stores communal data under parent communes (75056). The connector
translates: Paris 75101–75120 → 75056, Lyon 69381–69389 → 69123,
Marseille 13201–13216 → 13055.

---

## 3. WFS Per-Building Resolution Detail

The WFS connector (`resolve_per_building`) returns:

```jsonc
{
  "batiment": {
    "inondation": { "present": true, "resolution": "per-building", "count": 2 },
    "ppr": { "present": true, "resolution": "per-building", "count": 3 },
    "ppr_par_type": {
      "inondation": { "present": true, "resolution": "per-building", "count": 2 },
      "mouvement_terrain": { "present": false, "resolution": "per-building", "count": 0 },
      "feu_foret": { "present": null, "resolution": "commune-level" },
      "avalanche": { "present": null, "resolution": "commune-level" },
      "seisme": { "present": null, "resolution": "commune-level" }
    },
    "ssp": { "present": true, "resolution": "per-building", "count": 1, "closest_distance_m": 120.5 },
    "canalisations": { "present": false, "resolution": "per-building", "count": 0 }
  }
}
```

**Why `ppr_par_type` matters:** The aggregate `ppr` tells you "any PPR
touches this building." The `ppr_par_type` breakdown tells you *which
type* — a building can be inside a seismic PPR but outside a flood PPR.
The aggregate alone is insufficient for per-peril actuarial work.

---

## 4. Vulnerability Attributes (BDNB — the second half of the join)

### 4.1 What BDNB gives us

The BDNB returns up to 139 fields per building group. We pass the full
object through — no selection, no transformation, no filtering. The
insurer picks what matters to their model.

**Key field categories:**

| Category | Key fields | Actuarial relevance |
|---|---|---|
| Identity | `batiment_groupe_id`, `code_commune_insee` | Building ID, location |
| Construction | `annee_construction`, `nb_niveau`, `hauteur_mean` | Age, height, occupancy |
| Materials | `mat_mur_txt`, `mat_toit_txt` | Structural vulnerability |
| Energy | `classe_bilan_dpe`, `conso_5_usages_ep_m2` | Energy efficiency proxy |
| Geometry | `geom_groupe` (GeoJSON, EPSG:2154) | Footprint, area |
| Reliability | `fiabilite_cr_adr_niv_1`, `fiabilite_hauteur`, `contient_fictive_geom_groupe` | Data quality confidence |
| Risk (BDNB) | `alea_argile`, `alea_radon`, `alea_sismique` | BDNB's own risk flags |

### 4.2 Reliability indicators

The BDNB includes built-in data quality flags. These are **BDNB's own
assessment**, not ours. Insurers should use them to weight or filter:

| Field | Values | Meaning |
|---|---|---|
| `fiabilite_cr_adr_niv_1` | A/B/C | Address match confidence |
| `fiabilite_hauteur` | A/B/C | Height data source quality |
| `fiabilite_emprise_sol` | A/B/C | Footprint data quality |
| `contient_fictive_geom_groupe` | true/false | Geometry may be interpolated |

### 4.3 Why BDNB alone isn't enough

An insurer could call `api.bdnb.io` directly and get the same 139
fields. But they'd have no hazard data — just a building spec sheet.

An insurer could look up their property on Géorisques and see zone maps.
But they'd have no building data — just a hazard overview.

**The join is the product.** "This specific building, made of
unreinforced masonry, built in 1920, with DPE rating F, is *inside*
the flood PPR perimeter." That sentence cannot be produced by either
source alone.

---

## 5. Error Handling

### 5.1 Source isolation

Each source (BDNB, Géorisques) runs inside `_safe_call` — any exception
is caught and recorded in `erreurs_sources`. The diagnostic never
returns 500 because one source failed. Partial data is always returned.

### 5.2 Null semantics

- `present = true` → exposed (WFS polygon test passed)
- `present = false` → not exposed (WFS polygon test failed, building
  is outside the zone)
- `present = null` → unknown (WFS unavailable, or hazard has no vector
  layer — commune-level data only)

**Never infer `true`/`false` from a failed source.** `null` means "we
don't know."

---

## 6. Appendix A: Things We Keep But Don't Sell

> ⚠️ **Superseded 2026-08-25 (OQ-4/OQ-5):** the items below are **deleted**, not
> retained — connectors, routes, schemas, tests, and frontend surfaces all go
> (see `docs/workflow/spec.md` FR-24/FR-25). Subsections kept for the record.

### 6.1 Copernicus CDS Climate Projections

Grid-cell resolution (~10km). Every building in a 10km radius gets the
identical number. The CDS portal provides the same data for free.

**Retained as:** `copernicus` field in the response (when enabled),
served from local NetCDF cache.

**Display rule:** Any panel showing this data must carry:
*"Données régionales — résolution ~10km. Ne pas interpréter comme
applicable à un bâtiment individuel."*

### 6.2 Open-Meteo Real-Time Weather

Six connectors (flood, fire, heat, wind, seasonal, soil moisture) served
via a separate `GET /api/climate` endpoint. Regional resolution. Free
API. Not part of the per-building diagnostic.

### 6.3 WMS Map Overlays

BRGM raster overlays on the map. Same resolution as the Géorisques
portal. Visual context, not data.

### 6.4 3D Building Extrusions

BDNB geometry + height, rendered as MapLibre fill-extrusions. Visual
exploration tool, not a data product.

### 6.5 Scoring / D03 Bands

The `niveau` field (`tres_faible` → `critique`) is an internal display
label for coloring the `zonage` text. It is NOT a product score. The
D03 band system is used for frontend rendering only — it is not emitted
as a standalone output and must never be presented as a risk assessment.

### 6.6 Mistral AI Recommendations

Retained as optional UI enrichment. Must not be presented as professional
advice. The `RecommandationsIA` field is always nullable and always
labeled as AI-generated.

---

## 7. What to Build Next (Spec-Driven)

The spec defines the join. The next work items should all strengthen
the join or make it more sellable — not add more decoration:

### 7.1 Strengthen the join

- **Validate WFS results against known exposed buildings.** Pick 10
  addresses in documented flood zones, verify the WFS says `present:
  true`. Pick 10 outside, verify `present: false`. Build a test suite
  that proves the join works.

- **Improve BDNB → hazard linkage.** The BDNB `alea_argile` field is
  BDNB's own clay risk flag. Cross-reference it with the Géorisques RGA
  hazard. When they disagree, surface the discrepancy — that's a data
  quality signal the insurer doesn't get anywhere else.

- **Add CatNat frequency as a joined metric.** "This building has been
  declared CatNat 3 times in the last 10 years" + "it's made of X
  material, built in Y year" = a joined fact neither source provides
  alone.

### 7.2 Make the join sellable

- **Portfolio endpoint for insurers.** Accept a CSV of addresses, run
  the join for each, return a CSV where each row is a building with its
  hazard exposure + vulnerability attributes. This is the data feed
  actuaries actually want — not an interactive map.

- **Resolution badge.** Every hazard pill in the UI shows a green
  "per-building" or amber "commune-level" badge. This makes the quality
  difference visible and auditable.

- **Provenance per field.** Every field in the response has a `_source`
  tag. Actuaries can trace any value back to its origin. This is
  Solvency II defensibility — no black boxes.

### 7.3 Stop building

- No more Copernicus variables. The resolution can't improve.
- No more weather dashboard features. Free API, free data, no moat.
- No more scoring formulas. Insurers can't use them.
- No more map reproduction at source resolution. It's not data.
