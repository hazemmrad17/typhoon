# Spec — `/zone` cinematic VFX mode

**Status:** approved (2026-09-14) — follows constitution §2.1 amendment  
**Owner:** Hazem  
**Related:** `constitution.md` §2.1 · `docs/workflow/vfx-plan.md` · `frontend/src/zone/{floodSim,impactModel,waterFlight}.ts`

---

## Summary

Add a user-toggleable **VFX mode** on `/zone` that turns the risk simulation into a cinematic visual-effects demo. The canonical API and data-honest **`data`** mode stay unchanged. VFX is presentation-only, permanently labeled non-contractual, and driven by the same real inputs when they exist.

## Goals

- Deliver a “wow” demo suitable for pitches, screen recordings, and stakeholder walkthroughs.
- Keep insurer-facing API semantics untouched (constitution §2).
- Preserve **`data`** mode as the default and the auditable reference implementation.

## Non-goals

- No new backend endpoints or schema fields for VFX geometry.
- No claim of hydraulic / CFD accuracy in UI copy or exports.
- No replacement of the honest `impactModel` path — VFX is parallel, not a rewrite.
- No LIDAR digital-twin restoration (deleted per FR-25); terrain comes from Mapbox DEM only.

## User stories

**US-VFX-1 — Pitch demo.**  
As a product owner, I toggle VFX mode after diagnosing an address and press Play, so that the camera flies the hydro path and water rises dramatically over the terrain while staying loosely tied to the rain timeline and TRI peak.

**US-VFX-2 — Honest fallback.**  
As a reviewer, when Open-Meteo or TRI is missing, I still see a labeled illustrative render in VFX mode, so that the demo never shows a blank screen without warning.

**US-VFX-3 — Underwriter escape hatch.**  
As an underwriter, I switch back to **data** mode instantly, so that I see the current honest envelope and panels without cinematic exaggeration.

## Functional requirements

| ID | Requirement | Acceptance criteria |
|----|-------------|---------------------|
| FR-VFX-01 | Dual mode toggle on `/zone`: `data` (default) \| `vfx`. | Toggle persists for session; reload resets to `data`. Grep finds no VFX code paths mutating API payloads. |
| FR-VFX-02 | Persistent disclaimer in VFX mode. | Banner visible whenever `vfx` active; includes “Simulation visuelle — non contractuelle”. Partial inputs add secondary “Données partielles — rendu illustratif”. |
| FR-VFX-03 | VFX flood plane driven by existing sim. | `waterLevelM` derived from `depthAt(rainProfile, hourIndex, triPeak)` when inputs exist; smooth interpolation allowed (no 5 cm quantisation in VFX). |
| FR-VFX-04 | Three.js Mapbox custom layer. | Layer syncs camera with map pitch/bearing/zoom; removes cleanly on mode off/unmount. |
| FR-VFX-05 | Terrain-following water mesh. | Samples Mapbox terrain elevation on a bounded grid around focus; mesh displaces with uniform `waterLevelM`. |
| FR-VFX-06 | Camera director. | On “Play scenario”: `flyTo` building → optional `WaterFlight` along journey → hold on building during timeline scrub/play. |
| FR-VFX-07 | Windy off in VFX. | Enabling VFX disables Windy overlay and keeps 3D pitch enabled. Re-enabling data mode restores prior weather behavior. |
| FR-VFX-08 | UI chrome reduction in VFX. | Side panels collapse or minimize; hero = full-bleed map + timeline + play control + disclaimer. |
| FR-VFX-09 | Illustrative fallback. | If `rainProfileFrom` or TRI peak null: VFX may show reference depth (e.g. 1.0 m) only with partial-data label; data mode unchanged (still shows unavailability). |
| FR-VFX-10 | Offline tests for drivers. | Unit tests for `vfxWaterLevel()` mapping (real inputs, partial fallback, data-mode isolation). No WebGL in unit tests. |

## Architecture sketch

```
Zone.tsx
  viewMode: 'data' | 'vfx'
  ├── data → UnifiedMap(impact, journey) + RiskConsole + ScenarioPanel (current)
  └── vfx  → UnifiedMap(vfxMode, vfxWaterLevel, directorState)
              └── VfxFloodLayer (Three.js custom layer)
              └── VfxDirector (camera choreography, uses waterFlight.ts)
              └── VfxDisclaimer banner
```

**Input bus (shared, read-only):**

| Signal | Source module |
|--------|---------------|
| `timeMin` | `RiskConsole` / `Zone` state |
| `rainProfile`, `depthAt` | `floodSim.ts` |
| `triPeak`, `floodAlea` | `floodAlea.ts` |
| `journey`, basin | `hydroRoute.ts` |
| `gustProfile`, `fireCone` | `windSim.ts`, `hazardSim.ts` |
| Building footprint/height | `report.bdnb` |

## Out of scope (phase 2+)

- Fire/wind volumetric FX (particles) — plan task VFX-007+
- SSR water reflections, building window shaders
- PDF export of VFX frame
- Mobile WebGL perf parity
