import { useMemo, useState, type CSSProperties } from 'react';
import type { RisqueReport } from '../zone/config';
import {
  SCENARIOS,
  scenarioFor,
  computeDamage,
  effectiveDepthM,
  exposureFromReport,
  timeProfileAt,
} from '../zone/damageModel';
import {
  photoCaption,
  photoCredit,
  photoDetail,
  waterLineLabel,
  waterLinePct,
  type SitePhoto,
} from '../zone/sitePhoto';

/* ══════════════════════════════════════════════════════════════════════════
   TYPHOON — /zone : PANNEAU DES SCÉNARIOS (droite, mode « étape suivante »)
   Colonne droite de la vue risque, façon référence Fuselab (dashboard flood) :
     · .scenario-warn    — bandeau FLOOD WARNING (validité) + « EXPECTED » avec
                            la commune réelle du diagnostic ;
     · .scenario-block   — SELECT SCENARIO (liste déroulante) + ligne « Peak » ;
     · .scenario-rank    — classement des scénarios probables : % + barre de
                            probabilité, libellé de risque (HIGH / MODERATE /
                            LOW DAMAGE RISK) et métriques HP / dommages ;
     · .scenario-grid    — grille 2×4 « 8 échantillons du modèle ».
   Les valeurs des scénarios (probabilités, HP, dommages) sont maintenant
   CALCULÉES par le moteur de dommages (damageModel) : chaque rang appelle la
   même fonction que le panneau gauche, avec l'instant t de la timeline. La
   sélection d'un rang remonte vers la page (scenarioKey) qui recalcule tout.

   VIGNETTES : le support des cartes de la grille est la PHOTO TERRAIN RÉELLE du
   secteur (Panoramax, contrat GET /api/photo) — pas un fond abstrait, pas une
   image d'inondation trouvée ailleurs. Deux natures s'y superposent sans être
   confondues :
     · RÉEL      — l'image, sa date, son producteur, sa distance et son écart
                   d'orientation, affichés sous la grille ;
     · ENVELOPPE — le trait d'eau de la bande (hauteur d'eau du scénario /
                   hauteur de bâti BDNB), qui est du MODÈLE et le dit dans son
                   infobulle.
   Sans photo (secteur non couvert, service indisponible), les cartes gardent
   leur visuel abstrait et le panneau n'affiche aucune provenance inventée.
══════════════════════════════════════════════════════════════════════════ */

/* ── Événements possibles (liste déroulante du sélecteur — bande de hazard) ── */
const EVENTS = ['HURRICANE', 'TROPICAL STORM', 'STORM SURGE', 'FLASH FLOOD'] as const;

/* ── Ensemble : 8 échantillons RÉELS du moteur (4 bandes × 2 avancements de
   l'événement). Aucun identifiant de membre inventé : chaque tuile porte la
   probabilité de sa bande et les dommages calculés à cet avancement. ── */
const ENSEMBLE_ADVANCE = [0.5, 1] as const;

/* Étiquette de zone : commune BDNB quand disponible, sinon l'adresse ou la
   zone sélectionnée. */
function zoneLabel(place: string | null, report: RisqueReport | null): string {
  const commune = report?.bdnb?.batiment?.libelle_commune_insee;
  if (commune) return commune;
  if (report?.adresse_normalisee) return report.adresse_normalisee;
  return place ?? 'Secteur analysé';
}

/* Couleur de l'icône du membre (tone) — utilisée en variable CSS. */
const TONE_COLOR = { high: '#ff3b30', low: '#4da3ff' } as const;

/* Heure du pic de pluie du profil du moteur (dérivée, jamais saisie). */
const PEAK_HOUR = (() => {
  let best = 0;
  for (let h = 0; h < 24; h += 1) {
    if (timeProfileAt(h).rain > timeProfileAt(best).rain) best = h;
  }
  return best;
})();

export function ScenarioPanel({
  place,
  report,
  scenarioKey,
  onScenarioChange,
  timeMin,
  photo,
}: {
  place: string | null;
  report: RisqueReport | null;
  scenarioKey: string;
  onScenarioChange: (key: string) => void;
  timeMin: number;
  /* Photo terrain RÉELLE du secteur (Panoramax) — support des vignettes de la
     grille. null = pas encore chargée ; `available: false` = secteur non couvert. */
  photo: SitePhoto | null;
}) {
  const [event, setEvent] = useState<string>('HURRICANE');
  const [pickedMember, setPickedMember] = useState<string>('');

  /* Instant t de l'événement (profil partagé avec la console basse). */
  const time = timeProfileAt(timeMin / 60);
  const exposure = useMemo(() => exposureFromReport(report), [report]);

  /* Hauteur de bâti de référence (m) pour le trait d'eau des vignettes : la
     hauteur BDNB du bâtiment analysé, à défaut le nombre de niveaux × 3 m.
     Inconnue → null, et aucun trait n'est dessiné (cf. waterLinePct). */
  const buildingHeightM = useMemo(() => {
    const b = report?.bdnb?.batiment ?? null;
    if (typeof b?.hauteur_mean === 'number' && b.hauteur_mean > 0) return b.hauteur_mean;
    if (typeof b?.nb_niveau === 'number' && b.nb_niveau > 0) return b.nb_niveau * 3;
    return null;
  }, [report]);

  /* Échantillons de l'ensemble : chaque bande évaluée à mi-parcours puis en
     fin d'événement — c'est le MÊME moteur que les panneaux. Chaque tuile porte
     en plus la hauteur d'eau de sa bande à cet avancement, et la position du
     trait d'eau qui en découle sur la photo. */
  const ensemble = useMemo(
    () =>
      SCENARIOS.flatMap((s) =>
        ENSEMBLE_ADVANCE.map((adv) => {
          const at = timeProfileAt(24 * adv - 1);
          const est = computeDamage(exposure, s, at);
          const depthM = effectiveDepthM(s, at.accum);
          return {
            key: `${s.key}-${adv}`,
            pct: s.pct,
            advance: adv,
            tone: s.risk.startsWith('HIGH') ? ('high' as const) : ('low' as const),
            dmgM: (est.damageUSD.v / 1_000_000).toFixed(1),
            depthM,
            linePct: waterLinePct(depthM, buildingHeightM),
          };
        })
      ),
    [exposure, buildingHeightM]
  );

  /* Chaque scénario est évalué par le moteur à cet instant → HP + $M. */
  const ranks = useMemo(
    () =>
      SCENARIOS.map((s) => {
        const est = computeDamage(exposure, s, time);
        return {
          ...s,
          hp: Math.round(est.hp.v).toLocaleString('fr-FR'),
          dmg: (est.damageUSD.v / 1_000_000).toFixed(1),
        };
      }),
    [exposure, time]
  );

  const selected = scenarioFor(scenarioKey);

  return (
    <aside className="scenario-panel" aria-label="Sélection des scénarios d'inondation">
      {/* ── Bandeau d'alerte + localisation ── */}
      <div className="scenario-warn">
        <span className="scenario-warn-ico" aria-hidden="true">
          <md-icon>warning</md-icon>
        </span>
        <span className="scenario-warn-txt">
          <b>Flood Warning</b>
          <span>
            Valid: {report ? new Date(report.date_generation).toLocaleDateString('fr-FR') : '—'}
            {' · '}diagnostic de la zone
          </span>
        </span>
      </div>
      <div className="scenario-expected">
        <span className="scenario-expected-k">Expected</span>
        <span className="scenario-expected-v">{zoneLabel(place, report)}</span>
      </div>

      {/* ── Sélecteur d'événement ── */}
      <section className="scenario-block">
        <div className="scenario-block-head">
          <h2 className="scenario-title">Select Scenario</h2>
          <label className="scenario-pick">
            <select value={event} onChange={(e) => setEvent(e.target.value)} aria-label="Type d'événement">
              {EVENTS.map((ev) => (
                <option key={ev} value={ev}>
                  {ev}
                </option>
              ))}
            </select>
            <md-icon aria-hidden="true">arrow_drop_down</md-icon>
          </label>
        </div>
        {/* Pic de l'enveloppe : heure réelle du maximum de pluie du profil du
            moteur (aucune date de démonstration). */}
        <span className="scenario-peak">
          Pic de l'enveloppe : {String(PEAK_HOUR).padStart(2, '0')}:00 · {event.toLowerCase()}
          {' · '}eau {selected.depthPeakM.toFixed(1)} m · pluie {selected.rainPeakMmH} mm/h
        </span>
      </section>

      {/* ── Classement des scénarios probables (le plus probable en tête) —
          probabilités fixes, HP/dommages calculés par le moteur. ── */}
      <section className="scenario-block scenario-ranks" aria-label="Scénarios probables">
        {ranks.map((r) => (
          <button
            type="button"
            key={r.key}
            className={`scenario-rank${scenarioKey === r.key ? ' active' : ''}`}
            onClick={() => onScenarioChange(r.key)}
            aria-pressed={scenarioKey === r.key}
          >
            <span className="scenario-rank-pct">{r.pct}%</span>
            <span className="scenario-rank-body">
              <span className="scenario-rank-track" aria-hidden="true">
                <i style={{ width: `${r.pct}%` }} />
              </span>
              <span className="scenario-rank-meta">
                <span className="scenario-rank-risk">{r.risk}</span>
                <span className="scenario-rank-vals">
                  <b>HP {r.hp}</b>
                  <i aria-hidden="true">·</i>
                  <span>{r.dmg} ($1M)</span>
                </span>
              </span>
              {r.most ? (
                <span className="scenario-rank-most">
                  <md-icon aria-hidden="true">verified</md-icon>
                  Most probable
                </span>
              ) : null}
            </span>
          </button>
        ))}
      </section>

      {/* ── Grille des membres de l'ensemble (maquette) ── */}
      <section className="scenario-grid-sec" aria-label="Scénarios possibles">
        <div className="scenario-grid-head">
          <span className="scenario-grid-count">
            8 échantillons du modèle
            <small>4 bandes × 2 avancements · moteur de dommages</small>
          </span>
        </div>
        <div className="scenario-grid">
          {ensemble.map((m) => {
            const color = TONE_COLOR[m.tone];
            const hasPhoto = !!photo?.available && !!photo.thumb_url;
            const flooded = m.depthM >= 0.3; // seuil d'infrastructure du moteur
            return (
              <button
                type="button"
                key={m.key}
                className={`scenario-card${pickedMember === m.key ? ' picked' : ''}${hasPhoto ? ' has-photo' : ''}`}
                onClick={() => setPickedMember(m.key)}
                aria-pressed={pickedMember === m.key}
                style={{ '--sc': color } as CSSProperties}
                title={[
                  `Bande ${m.pct} % · avancement ${Math.round(m.advance * 100)} % de l'événement`,
                  m.linePct != null && buildingHeightM != null
                    ? waterLineLabel(m.depthM, buildingHeightM, m.linePct)
                    : null,
                  hasPhoto ? `Vue terrain réelle à ${photo?.distance_m} m — ${photoCredit(photo as SitePhoto)}` : null,
                ]
                  .filter(Boolean)
                  .join('\n')}
              >
                <span className="scenario-card-art" aria-hidden="true">
                  {/* Support RÉEL : la photo terrain du secteur. Sans elle, le
                      visuel abstrait du fond reste tel quel. */}
                  {hasPhoto ? (
                    <img
                      className="scenario-card-photo"
                      src={photo?.thumb_url ?? ''}
                      alt=""
                      loading="lazy"
                      decoding="async"
                    />
                  ) : null}
                  {/* Trait d'eau de la bande : RAPPORT hauteur d'eau / hauteur
                      de bâti (modèle), jamais une cote mesurée dans l'image. */}
                  {hasPhoto && m.linePct != null ? (
                    <span className="scenario-card-water" style={{ bottom: `${m.linePct}%` }} />
                  ) : null}
                  {/* Pastille : cette bande met le secteur sous l'eau (seuil du
                      moteur), pas un ornement — elle n'apparaît que si c'est vrai. */}
                  {flooded ? (
                    <span className="scenario-card-flood">
                      <md-icon>water_drop</md-icon>
                    </span>
                  ) : null}
                </span>
                <span className="scenario-card-body">
                  <b className="scenario-card-id">{m.pct}%</b>
                  <span className="scenario-card-note">${m.dmgM}M</span>
                </span>
                <span className={`scenario-card-risk ${m.tone}`}>
                  {m.tone === 'high' ? 'HIGH' : 'LOW'} RISK
                </span>
              </button>
            );
          })}
        </div>

        {/* Provenance des vignettes : la photo est RÉELLE, donc elle est créditée
            (etalab-2.0) avec sa date, son producteur, sa distance et son écart
            d'orientation. Sans photo, on ne prétend rien : pas de crédit. */}
        {photo && !photo.available ? (
          <div className="scenario-photo-credit is-empty">
            <md-icon aria-hidden="true">photo_camera_back</md-icon>
            <span>{photo.label ?? 'Pas de photo terrain pour ce secteur.'}</span>
          </div>
        ) : null}

        {photo?.available ? (
          <div className="scenario-photo-credit" title={photoDetail(photo)}>
            <md-icon aria-hidden="true">photo_camera</md-icon>
            <span>
              {photoCaption(photo)}
              {photo.page_url ? (
                <>
                  {' · '}
                  <a href={photo.page_url} target="_blank" rel="noreferrer noopener">
                    voir la photo
                  </a>
                </>
              ) : null}
            </span>
          </div>
        ) : null}
      </section>

      {/* Scénario actif — résumé d'entrée (pour le débogage / la confiance). */}
      <div className="scenario-debug">
        <span>
          <b>{selected.key}</b> · vent {Math.round(selected.windPeakKmh)} km/h · pluie{' '}
          {selected.rainPeakMmH} mm/h · eau {selected.depthPeakM.toFixed(1)} m
        </span>
      </div>
    </aside>
  );
}