# Concept — Per-Building Climate-Risk Data Service for French Insurers

> Phase 2 output of the spec-driven workflow. Source material: `01-brainstorm-notes.md`.
> Status: **STABLE — all open questions resolved 2026-08-25.** Treat as source material for constitution and spec; changes here ripple downstream.

## 1. Problem

We built a climate-risk platform for French real estate that queries four public data sources (Géorisques, BDNB, Copernicus, Open-Meteo) and presents results in a dashboard. Most connectors reproduce what each source's own portal already provides, at the same resolution, for free. The platform looks comprehensive but has unclear value differentiation from the public tools it aggregates.

The one thing none of these sources do — and the one thing we actually engineered — is link hazard exposure to building vulnerability at per-building resolution. Géorisques doesn't know what your building is made of. BDNB doesn't know if it's inside a flood polygon. Copernicus can't tell you anything about a specific building because its data lives on a ~10 km grid. We are the only place those two facts sit side-by-side for the same address — and we haven't organized the product around that.

Why now: insurers (underwriters today, actuaries tomorrow) currently solve this by eyeballing Géorisques in one tab and BDNB in another. The join exists nowhere else; our effort should stop funding what buyers can get from the source directly.

## 2. Solution at a glance

A per-building climate-risk data service for French insurers. An underwriter submits one address and receives one JSON record joining hazard exposure (Géorisques WFS polygon tests) to building vulnerability (BDNB attributes), with every fact carrying its resolution level and provenance. A map renders *our join* — building footprint colored by polygon-test result with a curated vulnerability sidebar — because underwriters do spatial judgment, not just lookups. There is no composite score anywhere in the contract: facts plus provenance only, because scoring is the buyer's job under Solvency II. Bulk delivery later is a derivative (N queued single queries), never a parallel snapshot pipeline.

## 3. Scope

- `POST /diagnostic/adresse` as THE product transaction, returning **one canonical JSON contract** (consolidation required — see OQ-1).
- Géorisques WFS polygon tests for all configured hazards (`WFS_LAYER_MAP` is config, not logic). **v1 certification scope** (known-answer test cases, address-in-polygon → verified): flood/PPRI, ground movement, forest fire, avalanche.
- RGA shipped either wired to a real vector source or plainly labeled "commune-level estimate" (decision deadline pre-spec — see OQ-2).
- Seismic zoning and radon ship labeled `commune-level` permanently (decree-communal by nature).
- Full verbatim BDNB pass-through in the contract; curation only at presentation layer.
- Mandatory `resolution` + provenance on every fact; degraded/fallback path tested as rigorously as the happy path.
- Join-rendering map (reuse MapLibre/BdnbMap infrastructure): footprint colored by polygon-test result + curated sidebar (materials, year, height, DPE class, reliability flags).
- Geocoding (IGN/BAN + arrondissement translation Paris/Lyon/Marseille) as a first-class, tested component.
- `/diagnostic/batch` survives as N queued single queries.

## 4. Non-scope (v1)

1. **Composite risk score** — no score, multiplier, or fused judgment in the contract. D03 bands exist only as internal display coloring for zonage text.
2. **Versioned national extracts / snapshot pipeline** — "monthly bulk file" delivery is explicitly out; bulk is derived later from the single query.
3. **Copernicus & Open-Meteo as insurer-facing features** — no climate-variable panel, no weather-derived hazard feed in v1.
4. **Source-data map reproduction** — raw WMS rasters / source zone layers rendered as if they were value.
5. **3D extrusions** — decoration.
6. **Actuary-facing bulk format & delivery mechanism** — post-v1 derivative work.

## 5. Users and use cases

**Primary v1 user — the underwriter (insurer's underwriting desk).**
*Scenario:* A submission lands on their desk. They paste the address into Typhoon (or their tool calls the API), get the record and the join map: where's the building relative to the river, how close is the flood perimeter, what does the PPR zone wrap, what is the building made of. They accept/refer/decline — and can justify the decision to a regulator using per-fact provenance and resolution labels. Today they do this with Géorisques in one tab, BDNB in another, and eyeballing.

**Future consumer — the actuary (pricing model builder).**
*Scenario:* Wants raw variables at scale to feed their own model. No UI at all. Served later by bulk = N queued single queries over the same primitive. Every hour hardening the single-address transaction transfers directly.

## 6. Key constraints

- **Solvency II context:** every fact must be traceable and correctly resolved. No liability-bearing judgments emitted by us.
- **Resolution-field integrity is non-negotiable:** it is the record's only quality signal now that scores are dead. Fallback paths must be tested equally with happy paths.
- **Latency/cache/contract stability matter** at the single-address endpoint (interactive underwriter use); throughput and snapshot versioning do not constrain v1.
- **French address handling:** arrondissement translation (Paris/Lyon/Marseille) must be correct or the WFS join silently fails.
- **Data licensing:** commercial redistribution rights must be confirmed before selling derived data (OQ-3).

## 7. Architecture sketch (prose)

An address enters through the API and is geocoded via IGN/BAN, including arrondissement translation — this step makes the WFS join possible and is treated as a tested product component. The resolved coordinates fan out to two sources in parallel: the Géorisques WFS connector, which tests the point against each configured hazard polygon layer (config-driven layer map; one shared geometry code path), and the BDNB connector, which fetches the building's full attribute record. A fusion step merges both into the canonical per-building record: verbatim BDNB fields, one hazard object per configured hazard carrying presence, provenance, and resolution. Source failures produce explicit degraded records, never silent gaps. The record is served as JSON; the map endpoint renders the same record spatially (footprint colored by polygon-test result, curated sidebar); the batch endpoint queues N single queries through the identical path.

## 8. Open questions

| # | Question | Status | Resolution |
|---|----------|--------|------------|
| OQ-1 | Which response shape is canonical? | **RESOLVED (decision)** | Canonical contract descends from the `RisqueReport` lineage: per-hazard `AleaDetail` objects with `resolution` + provenance, stripped of `copernicus` and `recommandations`. Transport becomes `POST /diagnostic/adresse`; batch re-routes through the identical path. Pipeline A's parallel `_safe_call` structure survives as internal collection plumbing only. D03 `niveau` is **not emitted** in the canonical contract — display-layer coloring only (locked decision #10); source gradation ships verbatim as zonage text. |
| OQ-2 | RGA fork: real vector source vs labeled commune-level? | **RESOLVED (decision)** | RGA ships in v1 labeled `commune-level estimate`, stated plainly to buyers. Wiring a real vector source (e.g., BRGM alea argile) becomes post-v1 work. No v1 delay. |
| OQ-3 | Licensing | **RESOLVED (research)** | See findings below. Commercial resale viable. |
| OQ-4 | Dead-code disposition | **RESOLVED (decision)** | **Delete** Copernicus/Open-Meteo connectors, scoring remnants, 3D extrusions. Git preserves history. |
| OQ-5 | Mistral recommandations field | **RESOLVED (decision)** | **Out of the canonical contract.** Presentation-layer only if it survives at all, clearly separated from facts. |
| OQ-6 | Geocoding dependency | **RESOLVED (research)** | Codebase already migrated to Géoplateforme (`data.geopf.fr/geocodage/search`, `app/connectors/geocoding.py`). Quota 50 req/s/IP; excess → HTTP 429 + `retry-after` (~5 s block). Quotas raisable via geoplateforme@ign.fr. Arrondissement data native in responses. Spec must add: 429/retry handling, geocode-score gate (0.4 exists), explicit degraded behavior when geocoding fails. |

### OQ-3 findings (licensing)

- **Géorisques**: distributed under Licence Ouverte 2.0 (Etalab, `etalab-2.0`). Commercial reuse explicitly permitted worldwide, free, unlimited duration. Sole obligation: attribution — source name + date de dernière mise à jour.
- **BDNB**: open data under Licence Ouverte 2.0 — reuse/rediffusion/commercial use permitted with citation. Restricted-access fields (fichiers fonciers, etc.) require a convention with CSTB — not used by us. Operational constraint: BDNB API quotas — free Open tier 10 000 req/month @120 req/min/IP; Open Plus 1 M req/month @1200 req/min (paid); Expert 10 M req/month (paid).
- **Consequence:** the legal attribution obligation coincides exactly with our provenance design — license compliance becomes a product feature, not overhead. Attribution strings belong *in* the record's provenance metadata.

### OQ-1 analysis (side-by-side)

**Pipeline A — `POST /diagnostic/adresse` → `collect()`** (`app/agents/collector_agent.py`)
Returns `{adresse, bdnb:{donnees}, georisques:{donnees: <raw API payloads>}, copernicus, erreurs_sources, genere_le}`. Géorisques content is *raw API dumps*: no per-hazard objects, no polygon-test results, no resolution labels. Includes Copernicus by default. Used by batch. **Verdict: this shape reproduces the sources — it fails our own thesis at the contract level.**

**Pipeline B — `GET /diagnostic/adresse` → `RisqueReport.model_dump()`** (`app/connectors/georisques.py`, `app/schemas/risque_report.py`)
Returns normalized `aleas[]` where each `AleaDetail` already carries `code, libelle, present, present_commune, zonage, source, url_detail, erreur, resolution` — i.e., per-hazard objects with provenance AND the resolution field we declared non-negotiable. Proper error semantics (422 ambiguous address via geocode-score gate, 502 source down, non-blocking `erreurs_partielles`). **Flaws vs locked decisions: attaches `copernicus` and `recommandations` (both now dead); D03 `niveau` baked into each aléa; served via GET instead of POST.**

**Recommendation:** the canonical contract descends from Pipeline B's schema (per-hazard objects, resolution, provenance, error semantics), stripped of `copernicus` and `recommandations`, with an explicit ruling on whether D03 `niveau` ships in v1 or stays internal display-only. Transport becomes `POST /diagnostic/adresse` (the v1 transaction); batch re-routes through the identical path. Pipeline A's parallel `_safe_call` structure survives internally as collection plumbing, not as the public shape.

## 9. Risks

| Risk | Mitigation |
|------|------------|
| Licence prohibits or burdens commercial resale of derived data | Resolve early (OQ-3); attribution compliance is cheap, prohibition forces renegotiation of the whole thesis — better to know in week one. |
| RGA mislabeled as building-level → trust/regulatory damage with exactly the buyers who check | Hard resolution-label rule + known-answer tests; the label is honest even where the data is communal. |
| Géorisques WFS instability/latency degrades the interactive experience | Caching, explicit degraded-mode records with resolution flags, tested fallback path. |
| Contract churn breaks early pilot integrations | Freeze canonical shape during spec (OQ-1); version the contract from day one. |
| Underwriter pilot never converts into actuarial bulk revenue | Accepted: the per-building primitive is the asset either way; bulk reuses it unchanged. |
