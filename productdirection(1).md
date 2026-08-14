# Typhoon — Product direction (one page)

> Written 2026-08-14, after a working session that tested the premise against
> real feedback (an insurance testimonial, an actuary) and against the public
> competitive landscape. This is the settled reference — update it when the
> premise changes, don't re-derive it from scratch each time.

## The one-sentence pitch

Typhoon turns public climate projections and property data into an auditable,
per-building risk **trajectory** — today's risk plus how it moves by 2050 and
2100, decomposed and traceable rather than blended into one black-box number —
delivered as a decision card for an underwriter, or as structured data for an
actuary's own pricing model.

## What we are not competing on

- **Not "better current risk data than insurers have."** For any property an
  insurer already covers, their own claims history is a better predictor of
  risk than anything built from public sources. Don't try to win there.
- **Not "we're first to do per-building instead of per-commune."** Funded
  competitors already sell exactly that framing (Descartes Underwriting,
  Callendar, among others). Building it is necessary, not differentiating on
  its own.
- **Not a pricing/actuarial model.** Typhoon supplies risk *inputs*, not a
  premium. That stays explicitly out of scope — it needs a loss-cost corpus
  Typhoon doesn't have and shouldn't pretend to.

## The actual wedge

Climate change is a **non-stationary** risk problem: the future doesn't
resemble the past. An insurer's claims data, however large, is a record of
realized losses under yesterday's climate — it structurally cannot tell them
how flood, drought, or heat exposure at a specific building shifts over the
next 25–75 years. That number has to come from climate science and projection
models (Copernicus CDS), not from a loss ledger. No amount of proprietary
claims data closes that specific gap — which is exactly the gap an actuary,
whose job is pricing and reserving decades out, cares about.

This is also not a hypothetical need: it's part of a live policy conversation
in French insurance (proposals to adapt the national insurance system to
climate risk, CatNat regime reform), not a niche concern invented for this
project.

## What creates value for the buyer

Not the score. Not the UI polish. The combination of three things, each
copyable alone, harder to copy together:

1. **Per building**, not per commune or per zone.
2. **As a trajectory**, multiple explicit horizons (now / 2050 / 2100), never
   silently blended into a single present-day number.
3. **With provenance** — which source, which date, which method, per data
   point — so the number is something an actuary can defend in a model
   review, not just a black box he has to trust.

## Two buyers, one engine

- **Underwriter** (day-to-day decision, e.g. "Claire"): wants a fast,
  auditable decision card per submission — accept / refer / decline, with a
  copyable summary and an exportable PDF.
- **Actuary / pricing team**: wants the same underlying per-building,
  multi-horizon variables delivered in bulk, structured, to feed their own
  models — not a UI, a data feed.

Same underlying engine, two delivery shapes. Don't build one and assume it
serves both.

## Validated with the actuary (2026-08-14)

Real answers, not assumptions — these now constrain the build:

- **Horizons: all of it.** Round years (2026/2050/2100) *and* values tied to
  explicit IPCC scenario conventions (RCP/SSP). Don't collapse to one
  horizon-per-year number — every value needs its scenario tag attached, not
  averaged away.
- **Delivery: both.** Per-submission/interactive *and* whole-book batch. Build
  for both from the start rather than picking one and bolting the other on
  later — the schema has to be the same either way, only the transport differs.
- **Output: raw variables, not a score.** He does not want "our score" — he
  wants the per-peril, per-horizon, per-scenario hazard variables themselves,
  clean and labeled, so he can run his own formulas on them. This simplifies
  one thing (his use case doesn't depend on Typhoon's combination/calibration
  weights being right) and raises the bar on another (variable correctness,
  units, and metadata completeness matter more than ever, since he's trusting
  the inputs directly, not a pre-digested output).
- **The alternative he's compared to: himself.** He's an actuary/data
  scientist who currently pulls this together and runs his own formulas
  manually. He is not comparing Typhoon to Descartes or Callendar — he's
  comparing it to his own time spent doing multi-source data engineering
  (Géorisques, BDNB, climate projections, per-building resolution) before he
  ever gets to run a formula. **That's the concrete value prop for this buyer:
  Typhoon does the unglamorous per-building, multi-horizon, multi-scenario
  data engineering so he doesn't have to build and maintain it himself — he
  keeps full ownership of the model.**

## Priority order, and why

1. **Make the trajectory real first.** It's currently the least-built part of
   the system: Copernicus is disabled by default, most hazards resolve at
   commune level rather than per building, and the one architectural decision
   that already got this right — never blending current risk with future
   projections — exists on paper in `typhon_risk_engine` but isn't wired into
   the live app. Everything else is built *on top of* this number; building
   the surrounding product before the number is trustworthy is building on
   sand.
2. **Confirm the exact shape the actuary needs** (which horizons, which
   variables, per-submission vs. whole-book batch) before sinking weeks into
   Copernicus engineering on a guess.
3. **Security/account/admin/testing/deployment foundation** — not
   differentiating, but blocking: none of the above is sellable on a public,
   unauthenticated API with a mocked user account.
4. **Delivery layers** — the underwriting card (UI) and the industrialized
   partner API (data feed) — are built on top of 1–3, not in parallel with
   them.

Full phase-by-phase detail: `docs/roadmap-production.md`.

## Pricing — open question

Not decided. This is deliberately left as a menu, not a recommendation — picking one
needs inputs only you have (real cost per diagnostic given external API/Mistral
spend, how many actuary-type vs. underwriter-type buyers you're actually talking to,
any willingness-to-pay signal from the conversations you've already had). Worth one
real paragraph here once you have those inputs, not left blank indefinitely.

Options, mapped to the two buyers from above:

- **Actuary / data feed (4B):** usage-based fits the "raw variables, his own model"
  shape best — per address diagnosed, or a tiered annual licence by book size (e.g.
  up to N addresses/year). A flat subscription is harder to justify here since his
  usage is naturally lumpy (whole-book batch runs, not steady daily calls).
- **Underwriter / UI (4A):** per-seat subscription fits better — this is a tool a
  person opens repeatedly, closer to typical SaaS pricing than a data feed.
- **Either buyer, as a floor:** a paid pilot (fixed fee, defined scope, defined
  success criteria) before committing to either model above — cheaper to renegotiate
  pricing after a pilot than to have guessed wrong on a signed annual contract.

Whichever you pick, know your cost floor first: each diagnosis carries real external
cost (BDNB/Géorisques calls, Mistral for the narrative report, Copernicus once
Phase 1 lands) — price below that floor and volume becomes a liability, not revenue.
