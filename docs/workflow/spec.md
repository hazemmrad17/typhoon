# Spec — Typhoon v1: Per-Building Hazard × Vulnerability Contract

**Status:** implemented (2026-08-25) — FR-01..FR-28 livrés ; certification T008 en attente de qualification portail ; calibration T016 en attente d'exécution live
**Owner:** Hazem
**Date:** 2026-08-25
**Related:** `docs/workflow/concept.md` (source material) · `constitution.md` (constraints) · `docs/workflow/01-brainstorm-notes.md` (decision log)
**Supersedes:** `docs/TECHNICAL_SPEC.md` v3.0 (kept as historical reference; contradictions resolved below)

---

## Summary

Typhoon v1 is a per-building climate-risk **data service** for French insurers. An underwriter submits one French address and receives one canonical JSON record joining hazard exposure (Géorisques WFS point-in-polygon tests) to building vulnerability (BDNB attributes, verbatim), with provenance and a resolution level on every fact. No scores, no AI narratives, no reproduced source portals — the join is the product.

## Goals

- From the underwriter's perspective: paste an address, get a regulator-defensible answer to "is *this building* exposed, and what is it made of?" — in one call, with the quality of each fact explicitly labeled.
- Make the single-address transaction (`POST /diagnostic/adresse`) trustworthy enough that every future surface (map, batch, bulk) is just a rendering or repetition of it.
- Achieve conformance: remove everything that fails the test "could the buyer get this from the source directly?"

## Non-goals

- No composite score, multiplier, fused judgment, or LLM-generated recommendation anywhere in API output (constitution §2).
- No versioned national extracts or monthly snapshot pipeline; no separate bulk implementation.
- No Copernicus or Open-Meteo features in any insurer-facing surface.
- No source-data map reproduction (raw WMS rasters as value).
- No actuarial bulk delivery format in v1 (post-v1 derivative of the single-address primitive).
- No OAuth/multi-tenant identity system — static pilot API keys only.

## User stories

**US-1 — Underwriter prices one submission.**
As an underwriter, when a submission lands, I submit the address and receive a JSON record plus a map view showing the building footprint colored by its polygon-test result, so that I can accept/refer/decline and justify the decision to my regulator using per-fact provenance and resolution labels. Today I do this with Géorisques in one tab and BDNB in another, eyeballing.

**US-2 — Underwriter hits a degraded source.**
As an underwriter, when Géorisques WFS is slow or down, I still get a record where affected hazards show `present: null` with `resolution: "commune-level-estimate"` and an explicit error entry — so that I am never misled into treating "unknown" as "safe".

**US-3 — Pilot integrator wires the API.**
As an insurer's developer, I authenticate with a static API key and POST addresses programmatically, so that my team can embed the service in our submission workflow before any UI work reaches us.

**US-4 — Actuary (future, out of v1).**
As an actuary, I will eventually consume bulk extracts built by replaying the single-address primitive N times — so that my pricing model gets raw variables at scale with identical semantics to the interactive product.

## Functional requirements

### A. Geocoding (load-bearing plumbing)

| ID | Requirement | Acceptance criteria |
|----|-------------|---------------------|
| FR-01 | Resolve free-text French addresses via the Géoplateforme geocoding service (`data.geopf.fr/geocodage/search`); produce lat/lon, INSEE citycode, postcode, city, normalized label, confidence score. | Given a valid Paris street address, response contains `adresse.citycode=75056`, coordinates within Paris bounds, `geocode_score ≥ 0.4`. |
| FR-02 | Translate arrondissement INSEE codes to parent communes for the WFS join: Paris 75101–75120 → 75056, Lyon 69381–69389 → 69123, Marseille 13201–13216 → 13055. | Unit tests assert each mapping range collapses to its parent code. |
| FR-03 | Reject low-confidence geocodes before any downstream call: score < 0.4 → HTTP 422 `adresse_ambigue` with `label_propose`. | Query "saint denis" (ambiguous) returns 422 with a proposal label; no BDNB/Géorisques calls occur (assert via mock call counters). |
| FR-04 | Handle upstream geocoder saturation: HTTP 429 responses honor `retry-after`, then fail; geocoder unreachable → HTTP 502 `geocodage_indisponible`. Geocoder failure is **transaction-fatal** — without a resolved point there is nothing to join (error matrix governs; FR-22 degradation applies only post-geocode). | Mocked 429 with `retry-after: 5` produces exactly one delayed retry, then structured 502. |
| FR-05 | Accept raw `"lat,lon"` input as an address alternative (bypasses forward geocoding, runs reverse geocode for citycode). | POST with body `{"adresse": "43.7102,7.2620"}` resolves to Nice citycode and completes the pipeline. |

### B. The join — hazard exposure (Géorisques)

| ID | Requirement | Acceptance criteria |
|----|-------------|---------------------|
| FR-06 | Test the resolved point against all configured WFS layers via `WFS_LAYER_MAP`: `ppr` (8 perimeter layers), `ssp` (classified sites), `canalisations` (TMD networks). Parse GML 3.2 with axis-order handling (`urn:ogc:def:crs:EPSG::4326` → lat,lon). | Known-inside fixture coordinate for a documented PPRI perimeter yields `per_building.count ≥ 1`. |
| FR-07 | Break PPR aggregates down per peril type via `PPR_TYPE_LAYERS` (inondation, mouvement_terrain, seisme-PPRS, avalanche, feu_foret, risque_industriel, minier) — the aggregate alone is insufficient for per-peril work. | Response exposes both the aggregate `ppr` result and per-type results; a point inside a flood perimeter but outside others shows `inondation.present=true`, others `false`. |
| FR-08 | Apply 200 m proximity testing (`PROXIMITY_RADIUS_M`) for non-polygonal layers (SSP sites, TMD pipelines); polygons use strict point-in-polygon. | Fixture coordinate 150 m from a classified site yields `present=true` with `method="proximity"` and `radius_m=200`. |
| FR-09 | Use a dedicated `httpx.AsyncClient` for WFS traffic, separate from REST `/api/v1` clients (Géorisques gateway binds keep-alive per backend; mixing causes cascading 404s). | Code review check; integration test performs REST+WFS sequence without 404 contamination. |
| FR-10 | Normalize the full Géorisques referential into per-hazard objects (13 hazards: icpe, inondation, sismicite, mouvement_terrain, radon, rga, cavite, feu_foret, avalanche, canalisations, vent_cyclonique, ppr, ssp). Each carries `present`, `present_commune`, verbatim `zonage` text, `source`, `url_detail`, `resolution`, optional fields per hazard type (`hauteur_eau_m`, `zone_sismique`, `catnat_historique`). **`present_commune` definition:** the official communal status ("existant"/"concerné") returned by the hazard's dedicated Géorisques `/api/v1` REST sub-endpoint queried by INSEE code (sismicité → zonage sismique décrétal, radon → classement de potentiel, vent cyclonique → zones réglementaires, catnat → historique des arrêtés GASPAR); it is independent of the WFS polygon test and of `resolution`. | Offline test builds a report from mocked raw payloads; all 13 objects present with required fields; `present_commune` populated whenever the communal sub-endpoint succeeded. |
| FR-11 | **v1 certification set:** known-answer tests prove polygon-test correctness for inondation/PPRI, mouvement_terrain, feu_foret, avalanche (address inside → `present=true`, `resolution="per-building"`; known outside → `present=false`). | Certification test suite passes against recorded WFS fixtures reviewed against official portal maps. |
| FR-12 | RGA ships with forced `resolution="commune-level-estimate"` regardless of any underlying signal, until a vector source is wired (constitution §2). | Schema/test asserts RGA object cannot serialize any other resolution value. |
| FR-13 | Seismic zoning (décret) and radon ship `resolution="commune-level"` permanently — correct behavior, not degradation. | Fixtures assert these two hazards always carry `commune-level`. |
| FR-14 | Never infer exposure from a failed source: `present=true` only from a passed polygon/proximity/communal test; `false` from a failed test; `null` when unknown. | Property test: any connector exception path yields `present=null` + populated `erreur`, never `true/false`. |

### C. The join — vulnerability (BDNB)

| ID | Requirement | Acceptance criteria |
|----|-------------|---------------------|
| FR-15 | Fetch the full BDNB building record (~139 fields) for the resolved address, with fallback retry on raw-address form when BAN-label lookup fails. **Multi-building disambiguation (pinned from existing behavior, `bdnb.py`):** the first row returned by the BDNB `batiment_groupe_complet/adresse` endpoint is the primary building; all additional buildings sharing the address are preserved verbatim in `autres_batiments_meme_adresse[]` — never discarded. | Offline test covers both lookup paths and a 3-buildings-at-one-address fixture: primary = `rows[0]`, other two present in `autres_batiments_meme_adresse`. |
| FR-16 | Pass BDNB through **verbatim**: no renaming, filtering, or recomputation. The passthrough structure is `{batiment: <row>, autres_batiments_meme_adresse: [...]}`. Unavailable fields are explicit `null` inside the payload or the whole block is `null` with an `erreurs_partielles` entry — fields are never silently omitted. | Contract test diffs mocked BDNB payload keys against response keys — identical set, including `autres_batiments_meme_adresse`. |

### D. Canonical contract & transport

| ID | Requirement | Acceptance criteria |
|----|-------------|---------------------|
| FR-17 | One canonical response schema (see Data model), served by `POST /diagnostic/adresse` with body `{"adresse": "<text>"}`. Carries `schema_version`, per-hazard `aleas[]`, verbatim `bdnb`, `_source` provenance blocks (provider, URL, attribution string, `recuperee_le` retrieval timestamp), `erreurs_partielles`, `genere_le`. **LO 2.0 attribution:** each `_source` block carries an `attribution` string composed of source name + the dataset's last-update date (millésime), held as per-source config and updated when providers publish new millésimes — e.g. `"Source Géorisques (BRGM / MTE) — données à jour au 2026-07-01"`. | JSON-schema validation test over golden fixtures; attribution fields present and non-empty for every served source. |
| FR-18 | Forbidden fields enforced at schema level: `niveau`/D03 bands, any numeric score, `recommandations`, `copernicus` must not exist in the response model. | Serialization test asserts these keys absent even when internal objects temporarily carry them. |
| FR-19 | `GET /diagnostic/adresse` is removed after frontend migration (FR-24); it must not linger as a second live shape (constitution §2). | Post-migration: route returns 404; grep gate finds no frontend caller. |
| FR-20 | Batch: `POST /diagnostic/batch` accepts ≤10 000 addresses, processes each through the identical single-address pipeline (no parallel bulk logic), stores results in-memory, polled via `GET /diagnostic/batch/{id}`. Submission responds `200` with `{batch_id, n_accepted}`; poll payload is `{batch_id, status: "pending"\|"done", results: [<canonical records>], item_errors: [{adresse, erreur}]}`. Individual item failures isolate — one bad address never fails the batch. Known v1 limitations, documented not hidden: in-memory store is lost on restart; monthly upstream budgets (FR-23) govern real throughput. Equivalence criterion: batch item outputs match single-call outputs **modulo volatile timestamps** (`genere_le`, `recuperee_le`). | Batch test with 3 good + 1 failing mock address: batch completes; failed item flagged individually; responses identical to single calls after timestamp normalization. |

### E. Access, caching, resilience

| ID | Requirement | Acceptance criteria |
|----|-------------|---------------------|
| FR-21 | Static API key auth: clients send `X-API-Key`; server validates against env-configured key list. Missing key → 401; invalid → 403. Exempt: `/health`, `/health/detailed`. Keys never logged. | Middleware tests cover 200/401/403 paths; log-capture test asserts key material absent. |
| FR-22 | Degraded-mode discipline: any single-source failure (timeout, 5xx, malformed payload) yields a partial record with explicit error entries — the endpoint never returns 500 because one source failed. Total Géorisques failure leaves communal-level facts + errors; total success path unaffected. | Chaos-style offline tests kill each source independently; every case returns 200 with structured errors and no 500s. |
| FR-23 | Client-side quota compliance (constants verified 2026-08-25 against provider docs): BDNB Open tier 120 req/min/IP + 10 000 req/month; Géoplateforme geocoding 50 req/s/IP. Enforcement: upstream throttling + result cache (FR-26) on all paths; monthly budget guard (FR-28) on the batch path. Interactive single requests remain bounded by throttle+cache only in v1 — accepted, documented residual. | Throttle unit tests assert no more than N upstream calls/sec/min under burst load. |
| FR-24 | Frontend conformance: `Zone.tsx` migrates to the canonical POST shape; `CopernicusPanel.tsx`, Mistral narrative flow (`/diagnostic/adresse/rapport` consumers), and jumeau/LIDAR scene-engine calls are removed; map re-points at join rendering (footprint colored by polygon result + curated sidebar: materials, year, height, DPE class, reliability flags). The zone/buildings endpoints (`GET /diagnostic/zone/building`, `/buildings`) are kept **verbatim, unchanged** — they are presentation-tier passthroughs of BDNB id/bbox queries and sit outside the canonical contract in v1. | Frontend build passes; grep finds zero references to copernicus/mistral/lidar/rapport-narratif; visual smoke test shows join rendering. |
| FR-25 | Backend conformance deletions (constitution §2 "no dormant code"): connectors `copernicus.py`, `era5_land.py`, `flood.py`, `fire_danger.py`, `heat_stress.py`, `wind_risk.py`, `seasonal.py`; route `climate.py`; `/diagnostic/copernicus/*` routes; `RecommandationsIA` schema + `recommandations` field; `zone_assessment.py`; scoring remnants incl. `risk_model` references; stale `rate_limit.py` entries (`adresse/rapport`); `DiagnosticRequest.copernicus` flag; deps `cdsapi`, `xarray`, `netCDF4`; associated tests (`test_climate_dashboard.py`, `test_copernicus_*.py` ×4, `test_trajectoire_brute.py`). Executed as its own change set, separate from feature work. | Full test suite green after deletion; grep gates find zero references to deleted modules; `requirements.txt` minimal. |
| FR-26 | Result cache: in-process TTL cache keyed on the resolved geocode tuple (normalized label + lat/lon rounded to **5 decimal places** ≈ 1 m + citycode) + `schema_version`. Default TTL 24 h, env-configurable. Cache hits skip all upstream calls and return the stored record as-is — `genere_le`/`recuperee_le` honestly reflect the original fetch. Batch items traverse the same cache. | Two identical consecutive requests produce exactly one set of upstream calls (mock counters); TTL expiry triggers fresh fetch; two addresses differing beyond 5 decimals produce distinct keys. |
| FR-27 | Inbound rate limiting: the existing per-route rate-limit middleware is retained for abuse protection on Typhoon's own API (inbound), distinct from FR-23 which governs Typhoon's *upstream* consumption. | Existing `test_rate_limit.py` stays green; middleware config contains only surviving routes after FR-25 cleanup. |
| FR-28 | Monthly upstream budget guard: an env-configured monthly counter (BDNB calls) rejects further batch submissions with HTTP 429 `budget_epuise` once exhausted, protecting the Open-tier allowance; single interactive requests are never blocked by it in v1. Raising real throughput = subscribe to BDNB Open Plus (business action, not code). | Counter test: N mocked calls then a batch submit → 429 `budget_epuise`; single POST still processes. |

## Non-functional requirements

- **Performance (proposed budgets — calibrate by measurement in Phase 5):**
  - p95 ≤ 10 s for `POST /diagnostic/adresse` with all sources healthy.
  - Degraded mode ≤ 2× healthy-path budget; failures trigger fallback, not retry storms.
  - ⚠ Calibration caveat: `resolve_per_building` currently fetches WFS layers sequentially (each with timeout+retry); if measurements breach budget, a **parallelize-the-layer-fetches** task goes on the Phase 5 plan rather than silently raising the budget.
- **Observability:** per-request structured log lines already established (`elapsed`, source-error counts, aléa counts) remain; add cache hit/miss counter and the FR-28 monthly budget counter. No secrets/keys in logs (addresses permitted — they are the query interface).
- **Compatibility:** backend CPython version pinned by CI config; FastAPI/Pydantic v2/httpx stack per constitution §1.
- **Test suite:** offline suite stays offline (upstream mocks) and completes < 60 s locally; live-source tests segregated.
- **License compliance:** LO 2.0 attribution (source + last-update date) travels inside every `_source` block — verified by FR-17 acceptance criteria.

## Data model — canonical contract (v1.0)

```jsonc
POST /diagnostic/adresse        body: { "adresse": "10 rue de Rivoli, 75004 Paris" }

200 → {
  "schema_version": "1.0",
  "adresse": {
    "saisie": "…",            // raw input
    "normalisee": "…",        // geocoder label
    "citycode": "75056", "postcode": "75004", "city": "Paris",
    "lat": 48.8566, "lon": 2.3522,
    "geocode_score": 0.95
  },
  "aleas": [                   // 13 objects, full referential (FR-10)
    {
      "code": "inondation",
      "libelle": "Inondation",
      "present": true,          // true=polygon/proximity/communal hit · false=tested absent · null=unknown (FR-14)
      "present_commune": true,
      "zonage": "Dans un périmètre PPR inondation",   // verbatim source text
      // Serialization rule (pinned): hazard-specific optional fields are ALWAYS
      // present in the JSON, null when not applicable — never absent keys.
      "hauteur_eau_m": 1.5,     // hazard-specific optionals, null when n/a
      "zone_sismique": null,
      "catnat_historique": [],
      "per_building": {         // object present ONLY iff polygon/proximity-checked
                                // (explicit carve-out from the always-present rule above);
                                // null when communal-only or unknown
        "method": "point-in-polygon",   // enum: "point-in-polygon" | "proximity"
        "radius_m": null,       // echoed PROXIMITY_RADIUS_M value when method="proximity"; else null
        "count": 2
      },
      "source": "georisques",
      "url_detail": "https://www.georisques.gouv.fr/risques/inondations",
      "erreur": null,           // string | null — short reason ("ConnectTimeout: …")
      "resolution": "per-building",
      //   enum: "per-building" | "commune-level" (decree-communal: sismicite, radon)
      //       | "commune-level-estimate" (fallback OR RGA-until-vector-source, FR-12)
    }
  ],
  "bdnb": {                    // entire block null when BDNB unavailable (FR-16)
    "donnees": { /* ~139 verbatim BDNB fields incl. fiabilite_* flags,
                     batiment = primary building, autres_batiments_meme_adresse = [...] */ },
    "_source": {
      "provider": "BDNB",
      "url": "https://api.bdnb.io",
      "attribution": "Source BDNB (CSTB) — données à jour au <millésime>",
      "recuperee_le": "2026-08-25T10:00:00+00:00"
    }
  },
  "georisques_source": {
    "provider": "Géorisques",
    "url": "https://www.georisques.gouv.fr",
    "attribution": "Source Géorisques (BRGM / MTE) — données à jour au <millésime>",
    "recuperee_le": "2026-08-25T10:00:00+00:00"
  },
  "erreurs_partielles": [],     // array of strings, format "source: ExceptionType: message"
  "genere_le": "2026-08-25T10:00:01+00:00",
  "avertissement": "Ce rapport agrège les données publiques Géorisques (BRGM / MTE). Il ne remplace pas l'État des Risques (ERRIAL) obligatoire à la vente/location."
}

// FORBIDDEN in this schema: niveau/D03 bands, numeric scores, recommandations,
// copernicus, any composite judgment. (FR-18, constitution §2)
```

Internal-only: `NiveauRisque`/D03 conversion survives solely for frontend display coloring of zonage text; it lives outside the serialized contract.

## API surface

| Method & path | Status in v1 | Notes |
|---|---|---|
| `POST /diagnostic/adresse` | **Canonical product transaction** | Auth, cache, full contract |
| `GET /diagnostic/adresse` | Removed after FR-24 migration | Was second shape (RisqueReport dump) |
| `POST /diagnostic/batch`, `GET /diagnostic/batch/{id}` | Kept | Same pipeline ×N (FR-20) |
| `GET /diagnostic/zone/building`, `/buildings` | Kept | Serves join-map presentation tier |
| `GET /diagnostic/adresse/rapport-pdf` | Kept | Proxy to official Géorisques PDF (underwriter convenience) |
| `GET /geocode`, `/geocode/search` | Kept | Autocomplete support |
| `GET /health`, `/health/detailed` | Kept | Unauthenticated |
| `GET /climate`, `/diagnostic/copernicus/*`, `POST /diagnostic/adresse/rapport`, `/diagnostic/zone/lidar*` | Deleted (FR-25) | Last three already absent backend-side — ghosts referenced by frontend/stale config |

## Error handling

| Condition | Behavior | Caller sees |
|---|---|---|
| Address not found by geocoder | Reject before any source call | 422 `{"error": "adresse_non_trouvee"}` |
| Geocode score < 0.4 | Reject, propose nearest label | 422 `{"error": "adresse_ambigue", "label_propose": …}` |
| Geocoder unreachable / saturated | 429 honored once via `retry-after`, then fail | 502 `{"error": "geocodage_indisponible"}` |
| Single WFS layer fails | That hazard: `present=null`, `erreur` filled, entry in `erreurs_partielles` | 200, partial record |
| All Géorisques down | Communal-level facts retained where available; polygon facts `null` | 200, degraded record |
| BDNB down / address unrecognized | `bdnb=null` + `erreurs_partielles` entry | 200, partial record |
| Invalid/missing API key | Rejected before processing | 403 / 401 |
| Batch item failure | Item flagged, batch continues | 200 with per-item status |
| Any unexpected exception | Logged with traceback, structured 502 — never a leaked 500 HTML | 502 `{"error": …}` |

## UI / UX notes (presentation tier)

- Map renders **the join**: building footprint colored by its polygon-test result (green per-building verified / amber commune-level / grey unknown), curated vulnerability sidebar (materials, year, height, DPE class, reliability flags). Resolution badge visible per hazard pill (FR-24).
- Every Copernicus/Open-Meteo/Mistral/jumeau UI surface removed; no "climate dashboard" remains.
- Empty/loading/error states for the map follow Zone.tsx migration; each state is part of FR-24 acceptance.

## Constitution check

- Rules applying to this spec: §1 (stack — httpx/FastAPI/Pydantic v2), §2 (all seven invariants drive FR-12/14/16/17/18/19/20/25), §3 (single-primitive architecture FR-17/20, geocoding-first-class FR-01..05, quota/cache FR-23), §4 (certification FR-11, degraded-path parity FR-22), §5 (keys FR-21, timeouts), §6 (budgets above), §8 (review gates).
- Amendments required: **none.**

## Open questions

*(none — all brainstorm/concept questions resolved and pinned above)*

## Out of scope (future work, with rationale)

- **Bulk CSV delivery for actuaries** — derivative: replay primitive ×N + file writer + versioning; deferred until primitive proves out with underwriters.
- **RGA polygon source wiring** (e.g., BRGM alea argile vectors) — requires constitution §2 amendment process when undertaken.
- **Multi-instance/external cache store** — in-process TTL suffices for single-instance pilot; revisit at scale-up.
- **OAuth / per-seat identity** — static keys cover pilot phase.
- **Log retention & rotation policy** — required before first external pilot per constitution §5 discussion; own decision record.
- **Portfolio concentration analytics** — banker persona; not the v1 buyer.
