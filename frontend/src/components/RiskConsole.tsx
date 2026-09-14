import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { RisqueReport } from '../zone/config';
import {
  MAX_RAIN,
  computeDamage,
  exposureFromReport,
  scenarioFor,
  timeProfileAt,
} from '../zone/damageModel';
import { INFRA_THRESHOLD_M, impactAt } from '../zone/impactModel';
import type { MeteoData } from '../zone/hydroRoute';

/* ══════════════════════════════════════════════════════════════════════════
   TYPHOON — /zone : CONSOLE D'ÉVALUATION DES RISQUES (mode « étape suivante »)
   Rangée basse du mode risk-open :
     · .risk-console-status   : bande de suivi — trois compteurs RECALCULÉS
                                depuis la même estimation que le panneau
                                gauche (aucune valeur de démonstration) ;
     · .risk-console-timeline : lecture/pause + règle temporelle de la journée
                                avec repères heure + pluie (mm) de l'ENVELOPPE
                                DE SCÉNARIO (l'axe qui pilote le moteur de
                                dommages) ; une aiguille + une capsule
                                (heure · mm) marquent le curseur. Ce panneau
                                n'est atteignable qu'avec une adresse
                                diagnostiquée (le stepper bloque l'étape 2).

   Trois natures de faits, jamais confondues :
     · MODÈLE    — les compteurs et la piste de pluie (scénario × instant t) ;
     · RÉFÉRENCE — pluie prévue (Open-Meteo) et débit estimé (GloFAS), affichés
                   À CÔTÉ, jamais fusionnés avec le modèle.
══════════════════════════════════════════════════════════════════════════ */

/* Minute de la journée affichée (0 → 1440). Défaut : 3 h 15 (console du haut). */
const DAY_MIN = 24 * 60;
const fmtMin = (m: number) => {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};

/* Pluie horaire de l'ENVELOPPE DE SCÉNARIO (mm) — axe partagé avec le moteur
   de dommages : la console pilote l'instant t, le panneau gauche recale ses
   estimations sur ce même profil. */
const mmAt = (m: number) => timeProfileAt(m / 60).rain;

/* Vitesses de lecture proposées. À 1× la journée défile en ~67 s (15 min par
   pas de 700 ms) — bien trop lent pour lire une montée des eaux ; à 16× la
   fenêtre d'événement se lit en quelques secondes. */
const RATES = [1, 4, 16];

/* Repères horaires : toutes les 3 h de 00:00 à 24:00 (9 repères). */
const HOUR_MARKS = Array.from({ length: 9 }, (_, i) => i * 3 * 60);

/* Piste façon règle : segments par heure (rectangles fins). */
const TRACK_SEGMENTS = Array.from({ length: 24 }, (_, i) => i);

const fmtInt = (v: number) => Math.round(v).toLocaleString('fr-FR');

/** Pluie prévue sur les prochaines 24 h + heure du pic (référence réelle). */
function forecastRain(meteo: MeteoData | null) {
  const series = (meteo?.rain_hourly ?? []).filter((p) => p.v != null).slice(0, 24);
  if (series.length === 0) return null;
  const values = series.map((p) => p.v as number);
  const peak = Math.max(...values);
  const peakIdx = values.indexOf(peak);
  const total = meteo?.rain_total_mm ?? values.reduce((a, b) => a + b, 0);
  return { total, peak, peakTime: series[peakIdx]?.t ?? null, dry: !!meteo?.dry };
}

const hourLabel = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : `${String(d.getHours()).padStart(2, '0')}h`;
};

export function RiskConsole({
  report,
  scenarioKey,
  timeMin,
  onTimeChange,
  meteo,
}: {
  place?: string | null;
  report: RisqueReport | null;
  /* Scénario sélectionné (panneau droit) → bande d'intensité du modèle. */
  scenarioKey: string;
  /* Heure du curseur (0 → 1440 min) — état partagé (pilote le moteur). */
  timeMin: number;
  onTimeChange: (m: number | ((prev: number) => number)) => void;
  /* Référence météo/hydrologique réelle (Open-Meteo, GloFAS) — jamais fusionnée
     avec l'enveloppe de scénario. */
  meteo: MeteoData | null;
}) {
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const scaleRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  /* Même moteur que le panneau gauche : exposition BDNB × scénario × instant t.
     Les trois compteurs ci-dessous en sont donc directement dérivés. */
  const exposure = useMemo(() => exposureFromReport(report), [report]);
  const time = timeProfileAt(timeMin / 60);
  const scenario = scenarioFor(scenarioKey);
  const est = useMemo(
    () => computeDamage(exposure, scenario, time),
    [exposure, scenario, time]
  );

  /* Même enveloppe que celle peinte sur la carte (bande de couleur comprise) :
     un seul calcul pilote le volume d'eau de la vue et ce compteur. Le seuil
     d'infrastructure du moteur (0,3 m) est une frontière — en dessous, il ne
     compte aucun dommage, donc la carte ne peint rien : le compteur le dit. */
  const impact = useMemo(() => impactAt(scenario, time.accum), [scenario, time]);

  const stats = useMemo(
    () => [
      {
        key: 'water',
        icon: 'water',
        value: impact.depthM.toFixed(2),
        unit: 'm',
        label: 'Hauteur d\u2019eau (scénario)',
        color: impact.band.color,
        band: impact.overThreshold
          ? `Enveloppe carte · ${impact.band.label}`
          : `Sous le seuil du moteur (${INFRA_THRESHOLD_M.toFixed(1).replace('.', ',')} m)`,
      },
      {
        key: 'buildings',
        icon: 'home',
        value: fmtInt(est.damagedBuildings.v),
        unit: '',
        label: 'Bâtiments touchés',
        color: '#ff3b30',
        band: '',
      },
      {
        key: 'roads',
        icon: 'road',
        value: fmtInt(est.damagedRoadsM.v),
        unit: 'm',
        label: 'Voirie inondée',
        color: '#f0c33c',
        band: '',
      },
    ],
    [est, impact]
  );

  const rain = useMemo(() => forecastRain(meteo), [meteo]);
  const discharge = meteo?.discharge ?? null;

  /* Cartes de référence : réelles quand le service répond, sinon repli explicite
     sur l'enveloppe du scénario (jamais une valeur de démonstration figée). */
  const wxCards = useMemo(() => {
    const rainCard = rain
      ? {
          key: 'rain',
          icon: 'water_drop',
          line1: 'Pluie prévue',
          line2: rain.dry
            ? 'aucune pluie prévue'
            : `${rain.total.toFixed(0)} mm / 24 h · pic ${rain.peak.toFixed(0)} mm/h${rain.peakTime ? ` ${hourLabel(rain.peakTime)}` : ''}`,
          title: meteo?.sources?.rain ?? 'Open-Meteo',
        }
      : {
          key: 'rain',
          icon: 'water_drop',
          line1: 'Pluie (scénario)',
          line2: `pic ${MAX_RAIN} mm/h — enveloppe modélisée`,
          title: 'Modèle (Open-Meteo indisponible)',
        };

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
        key: 'wind',
        icon: 'air',
        line1: 'Vent (scénario)',
        line2: `${Math.round(scenario.windPeakKmh)} km/h — bande ${scenario.pct} %`,
        title: 'Modèle : bande de scénario sélectionnée',
      },
    ];
  }, [rain, discharge, meteo, scenario]);

  /* Lecture auto : déroule la journée (pas de 15 min, boucle à 00:00) au
     rythme choisi. La cadence pilote l'instant t du moteur de dommages, donc
     la montée des eaux sur la carte suit directement cette vitesse. */
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      onTimeChange((m) => (m + 15 >= DAY_MIN ? 0 : m + 15));
    }, Math.round(700 / rate));
    return () => window.clearInterval(id);
  }, [playing, rate, onTimeChange]);

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

  const hourBars = useMemo(
    () =>
      Array.from({ length: 24 }, (_, i) => {
        const v = timeProfileAt(i).rain;
        return { v, h: 10 + (v / MAX_RAIN) * 100 };
      }),
    []
  );

  return (
    <div className="risk-console" aria-label="Simulation des risques de la zone">
      {/* ── Bande de suivi : compteurs dérivés de l'estimation + référence ── */}
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

      {/* ── Règle temporelle : lecture/pause + scrubber ── */}
      <div className="risk-console-timeline">
        <button
          type="button"
          className={`risk-console-play${playing ? ' playing' : ''}`}
          aria-label={playing ? 'Pause' : 'Lecture de la simulation'}
          title={playing ? 'Pause' : 'Lire la simulation'}
          onClick={() => setPlaying((v) => !v)}
        >
          <md-icon aria-hidden="true">{playing ? 'pause' : 'play_arrow'}</md-icon>
        </button>

        {/* Vitesse de lecture (cycle 1× → 4× → 16×). */}
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
          aria-valuetext={`${fmtMin(timeMin)}, ${mmAt(timeMin)} mm (enveloppe de scénario)`}
          tabIndex={0}
          title="Piste : enveloppe de pluie du scénario (axe qui pilote le moteur de dommages)"
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
          {/* Barres d'intensité (mm/h) du scénario — histogramme de la piste */}
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

          {/* Partie parcourue : lueur d'alerte */}
          <span className="risk-console-progress" style={{ width: `${pct}%` }} aria-hidden="true" />

          {/* Aiguille + capsule (heure · mm) à la position courante */}
          <span className="risk-console-needle" style={{ left: `${pct}%` }} aria-hidden="true" />
          <span
            className="risk-console-capsule"
            style={{
              left: `${Math.min(97, Math.max(3, pct))}%`,
              transform: 'translateX(-50%)',
            }}
          >
            <b>{fmtMin(timeMin)}</b>
            <i>{mmAt(timeMin)} mm</i>
          </span>

          {/* Repères horaires sous la piste : heure + pluie du scénario (mm) */}
          <div className="risk-console-marks" aria-hidden="true">
            {HOUR_MARKS.map((m) => (
              <span className="risk-console-mark" key={m}>
                <span className="risk-console-mark-time">{fmtMin(m)}</span>
                <span className="risk-console-mark-mm">{mmAt(m)} mm</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
