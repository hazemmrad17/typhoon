// =============================================================================
//   TYPHOON — Synthèse souscription (vue « Assurance »)
//
//   Deux blocs distincts, deux domaines, jamais mélangés :
//
//   1. ÉTAT DES LIEUX (Géorisques) — « Quel est le risque aujourd'hui, selon
//      la cartographie réglementaire ? » Le verdict (Acceptable / À expertiser /
//      Refus possible) vient UNIQUEMENT de ce bloc : opposable, sans scénario,
//      ERRIAL-compatible. On affiche les 2-3 périls qui pilotent le verdict
//      (« Pourquoi ») — pas les 8 périls d'un coup.
//
//   2. PROJECTION CLIMATIQUE (Copernicus CDS) — « Comment l'exposition
//      canicule/précipitations extrêmes évolue-t-elle en 2050/2100 ? »
//      Indicatif, toujours étiqueté comme tel, scénario RCP 4.5/8.5 visible.
//      Jamais un input du verdict : c'est un signal de tarification/vigilance.
//
//   La trajectoire vient de la réponse /diagnostic/fast (digital_twin.
//   trajectoire, produite par risk_model.compute_trajectoire).
// =============================================================================

import { useState } from 'react';
import {
  D03,
  bandForResolution,
  aleaScore,
  type AleaDetail,
  type Trajectoire,
  type TrajectoirePoint,
} from '../zone/config';

/* Verdict de souscription — règle simple, configurable plus tard. */
function verdictFor(band: { label: string; key: string } | null): {
  label: string;
  cls: string;
  hint: string;
} {
  if (!band) return { label: 'À expertiser', cls: 'verdict-na', hint: 'Sources insuffisantes pour trancher.' };
  if (band.key === 'critique') return { label: 'Refus possible', cls: 'verdict-refuse', hint: 'Exposition critique — expertise renforcée recommandée.' };
  if (band.key === 'eleve') return { label: 'À expertiser', cls: 'verdict-expertise', hint: 'Exposition élevée — dossier à expertiser.' };
  return { label: 'Acceptable', cls: 'verdict-ok', hint: 'Exposition maîtrisée — souscription possible.' };
}

/* Couleur de bande D03 d'une valeur brute F (0-100) — mêmes seuils que le moteur. */
function bandForValue(valeur: number | null) {
  if (valeur == null) return null;
  return D03.find((b) => valeur < b.max) || D03[D03.length - 1];
}

/* Drill-down « un péril à la fois » : pour l'aléa sélectionné, l'état à
   l'adresse vs la commune, le zonage, l'historique CatNat et la source.
   Affiché déplié uniquement sur clic — le résumé ne devient jamais un blob. */
function AleaDrillDown({ alea }: { alea: AleaDetail | null }) {
  if (!alea) return null;
  const aband = bandForResolution(alea.resolution);
  const catnat = alea.catnat_historique ?? [];
  const statut =
    alea.present === true
      ? { label: 'À votre adresse', cls: 'drill-status-ok' }
      : alea.present_commune
        ? { label: 'Dans la commune', cls: 'drill-status-commune' }
        : alea.present === false
          ? { label: 'Non recensé', cls: 'drill-status-none' }
          : { label: 'Indisponible', cls: 'drill-status-none' };
  return (
    <div className="alea-drilldown">
      <div className="drill-row">
        <span className={`drill-status ${statut.cls}`}>{statut.label}</span>
        {aband && <span className={`d03-pill ${aband.cls}`}>{aband.label}</span>}
      </div>
      {alea.zonage && <div className="drill-row"><span className="drill-k">Zonage</span><span className="drill-v">{alea.zonage}</span></div>}
      {alea.present_commune === false && (
        <div className="drill-row"><span className="drill-k">Commune</span><span className="drill-v">Aucun recensement au niveau communal</span></div>
      )}
      {catnat.length > 0 && (
        <div className="drill-catnat">
          <span className="drill-k">Historique CatNat ({catnat.length})</span>
          <ul className="drill-catnat-list">
            {catnat.slice(0, 5).map((ev, i) => (
              <li key={i}>
                <span>{ev.libelle_risque_jo || ev.libelle || 'Arrêté CatNat'}</span>
                {ev.date_debut_evt ? (
                  <span className="drill-date">{ev.date_debut_evt.slice(0, 10)}</span>
                ) : null}
              </li>
            ))}
            {catnat.length > 5 && <li className="drill-more">+ {catnat.length - 5} autre(s)…</li>}
          </ul>
        </div>
      )}
      {(alea.source || alea.url_detail) && (
        <div className="drill-row drill-source">
          <span className="drill-k">Source</span>
          {alea.url_detail ? (
            <a href={alea.url_detail} target="_blank" rel="noreferrer" className="drill-link">
              {alea.source ?? 'Géorisques'}
            </a>
          ) : (
            <span className="drill-v">{alea.source ?? 'Géorisques'}</span>
          )}
        </div>
      )}
      {alea.erreur && <div className="drill-row"><span className="drill-k">Source</span><span className="drill-v drill-err">{alea.erreur}</span></div>}
    </div>
  );
}

export function DecisionCard({
  aleas,
  trajectoire,
  scoreGlobal,
  onOpenProvenance,
  onExportPdf,
  onAddWatchlist,
}: {
  aleas: AleaDetail[];
  trajectoire: Trajectoire | null;
  scoreGlobal: number | null;
  onOpenProvenance?: () => void;
  /** Export PDF assurance (Ticket 2) — câblé depuis /zone. */
  onExportPdf?: () => void;
  /** Ajout à la watchlist (Ticket 5) — câblé depuis /zone. */
  onAddWatchlist?: () => void;
}) {
  /* Copier la synthèse : état « copié » temporaire pour le retour visuel. */
  const [copied, setCopied] = useState(false);
  /* Aléa ouvert dans le drill-down « un péril à la fois » (déplié sur clic,
     un seul à la fois — jamais le blob complet à l'écran). */
  const [openAlea, setOpenAlea] = useState<string | null>(null);

  const presentAleas = aleas.filter((a) => a.present === true);
  const maxScore =
    presentAleas.length ? Math.max(...presentAleas.map((a) => a.resolution === 'per-building' ? 3 : a.resolution === 'commune-level' ? 2 : 1)) : null
  const band = maxScore != null ? D03.find((b) => (maxScore as number) < b.max) || D03[D03.length - 1] : null;
  const verdict = { cls: band?.cls ?? '', label: band?.label ?? 'Aucun aléa recensé', hint: "Qualité de vérification — l'interprétation appartient à l'assureur." };

  const perils = trajectoire?.perils ?? {};

  /* ── Bloc 1 · « Pourquoi ce verdict » : les 2-3 périls qui pilotent la
     décision, à l'état actuel (horizon 2026, observé). Si la trajectoire
     manque, repli sur les aléas Géorisques présents. ── */
  const perilDrivers = Object.entries(perils)
    .map(([code, p]) => {
      const pt = p.points.find((x) => x.horizon === 2026) ?? null;
      return { code, label: p.label, pt, value: valueForPoint(pt) };
    })
    .filter((d) => d.value != null)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    .slice(0, 3);

  const aleaDrivers = presentAleas
    .map((a) => ({ code: a.code, label: a.libelle, value: a.resolution === 'per-building' ? 3 : a.resolution === 'commune-level' ? 2 : 1 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 3);

  const drivers = perilDrivers.length ? perilDrivers : aleaDrivers;

  /* Valeur brute du péril à l'état actuel (2026) — les drivers du verdict
     viennent TOUJOURS du présent (Géorisques), jamais d'une projection. */
  function valueForPoint(pt: TrajectoirePoint | null): number | null {
    if (!pt) return null;
    return pt.valeur;
  }

  /* ── Copier la synthèse : verdict + score + drivers + projection ── */
  async function handleCopySynthese() {
    const lines = [
      `Typhon — Synthèse souscription — ${new Date().toLocaleDateString('fr-FR')}`,
      `Verdict : ${verdict.label}${band ? ` (bande ${band.label})` : ''}`,
      `Aléas présents : ${presentAleas.length}`,
    ];
    if (drivers.length) {
      lines.push(`Pourquoi : ${drivers.map((d) => `${d.label} ${d.value ?? '—'}/100`).join(' · ')}`);
    }
    if (presentAleas.length) {
      lines.push(`Aléas présents : ${presentAleas.map((a) => a.libelle).join(', ')}`);
    }
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* presse-papiers indisponible (http non sécurisé…) — on laisse le texte visible via alert */
      window.alert('Impossible d\'accéder au presse-papiers.\n\n' + text);
    }
  }

  return (
    <section className="decision-card" aria-label="Synthèse de souscription">
      {/* ═══ BLOC 1 — ÉTAT DES LIEUX (Géorisques) : le verdict ═══ */}
      <div className={`decision-verdict ${verdict.cls}`}>
        <div className="decision-verdict-main">
          <span className="decision-verdict-label">Verdict de souscription</span>
          <span className="decision-verdict-value">{verdict.label}</span>
          <span className="decision-verdict-hint">{verdict.hint}</span>
        </div>
        {/* Score global rétrogradé : petite ligne, jamais le héros. */}
        <div className="decision-score-line" title="Score composite — la décomposition par aléa ci-dessous fait foi">
          <span className="decision-score-num" style={{ color: band?.color }}>
            {presentAleas.length}
          </span>
          <span className="decision-score-label">score global /100</span>
          {band && <span className={`d03-pill ${band.cls}`}>{band.label}</span>}
        </div>
      </div>

      {/* Pourquoi — les périls qui pilotent la décision, pas les 8 d'un coup. */}
      <div className="decision-drivers">
        <span className="decision-drivers-label">Pourquoi</span>
        {drivers.length === 0 ? (
          <span className="decision-drivers-empty">Aucun péril prépondérant recensé à cette adresse.</span>
        ) : (
          <div className="decision-drivers-list">
            {drivers.map((d) => {
              const db = bandForValue(d.value);
              return (
                <span key={d.code} className="driver-row" title={`${d.label} — ${d.value ?? '—'} /100`}>
                  <span className="driver-dot" style={{ background: db?.color ?? '#888' }} />
                  <span className="driver-name">{d.label}</span>
                  <span className="driver-value">{d.value ?? '—'}</span>
                  {db && <span className={`d03-pill ${db.cls}`}>{db.label}</span>}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* Aléas — pills cliquables : un clic ouvre le détail de CE péril
          (adresse vs commune, CatNat, source), jamais tous en même temps. */}
      <div className="decision-aleas">
        <span className="decision-aleas-label">Aléas à cette adresse</span>
        <div className="decision-pills">
          {aleas.length === 0 && (
            <span className="decision-pill decision-pill-none">Aucun aléa présent recensé</span>
          )}
          {aleas.map((a) => {
            const aband = bandForResolution(a.resolution);
            const isOpen = openAlea === a.code;
            return (
              <button
                key={a.code}
                type="button"
                className={`decision-pill${isOpen ? ' decision-pill-open' : ''}`}
                title={`${a.libelle} — cliquer pour le détail`}
                aria-expanded={isOpen}
                onClick={() => setOpenAlea(isOpen ? null : a.code)}
              >
                <span className="decision-pill-dot" style={{ background: aband?.color ?? '#888' }} />
                {a.libelle}
                <md-icon className="decision-pill-chevron">{isOpen ? 'expand_less' : 'expand_more'}</md-icon>
              </button>
            );
          })}
        </div>

        {/* Détail du péril ouvert — un seul à la fois. */}
        {openAlea && (
          <AleaDrillDown alea={aleas.find((a) => a.code === openAlea) ?? null} />
        )}
      </div>

      {/* Actions — toujours visibles, ce sont les seuls « sorties » du dossier. */}
      <div className="decision-actions">
        {onOpenProvenance && (
          <button type="button" className="decision-action" onClick={onOpenProvenance}>
            <md-icon>database</md-icon>
            Sources &amp; provenance
          </button>
        )}
        <button type="button" className="decision-action" onClick={() => void handleCopySynthese()}>
          <md-icon>{copied ? 'check' : 'content_copy'}</md-icon>
          {copied ? 'Copié !' : 'Copier la synthèse'}
        </button>
        {onExportPdf && (
          <button type="button" className="decision-action" onClick={onExportPdf}>
            <md-icon>picture_as_pdf</md-icon>
            Exporter PDF
          </button>
        )}
        {onAddWatchlist && (
          <button type="button" className="decision-action" onClick={onAddWatchlist}>
            <md-icon>bookmark_add</md-icon>
            Ajouter à la watchlist
          </button>
        )}
      </div>
    </section>
  );
}
