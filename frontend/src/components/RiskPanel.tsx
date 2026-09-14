// =============================================================================
//   TYPHOON — /zone : PANNEAU D'ÉVALUATION DES RISQUES (gauche, mode « étape
//   suivante »)
//   Dashboard latéral alimenté UNIQUEMENT par les données réelles du rapport
//   de diagnostic (contrat RisqueReport) :
//     · en-tête      — nom de la zone (adresse diagnostiquée) + sous-titre ;
//     · métriques    — aléas présents / bâtiments à l'adresse / emprise (BDNB) ;
//     · aléas        — liste des risques détectés (zonage Géorisques) avec
//                      historique CatNat quand disponible ;
//     · fiche BDNB   — usage, construction, hauteur, altitude, emprise,
//                      matériaux, aléa argile, fiabilité (réels) ;
//     · bloc bâtiment— étages / logements (BDNB ; « — » si absent) ;
//     · Floor Plan   — blueprint 2D dessiné depuis la géométrie BDNB
//                      (geom_groupe, EPSG:2154 → WGS84).
//   Aucune valeur inventée : ce que le backend ne fournit pas s'affiche « — »
//   (pas de fausses prédictions de pertes ni de dommages).
// =============================================================================

import { useMemo, useState } from 'react';
import type { RisqueReport, AleaDetail } from '../zone/config';
import { geomToWgs84, firstRing } from '../zone/mapHelpers';
import {
  scenarioFor,
  computeDamage,
  exposureFromReport,
  timeProfileAt,
  fmtRange,
  fmtMoneyEUR,
} from '../zone/damageModel';

/* ── Géométrie BDNB → polyline SVG (blueprint 2D) ──
   Convertit geom_groupe (Lambert-93) en WGS84, prend l'anneau extérieur du
   premier polygone et le projette dans une viewBox en remettant Y à l'endroit
   (nord = haut). Retourne null si la géométrie manque ou est invalide. */
function footprintSvg(
  geom: unknown
): { viewBox: string; points: string; size: number } | null {
  const wgs = geomToWgs84(geom as Record<string, unknown> | null | undefined);
  const ring = firstRing(wgs?.coordinates);
  if (!ring || ring.length < 3) return null;
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rawW = maxX - minX;
  const rawH = maxY - minY;
  if (rawW <= 0 || rawH <= 0) return null;
  const pad = 26;
  const size = 340; // viewBox carrée (le panneau est carré)
  const scale = Math.min((size - pad * 2) / rawW, (size - pad * 2) / rawH);
  const ox = (size - rawW * scale) / 2;
  const oy = (size - rawH * scale) / 2;
  const pts = ring
    .map((p) => {
      const x = ox + (p[0] - minX) * scale;
      const y = oy + (rawH * scale - (p[1] - minY) * scale); // Y inversé → nord en haut
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return { viewBox: `0 0 ${size} ${size}`, points: pts, size };
}

function fmtM2(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)} km²`;
  if (v >= 10_000) return `${(v / 1_000).toFixed(1)}k m²`;
  return `${Math.round(v).toLocaleString('fr-FR')} m²`;
}

/* ── Formatage : valeur absente → « — » (jamais de valeur inventée) ── */
function fmtNum(v: number | null | undefined): string {
  return v == null ? '—' : Math.round(v).toLocaleString('fr-FR');
}

/* Première lettre en capitale (libellés Géorisques/BDNB souvent en minuscules). */
function cap(v: string | null | undefined): string | null {
  if (!v) return null;
  return v.charAt(0).toUpperCase() + v.slice(1);
}

/* Icône Material par code d'aléa (fallback : « warning »). */
function aleaIcon(code: string): string {
  const c = code.toLowerCase();
  if (c.includes('inond') || c.includes('flood')) return 'water';
  if (c.includes('seisme') || c.includes('sism')) return 'vibration';
  if (c.includes('argile') || c.includes('mouvement') || c.includes('terrain')) return 'landslide';
  if (c.includes('radon')) return 'air';
  if (c.includes('feu') || c.includes('forest') || c.includes('incendie')) return 'local_fire_department';
  if (c.includes('cyclone') || c.includes('vent')) return 'air';
  if (c.includes('industrie') || c.includes('icpe') || c.includes('techno')) return 'factory';
  if (c.includes('cavite') || c.includes('souterrain')) return 'domain_disabled';
  if (c.includes(' avalanche')) return 'ac_unit';
  if (c.includes('pollu') || c.includes('sol')) return 'science';
  if (c.includes('ppr') || c.includes('prevention')) return 'gavel';
  return 'warning';
}

/* État d'un aléa : présent (zonage), seulement à l'échelle commune, absent. */
function aleaTone(a: AleaDetail): 'present' | 'commune' | 'absent' | 'unknown' {
  if (a.present) return 'present';
  if (a.present === false) return a.present_commune ? 'commune' : 'absent';
  return a.zonage ? 'present' : 'unknown';
}

export function RiskPanel({
  place,
  report,
  scenarioKey,
  timeMin,
}: {
  place: string | null;
  report: RisqueReport | null;
  /* Scénario sélectionné (panneau droit) → bande d'intensité. */
  scenarioKey: string;
  /* Minute de la journée (console basse) → instant t de l'événement. */
  timeMin: number;
}) {
  const b = report?.bdnb?.batiment ?? null;

  /* Moteur de dommages : exposition BDNB × scénario × instant t de la
     timeline → estimation calculée (avec fourchette d'incertitude). */
  const exposure = useMemo(() => exposureFromReport(report), [report]);
  const time = timeProfileAt(timeMin / 60);
  /* Scénario actif (référence stable : SCENARIOS est un tableau constant). */
  const scenario = scenarioFor(scenarioKey);
  const est = useMemo(
    () => computeDamage(exposure, scenario, time),
    [exposure, scenario, time]
  );

  /* Réels : aléas du rapport + bâtiments BDNB à l'adresse. */
  const aleas = useMemo(() => report?.aleas ?? [], [report]);
  const presentAleas = useMemo(() => aleas.filter((a) => aleaTone(a) === 'present'), [aleas]);
  const otherBuildings = report?.bdnb?.autres_batiments_meme_adresse?.length ?? 0;
  const buildingsAtAddress = (b ? 1 : 0) + otherBuildings;
  const area = b?.surface_emprise_sol ?? b?.s_geom_groupe ?? null;

  /* Historique CatNat cumulé sur tous les aléas (événements réels arrêtés). */
  const catNatEvents = useMemo(() => {
    const evts: { libelle: string; date: string }[] = [];
    for (const a of aleas) {
      for (const e of a.catnat_historique ?? []) {
        const lib = e.libelle_risque_jo || e.libelle || a.libelle;
        if (e.date_debut_evt) evts.push({ libelle: lib, date: e.date_debut_evt });
      }
    }
    evts.sort((x, y) => y.date.localeCompare(x.date));
    return evts;
  }, [aleas]);

  /* Fiche bâtiment BDNB (champs réels). */
  const usage = cap(b?.usage_principal_bdnb_open) || cap(b?.usage_niveau_1_txt) || null;
  const commune = b?.libelle_commune_insee || null;
  const insee = b?.code_commune_insee || null;
  const ficheRows: { label: string; value: string }[] = [
    { label: 'Usage', value: usage ?? '—' },
    { label: 'Construction', value: b?.annee_construction ? String(b.annee_construction) : '—' },
    { label: 'Hauteur', value: b?.hauteur_mean != null ? `${b.hauteur_mean.toFixed(1)} m` : '—' },
    { label: 'Altitude sol', value: b?.altitude_sol_mean != null ? `${b.altitude_sol_mean.toFixed(1)} m` : '—' },
    { label: 'Emprise', value: b?.surface_emprise_sol != null ? fmtM2(b.surface_emprise_sol) : '—' },
    { label: 'Murs', value: cap(b?.mat_mur_txt) ?? '—' },
    { label: 'Toiture', value: cap(b?.mat_toit_txt) ?? '—' },
    { label: 'Aléa argile', value: cap(b?.alea_argile) ?? '—' },
    { label: 'Fiab. adresse', value: cap(b?.fiabilite_cr_adr_niv_1) ?? '—' },
  ];

  /* Sélecteurs de la section « Structural Integrity Building ». */
  const floors = b?.nb_niveau ?? null;
  const buildingNos = useMemo(
    () => Array.from({ length: Math.max(1, buildingsAtAddress) }, (_, i) => String(i + 1)),
    [buildingsAtAddress]
  );
  const floorNos = useMemo(
    () => Array.from({ length: Math.max(1, floors ?? 0) }, (_, i) => String(i + 1)),
    [floors]
  );
  const [buildingNo, setBuildingNo] = useState('1');
  const [floor, setFloor] = useState('');

  const plan = useMemo(() => footprintSvg(b?.geom_groupe), [b?.geom_groupe]);

  return (
    <aside className="risk-panel" aria-label="Évaluation des risques de la zone">
      {/* ── En-tête : nom de la zone ── */}
      <header className="risk-head">
        <h1 className="risk-place">{place ?? 'Secteur'}</h1>
        <span className="risk-sub">
          Diagnostic risques · {report ? new Date(report.date_generation).toLocaleDateString('fr-FR') : '—'}
        </span>
      </header>

      {/* ── Rangée de métriques (réelles) ── */}
      <div className="risk-metrics">
        <div className="risk-metric">
          <span className="risk-metric-val">{presentAleas.length}</span>
          <span className="risk-metric-label">Aléas présents</span>
        </div>
        <div className="risk-metric">
          <span className="risk-metric-val">{buildingsAtAddress > 0 ? buildingsAtAddress : '—'}</span>
          <span className="risk-metric-label">Bâtiments</span>
        </div>
        <div className="risk-metric">
          <span className="risk-metric-val">{area ? fmtM2(area) : '—'}</span>
          <span className="risk-metric-label">Emprise</span>
        </div>
      </div>

      {/* ── Dommages estimés (modélisés) — recalés sur le scénario actif et
          l'instant t de la timeline. Chaque widget = estimation + fourchette
          (±) : valeurs calculées, pas mesurées. N'apparaît qu'après un
          diagnostic (sinon pas de bâtiment à modéliser). ── */}
      {report ? (
      <section className="risk-block">
        <div className="risk-title-row">
          <h2 className="risk-title">Dommages estimés</h2>
          <span className="risk-dmg-scenario">{scenario.risk}</span>
        </div>
        <div className="risk-loss-grid">
          <div className="risk-loss">
            <md-icon aria-hidden="true">park</md-icon>
            <span className="risk-loss-val">{fmtRange(est.brokenTrees)}</span>
            <span className="risk-loss-label">Arbres cassés</span>
          </div>
          <div className="risk-loss">
            <md-icon aria-hidden="true">directions_car</md-icon>
            <span className="risk-loss-val">{fmtRange(est.damagedVehicles)}</span>
            <span className="risk-loss-label">Véhicules endommagés</span>
          </div>
          <div className="risk-loss">
            <md-icon aria-hidden="true">bolt</md-icon>
            <span className="risk-loss-val">{fmtRange(est.downedPowerLines)}</span>
            <span className="risk-loss-label">Lignes coupées (km)</span>
          </div>
          <div className="risk-loss">
            <md-icon aria-hidden="true">water_damage</md-icon>
            <span className="risk-loss-val">{fmtRange(est.floodedConduitM)}</span>
            <span className="risk-loss-label">Conduites inondées (m)</span>
          </div>
          <div className="risk-loss">
            <md-icon aria-hidden="true">location_city</md-icon>
            <span className="risk-loss-val">{fmtRange(est.damagedBuildings)}</span>
            <span className="risk-loss-label">Bâtiments touchés</span>
          </div>
          <div className="risk-loss">
            <md-icon aria-hidden="true">road</md-icon>
            <span className="risk-loss-val">{fmtRange(est.damagedRoadsM)}</span>
            <span className="risk-loss-label">Voirie inondée (m)</span>
          </div>
        </div>
        <div className="risk-loss-totals">
          <div className="risk-loss-total">
            <span className="risk-loss-total-label">Niveau d'eau</span>
            <span className="risk-loss-total-val">{fmtRange(est.waterLevelFt)} ft</span>
          </div>
          <div className="risk-loss-total">
            <span className="risk-loss-total-label">Dommages estimés</span>
            <span className="risk-loss-total-val">{fmtMoneyEUR(est.damageEUR)}</span>
          </div>
        </div>
        <div className="risk-loss-note">
          Estimations modélisées : vent/eau du scénario × exposition BDNB ×
          courbes de vulnérabilité. Fourchettes ± d'incertitude. Ne sont pas
          des données mesurées.
        </div>
      </section>
      ) : null}

      {/* ── Aléas détectés (Géorisques, données réelles) ── */}
      <section className="risk-block">
        <h2 className="risk-title">
          Aléas · {report?.alea_count ?? 0} / {aleas.length}
        </h2>
        <div className="risk-aleas">
          {aleas.length === 0 ? (
            <span className="risk-plan-empty">Aucun aléa remonté par le diagnostic</span>
          ) : (
            aleas.map((a) => {
              const tone = aleaTone(a);
              return (
                <div className={`risk-alea risk-alea--${tone}`} key={a.code} title={a.zonage ?? undefined}>
                  <md-icon aria-hidden="true">{aleaIcon(a.code)}</md-icon>
                  <span className="risk-alea-label">{a.libelle}</span>
                  <span className="risk-alea-badge">
                    {tone === 'present'
                      ? a.zonage ?? 'Présent'
                      : tone === 'commune'
                        ? 'Commune'
                        : tone === 'absent'
                          ? 'Absent'
                          : '—'}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </section>

      {/* ── Historique CatNat (arrêtés réels, plus récents d'abord) ── */}
      {catNatEvents.length > 0 ? (
        <section className="risk-block">
          <h2 className="risk-title">Historique CatNat · {catNatEvents.length}</h2>
          <div className="risk-catnat">
            {catNatEvents.slice(0, 5).map((e, i) => (
              <div className="risk-catnat-row" key={`${e.date}-${i}`}>
                <span className="risk-catnat-date">
                  {new Date(e.date).toLocaleDateString('fr-FR')}
                </span>
                <span className="risk-catnat-lib">{e.libelle}</span>
              </div>
            ))}
            {catNatEvents.length > 5 ? (
              <span className="risk-catnat-more">
                + {catNatEvents.length - 5} autres événements
              </span>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* ── Bloc bâtiment (étages / logements — réels BDNB) ── */}
      <div className="risk-cc22d">
        <span className="risk-cc22d-code">{b?.batiment_groupe_id ? b.batiment_groupe_id.slice(-4).toUpperCase() : 'BDNB'}</span>
        <div className="risk-cc22d-stats">
          <div className="risk-cc22d-stat">
            <span className="risk-cc22d-val">{floors ?? '—'}</span>
            <span className="risk-cc22d-label">Floors</span>
          </div>
          <div className="risk-cc22d-stat">
            <span className="risk-cc22d-val">{fmtNum(b?.nb_log)}</span>
            <span className="risk-cc22d-label">Housing Units</span>
          </div>
        </div>
      </div>

      {/* ── Fiche bâtiment BDNB (champs réels) ── */}
      <section className="risk-block">
        <h2 className="risk-title">Fiche bâtiment BDNB</h2>
        <div className="risk-fiche">
          {commune ? (
            <div className="risk-fiche-loc">
              <md-icon aria-hidden="true">location_on</md-icon>
              <span>
                {commune}
                {insee ? ` · INSEE ${insee}` : ''}
              </span>
            </div>
          ) : null}
          <div className="risk-fiche-grid">
            {ficheRows.map((r) => (
              <div className={`risk-fiche-item${r.value === '—' ? ' risk-fiche-item--na' : ''}`} key={r.label}>
                <span className="risk-fiche-label">{r.label}</span>
                <span className="risk-fiche-val">{r.value}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Structural Integrity Building ── */}
      <section className="risk-block">
        <h2 className="risk-title">Structural Integrity Building</h2>
        <div className="risk-selects">
          <label className="risk-field">
            <span className="risk-field-label">Building Nº</span>
            <select
              className="risk-select"
              value={buildingNo}
              onChange={(e) => setBuildingNo(e.target.value)}
            >
              {buildingNos.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="risk-field">
            <span className="risk-field-label">Floor</span>
            <select
              className="risk-select"
              value={floor || (floorNos.length ? floorNos[floorNos.length - 1] : '')}
              onChange={(e) => setFloor(e.target.value)}
              disabled={floorNos.length === 0}
            >
              {floorNos.length === 0 ? <option value="">—</option> : null}
              {floorNos.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {/* ── Floor Plan blueprint (géométrie BDNB réelle) ── */}
      <section className="risk-plan-wrap">
        <h2 className="risk-title">Floor Plan</h2>
        <div className="risk-plan">
          {plan ? (
            <svg
              className="risk-plan-svg"
              viewBox={plan.viewBox}
              role="img"
              aria-label="Plan 2D de l'empreinte du bâtiment"
            >
              <polygon
                className="risk-plan-line"
                points={plan.points}
              />
            </svg>
          ) : (
            <span className="risk-plan-empty">Empreinte BDNB indisponible</span>
          )}
        </div>
      </section>
    </aside>
  );
}
