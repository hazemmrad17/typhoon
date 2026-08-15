# Insurer pages — execution plan (6 pages, finish all)

> No strategy in this doc. File paths, what to build, what "done" means. For the
> why, see `docs/product-direction.md`. For everything else in flight, see
> `docs/roadmap-production.md`. This is the ticket list for the 6-page inventory
> already agreed: Adresse, Décision, Analyse, Rapport, Portfolio, Watchlist.

Order matters — each ticket after #0 depends on the one before it being real, not
assumed. Analyse (page 3) needs no ticket — it's fine as-is, not listed below.

---

## Ticket 0 — Backend: close the per-building wiring gap

**Blocks everything downstream that claims "per-building."** Without this, Ticket 4
(Portfolio) visualizes a precision claim that isn't true yet.

- `backend/app/connectors/georisques.py` already calls `resolve_per_building` and
  stores the result in `resultat["batiment"]` (line ~69) — this part is done.
- `backend/app/scoring/risk_model.py`: `_ppr_inondation` (and the equivalent logic
  for `ssp`, `canalisations`) still reads `georisques.get("ppr")` only — the old
  commune-level REST list. Change it to check `georisques.get("batiment")` first;
  fall back to the commune-level list only when the WFS resolution has no result for
  that peril.
- `_resolution_flag()` (same file, ~line 661) is a static prefix check on the source
  string — it can never return `"per-building"` for a WFS-resolved hazard. Change the
  call sites that build trajectory points for `ppr`/`ssp`/`canalisations` to pass an
  explicit resolution when `georisques["batiment"]` actually resolved that peril,
  instead of relying on the prefix check.

**Done when:** a test address with a real WFS hit for PPR shows
`resolution: "per-building"` in `compute_trajectoire`'s output, not
`"commune-level"`. Add this case to `backend/tests/test_trajectoire.py` or
`test_georisques_wfs.py` — don't just eyeball it once.

---

## Ticket 1 — Finish the Décision screen

`frontend/src/components/DecisionCard.tsx` renders correctly today but ships with
one dead prop and three missing buttons.

- **New file** `frontend/src/components/ProvenancePanel.tsx`: a drawer/modal listing,
  per peril, source / date / resolution / confidence — all of this data already
  exists on each `TrajectoirePoint` (`source`, `date_source`, `resolution`,
  `confiance`) and on `AleaDetail`. No new backend work, this is purely rendering
  data that's already in the response.
- `frontend/src/routes/Zone.tsx` (~line 798): pass `onOpenProvenance={() =>
  setProvenanceOpen(true)}` into `<DecisionCard>` and render `<ProvenancePanel>`
  conditionally — right now the prop isn't passed at all, so the button is
  currently invisible (`{onOpenProvenance && (...)}` in `DecisionCard.tsx`).
- Add three buttons to `DecisionCard.tsx`, next to the existing provenance link:
  - **"Copier la synthèse"** — clipboard write of a plain-text summary (verdict +
    score + top perils + horizon). No dependency on anything else.
  - **"Exporter PDF"** — calls the new function from Ticket 2. Stub/disable until
    Ticket 2 lands, don't block this ticket on it.
  - **"Ajouter à la watchlist"** — calls the store from Ticket 5. Stub/disable until
    Ticket 5 lands, same reasoning.

**Done when:** clicking "Sources & provenance" opens a real panel with per-peril
source/date/resolution; "Copier la synthèse" puts text on the clipboard.

---

## Ticket 2 — Rapport: insurer PDF template

`frontend/src/zone/pdf-export.ts` (478 lines) already has a full jsPDF pipeline —
brand header, D03 gauge, alea table, BDNB fiche, Mistral report sections, paginated
footer. It's generic, used by every profile today. Don't rewrite it — add to it.

- New function alongside the existing export (e.g. `exportInsurerPdf`): same visual
  system, plus — a trajectory table (peril × horizon, reusing `Trajectoire` data,
  same as what's on-screen in `DecisionCard`), an organization name/reference-number
  field (blank input on the Rapport step, not hardcoded), and the disclaimer line
  ("ne remplace pas l'ERRIAL officiel").
- **Blocking, not optional:** get the exact disclaimer wording confirmed by whoever
  handles legal/compliance before this ships to a real customer. Placeholder text is
  fine for development, not for anything a real underwriter files.
- `Zone.tsx`'s `rapport` step: when `profile === 'assurance'`, call the new function
  instead of the existing generic one.

**Done when:** the insurer's exported PDF shows the decomposed trajectory table and
the disclaimer; the developer/bank profiles' export is untouched.

---

## Ticket 3 — Backend: internal batch endpoint (prerequisite for Portfolio)

Portfolio needs to submit many addresses and poll for results. That logic already
exists — in `backend/partner_api/service.py` (`submit_batch`, `_run_batch_worker`,
`get_batch`), built for third-party partners behind an `X-API-Key`. Don't make the
frontend call the partner API directly — that would mean baking an API key into
browser JS, which anyone can read. Extract and reuse instead.

- **New file** `backend/app/services/batch.py`: move `submit_batch` /
  `_run_batch_worker` / `get_batch` / the `_batches` store here, generic (not
  partner-specific).
- `backend/partner_api/service.py`: import from the new shared module instead of
  defining its own copy — existing partner batch tests must still pass unchanged.
- **New route** in `backend/app/api/routes/diagnostic.py`: `POST /diagnostic/batch`,
  `GET /diagnostic/batch/{id}` — same contract as the partner routes, no API-key
  requirement (internal, same-origin call from the app itself; real auth comes with
  Phase 2, not this ticket).

**Done when:** `backend/tests/test_partner_batch.py` still passes after the
extraction, and an equivalent test exists for the new internal route.

---

## Ticket 4 — Portfolio page (new, from nothing)

- **New file** `frontend/src/routes/Portfolio.tsx`, registered as `/portfolio` in the
  router, sidenav entry in `ZoneSidenav.tsx` gated on `profile === 'assurance'`
  (mirrors the `FEATURES[profile]` pattern already used in `Zone.tsx`).
- CSV upload (one column: address) → `POST /diagnostic/batch` (Ticket 3) → poll
  `GET /diagnostic/batch/{id}` → results table: address, score, D03 band,
  resolution, a "needs review" flag (band ≥ `eleve`).
- D03 band histogram — small bar chart, reuse `D03` colors from `config.ts`, no new
  charting library needed for a 5-bucket count.
- Heatmap: reuse `UnifiedMap.tsx` in point mode, one marker per address colored by
  band.
- Export: CSV of the table, plus a portfolio-summary PDF (extends Ticket 2's work,
  not a third template from scratch).
- **Storage note:** don't reuse `diagnosticCache.ts` for batch results — it caps at
  `MAX_ENTRIES = 30`, sized for a single-address browsing history, not a book of
  hundreds/thousands. Keep batch results in component state or `sessionStorage` for
  the session; persistence beyond that is a later problem, not this ticket's.

**Done when:** uploading a CSV of test addresses produces a populated table,
histogram, and colored map, end to end, against the real batch endpoint.

---

## Ticket 5 — Watchlist panel (new, small)

- **New file** `frontend/src/zone/watchlist.ts`: localStorage-backed store, same
  pattern as the existing `conversations.ts` — list of tracked communes/addresses.
- **New file** `frontend/src/components/WatchlistPanel.tsx`: renders the list, badge
  count of communes with a new CatNat entry since last seen (CatNat data is already
  fetched per diagnosis — compare against what's stored, no new backend call needed
  for the MVP version).
- Wire Ticket 1's "Ajouter à la watchlist" button to this store — closes that loop.
- Sidenav entry in `ZoneSidenav.tsx`, gated on `profile === 'assurance'`.

**Done when:** adding an address from the Décision screen makes its commune appear
in the Watchlist panel; a badge shows when a tracked commune's CatNat list has grown.

---

## Order to actually do this in

0 → 1 → 2 → 3 → 4 → 5. Ticket 0 is backend-only and unblocks nothing visually but
makes Ticket 4 honest. Tickets 1 and 2 finish the screen she opens every time. 3 and
4 are the bigger lift (new page, new backend route) — the actual differentiator. 5
is small and can slot in anywhere after 1, including in parallel with 3/4 if more
than one person/agent is working this.
