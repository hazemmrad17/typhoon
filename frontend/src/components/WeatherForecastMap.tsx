// =============================================================================
//   TYPHOON — WeatherForecastMap : carte des prévisions météo
//
//   Remplace UnifiedMap dans l'onglet « État climatique » pour afficher
//   les prévisions météo sur une carte interactive :
//   - Marqueurs colorés par jour avec indicateur de risque
//   - Overlay de température / vent / précipitations
//   - Sélecteur de variable (température, vent, pluie, humidité)
// =============================================================================

import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { API, type ClimateData } from '../zone/config';

/* ── Config ── */
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || '';
const DEFAULT_ZOOM = 6;

/* ── Color scales for weather variables ── */
const TEMP_COLORS = [
  { max: 0, color: '#3A7A6C' },    // freezing
  { max: 10, color: '#4A9A8C' },   // cold
  { max: 20, color: '#D4AC3E' },   // mild
  { max: 30, color: '#D07030' },   // warm
  { max: 40, color: '#C04030' },   // hot
  { max: 50, color: '#B03020' },   // extreme
];

const WIND_COLORS = [
  { max: 20, color: '#3A7A6C' },   // light
  { max: 40, color: '#D4AC3E' },   // moderate
  { max: 60, color: '#D07030' },   // strong
  { max: 80, color: '#C04030' },   // very strong
  { max: 120, color: '#B03020' },  // storm
];

const PRECIP_COLORS = [
  { max: 1, color: '#3A7A6C' },    // dry
  { max: 5, color: '#4A9A8C' },    // light
  { max: 15, color: '#D4AC3E' },   // moderate
  { max: 30, color: '#D07030' },   // heavy
  { max: 50, color: '#C04030' },   // very heavy
  { max: 100, color: '#B03020' },  // extreme
];

function getColorForValue(value: number, scale: { max: number; color: string }[]): string {
  for (const { max, color } of scale) {
    if (value <= max) return color;
  }
  return scale[scale.length - 1].color;
}

/* ── Variable selector ── */
type WeatherVariable = 'temperature' | 'wind' | 'precipitation' | 'fire';

const VARIABLE_CONFIG: Record<WeatherVariable, { label: string; icon: string; unit: string; colors: { max: number; color: string }[] }> = {
  temperature: { label: 'Température', icon: 'thermostat', unit: '°C', colors: TEMP_COLORS },
  wind: { label: 'Vent', icon: 'air', unit: 'km/h', colors: WIND_COLORS },
  precipitation: { label: 'Précipitations', icon: 'water_drop', unit: 'mm', colors: PRECIP_COLORS },
  fire: { label: 'Incendie', icon: 'local_fire_department', unit: 'FWI', colors: TEMP_COLORS },
};

/* ── Extract forecast data for a variable ── */
function extractForecastValues(data: ClimateData, variable: WeatherVariable): { date: string; value: number }[] {
  switch (variable) {
    case 'temperature':
      if (!data.heat_stress) return [];
      return data.heat_stress.forecast_16day.map((f) => ({ date: f.date, value: f.temp_max }));
    case 'wind':
      if (!data.wind_risk) return [];
      return data.wind_risk.forecast_16day.map((f) => ({ date: f.date, value: f.speed }));
    case 'precipitation':
      if (!data.flood) return [];
      return data.flood.forecast_30day.slice(0, 16).map((f) => ({ date: f.date, value: f.discharge_m3s }));
    case 'fire':
      if (!data.fire_danger) return [];
      return data.fire_danger.forecast_16day.map((f) => ({ date: f.date, value: f.fwi }));
    default:
      return [];
  }
}

/* ── Component ── */

interface WeatherForecastMapProps {
  lat: number;
  lon: number;
  data?: ClimateData | null;
}

export function WeatherForecastMap({ lat, lon, data: propData }: WeatherForecastMapProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const markers = useRef<mapboxgl.Marker[]>([]);
  const [selectedVariable, setSelectedVariable] = useState<WeatherVariable>('temperature');
  const [data, setData] = useState<ClimateData | null>(propData ?? null);

  // Fetch climate data if not provided as prop
  useEffect(() => {
    if (propData) {
      setData(propData);
      return;
    }
    let cancelled = false;
    fetch(`${API}/api/climate?lat=${lat}&lon=${lon}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setData(d);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [lat, lon, propData]);

  // Initialize map
  useEffect(() => {
    if (!mapContainer.current || !MAPBOX_TOKEN) return;

    mapboxgl.accessToken = MAPBOX_TOKEN;
    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: [lon, lat],
      zoom: DEFAULT_ZOOM,
    });

    map.current.addControl(new mapboxgl.NavigationControl(), 'top-right');

    return () => {
      map.current?.remove();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Update map center when coordinates change
  useEffect(() => {
    if (map.current) {
      map.current.flyTo({ center: [lon, lat], zoom: 10, duration: 1000 });
    }
  }, [lat, lon]);

  // Update markers when data or variable changes
  useEffect(() => {
    const mapInstance = map.current;
    if (!mapInstance || !data) return;

    // Clear existing markers
    markers.current.forEach((m) => m.remove());
    markers.current = [];

    const forecastValues = extractForecastValues(data, selectedVariable);
    const config = VARIABLE_CONFIG[selectedVariable];

    if (forecastValues.length === 0) return;

    // Add location marker (center)
    const centerEl = document.createElement('div');
    centerEl.className = 'weather-marker-center';
    centerEl.innerHTML = `
      <div style="
        width: 20px; height: 20px;
        background: var(--md-sys-color-primary, #6750A4);
        border: 3px solid white;
        border-radius: 50%;
        box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      "></div>
    `;

    const centerPopup = new mapboxgl.Popup({ offset: 25, closeButton: false }).setHTML(`
      <div style="padding: 8px; font-family: sans-serif; font-size: 13px;">
        <strong>Position analysée</strong><br/>
        ${lat.toFixed(4)}°N, ${lon.toFixed(4)}°E
      </div>
    `);

    const centerMarker = new mapboxgl.Marker({ element: centerEl })
      .setLngLat([lon, lat])
      .setPopup(centerPopup)
      .addTo(mapInstance);
    markers.current.push(centerMarker);

    // Add forecast markers in a circle around the location
    const radius = 0.02; // ~2km radius
    forecastValues.forEach((fv, i) => {
      const angle = (i / forecastValues.length) * 2 * Math.PI;
      const markerLon = lon + radius * Math.cos(angle);
      const markerLat = lat + radius * Math.sin(angle);

      const value = fv.value;
      const color = getColorForValue(value, config.colors);

      const el = document.createElement('div');
      el.className = 'weather-marker';
      el.innerHTML = `
        <div style="
          width: 14px; height: 14px;
          background: ${color};
          border: 2px solid white;
          border-radius: 50%;
          box-shadow: 0 1px 4px rgba(0,0,0,0.3);
          cursor: pointer;
          transition: transform 0.15s;
        " onmouseover="this.style.transform='scale(1.4)'" onmouseout="this.style.transform='scale(1)'"></div>
      `;

      const date = new Date(fv.date);
      const dayName = date.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });

      const popup = new mapboxgl.Popup({ offset: 15, closeButton: false }).setHTML(`
        <div style="padding: 8px; font-family: sans-serif; font-size: 13px;">
          <strong>${dayName}</strong><br/>
          ${config.label} : <strong>${value.toFixed(1)} ${config.unit}</strong>
        </div>
      `);

      const marker = new mapboxgl.Marker({ element: el })
        .setLngLat([markerLon, markerLat])
        .setPopup(popup)
        .addTo(mapInstance);

      markers.current.push(marker);
    });
  }, [data, selectedVariable, lat, lon]);

  return (
    <div className="weather-map-container">
      {/* Variable selector */}
      <div className="weather-var-selector">
        {(Object.keys(VARIABLE_CONFIG) as WeatherVariable[]).map((v) => (
          <button
            key={v}
            type="button"
            className={`weather-var-btn${selectedVariable === v ? ' active' : ''}`}
            onClick={() => setSelectedVariable(v)}
          >
            <md-icon style={{ fontSize: 16 }}>{VARIABLE_CONFIG[v].icon}</md-icon>
            {VARIABLE_CONFIG[v].label}
          </button>
        ))}
      </div>

      {/* Map */}
      <div ref={mapContainer} className="weather-map-canvas" />

      {/* Legend */}
      <div className="weather-legend">
        <span className="weather-legend-title">{VARIABLE_CONFIG[selectedVariable].label}</span>
        <div className="weather-legend-scale">
          {VARIABLE_CONFIG[selectedVariable].colors.map((c, i) => (
            <div key={i} className="weather-legend-item">
              <div className="weather-legend-color" style={{ background: c.color }} />
              <span>{c.max} {VARIABLE_CONFIG[selectedVariable].unit}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Source info */}
      {data && (
        <div className="weather-map-source">
          <md-icon style={{ fontSize: 14 }}>info</md-icon>
          <span>Prévisions 16 jours · {data.metadata.elapsed_ms}ms</span>
        </div>
      )}
    </div>
  );
}
