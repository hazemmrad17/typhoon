import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

/* ══════════════════════════════════════════════════════════════════════════
   CONSOLE MÉTÉO / CRUES — rangée basse façon Fuselab
     · .flood-console          : enveloppe invisible (positionnement seul) ;
     · .flood-console-main     : panneau principal (timeline + 4 cartes) ;
     · .flood-console-side     : le toggle FLOOD (md-switch) à droite.
   La timeline (moitié haute) est un SCRUBBER fait maison en Material :     · à gauche, le champ de période (md-outlined-text-field en lecture
       seule + bascule calendrier) qui ouvre un calendrier flottant;
       · au centre, la commande lecture/pause;
       · à droite, une piste pleine largeur avec graduations, repères horaires
       (00:00 → 24:00), une aiguille et une capsule de temps qui indique
       l'heure courante — interaction clic/glisser, clavier et lecture auto.
   Elle n'est montée QU'AVEC une carte métrique active : c'est elle qui date la
   couche que la carte affiche sur la planète. Sans carte allumée il n'y a rien
   à dater, donc pas d'échelle. Si l'adresse est retirée alors qu'une carte
   restait active, elle reste montée mais INERTE (.is-locked : grisée, pointeur
   coupé, lecture désactivée) — sans texte d'explication à l'écran, l'infobulle
   des commandes désactivées suffit.

   Lecture : la commande avance l'heure par pas de 30 min et reboucle sur la
   journée. Ce n'est pas une animation décorative — chaque pas appelle
   onTimeChange(), donc le timestamp de l'overlay météo réel (Windy) de la
   carte suit le défilement. La barre « lit » les graduations à hauteur de
   l'aiguille dans le même mouvement.

   Ce qui n'est PAS repris du bandeau de l'étape 2 : l'histogramme de pluie
   (mm/h) et les valeurs en mm de la capsule comme des repères. Le projet n'a
   aucune source pluviométrique horaire — Open-Meteo a été retiré (constitution
   §2) — et les barres d'origine venaient d'une enveloppe de scénario
   synthétique, pas d'une mesure. Inventer ces barres reproduirait exactement
   le décalage avec le réel que ce composant doit éviter : tant qu'il n'y a pas
   de série horaire réelle, la piste reste une règle horaire, sans mm.

   Les valeurs des 4 cartes métriques restent, elles, des constantes de
   maquette (durcies) — signalé séparément, hors de ce composant.
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
  onTimeChange,
  locked = false,
  active = true,
  floodMapping = false,
  onFloodMappingChange,
}: {
  /** Carte métrique active (temp/wind/pressure/rainfall) — pilotée depuis
   *  Zone.tsx pour relayer la couche météo à la carte. */
  selectedMetric?: string;
  onMetricChange?: (key: string) => void;
  /** Index de l'heure de prévision (time-aware) remonté à Zone.tsx :
   *  offset en HEURES depuis maintenant (jour du calendrier × 24 + heure du
   *  curseur), pour pointer le timestamp de l'overlay météo (Windy). */
  onTimeChange?: (hourOffset: number) => void;
  /** true = aucune adresse diagnostiquée : la timeline (période + lecture +
   *  curseur) reste affichée mais grisée et inerte, et les 4 cartes sont
   *  désactivées sous un indice invitant à saisir une adresse. */
  locked?: boolean;
  /** false = la console n'est plus à l'écran (étape ≥ 2, où elle est
   *  escamotée mais restée montée). La lecture s'arrête alors : sans cela la
   *  commande continuerait d'avancer l'heure 5 fois par seconde dans une
   *  console invisible, en re-datant l'overlay Windy pendant que
   *  l'utilisateur lit la bande de faits. */
  active?: boolean;
  /** Toggle Flood Mapping (contrôlé) — bascule la couche inondation
   *  Géorisques (WMS LIMITETRI) sur la carte via visibleLayerKeys. */
  floodMapping?: boolean;
  onFloodMappingChange?: (v: boolean) => void;
}) {
  /* Aide au survol uniquement : plus de chip « Entrez d'abord une adresse »
     posée sur la console. Elle reste en infobulle des commandes désactivées. */
  const LOCK_HINT = "Entrez d'abord une adresse pour activer la météo";

  /* Période (date range) — défaut calé sur la fenêtre de prévision météo
     (10 jours à partir d'aujourd'hui). */
  const defaultRange = (): Range => {
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const end = new Date(start);
    end.setDate(start.getDate() + 9);
    return { start, end };
  };
  const [range, setRange] = useState<Range>(defaultRange);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [draft, setDraft] = useState<Range | null>(null);
  const [view, setView] = useState(() => new Date());
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLElement | null>(null);

  /* Heure du jour du curseur (0 → 1440 min). Défaut 3:15 = minute 195. */
  const [timeMin, setTimeMin] = useState(195);
  /* Lecture automatique de la journée. Démarre en pause : rien ne bouge sans
     un geste explicite de l'utilisateur. */
  const [playing, setPlaying] = useState(false);
  const scaleRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  /* ── La timeline est la commande de temps de l'OVERLAY MÉTÉO ──
     Elle n'a donc de sens qu'avec une carte active : c'est la carte qui
     décide quelle couche est affichée sur la carte, et la timeline qui date
     cette couche. Pas de carte allumée → aucune couche à dater → aucune
     timeline (cliquer une carte l'ouvre, recliquer la même la referme). */
  const timelineVisible = !!selectedMetric;

  /* ── Lecture : avance de 30 min par tick, reboucle à minuit ──
     Le pas de 30 min est celui du clavier (flèches), donc la lecture et le
     clavier déplacent l'aiguille exactement de la même façon. Chaque tick
     passe par timeMin, donc l'effet de synchronisation ci-dessus rejoue et
     le timestamp de l'overlay météo suit.
     Aucune lecture sans commande visible : pas d'adresse (verrouillé), pas à
     l'étape 1, ou pas de carte active → l'échelle n'a rien à dater. */
  useEffect(() => {
    if (!playing || locked || !active || !timelineVisible) return;
    const id = window.setInterval(() => {
      setTimeMin((m) => (m + 30) % DAY_MIN);
    }, 180);
    return () => window.clearInterval(id);
  }, [playing, locked, active, timelineVisible]);

  /* Couper la lecture quand la commande disparaît (verrouillage, changement
     d'étape, carte éteinte) : l'état ne doit pas rester « en lecture » dans un
     instrument qu'on ne voit plus, en re-datant l'overlay dans le vide. */
  useEffect(() => {
    if (locked || !active || !timelineVisible) setPlaying(false);
  }, [locked, active, timelineVisible]);

  /* Time-aware : remonte l'offset horaire total (jour sélectionné + heure du
     curseur) quand le curseur OU le calendrier change, pour re-pointer le
     timestamp de l'overlay météo (Windy) sur la carte. */
  useEffect(() => {
    const dayOffset = Math.max(
      0,
      Math.round((range.start.getTime() - new Date().setHours(0, 0, 0, 0)) / 86_400_000)
    );
    onTimeChange?.(dayOffset * 24 + Math.floor(timeMin / 60));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeMin, range.start]);

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
    if (locked) return; // verrouillé tant qu'aucune adresse n'est diagnostiquée
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
    if (locked) return; // verrouillé tant qu'aucune adresse n'est diagnostiquée
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
          {/* Timeline montée seulement avec une carte active : elle date la
              couche que la carte affiche. Grisée et inerte si l'adresse a été
              retirée alors qu'une carte restait allumée (.is-locked). */}
          {timelineVisible && (
          <div className={`flood-timeline${locked ? ' is-locked' : ''}`}>
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

            {/* Commande lecture/pause — reprise du bandeau de l'étape 2.
                Elle anime l'heure, donc l'overlay météo réel de la carte. */}
            <button
              type="button"
              className={`flood-play${playing ? ' playing' : ''}`}
              disabled={locked}
              aria-label={playing ? 'Mettre la lecture en pause' : 'Lire la journée'}
              aria-pressed={playing}
              title={
                locked
                  ? LOCK_HINT
                  : playing
                    ? 'Pause'
                    : 'Défiler la journée (l\'heure de l\'overlay météo suit)'
              }
              onClick={() => setPlaying((p) => !p)}
            >
              <md-icon aria-hidden="true">{playing ? 'pause' : 'play_arrow'}</md-icon>
            </button>

            {/* Piste : règle horaire pleine largeur + repères + capsule */}
            <div
              className="flood-scale"
              ref={scaleRef}
              role="slider"
              aria-label="Heure de la journée"
              aria-valuemin={0}
              aria-valuemax={DAY_MIN}
              aria-valuenow={timeMin}
              aria-valuetext={fmtMin(timeMin)}
              aria-disabled={locked || undefined}
              /* Verrouillée : sortie du parcours clavier. `pointer-events: none`
                 ne coupe que la souris — sans cela, la piste resterait
                 atteignable au Tab et se laisserait flécher inutilement. */
              tabIndex={locked ? -1 : 0}
              onKeyDown={(e) => {
                if (locked) return; // verrouillé tant qu'aucune adresse n'est diagnostiquée
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
          )}

          {/* Moitié inférieure : les 4 cartes métriques. Avant toute adresse
              (locked) elles sont grisées et désactivées, sans pavé d'explication
              flottant : l'état est déjà porté par les cartes éteintes, par le
              champ d'adresse vide et par le cadenas de l'étape. Le texte d'aide
              reste accessible en infobulle sur chaque commande désactivée. */}
          <div className={`flood-cards-row${locked ? ' is-locked' : ''}`}>
            {/* Un seul clic suffit : carte inactive → sélectionnée ; carte
                active → coupée (métrique vide → applyWeatherLayer éteint
                l'overlay météo). Même sémantique que les toggles œil du
                panneau aléas — plus de double-clic à découvrir. */}
            {METRICS.map((m) => (
              <button
                key={m.key}
                type="button"
                disabled={locked}
                className={`flood-card${selectedMetric === m.key ? ' active' : ''}${locked ? ' flood-card--locked' : ''}`}
                aria-pressed={selectedMetric === m.key}
                title={
                  locked
                    ? LOCK_HINT
                    : selectedMetric === m.key
                      ? `Désactiver ${m.label}`
                      : `Afficher ${m.label}`
                }
                onClick={() => onMetricChange?.(selectedMetric === m.key ? '' : m.key)}
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

        {/* Toggle FLOOD (md-switch pivoté à 90°) à droite */}
        <div className="flood-console-side">
          <label className="flood-switch">
            <span className="flood-switch-rail">
              <md-switch
                selected={floodMapping}
                aria-label="Flood Mapping"
                onChange={() => onFloodMappingChange?.(!floodMapping)}
              />
            </span>
            <span className={`flood-switch-label${floodMapping ? ' on' : ''}`}>
              Flood Mapping
            </span>
          </label>
        </div>
      </div>
    </>
  );
}
