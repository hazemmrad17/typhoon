// =============================================================================
//   TYPHOON — Synthèse souscription enrichie (vue « Assurance »)
//
//   Version améliorée du DecisionCard avec :
//   1. Profil de vulnérabilité du bâtiment (BDNB)
//   2. Indicateurs de confiance par source
//   3. Décomposition F vs V enrichie
//   4. Estimation du potentiel de dommages
//   5. Actions améliorées (export, watchlist, etc.)
//
//   L'architecture reste la même : deux blocs distincts :
//   1. ÉTAT DES LIEUX (Géorisques) — le verdict
//   2. PROJECTION CLIMATIQUE (Copernicus) — indicatif
// =============================================================================

import { useState } from 'react';
import {
  D03,
  bandForKey,
  aleaScore,
  type AleaDetail,
  type Trajectoire,
  type TrajectoirePoint,
} from '../zone/config';

/* Types */
interface RiskScores {
  score_global: number;
  zones: Record<string, {
    risque: number;
    niveau: string;
    _f_score?: number;
    _v_score?: number;
  }>;
  confidence?: {
    score: number;
    niveau: string;
  };
}

interface BuildingData {
  bdnb?: {
    batiment?: {
      annee_construction?: number | null;
      hauteur_mean?: number | null;
      nb_niveau?: number | null;
      s_geom_groupe?: number | null;
      classe_bilan_dpe?: string | null;
      mat_mur_txt?: string | null;
    } | null;
  } | null;
}

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

/* Couleur de bande D03 d'une valeur brute F (0-100) */
function bandForValue(valeur: number | null) {
  if (valeur == null) return null;
  return D03.find((b) => valeur < b.max) || D03[D03.length - 1];
}

/* Classification du bâtiment */
function classificationBatiment(annee: number | null | undefined): string {
  if (!annee) return 'Inconnue';
  if (annee < 1949) return 'Ancien (pre-1949)';
  if (annee < 1975) return 'Après-guerre';
  if (annee < 2000) return 'Moderne';
  return 'Récent';
}

/* DPE color */
function dpeColor(dpe: string | null | undefined): string {
  const colors: Record<string, string> = {
    A: '#3A7A6C', B: '#6E9E52', C: '#D4AC3E', D: '#D07030',
    E: '#C83030', F: '#801060', G: '#300020',
  };
  return colors[dpe || ''] || '#888';
}

/* Drill-down « un péril à la fois » */
function AleaDrillDown({ alea }: { alea: AleaDetail | null }) {
  if (!alea) return null;
  const aband = alea.niveau ? bandForKey(alea.niveau) : undefined;
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

/* Sous-composant : Profil du bien */
function BuildingProfileMini({ bdnb }: { bdnb: BuildingData['bdnb'] }) {
  const bat = bdnb?.batiment;
  if (!bat) return null;

  const annee = bat.annee_construction;
  const dpe = bat.classe_bilan_dpe;
  const hauteur = bat.hauteur_mean;
  const surface = bat.s_geom_groupe;
  const classification = classificationBatiment(annee);

  return (
    <div className="decision-building-profile">
      <div className="building-profile-row">
        <span className="building-profile-label">Bien</span>
        <span className="building-profile-value">
          {classification}
          {annee && <span className="building-profile-year"> ({annee})</span>}
        </span>
      </div>
      <div className="building-profile-row">
        <span className="building-profile-label">Caractéristiques</span>
        <span className="building-profile-value">
          {hauteur != null && `${hauteur.toFixed(1)}m`}
          {hauteur != null && surface != null && ' · '}
          {surface != null && `${Math.round(surface)}m²`}
          {(!hauteur && !surface) && '—'}
        </span>
      </div>
      {dpe && (
        <div className="building-profile-row">
          <span className="building-profile-label">DPE</span>
          <span className="building-profile-value" style={{ color: dpeColor(dpe) }}>
            {dpe}
          </span>
        </div>
      )}
    </div>
  );
}

/* Sous-composant : Score de confiance */
function ConfidenceIndicator({ confidence }: { confidence?: { score: number; niveau: string } }) {
  if (!confidence) return null;

  const scoreColor = confidence.score >= 70 ? '#3A7A6C' :
                     confidence.score >= 50 ? '#D4AC3E' : '#D07030';

  return (
    <div className="decision-confidence">
      <span className="decision-confidence-label">Fiabilité</span>
      <span className="decision-confidence-score" style={{ color: scoreColor }}>
        {confidence.score}
        <span className="decision-confidence-unit">/100</span>
      </span>
      <span className="decision-confidence-level">{confidence.niveau}</span>
    </div>
  );
}

/* Sous-composant : Potentiel de dommages */
function DamagePotentialMini({ zones, bdnb }: {
  zones: RiskScores['zones'];
  bdnb: BuildingData['bdnb'];
}) {
  const bat = bdnb?.batiment;
  const surface = bat?.s_geom_groupe || 100;
  const annee = bat?.annee_construction;

  const avgRisk = Object.values(zones).reduce((sum, z) => sum + z.risque, 0) / Object.values(zones).length;
  const ageFactor = annee ? Math.max(1, (2024 - annee) / 50) : 1.5;
  const costPerSqm = Math.round(avgRisk * ageFactor * 5);
  const totalPotential = Math.round(costPerSqm * surface);

  return (
    <div className="decision-damage-potential">
      <span className="decision-damage-label">Potentiel de dommages estimé</span>
      <span className="decision-damage-value">
        {(totalPotential / 1000).toFixed(0)}
        <span className="decision-damage-unit">k€</span>
      </span>
      <span className="decision-damage-hint">
        {surface}m² · {costPerSqm}€/m² · {classificationBatiment(annee)}
      </span>
    </div>
  );
}

/* ── Composant principal ── */

export function DecisionCardEnhanced({
  aleas,
  trajectoire,
  scoreGlobal,
  riskScores,
  buildingData,
  onOpenProvenance,
  onExportPdf,
  onAddWatchlist,
}: {
  aleas: AleaDetail[];
  trajectoire: Trajectoire | null;
  scoreGlobal: number | null;
  riskScores?: RiskScores;
  buildingData?: BuildingData;
  onOpenProvenance?: () => void;
  onExportPdf?: () => void;
  onAddWatchlist?: () => void;
}) {
  /* Copier la synthèse : état « copié » temporaire */
  const [copied, setCopied] = useState(false);
  /* Aléa ouvert dans le drill-down */
  const [openAlea, setOpenAlea] = useState<string | null>(null);

  const presentAleas = aleas.filter((a) => a.present === true);
  const maxScore =
    presentAleas.length ? Math.max(...presentAleas.map((a) => aleaScore(a))) : null;
  const band = maxScore != null ? D03.find((b) => (maxScore as number) < b.max) || D03[D03.length - 1] : null;
  const verdict = verdictFor(band);

  const perils = trajectoire?.perils ?? {};

  /* Bloc 1 : les 2-3 périls qui pilotent la décision */
  const perilDrivers = Object.entries(perils)
    .map(([code, p]) => {
      const pt = p.points.find((x) => x.horizon === 2026) ?? null;
      return { code, label: p.label, pt, value: valueForPoint(pt) };
    })
    .filter((d) => d.value != null)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    .slice(0, 3);

  const aleaDrivers = presentAleas
    .map((a) => ({ code: a.code, label: a.libelle, value: aleaScore(a) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 3);

  const drivers = perilDrivers.length ? perilDrivers : aleaDrivers;

  function valueForPoint(pt: TrajectoirePoint | null): number | null {
    if (!pt) return null;
    return pt.valeur;
  }

  /* Copier la synthèse */
  async function handleCopySynthese() {
    const lines = [
      `Typhon — Synthèse souscription — ${new Date().toLocaleDateString('fr-FR')}`,
      `Verdict : ${verdict.label}${band ? ` (bande ${band.label})` : ''}`,
      `Score global : ${scoreGlobal ?? maxScore ?? '—'} / 100`,
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
      window.alert('Impossible d\'accéder au presse-papiers.\n\n' + text);
    }
  }

  return (
    <section className="decision-card-enhanced" aria-label="Synthèse de souscription">
      {/* ═══ BLOC 1 — ÉTAT DES LIEUX (Géorisques) : le verdict ═══ */}
      <div className={`decision-verdict ${verdict.cls}`}>
        <div className="decision-verdict-main">
          <span className="decision-verdict-label">Verdict de souscription</span>
          <span className="decision-verdict-value">{verdict.label}</span>
          <span className="decision-verdict-hint">{verdict.hint}</span>
        </div>
        {/* Score global rétrogradé */}
        <div className="decision-score-line" title="Score composite — la décomposition par aléa ci-dessous fait foi">
          <span className="decision-score-num" style={{ color: band?.color }}>
            {scoreGlobal ?? maxScore ?? '—'}
          </span>
          <span className="decision-score-label">score global /100</span>
          {band && <span className={`d03-pill ${band.cls}`}>{band.label}</span>}
        </div>
      </div>

      {/* Profil du bien (nouveau) */}
      {buildingData?.bdnb && (
        <BuildingProfileMini bdnb={buildingData.bdnb} />
      )}

      {/* Confiance (nouveau) */}
      {riskScores?.confidence && (
        <ConfidenceIndicator confidence={riskScores.confidence} />
      )}

      {/* Pourquoi — les périls qui pilotent la décision */}
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

      {/* Aléas — pills cliquables */}
      <div className="decision-aleas">
        <span className="decision-aleas-label">Aléas à cette adresse</span>
        <div className="decision-pills">
          {aleas.length === 0 && (
            <span className="decision-pill decision-pill-none">Aucun aléa présent recensé</span>
          )}
          {aleas.map((a) => {
            const aband = a.niveau ? bandForKey(a.niveau) : undefined;
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

        {/* Détail du péril ouvert */}
        {openAlea && (
          <AleaDrillDown alea={aleas.find((a) => a.code === openAlea) ?? null} />
        )}
      </div>

      {/* Potentiel de dommages (nouveau) */}
      {riskScores?.zones && (
        <DamagePotentialMini zones={riskScores.zones} bdnb={buildingData?.bdnb} />
      )}

      {/* Actions */}
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
