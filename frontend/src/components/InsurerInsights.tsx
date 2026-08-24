// =============================================================================
//   TYPHOON — Panneau Insights Assureur
//
//   Vue enrichie pour l'assureur/actuaire qui combine :
//   1. Profil de vulnérabilité du bâtiment (BDNB)
//   2. Décomposition F (aléa) vs V (vulnérabilité) par zone
//   3. Analyse de confiance (D02) — quels facteurs fiabilisent le score
//   4. Indicateurs historiques (CatNat, fréquence)
//   5. Estimation du potentiel de dommages
//
//   Toutes les données viennent déjà du backend (building_data, risk_scores,
//   trajectoire) — aucun nouvel appel réseau nécessaire.
// =============================================================================

import { useState } from 'react';
import {
  bandForKey,
  type AleaDetail,
  type Trajectoire,
} from '../zone/config';

/* ── Types ── */

interface RiskScores {
  score_global: number;
  zones: Record<string, {
    risque: number;
    niveau: string;
    alea_principal: string;
    _f_score?: number;
    _v_score?: number;
    _sources?: Array<{ source: string; statut: string; [key: string]: unknown }>;
  }>;
  confidence?: {
    score: number;
    niveau: string;
    composantes: {
      couverture: number;
      qualite_sources: number;
      absence_erreurs: number;
      absence_replis: number;
      bonus_projection: number;
    };
    n_sources_disponibles: number;
    n_sources_total: number;
  };
  risques_par_alea?: Record<string, {
    label: string;
    risque: number;
    niveau: string;
    justification: string;
    _f_score?: number;
    _v_score?: number;
  }>;
}

interface BuildingData {
  bdnb?: {
    batiment?: {
      annee_construction?: number | null;
      hauteur_mean?: number | null;
      nb_niveau?: number | null;
      nb_log?: number | null;
      surface_emprise_sol?: number | null;
      s_geom_groupe?: number | null;
      mat_mur_txt?: string | null;
      mat_toit_txt?: string | null;
      usage_principal_bdnb_open?: string | null;
      usage_niveau_1_txt?: string | null;
      classe_bilan_dpe?: string | null;
      conso_5_usages_ep_m2?: number | null;
      type_energie_chauffage?: string | null;
      altitde_sol_mean?: number | null;
    } | null;
  } | null;
  georisques?: {
    catnat?: {
      data?: Array<{
        libelle_risque_jo?: string;
        date_debut_evt?: string;
      }>;
    };
  };
}

/* ── Helpers ── */

function classificationBatiment(annee: number | null | undefined): string {
  if (!annee) return 'Inconnue';
  if (annee < 1949) return 'Antérieur 1949';
  if (annee < 1975) return '1949-1974';
  if (annee < 2000) return '1975-2000';
  if (annee < 2012) return '2001-2011';
  return '2012+';
}

function dpeColor(dpe: string | null | undefined): string {
  const colors: Record<string, string> = {
    A: '#3A7A6C', B: '#6E9E52', C: '#D4AC3E', D: '#D07030',
    E: '#C83030', F: '#801060', G: '#300020',
  };
  return colors[dpe || ''] || '#888';
}

function countCatNatByType(georisques: BuildingData['georisques']): Record<string, number> {
  const catnat = georisques?.catnat?.data || [];
  const counts: Record<string, number> = {};
  for (const ev of catnat) {
    const type = ev.libelle_risque_jo || 'Autre';
    counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}

/* ── Sous-composants ── */

function MetricCard({ label, value, unit, hint, color }: {
  label: string;
  value: string | number;
  unit?: string;
  hint?: string;
  color?: string;
}) {
  return (
    <div className="insight-metric-card">
      <div className="insight-metric-label">{label}</div>
      <div className="insight-metric-value" style={{ color }}>
        {value}
        {unit && <span className="insight-metric-unit">{unit}</span>}
      </div>
      {hint && <div className="insight-metric-hint">{hint}</div>}
    </div>
  );
}

function VulnerabilityProfile({ bdnb }: { bdnb: BuildingData['bdnb'] }) {
  const bat = bdnb?.batiment;
  const annee = bat?.annee_construction;
  const dpe = bat?.classe_bilan_dpe;
  const hauteur = bat?.hauteur_mean;
  const nbNiveaux = bat?.nb_niveau;
  const surface = bat?.s_geom_groupe || bat?.surface_emprise_sol;
  const materiau = bat?.mat_mur_txt;
  const toiture = bat?.mat_toit_txt;
  const usage = bat?.usage_niveau_1_txt || bat?.usage_principal_bdnb_open;

  const classification = classificationBatiment(annee);

  return (
    <div className="insight-section">
      <h3 className="insight-section-title">
        <span className="insight-section-icon">domain</span>
        Profil du bien
      </h3>
      <div className="insight-metrics-grid">
        <MetricCard
          label="Construction"
          value={annee || '—'}
          hint={classification}
        />
        <MetricCard
          label="Hauteur"
          value={hauteur != null ? `${hauteur.toFixed(1)}` : '—'}
          unit="m"
          hint={`${nbNiveaux || '?'} niveaux`}
        />
        <MetricCard
          label="Surface"
          value={surface != null ? `${Math.round(surface)}` : '—'}
          unit="m²"
        />
        <MetricCard
          label="DPE"
          value={dpe || '—'}
          color={dpeColor(dpe)}
          hint={dpe ? `Classe ${dpe}` : 'Non renseigné'}
        />
      </div>

      <div className="insight-details">
        <div className="insight-detail-row">
          <span className="insight-detail-label">Usage</span>
          <span className="insight-detail-value">{usage || 'Résidentiel'}</span>
        </div>
        <div className="insight-detail-row">
          <span className="insight-detail-label">Matériau mur</span>
          <span className="insight-detail-value">{materiau || '—'}</span>
        </div>
        <div className="insight-detail-row">
          <span className="insight-detail-label">Toiture</span>
          <span className="insight-detail-value">{toiture || '—'}</span>
        </div>
      </div>
    </div>
  );
}

function RiskDecomposition({ zones, risquesParAlea }: {
  zones: RiskScores['zones'];
  risquesParAlea?: RiskScores['risques_par_alea'];
}) {
  const [viewMode, setViewMode] = useState<'zones' | 'aleas'>('zones');

  return (
    <div className="insight-section">
      <h3 className="insight-section-title">
        <span className="insight-section-icon">analytics</span>
        Décomposition des risques
      </h3>

      <div className="insight-view-toggle">
        <button
          type="button"
          className={`insight-toggle-btn${viewMode === 'zones' ? ' active' : ''}`}
          onClick={() => setViewMode('zones')}
        >
          Par zone
        </button>
        <button
          type="button"
          className={`insight-toggle-btn${viewMode === 'aleas' ? ' active' : ''}`}
          onClick={() => setViewMode('aleas')}
        >
          Par aléa
        </button>
      </div>

      {viewMode === 'zones' ? (
        <div className="insight-radar-container">
          {/* Radar chart simplifié avec F et V par zone */}
          <div className="insight-radar">
            {Object.entries(zones).map(([zoneName, zone]) => {
              const fScore = zone._f_score ?? zone.risque;
              const vScore = zone._v_score ?? 50;
              const band = bandForKey(zone.niveau);
              return (
                <div key={zoneName} className="insight-radar-row">
                  <span className="insight-radar-label">
                    {zoneName.replace('_', ' ').replace('murs ', 'Murs ')}
                  </span>
                  <div className="insight-radar-bars">
                    <div className="insight-radar-bar-group">
                      <div className="insight-radar-bar insight-radar-bar-f"
                           style={{ width: `${fScore}%` }} />
                      <span className="insight-radar-bar-label">F</span>
                    </div>
                    <div className="insight-radar-bar-group">
                      <div className="insight-radar-bar insight-radar-bar-v"
                           style={{ width: `${vScore}%` }} />
                      <span className="insight-radar-bar-label">V</span>
                    </div>
                  </div>
                  <span className="insight-radar-score" style={{ color: band?.color }}>
                    {zone.risque}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="insight-legend">
            <span><span className="insight-legend-dot insight-legend-f" /> F = Aléa (0-100)</span>
            <span><span className="insight-legend-dot insight-legend-v" /> V = Vulnérabilité (0-100)</span>
          </div>
        </div>
      ) : (
        <div className="insight-aleas-list">
          {risquesParAlea && Object.entries(risquesParAlea).map(([code, alea]) => {
            const band = bandForKey(alea.niveau);
            return (
              <div key={code} className="insight-alea-row">
                <span className="insight-alea-dot" style={{ background: band?.color }} />
                <span className="insight-alea-name">{alea.label}</span>
                <span className="insight-alea-score" style={{ color: band?.color }}>
                  {alea.risque}
                </span>
                <span className={`insight-alea-band d03-pill ${band?.cls || ''}`}>
                  {band?.label || '—'}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ConfidenceAnalysis({ confidence }: { confidence?: RiskScores['confidence'] }) {
  if (!confidence) return null;

  const scoreColor = confidence.score >= 70 ? '#3A7A6C' :
                     confidence.score >= 50 ? '#D4AC3E' : '#D07030';

  return (
    <div className="insight-section">
      <h3 className="insight-section-title">
        <span className="insight-section-icon">verified</span>
        Fiabilité de l'analyse
      </h3>

      <div className="insight-confidence-header">
        <div className="insight-confidence-score" style={{ color: scoreColor }}>
          {confidence.score}
          <span className="insight-confidence-unit">/100</span>
        </div>
        <div className="insight-confidence-level">
          Confiance {confidence.niveau}
        </div>
      </div>

      <div className="insight-confidence-bars">
        <div className="insight-confidence-bar-item">
          <span className="insight-confidence-bar-label">
            Couverture sources
          </span>
          <div className="insight-confidence-bar-track">
            <div className="insight-confidence-bar-fill"
                 style={{ width: `${confidence.composantes.couverture * 100}%` }} />
          </div>
          <span className="insight-confidence-bar-value">
            {confidence.n_sources_disponibles}/{confidence.n_sources_total}
          </span>
        </div>

        <div className="insight-confidence-bar-item">
          <span className="insight-confidence-bar-label">
            Qualité sources
          </span>
          <div className="insight-confidence-bar-track">
            <div className="insight-confidence-bar-fill"
                 style={{ width: `${confidence.composantes.qualite_sources * 100}%` }} />
          </div>
          <span className="insight-confidence-bar-value">
            {(confidence.composantes.qualite_sources * 100).toFixed(0)}%
          </span>
        </div>

        <div className="insight-confidence-bar-item">
          <span className="insight-confidence-bar-label">
            Pas d'erreur API
          </span>
          <div className="insight-confidence-bar-track">
            <div className="insight-confidence-bar-fill"
                 style={{ width: `${confidence.composantes.absence_erreurs * 100}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function HistoricalIndicators({ georisques }: { georisques?: BuildingData['georisques'] }) {
  const catnatCounts = countCatNatByType(georisques);
  const totalCatNat = Object.values(catnatCounts).reduce((a, b) => a + b, 0);
  const topTypes = Object.entries(catnatCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return (
    <div className="insight-section">
      <h3 className="insight-section-title">
        <span className="insight-section-icon">history</span>
        Indicateurs historiques
      </h3>

      <div className="insight-metrics-grid">
        <MetricCard
          label="Événements CatNat"
          value={totalCatNat}
          hint="Sur la commune"
        />
      </div>

      {topTypes.length > 0 && (
        <div className="insight-catnat-list">
          {topTypes.map(([type, count]) => (
            <div key={type} className="insight-catnat-row">
              <span className="insight-catnat-type">{type}</span>
              <span className="insight-catnat-count">{count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DamagePotential({ zones, bdnb }: {
  zones: RiskScores['zones'];
  bdnb: BuildingData['bdnb'];
}) {
  const bat = bdnb?.batiment;
  const surface = bat?.s_geom_groupe || bat?.surface_emprise_sol || 100;
  const annee = bat?.annee_construction;

  // Estimation simplifiée du potentiel de dommages (€/m²)
  // Basée sur le score de risque moyen et l'âge du bâtiment
  const avgRisk = Object.values(zones).reduce((sum, z) => sum + z.risque, 0) / Object.values(zones).length;
  const ageFactor = annee ? Math.max(1, (2024 - annee) / 50) : 1.5;
  const costPerSqm = Math.round(avgRisk * ageFactor * 5); // €/m² estimé
  const totalPotential = Math.round(costPerSqm * surface);

  return (
    <div className="insight-section">
      <h3 className="insight-section-title">
        <span className="insight-section-icon">euro</span>
        Potentiel de dommages estimé
      </h3>

      <div className="insight-metrics-grid">
        <MetricCard
          label="Coût potentiel /m²"
          value={`${costPerSqm}`}
          unit="€"
          hint="Estimation indicative"
        />
        <MetricCard
          label="Potentiel total"
          value={`${(totalPotential / 1000).toFixed(0)}`}
          unit="k€"
          hint={`${surface} m² × ${costPerSqm} €/m²`}
        />
      </div>

      <p className="insight-disclaimer">
        <span className="insight-section-icon">info</span>
        Estimation indicative basée sur le score de risque et l'âge du bâtiment.
        Ne constitue pas une expertise de sinistre.
      </p>
    </div>
  );
}

/* ── Composant principal ── */

export function InsurerInsights({
  riskScores,
  buildingData,
  trajectoire: _trajectoire,
  aleas: _aleas,
}: {
  riskScores: RiskScores;
  buildingData: BuildingData;
  trajectoire: Trajectoire | null;
  aleas: AleaDetail[];
}) {
  const [activeTab, setActiveTab] = useState<'vulnerabilite' | 'risques' | 'confiance' | 'historique'>('risques');

  return (
    <section className="insurer-insights" aria-label="Insights Assureur">
      <div className="insights-header">
        <h2>Analyse approfondie</h2>
        <span className="insights-badge">Assureur</span>
      </div>

      <nav className="insights-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className={`insights-tab${activeTab === 'risques' ? ' active' : ''}`}
          aria-selected={activeTab === 'risques'}
          onClick={() => setActiveTab('risques')}
        >
          Risques
        </button>
        <button
          type="button"
          role="tab"
          className={`insights-tab${activeTab === 'vulnerabilite' ? ' active' : ''}`}
          aria-selected={activeTab === 'vulnerabilite'}
          onClick={() => setActiveTab('vulnerabilite')}
        >
          Vulnérabilité
        </button>
        <button
          type="button"
          role="tab"
          className={`insights-tab${activeTab === 'confiance' ? ' active' : ''}`}
          aria-selected={activeTab === 'confiance'}
          onClick={() => setActiveTab('confiance')}
        >
          Fiabilité
        </button>
        <button
          type="button"
          role="tab"
          className={`insights-tab${activeTab === 'historique' ? ' active' : ''}`}
          aria-selected={activeTab === 'historique'}
          onClick={() => setActiveTab('historique')}
        >
          Historique
        </button>
      </nav>

      <div className="insights-content">
        {activeTab === 'risques' && (
          <>
            <RiskDecomposition
              zones={riskScores.zones}
              risquesParAlea={riskScores.risques_par_alea}
            />
            <DamagePotential zones={riskScores.zones} bdnb={buildingData.bdnb} />
          </>
        )}

        {activeTab === 'vulnerabilite' && (
          <VulnerabilityProfile bdnb={buildingData.bdnb} />
        )}

        {activeTab === 'confiance' && (
          <ConfidenceAnalysis confidence={riskScores.confidence} />
        )}

        {activeTab === 'historique' && (
          <HistoricalIndicators georisques={buildingData.georisques} />
        )}
      </div>
    </section>
  );
}
