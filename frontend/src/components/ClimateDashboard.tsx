// =============================================================================
//   TYPHOON — ClimateDashboard : tableau de bord climatique opérationnel
//
//   Affiche les données climatiques en temps réel pour une coordonnée :
//   - Inondation (GloFAS v4) : débit rivière, périodes retour, prévisions 30j
//   - Incendie (FWI) : indice danger feu, prévisions 7j
//   - Humidité du sol (ERA5-Land) : surveillance subsidence
//
//   Layout : 3 risk status cards + 3 Recharts charts
//   Design : Google Material Web (md-*) + M3 tokens
// =============================================================================

import { useState, useEffect, useMemo } from 'react';
import {
  Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
  ComposedChart,
} from 'recharts';
import { API, type ClimateData, type FloodRisk, type FireDanger, type SoilMoisture, type HeatStress, type WindRisk, type SeasonalForecast } from '../zone/config';

/* ── Helpers ── */

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()}/${d.getMonth() + 1}`;
}



/* ── Risk Status Cards ── */

function RiskCard({
  icon,
  title,
  level,
  color,
  value,
  subtitle,
  onClick,
}: {
  icon: string;
  title: string;
  level: string;
  color: string;
  value: string;
  subtitle?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className="cd-card"
      onClick={onClick}
      style={{ '--cd-accent': color } as React.CSSProperties}
    >
      <div className="cd-card-icon">
        <md-icon style={{ color }}>{icon}</md-icon>
      </div>
      <div className="cd-card-body">
        <span className="cd-card-title">{title}</span>
        <span className="cd-card-value" style={{ color }}>{value}</span>
        <span className="cd-card-level" style={{ color }}>{level}</span>
        {subtitle && <span className="cd-card-sub">{subtitle}</span>}
      </div>
    </button>
  );
}

/* ── Flood Chart ── */

function FloodChart({ data }: { data: FloodRisk }) {
  const chartData = useMemo(() => {
    const base: { name: string; discharge: number; type: string }[] = [
      { name: 'Min', discharge: data.min_discharge_m3s, type: 'hist' },
      { name: 'Moy', discharge: data.mean_discharge_m3s, type: 'hist' },
      { name: 'Actuel', discharge: data.current_discharge_m3s ?? 0, type: 'current' },
      { name: 'Max', discharge: data.max_discharge_m3s, type: 'hist' },
    ];
    data.forecast_30day.forEach((f) => {
      base.push({
        name: formatShortDate(f.date),
        discharge: f.discharge_m3s,
        type: 'forecast',
      });
    });
    return base;
  }, [data]);



  return (
    <div className="cd-chart-wrap">
      <h4 className="cd-chart-title">
        <md-icon>water</md-icon>
        Débit rivière — {data.source}
      </h4>
      <div className="cd-chart-meta">
        <span className="cd-chart-meta-item">
          Période retour : <strong>{data.return_period}</strong>
        </span>
        <span className="cd-chart-meta-item">
          Percentile : <strong>{data.percentile}%</strong>
        </span>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--md-sys-color-outline-variant)" />
          <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--md-sys-color-on-surface-variant)' }} />
          <YAxis tick={{ fontSize: 11, fill: 'var(--md-sys-color-on-surface-variant)' }} unit=" m³/s" />
          <Tooltip
            contentStyle={{
              background: 'var(--md-sys-color-surface-container-high)',
              border: '1px solid var(--md-sys-color-outline-variant)',
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          <ReferenceLine y={data.mean_discharge_m3s} stroke="var(--md-sys-color-outline)" strokeDasharray="4 4" label={{ value: 'Moyenne', position: 'right', fontSize: 10 }} />
          <Area
            type="monotone"
            dataKey="discharge"
            stroke="var(--md-sys-color-primary)"
            fill="var(--md-sys-color-primary)"
            fillOpacity={0.15}
            strokeWidth={2}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ── Fire Danger Chart ── */

function FireChart({ data }: { data: FireDanger }) {
  const chartData = useMemo(() => {
    const today = { name: 'Auj.', fwi: data.current_fwi, fill: data.risk_color };
    const forecast = data.forecast_16day.map((f) => ({
      name: formatShortDate(f.date),
      fwi: f.fwi,
      fill: f.color,
    }));
    return [today, ...forecast];
  }, [data]);

  return (
    <div className="cd-chart-wrap">
      <h4 className="cd-chart-title">
        <md-icon>local_fire_department</md-icon>
        Danger incendie — {data.source}
      </h4>
      <div className="cd-chart-meta">
        <span className="cd-chart-meta-item">
          FWI 92j : <strong>{data.avg_fwi_92d}</strong> (moy.)
        </span>
        <span className="cd-chart-meta-item">
          Max 92j : <strong>{data.max_fwi_92d}</strong>
        </span>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--md-sys-color-outline-variant)" />
          <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--md-sys-color-on-surface-variant)' }} />
          <YAxis tick={{ fontSize: 11, fill: 'var(--md-sys-color-on-surface-variant)' }} />
          <Tooltip
            contentStyle={{
              background: 'var(--md-sys-color-surface-container-high)',
              border: '1px solid var(--md-sys-color-outline-variant)',
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          <Bar dataKey="fwi" radius={[4, 4, 0, 0]}>
            {chartData.map((entry, i) => (
              <rect key={i} fill={entry.fill} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ── Soil Moisture Chart ── */

function SoilMoistureChart({ data }: { data: SoilMoisture }) {
  const chartData = useMemo(() => {
    return (data.monthly_series || []).map((m) => ({
      name: formatShortDate(m.date),
      value: m.value,
    }));
  }, [data]);

  return (
    <div className="cd-chart-wrap">
      <h4 className="cd-chart-title">
        <md-icon>grass</md-icon>
        Humidité du sol — {data.source}
      </h4>
      <div className="cd-chart-meta">
        <span className="cd-chart-meta-item">
          Actuel : <strong>{data.current_value.toFixed(3)} {data.unit}</strong>
        </span>
        <span className="cd-chart-meta-item">
          Moy. 30j : <strong>{data.avg_value_30d?.toFixed(3) ?? '—'}</strong>
        </span>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--md-sys-color-outline-variant)" />
          <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--md-sys-color-on-surface-variant)' }} />
          <YAxis tick={{ fontSize: 11, fill: 'var(--md-sys-color-on-surface-variant)' }} unit=" m³/m³" />
          <Tooltip
            contentStyle={{
              background: 'var(--md-sys-color-surface-container-high)',
              border: '1px solid var(--md-sys-color-outline-variant)',
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          <ReferenceLine y={0.12} stroke="#D07030" strokeDasharray="4 4" label={{ value: 'Seuil élevé', position: 'right', fontSize: 10 }} />
          <Area
            type="monotone"
            dataKey="value"
            stroke="#3A7A6C"
            fill="#3A7A6C"
            fillOpacity={0.15}
            strokeWidth={2}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ── Seasonal Forecast Chart ── */

function SeasonalForecastChart({ data }: { data: SeasonalForecast }) {
  const chartData = useMemo(() => {
    return data.months.map((m) => ({
      name: `${m.month_name}\n${m.month}`,
      temp: m.avg_temp,
      precip: m.total_precip,
    }));
  }, [data]);

  return (
    <div className="cd-chart-wrap">
      <h4 className="cd-chart-title">
        <md-icon>wb_sunny</md-icon>
        Prévisions saisonnières — {data.source}
      </h4>
      <div className="cd-chart-meta">
        <span className="cd-chart-meta-item">
          {data.ensemble_members} membres ensemble
        </span>
        <span className="cd-chart-meta-item">
          Temp. moy. : <strong>{data.temp_range.avg ?? '—'}°C</strong>
        </span>
        <span className="cd-chart-meta-item">
          Précip. totales : <strong>{data.precip_range.total ?? '—'} mm</strong>
        </span>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--md-sys-color-outline-variant)" />
          <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'var(--md-sys-color-on-surface-variant)' }} />
          <YAxis yAxisId="temp" tick={{ fontSize: 11, fill: 'var(--md-sys-color-on-surface-variant)' }} unit="°C" />
          <YAxis yAxisId="precip" orientation="right" tick={{ fontSize: 11, fill: 'var(--md-sys-color-on-surface-variant)' }} unit=" mm" />
          <Tooltip
            contentStyle={{
              background: 'var(--md-sys-color-surface-container-high)',
              border: '1px solid var(--md-sys-color-outline-variant)',
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          <Bar yAxisId="precip" dataKey="precip" fill="#3A7A6C" fillOpacity={0.3} radius={[4, 4, 0, 0]} />
          <Area yAxisId="temp" type="monotone" dataKey="temp" stroke="#D07030" fill="#D07030" fillOpacity={0.1} strokeWidth={2} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ── Heat Stress Chart ── */

function HeatStressChart({ data }: { data: HeatStress }) {
  const chartData = useMemo(() => {
    const today = { name: 'Auj.', hi: data.current_hi, fill: data.risk_color };
    const forecast = data.forecast_16day.map((f) => ({
      name: formatShortDate(f.date),
      hi: f.hi,
      fill: f.color,
    }));
    return [today, ...forecast];
  }, [data]);

  return (
    <div className="cd-chart-wrap">
      <h4 className="cd-chart-title">
        <md-icon>thermostat</md-icon>
        Indice chaleur — {data.source}
      </h4>
      <div className="cd-chart-meta">
        <span className="cd-chart-meta-item">
          Max 92j : <strong>{data.max_hi_92d}°C</strong>
        </span>
        <span className="cd-chart-meta-item">
          Jours {'>'}32°C : <strong>{data.hot_days_92d}</strong>
        </span>
        <span className="cd-chart-meta-item">
          Jours {'>'}40°C : <strong>{data.danger_days_92d}</strong>
        </span>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--md-sys-color-outline-variant)" />
          <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--md-sys-color-on-surface-variant)' }} />
          <YAxis tick={{ fontSize: 11, fill: 'var(--md-sys-color-on-surface-variant)' }} unit="°C" />
          <Tooltip
            contentStyle={{
              background: 'var(--md-sys-color-surface-container-high)',
              border: '1px solid var(--md-sys-color-outline-variant)',
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          <ReferenceLine y={32} stroke="#D07030" strokeDasharray="4 4" label={{ value: '32°C', position: 'right', fontSize: 10 }} />
          <ReferenceLine y={40} stroke="#B03020" strokeDasharray="4 4" label={{ value: '40°C', position: 'right', fontSize: 10 }} />
          <Bar dataKey="hi" radius={[4, 4, 0, 0]}>
            {chartData.map((entry, i) => (
              <rect key={i} fill={entry.fill} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ── Wind Risk Chart ── */

function WindRiskChart({ data }: { data: WindRisk }) {
  const chartData = useMemo(() => {
    const today = { name: 'Auj.', speed: data.current_speed, gusts: data.current_gusts, fill: data.risk_color };
    const forecast = data.forecast_16day.map((f) => ({
      name: formatShortDate(f.date),
      speed: f.speed,
      gusts: f.gusts,
      fill: f.color,
    }));
    return [today, ...forecast];
  }, [data]);

  return (
    <div className="cd-chart-wrap">
      <h4 className="cd-chart-title">
        <md-icon>air</md-icon>
        Vent — {data.source}
      </h4>
      <div className="cd-chart-meta">
        <span className="cd-chart-meta-item">
          Max 92j : <strong>{data.max_speed_92d} km/h</strong>
        </span>
        <span className="cd-chart-meta-item">
          Jours {'>'}89 km/h : <strong>{data.storm_days_92d}</strong>
        </span>
        <span className="cd-chart-meta-item">
          Jours {'>'}62 km/h : <strong>{data.strong_days_92d}</strong>
        </span>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--md-sys-color-outline-variant)" />
          <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--md-sys-color-on-surface-variant)' }} />
          <YAxis tick={{ fontSize: 11, fill: 'var(--md-sys-color-on-surface-variant)' }} unit=" km/h" />
          <Tooltip
            contentStyle={{
              background: 'var(--md-sys-color-surface-container-high)',
              border: '1px solid var(--md-sys-color-outline-variant)',
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          <ReferenceLine y={62} stroke="#D07030" strokeDasharray="4 4" label={{ value: 'Fort', position: 'right', fontSize: 10 }} />
          <ReferenceLine y={89} stroke="#B03020" strokeDasharray="4 4" label={{ value: 'Tempête', position: 'right', fontSize: 10 }} />
          <Area
            type="monotone"
            dataKey="gusts"
            stroke="#D4AC3E"
            fill="#D4AC3E"
            fillOpacity={0.1}
            strokeWidth={1}
            strokeDasharray="4 4"
          />
          <Area
            type="monotone"
            dataKey="speed"
            stroke="var(--md-sys-color-primary)"
            fill="var(--md-sys-color-primary)"
            fillOpacity={0.15}
            strokeWidth={2}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ── Flood Map Overlay Button ── */



/* ── Main Dashboard ── */

interface ClimateDashboardProps {
  lat: number;
  lon: number;
  report?: { adresse_normalisee?: string } | null;
}

export function ClimateDashboard({ lat, lon, report }: ClimateDashboardProps) {
  const [data, setData] = useState<ClimateData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch climate data when coordinates change
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);

    fetch(`${API}/api/climate?lat=${lat}&lon=${lon}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: ClimateData) => {
        if (!cancelled) {
          setData(d);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Erreur de chargement');
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [lat, lon]);

  // Determine dominant risk
  const dominantRisk = useMemo(() => {
    if (!data) return null;
    const risks: { key: string; label: string; level: string; color: string; icon: string; priority: number }[] = [];
    if (data.flood) risks.push({ key: 'flood', label: 'Inondation', level: data.flood.risk_label, color: data.flood.risk_color, icon: 'water', priority: 5 });
    if (data.heat_stress) risks.push({ key: 'heat', label: 'Chaleur', level: data.heat_stress.risk_label, color: data.heat_stress.risk_color, icon: 'thermostat', priority: 4 });
    if (data.wind_risk) risks.push({ key: 'wind', label: 'Vent', level: data.wind_risk.risk_label, color: data.wind_risk.risk_color, icon: 'air', priority: 3 });
    if (data.fire_danger) risks.push({ key: 'fire', label: 'Incendie', level: data.fire_danger.risk_label, color: data.fire_danger.risk_color, icon: 'local_fire_department', priority: 2 });
    if (data.soil_moisture) risks.push({ key: 'soil', label: 'Subsidence', level: data.soil_moisture.risk_label || data.soil_moisture.status, color: data.soil_moisture.risk_color || '#D07030', icon: 'grass', priority: 1 });
    // Return highest priority risk
    return risks.sort((a, b) => b.priority - a.priority)[0] || null;
  }, [data]);

  if (loading) {
    return (
      <section className="cd-panel" aria-label="Données climatiques">
        <header className="cd-head">
          <h2 className="cd-title">État climatique</h2>
        </header>
        <div className="cd-loading">
          <md-linear-progress indeterminate></md-linear-progress>
          <span className="cd-loading-text">Chargement des données climatiques…</span>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="cd-panel" aria-label="Données climatiques">
        <header className="cd-head">
          <h2 className="cd-title">État climatique</h2>
        </header>
        <div className="cd-empty">
          <md-icon>cloud_off</md-icon>
          <p>Données climatiques indisponibles</p>
          <p className="cd-empty-detail">{error}</p>
        </div>
      </section>
    );
  }

  if (!data || (!data.flood && !data.fire_danger && !data.soil_moisture)) {
    return (
      <section className="cd-panel" aria-label="Données climatiques">
        <header className="cd-head">
          <h2 className="cd-title">État climatique</h2>
        </header>
        <div className="cd-empty">
          <md-icon>thermostat</md-icon>
          <p>Aucune donnée climatique disponible pour cette coordonnée.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="cd-panel" aria-label="Données climatiques">
      <header className="cd-head">
        <div className="cd-head-row">
          <h2 className="cd-title">État climatique</h2>
          {dominantRisk && (
            <span className="cd-chip" style={{ color: dominantRisk.color, borderColor: dominantRisk.color }}>
              <md-icon style={{ fontSize: 16 }}>{dominantRisk.icon}</md-icon>
              Risque dominant : {dominantRisk.label}
            </span>
          )}
        </div>
        {report?.adresse_normalisee && (
          <p className="cd-subtitle">{report.adresse_normalisee}</p>
        )}
      </header>

      {/* Risk Status Cards */}
      <div className="cd-cards">
        {data.flood && (
          <RiskCard
            icon="water"
            title="Inondation"
            level={data.flood.risk_label}
            color={data.flood.risk_color}
            value={`${data.flood.current_discharge_m3s ?? '—'} ${data.flood.unit}`}
            subtitle={`Période retour : ${data.flood.return_period}`}
          />
        )}
        {data.fire_danger && (
          <RiskCard
            icon="local_fire_department"
            title="Incendie"
            level={data.fire_danger.risk_label}
            color={data.fire_danger.risk_color}
            value={`FWI ${data.fire_danger.current_fwi}`}
            subtitle={`Moy. 92j : ${data.fire_danger.avg_fwi_92d}`}
          />
        )}
        {data.soil_moisture && (
          <RiskCard
            icon="grass"
            title="Subsidence"
            level={data.soil_moisture.risk_label || data.soil_moisture.status}
            color={data.soil_moisture.risk_color || (data.soil_moisture.status === 'critical' ? '#B03020' : data.soil_moisture.status === 'high' ? '#D07030' : '#D4AC3E')}
            value={`${data.soil_moisture.current_value.toFixed(3)} ${data.soil_moisture.unit}`}
            subtitle={`Moy. 30j : ${data.soil_moisture.avg_value_30d?.toFixed(3) ?? '—'} ${data.soil_moisture.unit}`}
          />
        )}
        {data.heat_stress && (
          <RiskCard
            icon="thermostat"
            title="Chaleur"
            level={data.heat_stress.risk_label}
            color={data.heat_stress.risk_color}
            value={`${data.heat_stress.current_hi}°C`}
            subtitle={`Max 92j : ${data.heat_stress.max_hi_92d}°C · ${data.heat_stress.hot_days_92d} jours >32°C`}
          />
        )}
        {data.wind_risk && (
          <RiskCard
            icon="air"
            title="Vent"
            level={data.wind_risk.risk_label}
            color={data.wind_risk.risk_color}
            value={`${data.wind_risk.current_speed} km/h`}
            subtitle={`Rafales : ${data.wind_risk.current_gusts} km/h · Max 92j : ${data.wind_risk.max_speed_92d} km/h`}
          />
        )}
      </div>

      {/* Charts */}
      <div className="cd-charts">
        {data.seasonal && <SeasonalForecastChart data={data.seasonal} />}
        {data.heat_stress && <HeatStressChart data={data.heat_stress} />}
        {data.wind_risk && <WindRiskChart data={data.wind_risk} />}
        {data.flood && <FloodChart data={data.flood} />}
        {data.fire_danger && <FireChart data={data.fire_danger} />}
        {data.soil_moisture && data.soil_moisture.monthly_series && data.soil_moisture.monthly_series.length > 0 && (
          <SoilMoistureChart data={data.soil_moisture} />
        )}
      </div>

      {/* Footer */}
      <footer className="cd-footer">
        <p className="cd-footer-source">
          <md-icon>database</md-icon>
          <span>
            Sources :{' '}
            {Object.entries(data.metadata.sources).map(([key, source], i) => (
              <span key={key}>
                {i > 0 && ' · '}
                {source}
              </span>
            ))}
          </span>
        </p>
        <p className="cd-footer-note">
          <md-icon>info</md-icon>
          <span>
            Données opérationnelles en temps réel. Les prévisions sont indicatives — consulter Météo-France pour les prévisions officielles.
          </span>
        </p>
      </footer>
    </section>
  );
}
