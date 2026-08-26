# Phase 1 — Brainstorm Notes (2026-08-25)

Raw decision log from the brainstorm session. Source material for `concept.md`.

## Starting diagnosis (verbatim intent)

- Platform queries four public sources — Géorisques, BDNB, Copernicus, Open-Meteo — and presents results in a dashboard.
- Most connectors reproduce what each source's own portal already provides, at the same resolution, for free.
- The one thing no source does, and the one thing we engineered: **linking hazard exposure to building vulnerability at per-building resolution**. Géorisques doesn't know the building; BDNB doesn't know the flood polygon; Copernicus lives on a ~10 km grid.
- Product was never organized around that. Effort spread across four connectors, a scoring layer, a climate dashboard, map reproduction, and 3D extrusions — decoration that fails the test "could the buyer get this from the source directly?"

## Decisions locked during brainstorm

| # | Question | Decision |
|---|----------|----------|
| 1 | Who is the buyer? | **French insurers.** Pilot runs through the **underwriting desk**, not the actuarial floor. |
| 2 | Primary deliverable | Per-building **JSON data contract** (single-address, on-demand). UI is a sales tool, not the product. |
| 3 | Which connectors survive | The **Géorisques WFS × BDNB join**. Copernicus and Open-Meteo serve no insurer-facing purpose in v1. |
| 4 | v1 transaction | **Underwriter's single-address request** (`POST /diagnostic/adresse`). Bulk = N queued singles, a derivative — never a parallel snapshot pipeline. |
| 5 | Hazards in scope | All hazards the WFS serves (layer map is config, marginal cost ≈ 0). **V1 certifies with known-answer tests:** flood/PPRI, ground movement, forest fire, avalanche. |
| 6 | RGA (clay shrink-swell) | Currently keyword-matching on communal data despite being a major claim driver. Either wire a real vector source pre-v1, or ship plainly labeled "commune-level estimate." Decision deadline: before spec sign-off. |
| 7 | Seismic / radon | Decree-communal by nature — permanently `resolution: "commune-level"`. Correct, not a gap. |
| 8 | Vulnerability data | **Full BDNB pass-through verbatim** in the contract (actuaries filter; we don't curate data). Curation happens only at presentation layer (map sidebar shows materials, year, height, DPE class, reliability flags). |
| 9 | Composite score | **Dead.** Facts + provenance only. Under Solvency II a third-party score gets reverse-engineered or refused, and carries liability either way. Scoring is the buyer's job. |
| 10 | D03 bands | Survive only as internal display coloring for zonage text — never emitted as standalone judgment. |
| 11 | Quality signal | With no score, the `resolution` field is the record's integrity backbone. Every hazard object must carry it; the fallback/degraded path is tested as rigorously as the happy path. |
| 12 | The map | Stays, re-justified: renders **our join** (footprint colored by polygon-test result + curated vulnerability sidebar), not reproduced source layers. Working tool for underwriters, sales artifact elsewhere. |
| 13 | Geocoding | IGN/BAN geocoding + arrondissement translation (Paris/Lyon/Marseille) is load-bearing plumbing that makes the WFS join possible. Tested like a product component, not treated as free utility. |

## Corrections made along the way

- Initial claim "maps are irrelevant" was corrected: maps are irrelevant to *actuaries*, but underwriters do spatial judgment (distance to river, PPR perimeter wrap) and already eyeball Géorisques in another tab today.
- The current map's flaw isn't existence — it's that it shows source data without showing the join.

## Residuals carried into Phase 2

1. Licensing: commercial redistribution rights for Géorisques/BDNB derived data (research).
2. RGA fork: real vector source vs labeled commune-level (decision, pre-spec deadline).
3. Dead code disposition: Copernicus/Open-Meteo/scoring — delete vs dormant (decision).
