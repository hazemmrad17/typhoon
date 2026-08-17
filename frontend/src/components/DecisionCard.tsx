// =============================================================================
//   TYPHOON — Carte de décision souscription (vue « Assurance », Phase 4A)
//
//   Ce que l'assureur veut voir pour trancher accept/refuse/expertise :
//   la décomposition par aléa et la trajectoire climatique (horizons
//   2026 → 2050 → 2100), PAS un score composite mis en avant. Le score global
//   est volontairement rétrogradé en petite ligne de synthèse (roadmap
//   production item 20 : « demote the global blended score, don't lead with
//   it ») — la donnée brute par péril prime, avec sa provenance.
//
//   La trajectoire vient de la réponse /diagnostic/fast (digital_twin.
//   trajectoire, produite par risk_model.compute_trajectoire) : variables
//   brutes F par péril et par horizon, jamais combinées.
// =============================================================================

import { useState } from 'react';
import {
  D03,
  SCENARIOS,
  bandForKey,
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

function PointCell({ point, value }: { point: TrajectoirePoint; value: number | null }) {
  if (point.type === 'indisponible') {
    return (
      <span className="traj-point traj-point-na" title={point.unite || 'Non simulé'}>
        —
      </span>
    );
  }
  const band = bandForValue(value);
  /* Comparaison de scénarios RCP dans l'infobulle, quand Copernicus la fournit. */
  const scenarioInfo =
    point.scenarios && Object.keys(point.scenarios).length
      ? ` · RCP ${Object.entries(point.scenarios)
          .map(([s, v]) => `${s.replace('rcp', 'RCP ').replace('_', '.')}=${v ?? '—'}`)
          .join(' / ')}`
      : '';
  return (
    <span
      className={`traj-point ${band ? band.cls : ''}`}
      style={band ? { background: band.color } : undefined}
      title={`${value} · ${point.unite} · ${point.resolution ?? 'commune-level'} · ${point.source ?? ''}${scenarioInfo}`}
    >
      {value ?? '—'}
    </span>
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
  /* Horizon sélectionné : 2026 (actuel) / 2050 / 2100 — la carte se recolore
     selon la valeur brute du péril à cet horizon (donnée réelle, pas un stub). */
  const [horizon, setHorizon] = useState<number>(2026);
  /* Scénario RCP sélectionné : bascule la comparaison 2100 sans relancer le
     diagnostic — les deux valeurs sont déjà dans la réponse (point.scenarios). */
  const [scenario, setScenario] = useState<string>('rcp8_5');

  const presentAleas = aleas.filter((a) => a.present === true);
  const maxScore =
    presentAleas.length ? Math.max(...presentAleas.map((a) => aleaScore(a))) : null;
  const band = maxScore != null ? D03.find((b) => (maxScore as number) < b.max) || D03[D03.length - 1] : null;
  const verdict = verdictFor(band);

  const perils = trajectoire?.perils ?? {};
  const perilEntries = Object.entries(perils).filter(([, p]) =>
    p.points.some((pt) => pt.horizon === horizon && pt.type !== 'indisponible')
  );

  /* Scénarios réellement présents dans les données (points projetés avec un
     détail par RCP) — le sélecteur ne propose que ceux-là, dans l'ordre CDS. */
  const availableScenarios = Array.from(
    new Set(
      Object.values(perils).flatMap((p) =>
        p.points
          .filter((pt) => pt.scenarios && Object.keys(pt.scenarios).length > 0)
          .flatMap((pt) => Object.keys(pt.scenarios ?? {}))
      )
    )
  );
  const scenarioOptions = SCENARIOS.filter((s) => availableScenarios.includes(s.key));

  /* Valeur brute du péril à l'horizon courant : sous le scénario sélectionné
     quand la comparaison RCP est disponible, sinon la valeur par défaut. */
  function valueForPoint(pt: TrajectoirePoint | null): number | null {
    if (!pt) return null;
    if (pt.scenarios && scenario in pt.scenarios) return pt.scenarios[scenario] ?? null;
    return pt.valeur;
  }

  /* ── Copier la synthèse : texte brut (verdict + score + top périls + horizon) ── */
  async function handleCopySynthese() {
    const lines = [
      `Typhon — Synthèse souscription — ${new Date().toLocaleDateString('fr-FR')}`,
      `Verdict : ${verdict.label}${band ? ` (bande ${band.label})` : ''}`,
      `Score global : ${scoreGlobal ?? maxScore ?? '—'} / 100`,
      `Horizon : ${horizon}`,
    ];
    if (presentAleas.length) {
      lines.push(`Aléas présents : ${presentAleas.map((a) => a.libelle).join(', ')}`);
    }
    perilEntries.forEach(([code, p]) => {
      const pt = p.points.find((x) => x.horizon === horizon) ?? null;
      if (!pt || pt.type === 'indisponible') return;
      const v = valueForPoint(pt);
      const b = pt ? bandForValue(v) : null;
      lines.push(`· ${p.label} : ${v ?? '—'} /100${b ? ` (${b.label})` : ''} — ${pt.resolution ?? 'commune-level'}`);
    });
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
    <section className="decision-card" aria-label="Carte de décision souscription">
      {/* Verdict — le seul élément « synthèse » mis en avant (la décision, pas le score). */}
      <div className={`decision-verdict ${verdict.cls}`}>
        <div className="decision-verdict-main">
          <span className="decision-verdict-label">Verdict de souscription</span>
          <span className="decision-verdict-value">{verdict.label}</span>
          <span className="decision-verdict-hint">{verdict.hint}</span>
        </div>
        {/* Score global rétrogradé : petite ligne, jamais le héros. */}
        <div className="decision-score-line" title="Score composite — la décomposition par aléa ci-dessous fait foi">
          <span className="decision-score-num" style={{ color: band?.color }}>
            {scoreGlobal ?? maxScore ?? '—'}
          </span>
          <span className="decision-score-label">score global /100</span>
          {band && <span className={`d03-pill ${band.cls}`}>{band.label}</span>}
        </div>
      </div>

      {/* Aléas présents — pills compactes (réutilise les couleurs D03). */}
      <div className="decision-aleas">
        <span className="decision-aleas-label">Aléas à cette adresse</span>
        <div className="decision-pills">
          {presentAleas.length === 0 && (
            <span className="decision-pill decision-pill-none">Aucun aléa présent recensé</span>
          )}
          {presentAleas.map((a) => {
            const aband = a.niveau ? bandForKey(a.niveau) : undefined;
            return (
              <span key={a.code} className="decision-pill" title={a.libelle}>
                <span className="decision-pill-dot" style={{ background: aband?.color ?? '#888' }} />
                {a.libelle}
              </span>
            );
          })}
        </div>
      </div>

      {/* Trajectoire climatique — horizons 2026 / 2050 / 2100, valeurs brutes F. */}
      <div className="decision-trajectoire">
        <div className="decision-trajectoire-head">
          <span className="decision-trajectoire-label">Trajectoire climatique</span>
          <div className="traj-controls">
            <div className="horizon-toggle" role="group" aria-label="Horizon de projection">
              {[2026, 2050, 2100].map((h) => (
                <button
                  key={h}
                  type="button"
                  className={`horizon-btn${horizon === h ? ' active' : ''}`}
                  aria-pressed={horizon === h}
                  onClick={() => setHorizon(h)}
                >
                  {h}
                </button>
              ))}
            </div>
            {/* Sélecteur de scénario RCP — visible dès que Copernicus fournit
                des points projetés avec comparaison (2100). */}
            {scenarioOptions.length > 0 && (
              <div className="horizon-toggle scenario-toggle" role="group" aria-label="Scénario climatique (RCP)">
                {scenarioOptions.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    className={`horizon-btn${scenario === s.key ? ' active' : ''}`}
                    aria-pressed={scenario === s.key}
                    title={s.hint}
                    onClick={() => setScenario(s.key)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {perilEntries.length === 0 ? (
          <p className="decision-trajectoire-empty">
            {trajectoire
              ? `Aucune donnée projetée à l'horizon ${horizon} pour ce bien (les périls présents n'ont pas de couche projection).`
              : 'Trajectoire indisponible pour ce diagnostic.'}
          </p>
        ) : (
          <div className="trajectoire-table">
            <div className="traj-row traj-head">
              <span>Péril</span>
              <span>Valeur F ({horizon})</span>
              <span>Niveau</span>
            </div>
            {perilEntries.map(([code, p]) => {
              const pt = p.points.find((x) => x.horizon === horizon) ?? null;
              const value = valueForPoint(pt);
              const band = pt ? bandForValue(value) : null;
              return (
                <div className="traj-row" key={code}>
                  <span className="traj-name" title={p.label}>
                    {p.label}
                  </span>
                  <PointCell
                    point={pt ?? { horizon, type: 'indisponible', scenario: null, valeur: null, unite: '', resolution: null, confiance: null, source: null, date_source: null }}
                    value={value}
                  />
                  <span className={`traj-niveau ${band ? band.cls : ''}`}>
                    {band ? band.label : '—'}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <div className="decision-trajectoire-meta">
          <span>
            {horizon === 2026
              ? 'Valeur observée (données Géorisques actuelles).'
              : horizon === 2050
                ? 'Projection climatique Open-Meteo (2041-2050).'
                : scenarioOptions.length > 0
                  ? `Projeté (Copernicus CDS) — scénario ${scenarioOptions.find((s) => s.key === scenario)?.label ?? scenario}, comparaison RCP disponible (infobulle des cellules).`
                  : 'Non simulé tant que Copernicus CDS est désactivé.'}
          </span>
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
        </div>
      </div>
    </section>
  );
}
