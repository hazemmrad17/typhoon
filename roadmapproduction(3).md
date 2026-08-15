# Typhoon — Roadmap to production

> Rewritten 2026-08-14 to reflect the direction settled in
> `docs/product-direction.md`: the differentiator is a per-building, multi-horizon
> climate risk **trajectory**, not a better current-risk score and not a UI. Phases
> are ordered so the trajectory gets built and validated before the product built on
> top of it. This replaces the UI-first ordering of the previous version of this
> document — see git history if you need that version back.
>
> Complements `docs/plan-multi-profils-assurance.md` (component-level UI spec) and
> `docs/visualisation-risques-2d-3d.md` (map rendering) — those remain accurate for
> *how* to build each screen; this document governs *when*.

---

## 0. Read this first

**Read `docs/product-direction.md` before this document if you haven't.** Short
version: don't build the underwriting UI or the portfolio dashboard assuming the
score underneath them is already differentiated — right now it isn't. The trajectory
(current risk + explicit 2050/2100 projections, per building, with provenance) is
the actual product; the UI and the data feed are two delivery shapes for it.

Two buyers, from the direction doc: the **underwriter** (day-to-day accept/refer/
decline decisions, wants a UI) and the **actuary / pricing team** (wants the same
variables in bulk, as data, to feed their own models). Keep both in mind — don't
build only the UI and assume it also serves the actuary.

---

## Current state, verified against `develop` (2026-08-14) — and the next sprint

Checked the actual code on `develop`, not just commit messages. Real progress, ahead
of where the phase numbering below would suggest — this section is the concrete
next-sprint plan; the phases below stay as the longer-range reference.

**Already done, confirmed in code:**
- `backend/app/scoring/risk_model.py::compute_trajectoire` exists and matches the
  spec: raw F per peril, per horizon, never combined. 2026 is `observe` (live
  Géorisques/BDNB), **2050 is `projete` using real Open-Meteo climate-projection data
  already** (`climat_open_meteo.projection_2041_2050` — this doesn't wait on
  Copernicus), 2100 is honestly `indisponible` until Copernicus is on.
  `backend/tests/test_trajectoire.py` regression-tests frozen values, exactly per
  roadmap item 7.
- `backend/partner_api/schemas.py` and `service.py` already expose this trajectory
  on `POST /v1/analyze` (`TrajectoirePoint` / `TrajectoirePeril` / `Trajectoire`,
  wired via `_trajectoire_from_raw`). Phase 4B's raw-variable contract is
  substantially started, not just planned.

**Not done yet, confirmed by absence:**
- `backend/app/connectors/georisques.py` is unchanged — every hazard endpoint still
  queried by `code_insee`, `present_commune` still the field name. Per-building
  resolution (Phase 1, item 4) hasn't started.
- No `climat_copernicus` producer anywhere in the tree — the 2100 point is
  `indisponible` because nothing populates it yet, not because of a bug.
- `backend/partner_api/service.py` only has `analyze_address` (singular) — no batch
  endpoint yet (Phase 4B, item 24).
- Frontend `Zone.tsx` is unchanged: still the six-step generic stepper, doesn't
  render the trajectory anywhere, no `profile` field.
- `mapbox-gl` is still the active map dependency; `maplibre-gl` sits unused in the
  root `package.json`.

**Independently re-verified (2026-08-14, after an implementation report came in):**
Pulled `origin/develop` fresh and checked it myself rather than taking the report on
faith — it matches. `diagnostic_builder.py` does wire `trajectoire` into the
diagnostic JSON (line ~135); I ran `test_trajectoire.py` myself, 3/3 pass. Two new,
real findings surfaced by that report and confirmed independently, not caused by the
trajectory work — both belong in Phase 3 (testing/CI), added as tickets below:
- **`tests/test_scoring.py` cannot even be collected** — `ModuleNotFoundError:
  app.scoring.zone_scoring` (also imports a `promoteur_report` module that doesn't
  exist in the current tree). Confirmed by running it myself: this is a real,
  pre-existing break, not an environment artifact — those modules are gone from a
  prior rewrite and nothing updated the test to match. Since CI (Phase 3, item 14)
  doesn't exist yet, this has been silently broken with nobody noticing.
- **9 other tests need `pytest-asyncio`** to run their `async def test_...`
  functions at all — it's in `requirements.txt` but apparently wasn't installed in
  the environment that hit this. Environment-setup gap, not a code bug, but exactly
  the kind of thing a real CI pipeline (pinned, reproducible install) prevents from
  recurring.

**Process note, not a code issue:** that report also mentioned a near-miss — a
`git stash` collision on a shared checkout with another agent's edits landing in
`frontend/` at the same time. It says the tree was fully restored, but multiple
agents mutating one shared working directory concurrently is a real way to lose
work, not just a hypothetical — worth moving to one working tree per agent (a
branch or worktree each) rather than a shared checkout, before it happens again and
isn't so recoverable.

**Next sprint, in order — each ticket sized to be shippable on its own:**

0. **Fix `test_scoring.py`'s collection failure and get `pytest-asyncio` installed
   in whatever environment runs tests.** Cheap, and it's the reason "138 passed" from
   the report undercounts what's actually being checked — a chunk of the suite isn't
   running at all right now. Do this before Phase 3's CI even goes in, so CI starts
   green instead of inheriting a known-broken baseline.
1. **Get real feedback on what already exists before building more.** You have real
   2026 + 2050 trajectory data (not stubs) flowing through `/v1/analyze` right now.
   Send the actuary an example response for a real address before finishing 2100 —
   confirm the `Trajectoire` schema shape is usable for his model ingestion (field
   names, units, the `scenario: null` on 2050 since it's Open-Meteo not an RCP/SSP
   run) while it's still cheap to change. Building the rest of Phase 1 on an
   unvalidated schema is the same mistake the original Phase 0 was trying to avoid.
2. **Per-building hazard resolution** — Phase 1, item 4: fix the WFS vector fetch,
   intersect against the building footprint in `georisques.py` instead of querying
   by `code_insee`. This is the biggest remaining gap between what's shipped and
   what was promised ("per-building," not "per-commune").
3. **Copernicus wiring for 2100 + explicit RCP/SSP scenario tagging.** Note the
   current code only ever tags one scenario (`"rcp8_5"`) when Copernicus is active —
   the actuary asked for scenario conventions plural; confirm with him (question 1)
   whether one scenario is enough for a first version or he needs more than one
   side by side.
4. **Batch endpoint on `partner_api`** (Phase 4B, item 24) — once (1) confirms the
   schema, this is mostly plumbing: same `Trajectoire` shape, an async submit/poll
   pattern instead of one address per call.
5. **Frontend: `profile` field + the redesigned Décision step** (Phase 4A) — now
   has real trajectory data to render instead of a stub, so this is a good time to
   build it, not before.
6. **Mapbox → MapLibre migration spike.** Someone already added `maplibre-gl` to the
   root `package.json` — worth finishing that thought. Estimate current/projected
   map-load volume against Mapbox's 50k/month free tier first; if you're far from
   it, this is a small, low-risk cost-avoidance ticket, not urgent, but cheap to do
   now while `UnifiedMap.tsx` is already getting touched for the Décision redesign
   rather than revisiting it a third time later. Remember: swapping the renderer
   doesn't remove the tile/style bill unless you also move off Mapbox's hosted
   styles (`VITE_MAPBOX_STYLE`) — check that cost too before treating this as fully
   free.

**One tension worth naming, not hiding:** feature work (trajectory, partner API) is
now ahead of the security foundation (Phase 2 — auth, CORS, admin — still entirely
unstarted). That's fine as a deliberate choice to validate the trajectory schema
with real buyers before spending days on infrastructure — but it's a choice, not an
accident, and Phase 2 still has to land before any of this is handed to an actual
customer, since the API remains fully open right now.

---

## Phase 0 — Validate before building — ANSWERED (2026-08-14)

Asked the actuary directly. Full detail and implications in
`docs/product-direction.md` §"Validated with the actuary" — summary:

1. **Horizons:** all of it — round years (2026/2050/2100) *and* values tied to
   explicit RCP/SSP scenario conventions. Every value must keep its scenario tag,
   never collapsed to a single averaged number per year.
2. **Delivery:** both interactive (per-submission) and whole-book batch, from the
   start — same schema, two transports.
3. **Output shape:** raw per-peril, per-horizon, per-scenario variables, not a
   composite score. He runs his own formulas; Typhoon supplies clean, correctly
   labeled inputs, not a pre-digested verdict.
4. **The real alternative:** himself. He's an actuary/data scientist who currently
   builds this data engineering (multi-source, per-building, multi-horizon) by hand
   before he can run a formula. That's the concrete value prop — not a smarter
   model, a data pipeline he doesn't have to build and maintain.

Still open, and still worth asking the *insurer testimonial* contact separately
(different person, different question): was "per-asset instead of zonage" about
today's risk, or about tracking how it changes over time for their book? That
determines how much of Phase 4A (the underwriter UI) should also foreground the
trajectory versus a simpler current-state verdict.

**Also still open, and not yet written down anywhere: pricing.** The wedge is
specified (§"Validated with the actuary" above); how you charge for it isn't. See
`docs/product-direction.md` §"Pricing — open question" for a menu of options mapped
to the two buyer types — deliberately not a firm number, since that needs unit-cost
and willingness-to-pay input only you have.

---

## Phase 1 — Make the trajectory real (the core differentiator, revised estimate below)

This is the center of gravity. Everything in Phases 3+ is built on top of its output.

**Timeline reality check (2026-08-14 revision):** the original "~1-2 weeks" estimate
was optimistic and should not be trusted as-is. The critical path — an unproven
Copernicus connector, GML/point-in-polygon work of unknown difficulty, batch-scale
elevation lookups, and a schema that has to satisfy an actuary's model ingestion —
is realistically **4-6 weeks**, not 1-2, and everything downstream stacks on it being
right. Concrete reasons, beyond "it's untested":

- The Copernicus connector has never run end-to-end — the sandbox it was written in
  blocks outbound access to `cds.climate.copernicus.eu`, so its request format is
  correct-per-documentation but unverified against a live response.
- The GML/WFS vector fix has an open-ended "unknown until tried" quality — the doc
  it's scoped in (`docs/visualisation-risques-2d-3d.md`) flags the current parsing as
  silently broken, not "almost working."
- **Climate projections are not naturally per-building.** CDS climate indicators
  (temperature, precipitation, drought indices) come on a spatial grid — tens of
  kilometres per cell, not per address. "Per-building trajectory" in practice means
  per-building *current* hazard combined with a coarser *future* climate delta applied
  from whichever grid cell the building falls in. That's still more precise than
  commune-level, but it needs its own honest resolution disclosure (same idea as the
  "per-building vs commune-level" flag below) — don't let "per-building trajectory"
  imply grid-cell-level precision for the projection component that doesn't exist.
- **"2026" isn't a projection horizon, it's the baseline.** Climate projection
  datasets are typically built around windows like 2021-2050 / 2071-2100, not a
  specific near-term year. Today's value comes from live Géorisques/BDNB data, not
  from Copernicus at all. Keep that distinction explicit in the schema — "2026" is
  observed/current, "2050"/"2100" are modeled, and they're not the same kind of
  number even though they'll sit side by side in the same trajectory.
- **The elevation lookup and the actuary's batch requirement collide.** The IGN
  altitude API is capped at 5 requests/second/IP (documented in
  `ign_altitude.py`). A whole-book batch of hundreds of thousands of addresses at
  that rate is many hours per run, serialized. The repo already has a working pattern
  for exactly this problem — `dvf_lookup_dir`, a locally downloaded dataset instead of
  a live per-request API call (see `backend/data/lookup/dvf/README.md`) — the same
  approach (download the relevant RGE ALTI tiles once, query locally) is very likely
  the right fix here too, rather than trying to rate-limit-manage a live API at
  actuarial batch scale.

Recommendation: **timebox a 2-3 day spike first** — register a CDS account, run one
real request against the live API, confirm the response shape and how long the async
queue actually takes, before committing engineering time to the rest of this phase
on the current estimate. If the spike surfaces a blocker (auth friction, a queue that
takes hours not minutes, a dataset structure different from what the docstring
assumes), the estimate moves again — better to find that in 3 days than in week 3.

3. **Turn on and productionize Copernicus** (`copernicus_enabled` is `false` by
   default today, flagged as expensive — multi-gigabyte download on first run). Scope
   the actual data volume needed once Phase 0 answers which horizons/variables matter;
   don't default to downloading everything.
4. **Resolve hazards per building, not per commune.** Today, most Géorisques-sourced
   hazards (flood zones, PPR, seismic zoning, radon, ICPE, contaminated sites, CatNat)
   are queried by `code_insee` in `backend/app/connectors/georisques.py` — the field is
   even named `present_commune`. Fix the WFS vector fetching already scoped in
   `docs/visualisation-risques-2d-3d.md` (P1: wrong output format requested, currently
   silently fails), but point its output at the **scoring layer**, not just the map:
   intersect the building's footprint/coordinates against the real hazard polygons
   instead of asking "does this commune have one anywhere." Add a building-elevation
   check via the existing `ign_altitude.py` connector for flood specifically — cheap
   for interactive single-address use; for batch, download the relevant RGE ALTI tiles
   locally instead (see the timeline note above) rather than hitting the live API at
   volume.
5. **Keep current risk and projected risk explicitly separate, never blended —**
   **and keep the raw per-peril variables queryable, not just the combined score.**
   `backend/typhon_risk_engine/` already made the current-vs-projected split on paper
   (D05: "projections prospectives jamais dans F, V, R") but it isn't wired into the
   live scoring agent (`backend/app/scoring/risk_model.py`, a partial rewrite, not the
   same code). Resolve that split now: either have the live app consume
   `typhon_risk_engine` directly so there's one tested source of truth, or explicitly
   port the D05 separation into `risk_model.py`. Confirmed by the actuary (Phase 0):
   the intermediate hazard variables per peril (F, before combination into R) are
   what he actually wants, tagged with horizon *and* scenario (RCP/SSP) — design the
   internal schema so those stay addressable on their own, not only as inputs
   consumed internally on the way to a final score. The underwriter-facing UI
   (Phase 4A) can still show a combined verdict; the data underneath must not force
   that combination on every consumer.
6. **Provenance per data point.** For every hazard, at every horizon: source, date,
   method, and a resolution flag ("per-building, polygon-checked" vs. "commune-level
   estimate" — be honest about which hazards are still zone-level after step 4). This
   is what makes the trajectory defensible to an actuary in a model review instead of
   a black box he has to trust on faith.
7. **Regression tests on the trajectory itself**, not just the current score: freeze
   reference addresses, freeze their expected values at each horizon, fail CI if a
   change moves them without explicit review. Getting this wrong silently is worse
   here than anywhere else in the app — it's the number the whole pitch rests on.

**Deliverable:** for a given address, the API returns a real, per-building risk
reading at each horizon (not a stub), each with its source and resolution level
disclosed, current and future cleanly separated.

---

## Phase 2 — Security & account foundation (blocking, ~3-4 days)

Unchanged from before — this doesn't depend on Phase 1 and can run in parallel with
it if you have the people for it, but nothing in Phase 3+ ships without it.

8. Real authentication on `backend/app.main` (sessions or JWT; one user = one
   organization = one profile). Replace `mockUser.ts` with a real `/auth/me` call.
9. Tighten CORS (`allow_origins=["*"]` → known domains) once a real frontend is
   deployed somewhere with a domain.
10. Real secrets management (vault/secrets manager) instead of a hand-copied `.env`.
11. Basic rate limiting on `/diagnostic*` and whatever new trajectory endpoints
    Phase 1 adds — batch/actuarial usage in particular can hammer external APIs and
    your Mistral/Copernicus bill if unthrottled.

### Phase 2.5 — Minimal admin/ops layer (~2-3 days)
12. Protected endpoints or a small internal page: create an organization, assign it a
    profile, issue/revoke a Partner API key, see basic usage (diagnostics run,
    external API calls, errors). No admin tooling exists today — you need this before
    a second real customer, not before a tenth.

---

## Phase 3 — Testing, CI & deployment (blocking for any real launch, ~4-6 days)

13. Frontend tests (vitest + React Testing Library) on whatever UI ships next.
14. GitHub Actions CI: lint + `tsc -b` + frontend tests, `pytest` backend (including
    the Phase 1 trajectory regression tests), on every PR.
15. Containerization (`Dockerfile`s + `docker-compose.yml`) and a real deployment
    target — everything currently only runs on a developer's laptop.
16. Observability: a full health-check (external dependencies up/down, not just
    today's basic `/health`) and error tracking (Sentry or equivalent).
17. Data-license review for commercial B2B use of Géorisques, BDNB, DVF, IGN,
    Open-Meteo/Copernicus, Mistral — before a first paying contract, not after.
    **Copernicus: resolved (2026-08-14)** — the CDS "Licence to use Copernicus
    Products" explicitly permits commercial use, royalty-free and perpetual;
    requires attribution ("Generated using Copernicus Climate Change Service
    information [year]", or "Contains modified..." once scored) wherever the data
    or a derivative of it is shown — build this into the PDF/report templates from
    the start. No warranty/liability on their side. Still open: Géorisques, BDNB,
    DVF, IGN, Mistral. Also still open: confirm the CDS connector actually works
    end-to-end — it was written and documented against the official API request
    format but never tested live (the dev sandbox it was built in blocks outbound
    access to `cds.climate.copernicus.eu`); verify on Phase 1 kickoff, on a machine
    with normal network access, before relying on it.
18. Privacy review: addresses tied to a customer's book of business are indirect
    personal data — legal basis, retention, DPA-with-customer if needed.

---

## Phase 4 — Delivery layers (built on top of 1-3)

Two shapes for the same underlying trajectory. Phase 0 answered 4B's requirements
precisely (raw variables, both interactive and batch) — 4A's priority for the
underwriter-UI side still depends on following up with the insurer testimonial
contact (see Phase 0 note above) on whether he needs the trajectory front-and-center
or a simpler current-state verdict is enough for that persona. Don't assume the UI
is the default just because it was scoped first in earlier drafts of this roadmap.

### 4A — Underwriter UI (`docs/plan-multi-profils-assurance.md` has full component specs)
19. `profile` field on the real account (from Phase 2); `FEATURES[profile]` +
    `STEP_ORDER[profile]` in `Zone.tsx`; conditional sidenav.
20. `UnderwritingCard`: verdict, hazard pills, CatNat timeline, the horizon toggle now
    backed by a *real* trajectory instead of a stub, collapsible provenance panel
    (surfacing the per-hazard resolution-level disclosure from Phase 1.6).
    **Demote the global blended score, don't lead with it.** The current `/zone`
    screen (`frontend/src/routes/Zone.tsx`, the `score-block` around line 713) puts a
    large "Score de risque global /100" with a D03 badge *above* the per-aléa cards —
    exactly the black-box composite the actuary said he doesn't trust, and in tension
    with this whole document's "not the score" position. For the insurer step order,
    don't reuse that hierarchy as-is: lead with the per-aléa decomposition and the
    horizon trajectory, keep the global number as a small summary line, not the
    headline. (The developer-facing flow can keep its current layout — this is a
    per-persona `STEP_ORDER`/layout change, not a removal of the score app-wide.)
21. Company-branded PDF export with the trajectory shown decomposed by horizon and
    the "does not replace the official ERRIAL" disclaimer — have a lawyer confirm
    the wording before shipping it.
22. `PortfolioDashboard`: CSV import, batch diagnosis, aggregate view (band
    histogram, most-exposed communes, heatmap, exports). Biggest single build here
    (3-5 days) — the real product-side differentiator once the score under it is
    trustworthy.
23. `WatchlistPanel`: followed communes/addresses, alert badge on new CatNat decrees.

### 4B — Actuarial / bulk data feed (requirements confirmed, Phase 0)
24. Industrialize `backend/partner_api/` (currently a bare `X-API-Key`-gated
    `POST /v1/analyze`, scoped for third-party integration but never built out) into
    **two endpoints on one schema**: the existing single-address interactive call,
    and a new batch endpoint for whole-book submissions (hundreds of thousands of
    addresses) — both confirmed needed, build both, not one-then-maybe-the-other.
    Batch at that volume needs a real async pipeline (submit → poll/webhook → file
    export), not a live loop through `/diagnostic/adresse` per address.
25. Response payload is **raw variables, per peril, per horizon, per scenario** —
    not a composite score. Example shape: an array of
    `{peril, horizon_year, scenario (RCP/SSP tag), value, unit, confidence,
    resolution ("per-building" | "commune-level"), source, source_date}` records per
    address, not a single risk number. This is a direct, confirmed requirement, not
    a guess — don't simplify it back down to a score to make the API "cleaner."
26. Document the response contract explicitly enough that his model ingestion
    doesn't require a call with you every time a field changes — versioned schema,
    changelog. Since he consumes raw variables directly into his own formulas, a
    silent schema change breaks his model, not just a display — version this more
    carefully than a typical internal API.

---

## Out of scope, still (unchanged, deliberately)

- **Actuarial pricing model.** Typhoon supplies risk inputs, not a premium.
- **The 3D digital twin / BIM viewer, for the insurer track.** It's real and valuable
  for the developer persona (visualizing renovation work); for insurer, it doesn't
  drive the accept/refer/decline decision, its current geometry accuracy isn't good
  enough to feed a score responsibly, and it's explicitly not where the validated
  customer signal points. Leave it alone here.
- **Developer and bank persona feature work.** The developer flow already works and
  mostly just needs to sit behind the Phase 2 auth; the bank persona is a small
  follow-on (a compliance-checklist step around the existing ERRIAL export) — pick
  it up after the insurer track ships, not alongside it.
- **Multi-user roles / team permissions.** Needed eventually, not blocking a first
  launch with one profile per account.

---

## Launch checklist

- [ ] Phase 0 answers in hand — you know which horizons/granularity/volume the
      actuary and the insurer contact actually need
- [ ] Phase 1: trajectory is real, per-building, horizon-decomposed, provenance-tagged,
      regression-tested
- [ ] Phase 2 + 2.5: real accounts, CORS locked down, minimal admin layer
- [ ] Phase 3: CI green, tests passing, deployed off-laptop, licenses and privacy
      reviewed
- [ ] Phase 4A and/or 4B, per what Phase 0 told you to build first
