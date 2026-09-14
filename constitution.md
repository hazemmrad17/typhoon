# Constitution

> The non-negotiable rules for this project. Every spec, plan, and implementation must respect these. To change a rule, open a PR that amends this file *before* the change that would violate it.
>
> Enforcement tags: **[CI]** = automated check · **[test]** = asserted in test suite · **[review]** = human/code-review checkpoint

**Version:** 0.2
**Last amended:** 2026-09-14

---

## §1 — Tech stack

- Backend: Python (version pinned in CI config — the CI version is the only supported one), FastAPI, Pydantic v2, httpx (async), pyproj, uvicorn.
- Frontend: Mapbox GL JS for map rendering on `/zone` and portfolio surfaces; turf for client-side geometry; Three.js (presentation-tier VFX only — see §2.1).
- Tests: pytest + pytest-asyncio. Lint/format: ruff.

**Rules:**
- New HTTP calls use `httpx.AsyncClient`. `requests` appears nowhere in new code. **[review]**
- No new runtime dependency without an explicit decision recorded in this repo. **[review]**
- **Approved presentation dependencies (2026-09-14):** `three` + `@types/three` for the `/zone` VFX custom layer (§2.1). No other Three.js usage without a further amendment. **[review]**

## §2 — Product invariants

These encode what the *product* is. Violating any of them means building a different product.

- **Facts + provenance only.** No API response may contain a composite score, risk judgment, recommendation, or AI-generated assessment. Source-provided gradation ships verbatim as text (e.g., zonage labels); our D03 5-band conversion is presentation-layer coloring and is never serialized into the canonical contract. **[test]** — schema forbids score-like fields; **[CI]** — grep gate for `niveau`/`score`/`recommandations` in emitted schemas.
- **Resolution on every fact.** Every hazard object in the contract carries `source`, `resolution`, and attribution fields (`source` + data last-update date, satisfying Licence Ouverte 2.0). A hazard object without these fails schema validation. **[test]**
- **Verbatim BDNB pass-through.** The contract passes BDNB attributes through without silent dropping or renaming. If a field is unavailable it is explicitly null with the failure recorded in the error list — never omitted. **[test]**
- **One canonical shape.** Exactly one response schema per route. Two live shapes for the same resource is a defect (this happened once — see OQ-1 in `docs/workflow/concept.md`). **[review]**
- **Batch is N singles.** `/diagnostic/batch` processes addresses through the identical single-address pipeline. No parallel bulk implementation, no snapshot/versioned-extract code path. **[review]**
- **RGA honesty.** Until a polygon vector source is wired, RGA ships with `resolution: "commune-level estimate"` and nothing may claim per-building resolution for it. **[test]**
- **No dormant code.** Retired features (Copernicus, Open-Meteo, scoring, undifferentiated 3D decoration) are deleted, not commented out or left unreferenced. Git history is the archive. Presentation-tier VFX (§2.1) is an explicit, maintained surface — not dormant decoration. **[review]**

### §2.1 — Presentation-tier cinematic simulation (VFX mode)

The `/zone` map may run a **visual-effects demo mode** alongside the existing data-honest rendering. This is a *presentation* surface only: it must never change API semantics or leak into the canonical contract.

**Scope**
- Applies to frontend presentation only (`/zone`, screenshots/PDF exports derived from it).
- Zero backend routes, schema fields, or batch payloads may carry VFX geometry, scores, or synthetic hazard judgments.

**Dual modes (mandatory)**
- **`data`** — current behavior: honest envelopes (`impactModel`), SVG vignettes, Mapbox fill-extrusion on building footprints, explicit unavailability when inputs are missing.
- **`vfx`** — cinematic rendering: Three.js custom layer on Mapbox, terrain-following water, particles, post-processing, camera director. User-selectable; default remains **`data`** until explicitly toggled.

**Labeling (mandatory in VFX mode)**
- A persistent, visible banner: *« Simulation visuelle — non contractuelle »* (or equivalent i18n key).
- When real inputs are partial, secondary label: *« Données partielles — rendu illustratif »*.
- VFX must not reuse contract vocabulary (`resolution`, `present`, D03 band labels) as if the render were a sourced fact.

**Input rules**
- VFX **must** consume the same client-side drivers as the data mode when available: `timeMin`, Open-Meteo profiles, TRI depth bands (`floodAlea`), hydro journey (`waterFlight` path), BDNB building height/footprint.
- VFX **may** exaggerate appearance (smooth rise, terrain flood plane, bloom, camera motion) but **must not** claim hydraulic accuracy.
- Illustrative fallbacks (e.g. reference-depth preview when meteo is dry) are allowed **only** in VFX mode and **only** with the partial-data label above.

**Performance & integration**
- Windy overlay and VFX 3D camera are mutually exclusive while VFX is active (Windy forces flat mercator). **[test]**
- VFX layer mounts/unmounts cleanly on mode toggle; no WebGL context leak on route change. **[test]**
- Target: ≥ 30 fps on a mid-range laptop at building zoom with water plane enabled; degrade gracefully (disable post-FX first). **[review]**

## §3 — Architecture

- The single-address transaction (`POST /diagnostic/adresse`) is the primitive. Every other surface (map, batch, future bulk) renders, queues, or aggregates it. Features that require a second pipeline are a constitution amendment, not a design choice. **[review]**
- External I/O goes through `app/connectors/*` with explicit timeouts. No upstream call without a timeout. **[review]**
- Geocoding is a tested product component, not a utility: arrondissement handling (Paris/Lyon/Marseille), low-confidence rejection (score < 0.4 → 422), and geocoder-failure behavior have dedicated tests. **[test]**
- Upstream quota limits are respected client-side: BDNB free tier is 120 req/min (10k/month), Géoplateforme geocoding 50 req/s/IP. Identical-address results are served from cache within the configured TTL without re-hitting upstreams. **[test]**

## §4 — Testing

- Known-answer certification tests exist for the four v1-certified hazards (flood/PPRI, ground movement, forest fire, avalanche): a known-inside address yields `present: true` with polygon-checked resolution; a known-outside address yields `present: false`. **[test]**
- **Degraded paths are tested with the same rigor as happy paths:** every connector's failure mode (timeout, 5xx, empty result, malformed payload) produces an explicit degraded record — never a silent gap, never a 500. **[test]**
- Tests run offline by default (upstream APIs mocked); integration tests against live sources are a separate tier. **[CI]**
- Existing tests are not modified during feature work. A wrong test is flagged and fixed in a separate change. **[review]**
- Tests assert behavior (given inputs → expected record), not internal call graphs. **[review]**

## §5 — Security & privacy

- No secrets in code. All credentials via environment variables; `.env.example` documents every variable. **[CI]** — grep gate + example file kept current.
- All external calls carry explicit timeouts; no unbounded waits. **[review]**
- API keys and tokens never appear in logs. Addresses may appear in application logs (they are the query interface), but no policyholder-linked datasets are persisted server-side without a documented retention decision. **[review]**

## §6 — Performance

- p95 latency for `POST /diagnostic/adresse` ≤ 10 s with all sources healthy (budget dominated by public upstreams; revisit at spec with measurements).
- Degraded mode must not exceed the healthy-path budget by more than 2× — a failing source triggers fallback, not retry-storms.
- Latency budgets measured in CI where feasible; regressions > 25% block merge.

*(Numbers proposed at concept stage; calibrated against real measurements during Phase 4/5.)*

## §7 — Documentation

- The canonical contract is documented (schema reference) and updated in the same PR as any schema change. **[review]**
- Decisions that will confuse future-you become short ADRs in `docs/workflow/` or `decisions/`. **[review]**
- `AGENTS.md` is updated when commands, conventions, or workflow locations change. **[review]**

## §8 — Review & merge

- CI green (tests + ruff + lint gates) required before merge. **[CI]**
- PR description includes the self-review checklist from `workflow/07-review.md`. **[review]**
- The constitution is the merge gate: a reviewer checks §2 invariants explicitly on every PR touching the contract. **[review]**

---

## Amendments

| Date | Change | Rationale |
|------|--------|-----------|
| 2026-08-25 | Initial constitution derived from brainstorm + concept phases | Product recentering on per-building hazard × vulnerability join |
| 2026-09-14 | §1: Mapbox GL JS + approved `three` dep; §2.1: dual `data`/`vfx` presentation modes on `/zone` | Enable cinematic demo without compromising API facts-only invariants |
