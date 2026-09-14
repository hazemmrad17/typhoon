import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react';
import type { RisqueReport } from '../zone/config';
import { exposureOf } from '../zone/exposure';
import type { MeteoData } from '../zone/hydroRoute';
import {
  fireConeFrom,
  rgaProfileFrom,
  seismicFrom,
} from '../zone/hazardSim';
import {
  SCENARIOS,
  scenarioFor,
} from '../zone/damageModel';
import {
  photoCaption,
  photoCredit,
  photoDetail,
  waterLineLabel,
  waterLinePct,
  type SitePhoto,
} from '../zone/sitePhoto';
import {
  triDepthForScenario,
  bandPeakM,
  triProvenanceLabel,
  triAbsenceKind,
  triAbsenceText,
  type FloodAleaResult,
} from '../zone/floodAlea';

/* ══════════════════════════════════════════════════════════════════════════
   TYPHOON — /zone : PANNEAU DES SCÉNARIOS (droite, mode « étape suivante »)
   Colonne droite de la vue risque, façon référence Fuselab (dashboard flood) :
     · .scenario-warn    — bandeau FLOOD WARNING (validité) + « EXPECTED » avec
                            la commune réelle du diagnostic ;
     · .scenario-block   — SELECT SCENARIO (liste d'aléas à icônes) + ligne « Peak » ;
     · .scenario-rank    — classes réglementaires TRI (Directive Inondation) :
                            extrême / référence / fréquent / faible ;
     · .scenario-grid    — grille 2×4 des échantillons.
   Les scénarios sont les CLASSES TRI cartographiées au point (floodAlea) : la
   profondeur vient de la classe officielle, jamais d'un pic inventé. Une
   classe non cartographiée s'affiche « non cartographié ».

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

/* ── Types d'aléa. Chaque aléa affiché s'appuie sur des DONNÉES RÉELLES du
   diagnostic Géorisques (report.aleas) — statut bâtiment/commune, zonage,
   périmètre PPR testé au point. Aucune simulation synthétique : sans donnée
   au point, la ligne l'explicitement. ── */
const EVENTS = [
  { key: 'FLOODING', label: 'FLOODING', icon: 'water', hint: 'Crue / submersion', available: true, aleaCode: 'inondation' },
  { key: 'HURRICANE', label: 'HURRICANE', icon: 'storm', hint: 'Vent extrême', available: true, aleaCode: 'vent_cyclonique' },
  { key: 'RGA', label: 'RGA · ARGILES', icon: 'landslide', hint: 'Retrait-gonflement des argiles', available: true, aleaCode: 'rga' },
  { key: 'FIRE', label: 'FIRE HAZARD', icon: 'local_fire_department', hint: 'Feu de forêt', available: true, aleaCode: 'feu_foret' },
  { key: 'SEISMIC', label: 'SEISMIC RISK', icon: 'vibration', hint: 'Séismicité', available: true, aleaCode: 'sismicite' },
  { key: 'MVT', label: 'GROUND MOVEMENT', icon: 'terrain', hint: 'Mouvements de terrain', available: true, aleaCode: 'mouvement_terrain' },
  { key: 'ICPE', label: 'INDUSTRIAL', icon: 'factory', hint: 'Installations classées (ICPE)', available: true, aleaCode: 'icpe' },
  { key: 'RADON', label: 'RADON', icon: 'air', hint: 'Potentiel radon', available: true, aleaCode: 'radon' },
  { key: 'CAVITE', label: 'CAVITIES', icon: 'downloading', hint: 'Cavités souterraines', available: true, aleaCode: 'cavite' },
  { key: 'PIPES', label: 'PIPELINES', icon: 'settings_input_component', hint: 'Réseaux et canalisations', available: true, aleaCode: 'canalisations' },
  { key: 'AVALANCHE', label: 'AVALANCHE', icon: 'ac_unit', hint: 'Avalanches', available: true, aleaCode: 'avalanche' },
  { key: 'PPR', label: 'PPR', icon: 'gavel', hint: 'Plan de Prévention des Risques', available: true, aleaCode: 'ppr' },
  { key: 'SSP', label: 'POLLUTED SOILS', icon: 'warning_amber', hint: 'Sites et sols pollués (SSP)', available: true, aleaCode: 'ssp' },
] as const;

/* ── Ensemble : 8 échantillons RÉELS du moteur (4 bandes × 2 avancements de
   l'événement). Aucune probabilité inventée, aucun montant : chaque tuile
   porte la hauteur d'eau de sa bande à cet avancement. ── */
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

export function ScenarioPanel({
  place,
  report,
  scenarioKey,
  onScenarioChange,
  timeMin: _timeMin,
  photo,
  floodAlea = null,
  triFailed = false,
  hazardEvent = 'FLOODING',
  onHazardChange,
  gustPeak = null,
  gustTime = null,
  meteo = null,
}: {
  place: string | null;
  report: RisqueReport | null;
  scenarioKey: string;
  onScenarioChange: (key: string) => void;
  timeMin: number;
  /* Photo terrain RÉELLE du secteur (Panoramax) — null = pas encore chargée ;
     `available: false` = secteur non couvert. */
  photo: SitePhoto | null;
  /* Repère réglementaire TRI complet (Directive Inondation). */
  floodAlea?: FloodAleaResult | null;
  /* SCN-003 — la source TRI a-t-elle ÉCHOUÉ (vs répondu « hors TRI ») ?
     Deux absences distinctes : l'une est un fait, l'autre une panne. */
  triFailed?: boolean;
  /* Type d'aléa actif — état remonté au parent (partagé avec la console). */
  hazardEvent?: string;
  onHazardChange?: (key: string) => void;
  /* Pic de rafales RÉEL de la prévision Open-Meteo (mode vent). */
  gustPeak?: number | null;
  gustTime?: string | null;
  /* Prévision météo RÉELLE du point — alimente les simulations par aléa
     (cône feu, dessiccation RGA). null = pas encore chargée. */
  meteo?: MeteoData | null;
}) {
  const [pickedMember, setPickedMember] = useState<string>('');

  /* ── Liste DÉTERMINISTE d'aléas — pilotée par le diagnostic de l'adresse.
     Les 4 aléas diagnostiqués (feu, RGA, séisme, mvt de terrain) ne sont
     PRÉSENTÉS que si le diagnostic Géorisques trouve CE risque réel à
     l'adresse (present === true). Pas de risque → pas de ligne : on ne
     présente pas un aléa que l'adresse n'a pas.
     Inondation et vent restent listés : ils sont pilotés par des sources
     autres que le référentiel communal (cartographie TRI au point / prévision
     météo horaire du point) et s'affichent honnêtement s'ils ne sont pas
     cartographiés — ils ne prétendent jamais un risque qu'ils ne mesurent pas. */
  const visibleEvents = useMemo(() => {
    const aleaOf = (code: string) => report?.aleas?.find((a) => a.code === code) ?? null;
    return EVENTS.filter((ev) => {
      if (ev.key === 'FLOODING' || ev.key === 'HURRICANE') return true;
      return aleaOf(ev.aleaCode)?.present === true;
    });
  }, [report]);

  /* Si l'aléa affiché vient de disparaître (nouveau diagnostic sans ce
     risque), on retombe sur la première ligne disponible. */
  useEffect(() => {
    if (hazardEvent !== 'FLOODING' && !visibleEvents.some((e) => e.key === hazardEvent)) {
      onHazardChange?.(visibleEvents[0]?.key ?? 'FLOODING');
    }
  }, [hazardEvent, visibleEvents, onHazardChange]);

  /* Hauteur de bâti de référence (m) pour le trait d'eau des vignettes : la
     hauteur BDNB du bâtiment analysé, à défaut le nombre de niveaux × 3 m.
     Inconnue → null, et aucun trait n'est dessiné (cf. waterLinePct). */
  const buildingHeightM = useMemo(() => {
    const b = report?.bdnb?.batiment ?? null;
    if (typeof b?.hauteur_mean === 'number' && b.hauteur_mean > 0) return b.hauteur_mean;
    if (typeof b?.nb_niveau === 'number' && b.nb_niveau > 0) return b.nb_niveau * 3;
    return null;
  }, [report]);

  /* Échantillons : chaque classe TRI à mi-parcours puis au pic de la montée
     (accumulation 50 % → 100 % de la pluie prévue réelle). Une classe non
     cartographiée n'a pas de profondeur : la tuile reste à 0. */
  const ensemble = useMemo(
    () =>
      SCENARIOS.flatMap((s) =>
        ENSEMBLE_ADVANCE.map((adv) => {
          const tileTri = triDepthForScenario(floodAlea, s.key);
          const peak = tileTri ? bandPeakM(tileTri.depth_band!) : null;
          const accum = 0.5 * adv; // mi-parcours = 50 % du cumul, pic = 100 %
          const depthM = typeof peak === 'number' ? peak * (0.05 + 0.95 * accum) : 0;
          return {
            key: `${s.key}-${adv}`,
            advance: adv,
            tone: peak != null && peak >= 1 ? ('high' as const) : ('low' as const),
            depthM,
            linePct: waterLinePct(depthM, buildingHeightM),
          };
        })
      ),
    [floodAlea, buildingHeightM]
  );

  const selected = scenarioFor(scenarioKey);
  /* Provenance du pic d'eau de la sélection courante (classe TRI ou enveloppe
     synthétique) — affichée sous le classement. */
  const selectedTri = triDepthForScenario(floodAlea, scenarioKey);

  /* Pourquoi AUCUNE classe n'est cartographiée — panne, hors TRI, ou dans un
     TRI sans classe au point (trois vérités distinctes, cf. floodAlea). */
  const absence = triAbsenceText(triAbsenceKind(floodAlea, triFailed));
  const triBadge = triProvenanceLabel(selectedTri);

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

      {/* ── Sélecteur d'aléa : liste à icônes (pas un dropdown). L'aléa actif
          est la seule ligne sélectionnable ; les autres sont grisés avec la
          mention « coming soon » tant qu'aucun moteur ne les soutient. ── */}
      <section className="scenario-block" aria-label="Type d'aléa">
        <div className="scenario-block-head">
          <h2 className="scenario-title">Select Scenario</h2>
        </div>
        <div className="scenario-hazards">
          {visibleEvents.map((ev) => {
            const active = ev.available && hazardEvent === ev.key;
            return (
              <button
                type="button"
                key={ev.key}
                className={`scenario-hazard${active ? ' active' : ''}${ev.available ? '' : ' soon'}`}
                onClick={ev.available ? () => onHazardChange?.(ev.key) : undefined}
                disabled={!ev.available}
                aria-pressed={active}
                title={ev.available ? ev.hint : `${ev.hint} — coming soon`}
              >
                <md-icon aria-hidden="true" className="scenario-hazard-ico">
                  {ev.icon}
                </md-icon>
                <span className="scenario-hazard-body">
                  <span className="scenario-hazard-label">{ev.label}</span>
                  <span className="scenario-hazard-hint">{ev.hint}</span>
                </span>
                {!ev.available ? (
                  <span className="scenario-hazard-soon">
                    <md-icon aria-hidden="true">schedule</md-icon>
                    Coming soon
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        {/* Le corps du panneau suit l'aléa actif : vent → repères de rafales
            réelles ; inondation → pic TRI + classement des classes. */}
        {hazardEvent === 'HURRICANE' ? (
          <>
            <span className="scenario-peak">
              Pic de rafales : {gustPeak != null ? `${Math.round(gustPeak)} km/h` : 'prévision indisponible'}
              {gustTime ? ` · à ${gustTime}` : ''}
              {' · '}(prévision réelle Open-Meteo)
            </span>
            <span className="scenario-peak scenario-tri">
              Pas de zone réglementaire vent en métropole — seuils d'effets
              Beaufort/Carpenter : dégâts possibles ≥ 90 km/h
            </span>
            <section className="scenario-block scenario-ranks" aria-label="Seuils de rafales (effets)">
              {[
                { l: '≥ 150 km/h', d: 'Rafales destructrices — dégâts très graves', tone: 'severe' },
                { l: '≥ 120 km/h', d: 'Dégâts importants (toitures, arbres)', tone: 'high' },
                { l: '≥ 90 km/h', d: 'Premiers dégâts possibles', tone: 'moderate' },
                { l: '< 60 km/h', d: 'Vent faible à sensible', tone: 'low' },
              ].map((r) => (
                <span key={r.l} className="scenario-rank unmapped">
                  <span className="scenario-rank-body">
                    <span className="scenario-rank-meta">
                      <span className="scenario-rank-risk">{r.l}</span>
                      <span className="scenario-rank-vals">
                        <span>{r.d}</span>
                      </span>
                    </span>
                  </span>
                </span>
              ))}
            </section>
          </>
        ) : hazardEvent !== 'FLOODING' && hazardEvent !== 'HURRICANE' ? (
          <>
            {(() => {
              const ev = EVENTS.find((e) => e.key === hazardEvent);
              const alea = report?.aleas?.find((a) => a.code === ev?.aleaCode) ?? null;
              /* Le statut ET l'échelle viennent du MÊME module que le rapport
                 (zone/exposure) : panneau et rapport ne peuvent plus afficher
                 deux statuts contradictoires pour le même aléa. */
              const expo = alea ? exposureOf(alea) : null;
              const presentLabel =
                alea == null
                  ? 'diagnostic indisponible'
                  : expo!.level === 'inconnu'
                    ? 'statut inconnu (source indisponible)'
                    : expo!.identified
                      ? `exposé — ${expo!.label}`
                      : 'non exposé au point';
              return (
                <>
                  <span className="scenario-peak">
                    Statut : {presentLabel}
                  </span>
                  {alea?.zonage ? (
                    <span className="scenario-peak scenario-tri">{alea.zonage}</span>
                  ) : null}
                  {expo ? (
                    <span className="scenario-peak scenario-tri">
                      Échelle de la donnée : {expo.resolutionLabel}
                    </span>
                  ) : null}
                  {alea?.erreur ? (
                    <span className="scenario-peak scenario-tri">{alea.erreur}</span>
                  ) : null}
                  {/* ── Simulation de l'aléa — UNIQUEMENT si le diagnostic a
                      trouvé CE risque à l'adresse, et avec ses données réelles.
                      Sinon rien : pas de figure décorative. ── */}
                  {hazardEvent === 'FIRE' && alea?.present === true ? (
                    <HazardFigure
                      title="Cône d'exposition feu (vent réel Open-Meteo)"
                      render={() => <FireConeSvg meteo={meteo} />}
                    />
                  ) : null}
                  {hazardEvent === 'RGA' && alea?.present === true ? (
                    <HazardFigure
                      title="Chronique de dessiccation du sol (0–7 cm, réel)"
                      render={() => <RgaChart meteo={meteo} />}
                    />
                  ) : null}
                  {hazardEvent === 'SEISMIC' && alea?.present === true ? (
                    <HazardFigure
                      title="Accélération de référence agR (décret 2010-1255)"
                      render={() => <SeismicBar zoneSismique={alea.zone_sismique} />}
                    />
                  ) : null}
                  {hazardEvent === 'MVT' && alea?.present === true ? (
                    <span className="scenario-peak scenario-tri">
                      Périmètre PPR mouvement de terrain testé au point — pas de
                      simulation d'étendue : l'emprise réelle est le polygone
                      réglementaire (voir la carte).
                    </span>
                  ) : null}
                </>
              );
            })()}
          </>
        ) : (
          <>
        {/* Pic d'eau : la CLASSE TRI OFFICIELLE de la sélection courante.
            Déterministe : hors TRI, aucune ligne « pic » n'est affichée —
            pas de profondeur inventée, pas de repère fantôme. */}
        {selectedTri ? (
          <>
            <span className="scenario-peak">
              Pic d'eau : {bandPeakM(selectedTri.depth_band!).toFixed(1)} m · {selectedTri.cours_deau ?? 'TRI'}
            </span>
            {triBadge ? (
              <span className="scenario-peak scenario-tri">Repère réglementaire : {triBadge}</span>
            ) : null}
          </>
        ) : null}
          </>
        )}
      </section>

      {/* ── Classes réglementaires TRI (Directive Inondation) — la sélection
          pilote le pic d'eau de la simulation. Chaque rang affiche la CLASSE
          OFFICIELLE cartographiée au point ; déterministe : hors TRI, un seul
          message remplace les 4 rangs vides. ── */}
      <section className="scenario-block scenario-ranks" aria-label="Classes de crue TRI" hidden={hazardEvent !== 'FLOODING'}>
        {/* Déterministe : les rangs TRI ne s'affichent que si le point est
            cartographié (au moins une classe au point). Hors TRI → un seul
            message, pas 4 rangs « non cartographié ». */}
        {(() => {
          const anyMapped = SCENARIOS.some((r) => triDepthForScenario(floodAlea, r.key) != null);
          /* « Most probable » est attribué à la classe la PLUS INTENSE
             réellement cartographiée au point — jamais à un rang fixe : sur
             une adresse où seule « faible » est cartographiée, marquer
             « EXTREME » de ce badge serait un mensonge. */
          const mostKey =
            SCENARIOS.find((r) => triDepthForScenario(floodAlea, r.key) != null)?.key ?? null;
          if (hazardEvent !== 'FLOODING' || anyMapped) {
            return SCENARIOS.map((r) => {
              const tri = triDepthForScenario(floodAlea, r.key);
              const bandLabel = tri?.depth_band?.label ?? null;
              return (
                <button
                  type="button"
                  key={r.key}
                  className={`scenario-rank${scenarioKey === r.key ? ' active' : ''}${tri ? '' : ' unmapped'}`}
                  onClick={() => onScenarioChange(r.key)}
                  aria-pressed={scenarioKey === r.key}
                  /* Une classe NON cartographiée au point n'est pas simulable :
                     le bouton n'est plus cliquable, sinon le clic paraît sans
                     effet (c'était le symptôme « rien ne se passe »). */
                  disabled={!tri}
                  title={
                    tri
                      ? `Simuler la classe officielle ${bandLabel}`
                      : 'Aucune classe cartographiée au point pour ce scénario'
                  }
                >
                  <span className="scenario-rank-body">
                    <span className="scenario-rank-meta">
                      <span className="scenario-rank-risk">{r.risk}</span>
                      <span className="scenario-rank-vals">
                        <span>{bandLabel ? `eau ${bandLabel}` : 'non cartographié'}</span>
                      </span>
                    </span>
                    {tri?.cours_deau ? (
                      <span className="scenario-rank-tri-river">{tri.cours_deau}</span>
                    ) : null}
                  </span>
                  {r.key === mostKey ? (
                    <span className="scenario-rank-most">
                      <md-icon aria-hidden="true">verified</md-icon>
                      Classe la plus élevée au point
                    </span>
                  ) : null}
                </button>
              );
            });
          }
          /* SCN-003 — deux absences différentes, deux messages : « hors TRI »
             est un FAIT réglementaire ; « service indisponible » est un échec
             de source. Les confondre ferait passer une panne pour une absence
             de risque. La formulation est partagée avec la console et le
             rapport (`triAbsenceText`) pour qu'ils ne divergent jamais. */
          return (
            <span
              className="scenario-rank unmapped is-static"
              aria-label={absence.detail}
            >
              <span className="scenario-rank-body">
                <span className="scenario-rank-meta">
                  <span className="scenario-rank-risk">{absence.label}</span>
                  <span className="scenario-rank-vals">
                    <span>{absence.detail}</span>
                  </span>
                </span>
              </span>
            </span>
          );
        })()}
      </section>

      {/* ── Grille des membres de l'ensemble (maquette) — spécifique au mode
          inondation (hauteurs d'eau sur photo terrain). Déterministe : elle
          ne s'affiche que si le point est cartographié TRI et a une photo —
          sinon 8 tuiles à 0,0 m n'ont aucune valeur d'information. ── */}
      <section
        className="scenario-grid-sec"
        aria-label="Scénarios possibles"
        hidden={hazardEvent !== 'FLOODING' || !selectedTri || !(photo?.available && photo.thumb_url)}
      >
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
                  `Bande · avancement ${Math.round(m.advance * 100)} % de l'événement`,
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
                  <b className="scenario-card-id">{m.depthM.toFixed(1)} m</b>
                  <span className="scenario-card-note">eau (modèle)</span>
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

      {/* Scénario actif — résumé d'entrée (débogage/confiance). Déterministe :
          masqué hors TRI (rien de sélectionnable à résumer). */}
      {selectedTri ? (
        <div className="scenario-debug">
          <span>
            <b>{selected.key}</b> · classe TRI {selectedTri.depth_band?.label}
            {selectedTri.cours_deau ? ` · ${selectedTri.cours_deau}` : ''}
          </span>
        </div>
      ) : null}
    </aside>
  );
}
/* ══════════════════════════════════════════════════════════════════════════
   FIGURES DE SIMULATION PAR ALÉA — légères (SVG), réelles, imprimables.
   Chaque composant retourne null sans ses données réelles : aucune figure
   décorative n'est substituée.
   ══════════════════════════════════════════════════════════════════════════ */

function HazardFigure({
  title,
  render,
}: {
  title: string;
  render: () => ReactElement | null;
}) {
  const fig = render();
  if (!fig) return null;
  return (
    <div className="scenario-hazard-fig" role="img" aria-label={title}>
      <span className="scenario-fig-title">{title}</span>
      {fig}
    </div>
  );
}

/** FEU — cône d'exposition : direction = vent RÉEL au pic, longueur =
 *  rafale réelle, ouverture = hypothèse affichée en tooltip. */
function FireConeSvg({ meteo }: { meteo: MeteoData | null }) {
  const cone = fireConeFrom(meteo);
  if (!cone) return null;
  // Le vent vient de `fromDeg` (provenance) → le cône se propage vers
  // l'opposé (vers = fromDeg + 180°).
  const toward = (cone.fromDeg + 180) % 360;
  const rad = ((toward - 90) * Math.PI) / 180; // 0° = nord → x=sin, y=-cos
  const R = 100 * cone.reach;
  const half = (cone.spreadDeg / 2) * (Math.PI / 180);
  const cx = 110;
  const cy = 110;
  const x1 = cx + R * Math.cos(rad - half);
  const y1 = cy + R * Math.sin(rad - half);
  const x2 = cx + R * Math.cos(rad + half);
  const y2 = cy + R * Math.sin(rad + half);
  return (
    <svg viewBox="0 0 220 220" width="100%" height="150">
      {/* Point analysé (bâtiment) */}
      <circle cx={cx} cy={cy} r={5} fill="#4da3ff" />
      {/* Cône d'exposition (hypothèse de propagation affichée) */}
      <path
        d={`M ${cx} ${cy} L ${x1} ${y1} A ${R} ${R} 0 0 1 ${x2} ${y2} Z`}
        fill="rgba(255,120,40,0.28)"
        stroke="#ff7828"
        strokeWidth={1.2}
      >
        <title>{`Vent ${Math.round(cone.gustPeakKmh ?? 0)} km/h · ouverture ${Math.round(cone.spreadDeg)}° (hypothèse)`}</title>
      </path>
      {/* Rose des vents */}
      <text x={cx} y={16} fontSize={9} fill="var(--rp-muted, #9aa7b4)" textAnchor="middle">N</text>
      <text
        x={cx + 92 * Math.sin((toward * Math.PI) / 180)}
        y={cy - 92 * Math.cos((toward * Math.PI) / 180) + 3}
        fontSize={9}
        fill="#ff7828"
        textAnchor="middle"
      >
        propagation
      </text>
    </svg>
  );
}

/** RGA — courbe de dessiccation : humidité du sol RÉELLE 0–7 cm. */
function RgaChart({ meteo }: { meteo: MeteoData | null }) {
  const prof = rgaProfileFrom(meteo);
  if (!prof) return null;
  const W = 220;
  const H = 90;
  const pad = 6;
  const span = prof.max - prof.min || 1;
  const pts = prof.moisture
    .map((v, i) => {
      const x = pad + (i / (prof.moisture.length - 1)) * (W - 2 * pad);
      const y = H - pad - ((v - prof.min) / span) * (H - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="90">
      <polyline
        points={pts}
        fill="none"
        stroke="#c98b4b"
        strokeWidth={1.8}
      >
        <title>{`Humidité du sol réelle : ${prof.min.toFixed(3)} – ${prof.max.toFixed(3)} m³/m³`}</title>
      </polyline>
      <text x={pad} y={H - 1} fontSize={7} fill="var(--rp-muted, #9aa7b4)">
        {prof.hours[0]}
      </text>
      <text x={W - pad} y={H - 1} fontSize={7} fill="var(--rp-muted, #9aa7b4)" textAnchor="end">
        {prof.hours[prof.hours.length - 1]}
      </text>
      <text x={W / 2} y={10} fontSize={8} fill="var(--rp-muted, #9aa7b4)" textAnchor="middle">
        {`amplitude ${(prof.swing * 100).toFixed(0)} % · m³/m³`}
      </text>
    </svg>
  );
}

/** SÉISMICITÉ — jauge agR : la VALEUR RÉGLEMENTAIRE, pas une simulation. */
function SeismicBar({
  zoneSismique,
}: {
  zoneSismique: string | null | undefined;
}) {
  const zone = Number(zoneSismique);
  const prof = seismicFrom(zone);
  if (!prof) return null;
  return (
    <svg viewBox="0 0 220 56" width="100%" height="56">
      {[1, 2, 3, 4, 5].map((z) => {
        const x = 10 + (z - 1) * 41;
        const active = z <= prof.zone;
        return (
          <g key={z}>
            <rect
              x={x}
              y={14}
              width={36}
              height={18}
              rx={3}
              fill={
                active
                  ? `rgba(255,${180 - z * 30},60,${0.25 + z * 0.15})`
                  : 'rgba(255,255,255,0.06)'
              }
              stroke={z === prof.zone ? '#ffb43c' : 'rgba(255,255,255,0.15)'}
              strokeWidth={z === prof.zone ? 1.6 : 1}
            />
            <text x={x + 18} y={27} fontSize={9} textAnchor="middle" fill="var(--rp-muted, #9aa7b4)">
              {z}
            </text>
          </g>
        );
      })}
      <text x={110} y={48} fontSize={9} textAnchor="middle" fill="var(--rp-muted, #9aa7b4)">
        {`Zone ${prof.zone} · agR = ${prof.agr} m/s² (décret)`}
      </text>
    </svg>
  );
}
