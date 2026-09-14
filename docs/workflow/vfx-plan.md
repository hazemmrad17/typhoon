# Plan — `/zone` cinematic VFX mode

**Spec:** `docs/workflow/vfx-spec.md` (approved 2026-09-14)  
**Constitution:** §2.1 (amended 2026-09-14)  
**Status:** approved — ready for implementation  
**Conventions:** task ID `VFX-00N`; commits `test(VFX-00N): …` then `feat(VFX-00N): …`; do not modify existing tests during feature work.

---

## Task list

### VFX-001 — Constitution & spec land (this change set)

- **Depends on:** —
- **Spec reference:** FR-VFX-01 (documentation half)
- **Estimate:** 1 h
- **Constitution touchpoints:** §2.1, §7
- **Acceptance criteria:**
  - [x] `constitution.md` amended to v0.2 with §2.1
  - [x] `docs/workflow/vfx-spec.md` and this plan exist
  - [x] `AGENTS.md` points agents to VFX docs
- **Tests to write first:** none

### VFX-002 — Mode toggle + disclaimer shell

- **Depends on:** VFX-001
- **Spec reference:** FR-VFX-01, FR-VFX-02, FR-VFX-08
- **Estimate:** 3–4 h
- **Constitution touchpoints:** §2.1 (dual mode, labeling)
- **Acceptance criteria:**
  - [x] `viewMode: 'data' | 'vfx'` state in `Zone.tsx`; default `'data'`
  - [x] Toggle control in topbar or risk chrome (accessible, keyboard reachable)
  - [x] `VfxDisclaimer` component: primary + optional partial-data label
  - [x] VFX active → panels use minimized layout class (`.zone-vfx-active`)
  - [x] No changes to API calls or `canonicalAdapter` output

  **Implémenté :** `viewMode` par défaut `'data'`, bascule `<button aria-pressed>` dans la topbar (`.vfx-toggle`, icône `movie` ↔ `analytics`, uniquement en vue risques) ; `VfxDisclaimer` rendu **uniquement** en VFX ; `.zone-vfx-active` atténue les panneaux latéraux (opacité 0,35 → 1 au survol). Aucun appel d'API touché.
- **Tests to write first:**
  - `VfxDisclaimer.test.tsx` — renders both label tiers
  - `Zone.vfxMode.test.tsx` — toggle switches class/disclaimer; default is data

**Files:** `Zone.tsx`, `components/VfxDisclaimer.tsx`, `styles/zone.css`

### VFX-003 — VFX input bus + water level driver

- **Depends on:** VFX-002
- **Spec reference:** FR-VFX-03, FR-VFX-09, FR-VFX-10
- **Estimate:** 2–3 h
- **Constitution touchpoints:** §2.1 (input rules)
- **Acceptance criteria:**
  - [x] New module `frontend/src/zone/vfx/vfxInputs.ts`
  - [x] `vfxWaterLevel({ rainProfile, hourIndex, triPeak, allowFallback })` returns `{ levelM, partial, source: 'forecast' | 'fallback' | 'none' }`
  - [x] `data` mode continues using `impactState` / quantised slabs — untouched
  - [x] Fallback depth constant documented (default 1.0 m reference) only when `allowFallback && viewMode==='vfx'`

  **Implémenté :** `VFX_FALLBACK_DEPTH_M = 1.0`, **plafonné par la classe TRI** (`min(triPeak, 1.0)`) : le repli illustratif n'exagère jamais au-delà de l'exposition réglementaire. Sans classe TRI → `source: 'none'` et niveau 0, même avec `allowFallback` : on n'invente pas une exposition. `vfxSourceLabel()` fournit le libellé du disclaimer.
- **Tests to write first:**
  - `vfxInputs.test.ts` — full inputs → level matches `depthAt`; dry meteo + vfx fallback → partial flag; data path not imported by impactModel

**Files:** `frontend/src/zone/vfx/vfxInputs.ts`, `frontend/src/zone/vfx/vfxInputs.test.ts`

### VFX-004 — Add Three.js + custom layer scaffold

- **Depends on:** VFX-003
- **Spec reference:** FR-VFX-04, FR-VFX-05
- **Estimate:** 6–8 h
- **Constitution touchpoints:** §1 (approved dep), §2.1 (mount/unmount)
- **Acceptance criteria:**
  - [ ] `npm install three @types/three`; lockfile updated
  - [ ] `frontend/src/zone/vfx/VfxFloodLayer.ts` implements Mapbox `CustomLayerInterface`
  - [ ] Creates shared WebGL renderer synced via `map.transform`
  - [ ] Placeholder mesh (flat blue plane) visible in VFX mode at building zoom
  - [ ] Layer removed on mode off; no duplicate layers on hot toggle
  - [ ] `UnifiedMap` accepts `vfxMode` + `vfxWaterLevelM` props; wires layer in `style.load` / cleanup
- **Tests to write first:**
  - `VfxFloodLayer.test.ts` — unit-test public helpers (grid bounds, level clamping) without WebGL
  - Manual smoke: toggle 10× without memory spike (document in PR)

**Files:** `VfxFloodLayer.ts`, `UnifiedMap.tsx`, `package.json`

### VFX-005 — Terrain grid + water shader

- **Depends on:** VFX-004
- **Spec reference:** FR-VFX-05
- **Estimate:** 8–12 h
- **Constitution touchpoints:** §2.1 (exaggeration allowed, no accuracy claims)
- **Acceptance criteria:**
  - [ ] Sample DEM via `map.queryTerrainElevation` on N×N grid (default 64×64, configurable)
  - [ ] BufferGeometry displaced by terrain; water plane at `vfxWaterLevelM` with smooth lerp animation (~300 ms)
  - [ ] Fragment shader: depth-tinted water, fresnel rim, semi-transparent
  - [ ] Grid recenters when map `moveend` beyond threshold (debounced)
  - [ ] Graceful degrade if terrain unavailable (flat plane + console warn)
- **Tests to write first:**
  - `terrainGrid.test.ts` — lat/lon bounds, cell count, elevation fallback when query returns null

**Files:** `VfxFloodLayer.ts`, `frontend/src/zone/vfx/terrainGrid.ts`

### VFX-006 — Windy off + 3D camera policy

- **Depends on:** VFX-002
- **Spec reference:** FR-VFX-07
- **Estimate:** 2–3 h
- **Constitution touchpoints:** §2.1 (Windy mutual exclusion)
- **Acceptance criteria:**
  - [x] `UnifiedMap`: when `vfxMode`, call `disableWindyOverlay`, force `pitch ≥ 55`, keep terrain exaggeration from `waterFlight` DEM setup
  - [x] Exiting VFX restores previous metric/overlay state
  - [x] Mapbox `setRain` may stay on in VFX (native, compatible with pitch)
- **Tests to write first:**
  - [ ] `UnifiedMap.vfxMode.test.ts` — mock map: vfx prop triggers windy disable hook (spy on internal helper or exported flag)

  **Implémenté :** prop `vfxMode` sur `UnifiedMap` + effet dédié : `disableWindyOverlay(map)` puis `easeTo({ pitch: VFX_MIN_PITCH_DEG })`. **Exclusion mutuelle** Windy ↔ caméra 3D (§2.1). En sortie de VFX, l'effet `weatherMetric` existant reprend la main : la politique data est restaurée telle quelle.
  *Restant :* le test de prop est **non écrit** — il demande un double de `mapboxgl.Map`, qui n'existe pas encore dans la suite frontend. À faire avec VFX-004, qui introduit de toute façon un faux map pour le custom layer.
  *Restant :* l'exagération de terrain du vol hydro n'est pas encore branchée (elle viendra avec VFX-004/005 ; aucune source DEM n'est montée par `ensureTerrain` pour l'instant).

**Files:** `UnifiedMap.tsx`

### VFX-007 — Camera director (“Play scenario”)

- **Depends on:** VFX-005, VFX-006
- **Spec reference:** FR-VFX-06
- **Estimate:** 6–8 h
- **Constitution touchpoints:** §2.1
- **Acceptance criteria:**
  - [ ] `frontend/src/zone/vfx/VfxDirector.ts` orchestrates: `flyTo` (building, pitch 65, zoom 17) → `WaterFlight.play()` if journey → `onComplete` starts timeline play
  - [ ] “Play scenario” button in VFX chrome; disabled without diagnosed address
  - [ ] Director cancellable (mode toggle, new diagnosis, user pan)
  - [ ] Reuses `waterFlight.ts` callbacks; no duplicate path math
- **Tests to write first:**
  - `VfxDirector.test.ts` — state machine transitions with mocked map/flight

**Files:** `VfxDirector.ts`, `Zone.tsx`, `RiskConsole.tsx` or new `VfxControls.tsx`

### VFX-008 — Timeline sync + data mode isolation

- **Depends on:** VFX-003, VFX-005
- **Spec reference:** FR-VFX-03, FR-VFX-01
- **Estimate:** 3–4 h
- **Constitution touchpoints:** §2.1
- **Acceptance criteria:**
  - [x] `timeMin` scrub/play updates `vfxWaterLevelM` every frame in VFX mode
  - [x] `impact` prop to UnifiedMap forced `null` in VFX mode (no double water)
  - [x] `ScenarioPanel` vignettes show optional “VFX preview” badge or stay data-honest (team choice: **stay data-honest** per spec)

  **Implémenté (partiel) :** `vfxLevel` est recalculé à chaque changement de `riskTimeMin`/`triPeak`/`rainProfile`, et `Zone` transmet `impact={vfx ? null : riskImpact}` — **aucune double nappe d'eau**. Les vignettes du panneau restent data-honest (choix de spec), donc aucun badge « VFX preview » n'est ajouté.
  *Restant :* `vfxWaterLevelM` n'est pas encore consommé par une couche de rendu — il le sera par `VfxFloodLayer` (VFX-004). D'ici là, `vfxLevel` alimente le libellé du disclaimer (`partial`), qui n'est donc pas dormant.
- **Tests to write first:**
  - `Zone.vfxIsolation.test.ts` — vfx mode does not pass `impact` to map

**Files:** `Zone.tsx`, `UnifiedMap.tsx`

### VFX-009 — Post-FX pass (optional polish)

- **Depends on:** VFX-005
- **Spec reference:** performance target §2.1
- **Estimate:** 4–6 h
- **Constitution touchpoints:** §2.1 (perf)
- **Acceptance criteria:**
  - [ ] Lightweight bloom + vignette via `EffectComposer` or single full-screen quad
  - [ ] Toggle `vfxPostFx` env or setting; auto-off if frame time > 33 ms for 2 s
  - [ ] Document perf baseline in PR
- **Tests to write first:** none (manual perf); optional frame-budget unit test for auto-off logic

**Files:** `VfxPostFx.ts`, `VfxFloodLayer.ts`

### VFX-010 — Secondary hazard FX (wind / fire)

- **Depends on:** VFX-007
- **Spec reference:** phase 2 in vfx-spec
- **Estimate:** 8–10 h
- **Constitution touchpoints:** §2.1
- **Acceptance criteria:**
  - [ ] Wind: particle field oriented by `gustProfileFrom` peak direction
  - [ ] Fire: extruded cone from `fireConeFrom`, additive particles
  - [ ] Activated by `hazardEvent` switch; flood layer coexists or hides per event
- **Tests to write first:**
  - `vfxHazardFx.test.ts` — particle count/direction derived from gust/fire inputs

**Files:** `VfxWindParticles.ts`, `VfxFireCone.ts`

---

## Task ordering

```
VFX-001 (done)
    └── VFX-002 ──┬── VFX-003 ── VFX-004 ── VFX-005 ── VFX-009
                  │                              │
                  └── VFX-006 ────────────────────┴── VFX-007
                                                   │
                              VFX-008 ◄────────────┘
                              VFX-010 (after VFX-007, parallel to VFX-009)
```

**Parallel groups:**
- After VFX-002: VFX-003 and VFX-006 can run in parallel
- After VFX-005: VFX-007, VFX-008, VFX-009 can overlap

**Suggested PR slices (reviewable):**
1. **PR-A:** VFX-002 + VFX-003 + VFX-006 (toggle, disclaimer, drivers, Windy policy) — shippable, no WebGL yet
2. **PR-B:** VFX-004 + VFX-005 + VFX-008 (water plane MVP)
3. **PR-C:** VFX-007 + VFX-009 (director + polish)
4. **PR-D:** VFX-010 (wind/fire)

---

## Risk log

| Task | Risk | Mitigation |
|------|------|------------|
| VFX-004 | Mapbox + Three context sync bugs on resize | Follow Mapbox custom-layer example; resize observer on container |
| VFX-005 | `queryTerrainElevation` sparse / slow | Cap grid size; cache last grid; debounce moveend |
| VFX-005 | No terrain source until hydro flight mounts DEM | Ensure `ensureTerrain()` runs on VFX enter (reuse `waterFlight` DEM source id) |
| VFX-006 | Users expect Windy wind in VFX | Document in disclaimer; native rain + Three wind particles in VFX-010 |
| VFX-007 | Camera nausea | Cap pitch, ease durations, allow skip |
| All | Perf on Intel iGPU | Post-FX auto-off; reduce grid to 32×32 |

---

## Definition of done (whole feature)

- [ ] All VFX-001..VFX-008 tasks merged (VFX-009/010 optional but documented)
- [ ] `npm test` + `npm run build` green
- [ ] `python -m pytest tests/ -q` green (no backend changes expected)
- [ ] Manual smoke script recorded in PR:
  1. Diagnose flood-exposed address
  2. Toggle VFX → disclaimer visible, Windy off, pitch 3D
  3. Play scenario → camera flight → water rises with timeline
  4. Toggle back to data → footprint envelope returns, no WebGL errors
- [ ] Constitution §2 API invariants verified unchanged (grep + schema tests)
- [ ] `AGENTS.md` updated with VFX mode note

---

## Implementation notes (for agents)

**Key integration points**

| File | Change |
|------|--------|
| `Zone.tsx` | `viewMode`, wire `vfxWaterLevel`, conditional `impact={viewMode==='data' ? riskImpact : null}` |
| `UnifiedMap.tsx` | Props `vfxMode`, `vfxWaterLevelM`; mount `VfxFloodLayer`; VFX camera policy |
| `waterFlight.ts` | Export `ensureTerrain(map)` if not already public — VFX reuses same DEM source |
| `impactModel.ts` | **Do not modify** for VFX; keep data mode honest |
| `hazardSim.ts` | Update header comment to note VFX mode uses SVG in data, Three in vfx — optional doc-only |

**Env vars:** none new (uses existing `VITE_MAPBOX_TOKEN`).

**Branch name:** `feat/VFX-002-mode-toggle` (first implementation PR after this docs PR).
