import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { RisqueReport } from '../zone/config';
import { INFRA_THRESHOLD_M, impactState } from '../zone/impactModel';
import {
  curveIsHypothesis,
  rainProfileFrom,
  scenarioDepthAt,
  type RainProfile,
} from '../zone/floodSim';
import type { MeteoData } from '../zone/hydroRoute';
import {
  gustAt,
  gustBand,
  type GustProfile,
} from '../zone/windSim';

/* ══════════════════════════════════════════════════════════════════════════
   TYPHOON — /zone : CONSOLE DE SIMULATION DE CRUE (données réelles)
   Rangée basse du mode risk-open :
     · .risk-console-status   : hauteur d'eau à l'instant t (pluie réelle ×
                                classe TRI) + références réelles ;
     · .risk-console-timeline : lecture/pause + règle temporelle de la journée
                                avec l'HISTOGRAMME DE PLUIE RÉELLE Open-Meteo
                                (l'axe qui pilote la montée des eaux).

   Règle d'honnêteté : sans prévision horaire réelle ou sans classe TRI au
   point, la console affiche explicitement l'indisponibilité — elle n'invente
   ni profil de pluie ni profondeur.
══════════════════════════════════════════════════════════════════════════ */

/* Minute de la journée affichée (0 → 1440). Défaut : 3 h 15. */
const DAY_MIN = 24 * 60;
const fmtMin = (m: number) => {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};

/* Vitesses de lecture proposées (cycle 1× → 4× → 16×). */
const RATES = [1, 4, 16];

/* Repères horaires : toutes les 3 h de 00:00 à 24:00 (9 repères). */
const HOUR_MARKS = Array.from({ length: 9 }, (_, i) => i * 3 * 60);

/* Piste façon règle : segments par heure (rectangles fins). */
const TRACK_SEGMENTS = Array.from({ length: 24 }, (_, i) => i);

/** Libellé d'heure de prévision (« 14h ») → minute de la journée (840).
 *  `null` si le libellé n'est pas exploitable : on ne devine pas une heure. */
const hourLabelToMin = (label: string | null | undefined): number | null => {
  if (!label) return null;
  const n = Number.parseInt(label, 10);
  return Number.isFinite(n) ? n * 60 : null;
};

export function RiskConsole({
  report: _report,
  timeMin,
  onTimeChange,
  meteo,
  triPeak = null,
  triLabel = null,
  triAbsenceLabel = null,
  hazardEvent = 'FLOODING',
  gustProfile = null,
  windBand = null,
}: {
  place?: string | null;
  report: RisqueReport | null;
  /* Heure du curseur (0 → 1440 min) — état partagé (pilote la carte). */
  timeMin: number;
  onTimeChange: (m: number | ((prev: number) => number)) => void;
  /* Prévision RÉELLE (Open-Meteo, GloFAS) : l'axe ET la référence. */
  meteo: MeteoData | null;
  /* Pic d'eau de la CLASSE TRI officielle (null = hors TRI → pas de simulation). */
  triPeak?: number | null;
  triLabel?: string | null;
  /* Formulation partagée de l'absence de classe quand AUCUNE classe n'est
     cartographiée au point (panne / dans un TRI sans classe / hors TRI) —
     fournie par le parent, pour que la console ne se contredise pas avec le
     panneau des scénarios. `null` = une autre classe existe : la console dit
     alors « non cartographié POUR CE SCÉNARIO », une vérité locale. */
  triAbsenceLabel?: string | null;
  /* Type d'aléa actif (FLOODING | HURRICANE) — partagé avec le panneau. */
  hazardEvent?: string;
  gustProfile?: GustProfile | null;
  windBand?: { key: string; label: string; color: string } | null;
}) {
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const scaleRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  /* Profil de pluie RÉEL — la colonne vertébrale de la simulation. */
  const profile: RainProfile | null = useMemo(() => rainProfileFrom(meteo), [meteo]);

  /* Heure du curseur → index horaire du profil (0..23). */
  const hourIndex = timeMin / 60;

  /* Profondeur à l'instant t : le SCÉNARIO fixe le pic (classe TRI officielle),
     la pluie prévue n'en fixe que la forme. Sans pluie, la console continue
     d'afficher le niveau du scénario via une rampe documentée. */
  const depth = useMemo(
    () => scenarioDepthAt(profile, hourIndex, triPeak),
    [profile, hourIndex, triPeak]
  );
  /* La courbe est-elle une hypothèse (aucune prévision ne la pilote) ? */
  const curveHypothesis = curveIsHypothesis(profile);
  const impact = useMemo(
    () => impactState(depth, triPeak ?? 0),
    [depth, triPeak]
  );

  const isWind = hazardEvent === 'HURRICANE';
  const windNow = isWind ? gustAt(gustProfile, timeMin / 60) : 0;
  const wBand = isWind ? windBand ?? gustBand(windNow) : null;

  /* Une simulation existe dès qu'un PIC est disponible : classe TRI en crue,
     prévision de rafales en vent. Elle ne dépend plus de la pluie du jour —
     c'était la cause du bouton « Play » grisé par temps sec. */
  const hasSim = isWind
    ? !!gustProfile
    : typeof triPeak === 'number' && triPeak > 0;

  const stats = useMemo(
    () =>
      isWind
        ? [
            {
              key: 'wind',
              icon: 'storm',
              value: gustProfile ? String(Math.round(windNow)) : '—',
              unit: gustProfile ? 'km/h' : '',
              label: 'Rafale prévue (réelle)',
              color: wBand?.color ?? '#4da3ff',
              band: !gustProfile
                ? 'Prévision de vent indisponible'
                : `Seuils documentés · ${wBand?.label ?? '—'}`,
            } as const,
          ]
        : [
            {
              key: 'water',
              icon: 'water',
              value: hasSim ? impact.depthM.toFixed(2) : '—',
              unit: hasSim ? 'm' : '',
              label: 'Hauteur d\u2019eau (simulation)',
              color: impact.band.color,
              band: !hasSim
                ? 'Simulation indisponible — aucune classe TRI cartographiée au point'
                : curveHypothesis
                  ? `Classe officielle ${impact.band.label} · montée : hypothèse (aucune pluie prévue)`
                  : impact.overThreshold
                    ? `Enveloppe carte · ${impact.band.label} · montée pilotée par la pluie prévue`
                    : `Sous le seuil (${INFRA_THRESHOLD_M.toFixed(1).replace('.', ',')} m) · montée pilotée par la pluie prévue`,
            } as const,
          ],
    [isWind, gustProfile, windNow, wBand, impact, hasSim, curveHypothesis]
  );

  const rain = profile;
  const discharge = meteo?.discharge ?? null;

  /* Message de repli quand AUCUNE classe n'est cartographiée POUR LE SCÉNARIO
     SÉLECTIONNÉ — distinct de « service indisponible », et sans nier les
     classes qui existent au point pour d'autres scénarios. */
  const triFallback =
    typeof triPeak === 'number' && triPeak > 0
      ? 'classe en cours de chargement'
      : 'non cartographié pour ce scénario';

  const wxCards = useMemo(() => {
    const rainCard = rain
      ? {
          key: 'rain',
          icon: 'water_drop',
          line1: 'Pluie prévue (réelle)',
          line2: `${rain.totalMm.toFixed(0)} mm / 24 h · pic ${rain.peakMmH.toFixed(0)} mm/h à ${rain.hours[rain.peakIndex]}`,
          title: meteo?.sources?.rain ?? 'Open-Meteo',
        }
      : {
          key: 'rain',
          icon: 'water_drop',
          line1: 'Pluie prévue',
          line2: 'aucune pluie prévue — montée du scénario non pilotée par la pluie',
          title: meteo?.sources?.rain ?? 'Open-Meteo',
        } as const;

    const riverCard = discharge
      ? {
          key: 'river',
          icon: 'waves',
          line1: 'Débit rivière (GloFAS)',
          line2:
            discharge.current != null
              ? `${discharge.current.toFixed(1)} ${discharge.unit}${discharge.peak != null ? ` · pic ${discharge.peak.toFixed(1)}` : ''}`
              : 'série indisponible',
          title: meteo?.sources?.discharge ?? 'Copernicus GloFAS',
        }
      : {
          key: 'river',
          icon: 'waves',
          line1: 'Débit rivière',
          line2: meteo?.unavailable_label ?? 'référence indisponible',
          title: 'Copernicus GloFAS',
        };

    return [
      rainCard,
      riverCard,
      {
        key: 'tri',
        icon: 'fact_check',
        line1: 'Classe TRI (Directive Inondation)',
        /* Deux absences distinctes, deux messages : « non cartographié pour ce
           scénario » (une autre classe peut exister au point) vs « service
           indisponible ». Dire « point non cartographié » alors qu'une classe
           est cartographiée pour un autre scénario était faux. */
        line2: triLabel ?? triAbsenceLabel ?? triFallback,
        title: 'Repère réglementaire du pic d\u2019eau',
      },
    ];
  },    [rain, discharge, meteo, triLabel, triAbsenceLabel, triFallback]
  );

  /* SCN-011 — « Play scenario » : la lecture part de minuit et déroule la
     journée jusqu'au PIC de la prévision RÉELLE (pluie en mode crue, rafale en
     mode vent) — pas de boucle infinie : le moteur s'arrête sur le pic, s'y
     tient 2 s, puis se met en pause. Sans simulation, le bouton est inactif. */
  const peakMin = useMemo(() => {
    if (isWind) {
      return gustProfile ? hourLabelToMin(gustProfile.hours[gustProfile.peakIndex]) : null;
    }
    if (profile) return hourLabelToMin(profile.hours[profile.peakIndex]);
    /* Aucune prévision de pluie : la rampe documentée culmine à 24 h — sans
       quoi « Play » n'aurait aucune cible et resterait sans effet. */
    return typeof triPeak === 'number' && triPeak > 0 ? DAY_MIN : null;
  }, [isWind, gustProfile, profile, triPeak]);

  const holdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!playing) return;
    if (peakMin == null) {
      /* Pas de pic réel (prévision vide) : rien à dérouler. */
      setPlaying(false);
      return;
    }
    const id = window.setInterval(() => {
      onTimeChange((m) => {
        const next = m + 15;
        if (next >= peakMin) {
          window.clearInterval(id);
          holdRef.current = window.setTimeout(() => setPlaying(false), 2000);
          return peakMin;
        }
        return next;
      });
    }, Math.round(700 / rate));
    return () => {
      window.clearInterval(id);
      if (holdRef.current) window.clearTimeout(holdRef.current);
    };
    /* peakMin est calculé en minutes ; l'effet ne doit PAS redémarrer quand
       l'intervalle modifie l'heure courante (sinon la lecture se réarme). */
  }, [playing, rate, peakMin, onTimeChange]);

  /* Bascule lecture/pause : repart de minuit si le curseur est déjà au-delà du
     pic (sinon « Play » ne produirait aucun mouvement). */
  const togglePlay = () => {
    if (!hasSim) return;
    if (playing) {
      setPlaying(false);
      return;
    }
    if (peakMin != null && timeMin >= peakMin) onTimeChange(0);
    setPlaying(true);
  };

  /* ── Scrubber : pointer → minute de la journée ── */
  const minuteFromClientX = (clientX: number) => {
    const el = scaleRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    onTimeChange(Math.round((f * DAY_MIN) / 5) * 5);
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    minuteFromClientX(e.clientX);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (draggingRef.current) minuteFromClientX(e.clientX);
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const pct = (timeMin / DAY_MIN) * 100;

  /* Histogramme : pluie RÉELLE (mode crue) ou rafales RÉELLES (mode vent). */
  const hourBars = useMemo(() => {
    if (isWind) {
      const arr = gustProfile?.gust ?? [];
      const maxG = gustProfile?.peakKmh ?? 0;
      return Array.from({ length: 24 }, (_, i) => {
        const v = arr[i] ?? 0;
        return { v, h: maxG > 0 ? 4 + (v / maxG) * 96 : 2 };
      });
    }
    const rainArr = profile?.rain ?? [];
    const maxRain = profile?.peakMmH ?? 0;
    return Array.from({ length: 24 }, (_, i) => {
      const v = rainArr[i] ?? 0;
      return { v, h: maxRain > 0 ? 4 + (v / maxRain) * 96 : 2 };
    });
  }, [isWind, gustProfile, profile]);

  const unitAt = (m: number) => {
    if (isWind) {
      if (!gustProfile) return null;
      return `${Math.round(gustAt(gustProfile, m / 60))} km/h`;
    }
    if (!profile) return null;
    const i = Math.max(0, Math.min(profile.rain.length - 1, Math.floor(m / 60)));
    return `${profile.rain[i]} mm`;
  };
  const unitName = isWind ? 'km/h' : 'mm';

  return (
    <div className="risk-console" aria-label="Simulation des risques de la zone">
      {/* ── Bande de suivi : compteur d'eau (réel × TRI) + références ── */}
      <div className="risk-console-status">
        <div className="risk-console-stats">
          {stats.map((s) => (
            <div
              className="risk-console-stat"
              key={s.key}
              style={{ '--risk-c': s.color } as CSSProperties}
              title={s.label}
            >
              <span className="risk-console-stat-ico" aria-hidden="true">
                <md-icon>{s.icon}</md-icon>
              </span>
              <span className="risk-console-stat-text">
                <span className="risk-console-stat-val">
                  {s.value}
                  {s.unit ? <i className="risk-console-stat-unit">{s.unit}</i> : null}
                </span>
                <span className="risk-console-stat-label">{s.label}</span>
                {s.band ? (
                  <span className="risk-console-stat-band">
                    <i aria-hidden="true" />
                    {s.band}
                  </span>
                ) : null}
              </span>
            </div>
          ))}
        </div>

        <span className="risk-console-divider" aria-hidden="true" />

        <div className="risk-console-wx">
          {wxCards.map((w) => (
            <div className="risk-console-wx-card" key={w.key} title={w.title}>
              <span className="risk-console-wx-ico" aria-hidden="true">
                <md-icon>{w.icon}</md-icon>
              </span>
              <span className="risk-console-wx-text">
                <span className="risk-console-wx-line">{w.line1}</span>
                <span className="risk-console-wx-sub">{w.line2}</span>
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Règle temporelle : lecture/pause + scrubber sur la pluie réelle ── */}
      <div className="risk-console-timeline">
        <button
          type="button"
          className={`risk-console-play${playing ? ' playing' : ''}`}
          aria-label={playing ? 'Pause' : 'Lecture de la simulation'}
          title={
            !hasSim
              ? 'Simulation indisponible (prévision ou classe TRI manquante)'
              : playing
                ? 'Pause'
                : 'Lire la simulation jusqu\u2019au pic prévu'
          }
          disabled={!hasSim}
          onClick={togglePlay}
        >
          <md-icon aria-hidden="true">{playing ? 'pause' : 'play_arrow'}</md-icon>
        </button>

        <button
          type="button"
          className="risk-console-rate"
          aria-label={`Vitesse de lecture ×${rate}`}
          title="Vitesse de lecture"
          onClick={() => setRate((r) => RATES[(RATES.indexOf(r) + 1) % RATES.length])}
        >
          ×{rate}
        </button>

        <div
          className="risk-console-scale"
          ref={scaleRef}
          role="slider"
          aria-label="Heure de la journée"
          aria-valuemin={0}
          aria-valuemax={DAY_MIN}
          aria-valuenow={timeMin}
          aria-valuetext={`${fmtMin(timeMin)}${unitAt(timeMin) != null ? `, ${unitAt(timeMin)} ${isWind ? 'de rafale prévue' : 'de pluie prévue'}` : ''}`}
          tabIndex={0}
          title={isWind ? 'Piste : rafales horaires PRÉVUES (Open-Meteo)' : "Piste : pluie horaire PRÉVUE (Open-Meteo) — l'axe qui pilote la montée des eaux"}
          onKeyDown={(e) => {
            const step =
              e.key === 'ArrowRight' || e.key === 'ArrowUp'
                ? 30
                : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
                  ? -30
                  : 0;
            if (step) {
              e.preventDefault();
              onTimeChange((m) => Math.min(DAY_MIN, Math.max(0, m + step)));
            }
          }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          {/* Barres d'intensité : pluie RÉELLE par heure */}
          <div className="risk-console-bars" aria-hidden="true">
            {TRACK_SEGMENTS.map((i) => {
              const lit = (i + 0.5) / TRACK_SEGMENTS.length <= pct / 100;
              const b = hourBars[i];
              return (
                <span
                  key={i}
                  className={`risk-console-bar${lit ? ' lit' : ''}`}
                  style={{ height: `${Math.min(100, b.h)}%` }}
                />
              );
            })}
          </div>

          <span className="risk-console-progress" style={{ width: `${pct}%` }} aria-hidden="true" />

          <span className="risk-console-needle" style={{ left: `${pct}%` }} aria-hidden="true" />          <span className="risk-console-capsule"
            style={{
              left: `${Math.min(97, Math.max(3, pct))}%`,
              transform: 'translateX(-50%)',
            }}
          >
            <b>{fmtMin(timeMin)}</b>
            <i>{unitAt(timeMin) ?? `— ${unitName}`}</i>
          </span>

          <div className="risk-console-marks" aria-hidden="true">
            {HOUR_MARKS.map((m) => (
              <span className="risk-console-mark" key={m}>
                <span className="risk-console-mark-time">{fmtMin(m)}</span>
                <span className="risk-console-mark-mm">
                  {unitAt(m) ?? '—'}
                </span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
