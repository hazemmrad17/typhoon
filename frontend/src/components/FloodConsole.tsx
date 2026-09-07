import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

/* ══════════════════════════════════════════════════════════════════════════
   CONSOLE MÉTÉO / CRUES — rangée basse façon Fuselab
     · .flood-console          : enveloppe invisible (positionnement seul) ;
     · .flood-console-main     : panneau principal (timeline + 4 cartes) ;
     · .flood-console-side     : les 2 toggles FLOOD (md-switch) à droite.
   La timeline (moitié haute) est un SCRUBBER fait maison en Material :
     · à gauche, le champ de période (md-outlined-text-field en lecture
       seule + bascule calendrier) qui ouvre un calendrier flottant ;
     · à droite, une piste pleine largeur avec blocs colorés, repères
       horaires (00:00 → 24:00), une aiguille rouge et une capsule de temps
       qui indique l'heure courante — interaction clic/glisser + clavier.
   Les valeurs météo sont des données de démonstration issues de la maquette.
══════════════════════════════════════════════════════════════════════════ */

const METRICS = [
  { key: 'temp', label: 'Temperature', value: '18', unit: '°C', icon: 'device_thermostat' },
  { key: 'wind', label: 'Wind', value: '24', unit: 'm/sec', icon: 'air' },
  { key: 'pressure', label: 'Atm. pressure', value: '1013.20', unit: 'hPa', icon: 'speed' },
  { key: 'rainfall', label: 'Rainfall', value: '5.33', unit: 'mm', icon: 'water_drop' },
] as const;

const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const WEEKDAYS_FR = ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];

const toKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth()).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const fmtRange = (start: Date, end: Date | null) => {
  if (!end || toKey(start) === toKey(end)) {
    return `${start.getDate()} ${MONTHS_FR[start.getMonth()]}`;
  }
  const s = `${start.getDate()} ${MONTHS_FR[start.getMonth()]}`;
  const e = `${end.getDate()} ${MONTHS_FR[end.getMonth()]}`;
  return start.getFullYear() === end.getFullYear() ? `${s} – ${e}` : `${s} ${start.getFullYear()} – ${e} ${end.getFullYear()}`;
};

type Range = { start: Date; end: Date | null };

/* Minute de la journée affichée (0 → 1440). Défaut : 3 h 15 (maquette). */
const DAY_MIN = 24 * 60;
const fmtMin = (m: number) => {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};

/* Repères horaires : toutes les 3 h de 00:00 à 24:00 (9 repères, comme la
   maquette Fuselab qui affiche 9 marqueurs d'heures sur la piste). */
const HOUR_MARKS = Array.from({ length: 9 }, (_, i) => i * 3 * 60); // 0..1440 pas de 3 h

/* Piste façon règle : segments clairs (rectangles blancs) séparés par de
   fins interstices — remplis plus tard avec l'intensité horaire réelle. */
const TRACK_SEGMENTS = Array.from({ length: 24 }, (_, i) => i);

export function FloodConsole({
  selectedMetric = 'wind',
  onMetricChange,
}: {
  /** Carte métrique active (temp/wind/pressure/rainfall) — pilotée depuis
   *  Zone.tsx pour relayer « Wind » à la carte (particules de vent). */
  selectedMetric?: string;
  onMetricChange?: (key: string) => void;
}) {
  const [floodMapping, setFloodMapping] = useState(true);
  const [floodForecast, setFloodForecast] = useState(false);

  /* Période (date range) — défaut aligné sur la maquette (6 → 10 août). */
  const [range, setRange] = useState<Range>({ start: new Date(2026, 7, 6), end: new Date(2026, 7, 10) });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [draft, setDraft] = useState<Range | null>(null);
  const [view, setView] = useState(() => new Date(2026, 7, 1));
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLElement | null>(null);

  /* Heure du jour du curseur (0 → 1440 min). Défaut 3:15 = minute 195. */
  const [timeMin, setTimeMin] = useState(195);
  const scaleRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  /* Ferme le calendrier au clic hors du picker (ou Échap). */
  const closePicker = () => setPickerOpen(false);

  /* Ouvre le calendrier AU-DESSUS du champ et le limite à l'espace libre
     disponible (jamais coupé en haut de l'écran). */
  useEffect(() => {
    if (!pickerOpen) return;
    const pop = pickerRef.current;
    const field = fieldRef.current;
    if (pop && field) {
      const gap = 10;
      const maxH = Math.max(180, field.getBoundingClientRect().top - gap);
      pop.style.maxHeight = `${maxH}px`;
      pop.style.overflowY = 'auto';
    }
  }, [pickerOpen]);

  useEffect(() => {
    if (!pickerOpen) return;
    const inside = (e: MouseEvent | TouchEvent) => {
      const path = (e as MouseEvent & { composedPath?: () => EventTarget[] }).composedPath?.() ?? [];
      return (
        pickerRef.current?.contains(e.target as Node) ||
        fieldRef.current?.contains(e.target as Node) ||
        path.includes(pickerRef.current as EventTarget) ||
        path.includes(fieldRef.current as EventTarget)
      );
    };
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (inside(e)) return;
      closePicker();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePicker();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  const cells = useMemo(() => {
    const y = view.getFullYear();
    const m = view.getMonth();
    const offset = (new Date(y, m, 1).getDay() + 6) % 7; // lundi = 0
    const dim = new Date(y, m + 1, 0).getDate();
    const arr: (Date | null)[] = [];
    for (let i = 0; i < offset; i += 1) arr.push(null);
    for (let d = 1; d <= dim; d += 1) arr.push(new Date(y, m, d));
    return arr;
  }, [view]);

  const openPicker = () => {
    setDraft(range);
    setView(new Date(range.start.getFullYear(), range.start.getMonth(), 1));
    setPickerOpen(true);
  };

  const onDayClick = (d: Date) => {
    setDraft((prev) => {
      if (!prev || !prev.start || (prev.start && prev.end)) return { start: d, end: null };
      return d < prev.start ? { start: d, end: null } : { start: prev.start, end: d };
    });
  };

  const confirmRange = () => {
    if (draft?.start) setRange({ start: draft.start, end: draft.end ?? draft.start });
    setPickerOpen(false);
  };

  /* ── Scrubber : pointer → minute de la journée ── */
  const minuteFromClientX = (clientX: number) => {
    const el = scaleRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    setTimeMin(Math.round((f * DAY_MIN) / 5) * 5);
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

  return (
    <>
      {/* ═══ Conteneur invisible : enveloppe de la console ═══ */}
      <div className="flood-console">
        {/* Panneau principal : timeline (date + scrubber) / cartes */}
        <div className="flood-console-main">
          <div className="flood-timeline">
            {/* Sélecteur de période (date range) — champ Material en lecture
                seule + bascule calendrier, façon matDatepickerToggle. */}
            <div className="flood-date">
              <md-outlined-text-field
                ref={fieldRef}
                className="flood-date-field"
                value={fmtRange(range.start, range.end)}
                label="Période"
                readonly
                aria-haspopup="dialog"
                aria-expanded={pickerOpen}
                onClick={openPicker}
              >
                <md-icon-button
                  slot="end"
                  class="flood-date-toggle"
                  aria-label="Ouvrir le calendrier"
                  title="Choisir une période"
                  onClick={(e: React.MouseEvent) => {
                    e.stopPropagation();
                    openPicker();
                  }}
                >
                  <md-icon>calendar_month</md-icon>
                </md-icon-button>
                <span slot="supporting-text">JJ/MM/AAAA</span>
              </md-outlined-text-field>

              {/* Calendrier flottant (à la place du md-dialog) */}
              {pickerOpen && (
                <div className="flood-calendar-pop" ref={pickerRef} role="dialog" aria-label="Sélectionner une période">
                  <div className="flood-cal-header">
                    <md-icon-button
                      aria-label="Mois précédent"
                      onClick={() => setView((v) => new Date(v.getFullYear(), v.getMonth() - 1, 1))}
                    >
                      <md-icon>chevron_left</md-icon>
                    </md-icon-button>
                    <span className="flood-cal-title">
                      {MONTHS_FR[view.getMonth()]} {view.getFullYear()}
                    </span>
                    <md-icon-button
                      aria-label="Mois suivant"
                      onClick={() => setView((v) => new Date(v.getFullYear(), v.getMonth() + 1, 1))}
                    >
                      <md-icon>chevron_right</md-icon>
                    </md-icon-button>
                  </div>
                  <div className="flood-cal-weekdays" aria-hidden="true">
                    {WEEKDAYS_FR.map((w) => (
                      <span key={w}>{w}</span>
                    ))}
                  </div>
                  <div className="flood-cal-grid" role="grid" aria-label="Calendrier">
                    {cells.map((d, i) => {
                      if (!d) return <span key={`x${i}`} aria-hidden="true" />;
                      const key = toKey(d);
                      const isEdge =
                        !!draft?.start && (key === toKey(draft.start) || (!!draft.end && key === toKey(draft.end)));
                      const inRange =
                        !!draft?.start && !!draft.end && key > toKey(draft.start) && key < toKey(draft.end);
                      const cls = `flood-cal-day${isEdge ? ' range-edge' : ''}${inRange ? ' in-range' : ''}`;
                      return (
                        <button
                          key={key}
                          type="button"
                          role="gridcell"
                          className={cls}
                          aria-pressed={isEdge}
                          onClick={() => onDayClick(d)}
                        >
                          {d.getDate()}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flood-cal-actions">
                    <md-text-button onClick={closePicker}>Annuler</md-text-button>
                    <md-text-button onClick={confirmRange}>OK</md-text-button>
                  </div>
                </div>
              )}
            </div>

            {/* Scrubber Fuselab : piste pleine largeur + repères + capsule */}
            <div
              className="flood-scale"
              ref={scaleRef}
              role="slider"
              aria-label="Heure de la journée"
              aria-valuemin={0}
              aria-valuemax={DAY_MIN}
              aria-valuenow={timeMin}
              aria-valuetext={fmtMin(timeMin)}
              tabIndex={0}
              onKeyDown={(e) => {
                const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 30 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -30 : 0;
                if (step) {
                  e.preventDefault();
                  setTimeMin((m) => Math.min(DAY_MIN, Math.max(0, m + step)));
                }
              }}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
            >
              {/* Graduations façon règle (traits blancs verticaux sur une base) */}
              <div className="flood-scale-blocks" aria-hidden="true">
                {TRACK_SEGMENTS.map((i) => {
                  const x = (i / (TRACK_SEGMENTS.length - 1)) * 100;
                  const lit = i / (TRACK_SEGMENTS.length - 1) <= pct / 100;
                  return (
                    <span
                      key={i}
                      className="flood-ruler-tick"
                      style={{
                        left: `${x}%`,
                        height: i % 4 === 0 ? 13 : 8, // trait long toutes les 4 h
                        opacity: lit ? 1 : 0.28,
                      }}
                    />
                  );
                })}
              </div>

              {/* Aiguille rouge + capsule de temps à la position courante */}
              <span className="flood-scale-needle" style={{ left: `${pct}%` }} aria-hidden="true" />
              <span
                className="flood-scale-capsule"
                style={{
                  left: `${Math.min(97, Math.max(3, pct))}%`,
                  transform: 'translateX(-50%)',
                }}
              >
                {fmtMin(timeMin)}
              </span>

              {/* Repères horaires sous la piste */}
              <div className="flood-scale-marks" aria-hidden="true">
                {HOUR_MARKS.map((m) => (
                  <span key={m}>{fmtMin(m)}</span>
                ))}
              </div>
            </div>
          </div>

          {/* Moitié inférieure : les 4 cartes métriques */}
          <div className="flood-cards-row">
            {METRICS.map((m) => (
              <button
                key={m.key}
                type="button"
                className={`flood-card${selectedMetric === m.key ? ' active' : ''}`}
                aria-pressed={selectedMetric === m.key}
                onClick={() => onMetricChange?.(m.key)}
              >
                <span className="flood-card-icon" aria-hidden="true">
                  <md-icon>{m.icon}</md-icon>
                </span>
                <span className="flood-card-text">
                  <span className="flood-card-value">
                    {m.value}
                    <small>{m.unit}</small>
                  </span>
                  <span className="flood-card-label">{m.label}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Les 2 toggles FLOOD (md-switch pivotés à 90°) à droite */}
        <div className="flood-console-side">
          <label className="flood-switch">
            <span className="flood-switch-rail">
              <md-switch
                selected={floodMapping}
                aria-label="Flood Mapping"
                onChange={() => setFloodMapping((v) => !v)}
              />
            </span>
            <span className={`flood-switch-label${floodMapping ? ' on' : ''}`}>
              Flood Mapping
            </span>
          </label>
          <label className="flood-switch">
            <span className="flood-switch-rail">
              <md-switch
                selected={floodForecast}
                aria-label="Flood Forecast"
                onChange={() => setFloodForecast((v) => !v)}
              />
            </span>
            <span className={`flood-switch-label${floodForecast ? ' on' : ''}`}>
              Flood Forecast
            </span>
          </label>
        </div>
      </div>
    </>
  );
}
