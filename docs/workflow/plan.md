# Plan — Typhoon v1: Per-Building Hazard × Vulnerability Contract

**Spec:** `docs/workflow/spec.md` (approved 2026-08-25)
**Status:** approved
**Conventions:** one task = one branch = one PR; task ID prefixes commits (`feat(T004): …`). Tests are written before implementation (constitution §4); existing tests are never modified during feature work — deletions happen only inside the T001/T002 change sets.

---

## Task list

### T001 — Delete dead backend code (own change set)

- **Depends on:** —
- **Spec reference:** FR-25
- **Estimate:** 3–5 h
- **Constitution touchpoints:** §2 (no dormant code), §4 (deletions are their own change set)
- **Acceptance criteria:**
  - [ ] Deleted: `connectors/{copernicus,era5_land,flood,fire_danger,heat_stress,wind_risk,seasonal}.py`, `routes/climate.py`, `/diagnostic/copernicus/*` routes, `RecommandationsIA` + `recommandations` field, `schemas/zone_assessment.py`, all `risk_model` references, `DiagnosticRequest.copernicus` flag, stale `rate_limit.py` entries (`adresse/rapport`)
  - [ ] `requirements.txt` drops `cdsapi`, `xarray`, `netCDF4`
  - [ ] Deleted tests: `test_climate_dashboard.py`, `test_copernicus_*.py` ×4, `test_trajectoire_brute.py`
  - [ ] Remaining suite green; grep gates find zero references to deleted modules
- **Tests to write first:** none new — this change set only removes; the gate is the surviving suite staying green

### T002 — Delete dead frontend surfaces

> **Amendment 2026-08-25 (during execution):** the Mistral narrative flow (`loadRapport`, `RapportNarratif` types, cache rapport fields) is interwoven through `Zone.tsx`/`config.ts`/`diagnosticCache.ts` and is removed by **T014** together with the Zone reshape — not here. T002 removes only *standalone unreachable surfaces* (nothing routes to or imports them). Residual grep hits therefore remain in Zone/config/cache until T014.

- **Depends on:** —
- **Spec reference:** FR-24 (deletion half)
- **Estimate:** 2–4 h
- **Constitution touchpoints:** §2
- **Acceptance criteria:**
  - [x] Deleted (unreachable — no route/importer): `CopernicusPanel.tsx`, `CopernicusStatusBanner.tsx` + test, `jumeau/` directory (scene-engine.js/.d.ts incl. LIDAR code, recommendations.ts), `Artisans.tsx`, `copernicus.css`, `jumeau.css`, `artisans.css`
  - [x] `jumeau/recommendations.ts` relocated to `src/zone/recommendations.ts` (live shared code, 5 importers updated)
  - [ ] Frontend builds and tests pass
  - [ ] Zero references to deleted surfaces (grep); documented residue confined to Zone/config/diagnosticCache pending T014
- **Tests to write first:** none (build + grep gates only)

### T003 — Canonical contract schema `DiagnosticRecord` v1.0

- **Depends on:** T001
- **Spec reference:** FR-17, FR-18 (schema half)
- **Estimate:** 4–6 h
- **Constitution touchpoints:** §2 (all invariants encoded here)
- **Acceptance criteria:**
  - [ ] Pydantic models for the full data-model section: `adresse`, 13-hazard `aleas[]` with resolution enum (`per-building` | `commune-level` | `commune-level-estimate`), optional-always-null serialization rule, `per_building{method,radius_m,count}` carve-out, `_source{provider,url,attribution,recuperee_le}`
  - [ ] Forbidden fields (`niveau`, scores, `recommandations`, `copernicus`) cannot be serialized — schema-level exclusion test passes
  - [ ] Per-source attribution config carries millésime strings
- **Tests to write first:**
  - `test_schema_forbidden_fields_absent` — serialization of an internally-scored object still emits no forbidden keys
  - `test_optional_fields_always_present_null` — hazard-specific optionals serialize as null, never missing keys
  - `test_per_building_carve_out` — communal-only hazards have no `per_building` key
  - `test_resolution_enum_constrained` — RGA rejects any value except `commune-level-estimate`

### T004 — POST endpoint serves the canonical record

- **Depends on:** T003
- **Spec reference:** FR-17 (transport), FR-10, FR-12, FR-13, FR-14 (normalization semantics land here)
- **Estimate:** 6–8 h
- **Constitution touchpoints:** §2, §3 (single primitive)
- **Acceptance criteria:**
  - [ ] `POST /diagnostic/adresse` returns `DiagnosticRecord`; response built from the RisqueReport lineage + collector parallel plumbing; `copernicus` flag gone from request model
  - [ ] All 13 hazards present per referential; `present_commune` populated from communal sub-endpoints whenever they succeeded
  - [ ] RGA forced `commune-level-estimate`; sismicite/radon always `commune-level`
  - [ ] Any connector exception → `present=null` + filled `erreur` + `erreurs_partielles` entry, never inferred true/false
- **Tests to write first:**
  - `test_post_returns_canonical_record` — golden fixture end-to-end offline
  - `test_rga_resolution_forced` / `test_seismic_radon_commune_level`
  - `test_connector_failure_never_infers_present` — property-style: each source kill yields null+erreur
  - `test_erreurs_partielles_format` — `"source: ExceptionType: message"` strings

### T005 — Batch endpoints on the identical pipeline

- **Depends on:** T004
- **Spec reference:** FR-20
- **Estimate:** 4–6 h
- **Constitution touchpoints:** §2 (batch is N singles), §3
- **Acceptance criteria:**
  - [ ] Submission → `200 {batch_id, n_accepted}`; poll payload `{batch_id, status, results[], item_errors[]}`
  - [ ] Item failure isolates; batch continues
  - [ ] Batch outputs ≡ single-call outputs modulo volatile timestamps
- **Tests to write first:**
  - `test_batch_item_isolation` — 1 failing mock among goods never fails the batch
  - `test_batch_matches_single_call_modulo_timestamps`
  - `test_poll_unknown_id_404`

### T006 — Geocoding hardening

- **Depends on:** T001 (stale settings removal)
- **Spec reference:** FR-01..FR-05
- **Estimate:** 4–6 h
- **Constitution touchpoints:** §3 (geocoding is first-class), §5 (timeouts)
- **Acceptance criteria:**
  - [ ] Arrondissement maps pinned: 75101–75120→75056, 69381–69389→69123, 13201–13216→13055
  - [ ] Score <0.4 → 422 `adresse_ambigue` with `label_propose`, zero downstream calls (mock counters)
  - [ ] 429 honored once via `retry-after`, then 502 `geocodage_indisponible`
  - [ ] `"lat,lon"` input bypasses forward geocoding, runs reverse lookup
- **Tests to write first:**
  - `test_arrondissement_translation_paris_lyon_marseille`
  - `test_low_score_rejected_before_downstream_calls`
  - `test_geocoder_429_retry_once_then_502`
  - `test_latlon_input_skips_forward_geocode`

### T007 — WFS integration & resolution semantics

- **Depends on:** T003
- **Spec reference:** FR-06, FR-07, FR-08, FR-09
- **Estimate:** 6–8 h
- **Constitution touchpoints:** §2 (resolution integrity), §3 (timeouts/dedicated client)
- **Acceptance criteria:**
  - [ ] Polygon layers point-in-polygon; SSP/canalisations proximity with `radius_m` echo
  - [ ] PPR aggregate + per-type breakdown surfaced (`PPR_TYPE_LAYERS`)
  - [ ] Dedicated AsyncClient for WFS asserted; REST+WFS sequence without keep-alive contamination
  - [ ] GML axis-order handling covered by fixture parse tests
- **Tests to write first:**
  - `test_gml_axis_order_latlon_and_lonlat`
  - `test_proximity_method_echoes_radius`
  - `test_ppr_type_breakdown_independent`
  - `test_wfs_dedicated_client_no_contamination`

### T008 — Certification known-answer suite (v1 sign-off gate)

- **Depends on:** T004, T007
- **Spec reference:** FR-11
- **Estimate:** 4–8 h (fixture collection dominates)
- **Constitution touchpoints:** §2, §4
- **Acceptance criteria:**
  - [ ] Recorded fixtures: known-inside and known-outside address per certified hazard (inondation/PPRI, mouvement_terrain, feu_foret, avalanche), reviewed against official portal maps
  - [ ] Inside → `present=true` + `resolution="per-building"`; outside → `present=false`
- **Tests to write first:**
  - `test_certified_inside_<hazard>` ×4
  - `test_certified_outside_<hazard>` ×4

### T009 — API key authentication

- **Depends on:** T004
- **Spec reference:** FR-21
- **Estimate:** 2–4 h
- **Constitution touchpoints:** §5
- **Acceptance criteria:**
  - [ ] `X-API-Key` checked against env-configured list; missing→401, invalid→403; `/health*` exempt
  - [ ] Key material never logged (log-capture assertion)
- **Tests to write first:**
  - `test_auth_missing_key_401_invalid_403_exempt_health`
  - `test_api_key_never_in_logs`

### T010 — Result cache

- **Depends on:** T004
- **Spec reference:** FR-26
- **Estimate:** 3–5 h
- **Constitution touchpoints:** §3 (quota respect), §6
- **Acceptance criteria:**
  - [ ] Key = normalized label + lat/lon @5 dp + citycode + schema_version; TTL default 24 h env-configurable
  - [ ] Hits skip upstreams entirely; stored timestamps honestly reflect original fetch; batch traverses cache
- **Tests to write first:**
  - `test_cache_hit_single_upstream_call_set`
  - `test_cache_ttl_expiry_refetches`
  - `test_cache_key_precision_five_decimals`

### T011 — Upstream throttling

- **Depends on:** T004
- **Spec reference:** FR-23
- **Estimate:** 3–4 h
- **Constitution touchpoints:** §3
- **Acceptance criteria:**
  - [ ] BDNB ≤120 req/min/IP pacing; geocoder burst guard under 50 req/s/IP
- **Tests to write first:**
  - `test_bdnb_minute_rate_paced_under_burst`
  - `test_geocoder_second_rate_paced_under_burst`

### T012 — Monthly budget guard

- **Depends on:** T005, T011
- **Spec reference:** FR-28
- **Estimate:** 2–3 h
- **Constitution touchpoints:** §3
- **Acceptance criteria:**
  - [ ] Env-configured monthly BDNB counter; exhausted → batch submit `429 budget_epuise`; interactive single requests unaffected
- **Tests to write first:**
  - `test_budget_exhausted_blocks_batch_only`

### T013 — Degraded-path chaos suite

- **Depends on:** T004, T007
- **Spec reference:** FR-22 (+FR-14 property assertions)
- **Estimate:** 4–6 h
- **Constitution touchpoints:** §4 (degraded parity)
- **Acceptance criteria:**
  - [ ] Each source independently killed (timeout / 5xx / malformed / empty) → 200 partial record, structured errors, no 500s
  - [ ] Total Géorisques failure retains communal facts; BDNB failure → `bdnb=null`
- **Tests to write first:**
  - `test_kill_<source>_<mode>_yields_partial_record` (matrix, parametrized)

### T014 — Frontend migration to canonical shape + join rendering

- **Depends on:** T002, T004
- **Spec reference:** FR-24
- **Estimate:** 6–8 h
- **Constitution touchpoints:** §2 (D03 display-only coloring lives frontend-side now)
- **Acceptance criteria:**
  - [ ] `Zone.tsx` calls POST canonical shape; footprint colored by polygon result (green/amber/grey), curated sidebar (materials, year, height, DPE, reliability flags), resolution badges per hazard pill
  - [ ] Mistral narrative flow fully excised: `loadRapport`/`RapportNarratif`/rapport cache fields removed from `Zone.tsx`, `config.ts`, `diagnosticCache.ts` (amended from T002)
  - [ ] Copernicus wizard step removed from the stepper; `ClimateDashboard`/`WeatherForecastMap` deleted if then-unreferenced
  - [ ] Zero GET `/diagnostic/adresse` calls remain; build green; visual smoke test passes
- **Tests to write first:**
  - `frontend_contract_adapter_maps_canonical_record`
  - `grep_gate_no_get_diagnostic_adresse_calls`

### T015 — Remove GET /diagnostic/adresse route

- **Depends on:** T014
- **Spec reference:** FR-19
- **Estimate:** 1 h
- **Constitution touchpoints:** §2 (one canonical shape)
- **Acceptance criteria:**
  - [ ] Route deleted; GET returns 404; no frontend caller (grep)
- **Tests to write first:**
  - `test_get_diagnostic_adresse_removed_404`

### T016 — p95 latency baseline (calibration carry-forward)

- **Depends on:** T009–T013 merged (real pipeline)
- **Spec reference:** NFR performance budgets
- **Estimate:** 3–4 h
- **Constitution touchpoints:** §6
- **Acceptance criteria:**
  - [ ] Measurement harness records p50/p95 over ≥100 real single-address calls against live sources
  - [ ] Written calibration verdict: budget holds or triggers T017
- **Tests to write first:**
  - `test_latency_report_produces_percentiles`

### T017 — Parallelize WFS layer fetches *(conditional)*

- **Depends on:** T016 breaching budget
- **Spec reference:** NFR caveat (spec §Non-functional)
- **Estimate:** 4–6 h
- **Constitution touchpoints:** §6, §3
- **Acceptance criteria:**
  - [ ] Layer fetches concurrent with bounded parallelism; results order-independent; dedicated-client constraint (FR-09) preserved
  - [ ] Re-measured p95 within budget
- **Tests to write first:**
  - `test_parallel_fetch_results_identical_to_sequential`
  - `test_parallelism_bounded`

### T018 — Docs & agent conventions update

- **Depends on:** T015
- **Spec reference:** constitution §7
- **Estimate:** 2 h
- **Constitution touchpoints:** §7
- **Acceptance criteria:**
  - [ ] Contract reference published (from spec Data model); AGENTS.md commands/conventions current
- **Tests to write first:** none (docs)

---

## Task ordering

- **Parallel group A (start immediately):** T001, T002, T006
- **Sequential spine:** T003 → T004 → {T005, T007} → T008
- **Parallel group B (after T004):** T009, T010, T011, T013
- **Then:** T012 (needs T005+T011) · T014 (needs T002+T004) → T015 → T018
- **Last:** T016 → T017 (conditional)
- Multiple agents: use one `git worktree` per task within a group.

## Risk log

| Task | Risk | Mitigation |
|------|------|------------|
| T008 | Live Géorisques data drifts → fixtures rot | Record fixtures once, review vs portal, re-record procedure documented; certification tier separate from offline suite |
| T004 | RisqueReport→DiagnosticRecord adapter misses a hazard nuance | Golden-fixture diff against current GET output before cutover |
| T010 | Cache-key rounding false-shares neighbors | 5 dp ≈ 1 m pinned; distinct-key test |
| T014 | D03 coloring logic lost in migration | Port band logic explicitly into presentation component; constitution §2 grep stays clean |
| T016 | Budget breach discovered late | T017 pre-scoped as conditional task; spec documents contingency openly |
| T012 | Counter drift vs billing reality | Counter counts our outbound calls; monthly review against provider dashboard |

## Definition of done (whole feature)

- [ ] All tasks merged; suite green; offline suite < 60 s
- [ ] Every spec acceptance criterion verified or explicitly waived in review
- [ ] Docs updated (T018); workflow artifacts committed
- [ ] Constitution respected — §2 grep gates pass on final tree
