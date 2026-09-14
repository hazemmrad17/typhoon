// =============================================================================
//   TYPHOON — hook de flux SSE du rapport de risque (étape 3).
//   POSTe la sortie structurée de l'étape 2 vers /api/report/stream et lit le
//   flux : sections déterministes (header, synthèse, catégories,
//   recommandations, confiance, annexe) puis prose Mistral validée en
//   « patch », puis « done ». Extraction du panneau RiskReport pour être
//   partagé par la page rapport autonome.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { API } from './config';

export type ReportStatus = 'idle' | 'loading' | 'streaming' | 'done' | 'error';

export interface ReportMeta {
  data_version?: string;
  prompt_version?: string;
  model?: string;
  cache_hit?: boolean;
  cache_key?: string;
  generated_at?: string;
}

export interface ReportHeader {
  sector: string;
  scenario: string;
  pct: number;
  timestamp: string;
  timestamp_label: string;
}

export interface ReportSummary {
  damageEUR: string;
  damageRange: string;
  hp: string;
  waterLevelFt: string;
  executive_summary: string;
}

export interface ReportCategory {
  category: string;
  label: string;
  risk_level: string;
  value: number;
  unit: string;
  estimate: string;
  narrative: string;
}

export interface ReportMitigation {
  id: string;
  category: string;
  text: string;
  trigger: string;
  narrative?: string;
}

/* ── Section « trajet de l'eau » (GÉOGRAPHIE RÉELLE) — émise uniquement quand
   le rapport porte un parcours reconstruit (payload.hydro). Remplace l'ancienne
   section « hypothèse de crue » : ce ne sont plus des valeurs simulées mais des
   faits de géographie sourcés (réseau hydrographique IGN BD TOPO). ── */
export interface ReportHydroHeader {
  watercourse: string | null;
  basin_libelle: string | null;
  upstream_km: number;
  downstream_km: number;
  upstream_stop: string | null;
  downstream_stop: string | null;
  arrival_min_hours: number | null;
  arrival_max_hours: number | null;
  source: string;
}

export interface ReportHydro {
  header: ReportHydroHeader;
  /** Narratif ancré dans les faits du parcours (jamais de géographie inventée). */
  summary: string;
}

export interface ReportStreamResult {
  status: ReportStatus;
  header: ReportHeader | null;
  summary: ReportSummary | null;
  cats: Record<string, ReportCategory>;
  catOrder: string[];
  migs: ReportMitigation[];
  confidence: { low: string; high: string } | null;
  appendix: [string, string][] | null;
  /** Trajet de l'eau réel (nul si le rapport n'en porte pas). */
  hydro: ReportHydro | null;
  fallback: boolean;
  meta: ReportMeta;
  error: string | null;
}

/** Payload envoyé au backend — sortie structurée de l'étape 2. */
export type ReportPayload = {
  sector: string;
  timestamp: string;
  scenario: {
    key: string;
    pct: number;
    risk: string;
    windPeakKmh: number;
    rainPeakMmH: number;
    depthPeakM: number;
  };
  damage: Record<string, { v: number; low: number; high: number }>;
  /** Trajet de l'eau RÉEL (facultatif) : faits de géographie reconstruits sur
      le réseau hydrographique IGN BD TOPO. `null`/absent → rapport identique à
      celui d'avant (la clé de cache côté serveur ne change pas). */
  hydro?: {
    watercourse: string | null;
    snap_distance_m: number | null;
    basin: {
      libelle: string | null;
      toponyme: string | null;
      group_libelle: string | null;
      area_km2: number | null;
    } | null;
    upstream_km: number;
    downstream_km: number;
    upstream_stop: string | null;
    downstream_stop: string | null;
    arrival_min_hours: number | null;
    arrival_max_hours: number | null;
    sources: Record<string, string>;
  } | null;
};

export function useReportStream(payload: ReportPayload | null): ReportStreamResult {
  const [status, setStatus] = useState<ReportStatus>('idle');
  const [header, setHeader] = useState<ReportHeader | null>(null);
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [cats, setCats] = useState<Record<string, ReportCategory>>({});
  const [catOrder, setCatOrder] = useState<string[]>([]);
  const [migs, setMigs] = useState<ReportMitigation[]>([]);
  const [confidence, setConfidence] = useState<{ low: string; high: string } | null>(null);
  const [appendix, setAppendix] = useState<[string, string][] | null>(null);
  const [hydro, setHydro] = useState<ReportHydro | null>(null);
  const [fallback, setFallback] = useState(false);
  const [meta, setMeta] = useState<ReportMeta>({});
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const applyEvent = useCallback((ev: { type: string; data: Record<string, unknown> }) => {
    const d = ev.data;
    switch (ev.type) {
      case 'header':
        setHeader(d as unknown as ReportHeader);
        break;
      case 'summary':
        setSummary(d as unknown as ReportSummary);
        break;
      case 'category': {
        const c = d as unknown as ReportCategory;
        setCats((prev) => ({ ...prev, [c.category]: c }));
        setCatOrder((prev) => (prev.includes(c.category) ? prev : [...prev, c.category]));
        break;
      }
      case 'mitigations':
        setMigs((d.items as ReportMitigation[]) ?? []);
        break;
      case 'confidence':
        setConfidence(d as unknown as { low: string; high: string });
        break;
      case 'appendix':
        setAppendix((d.rows as [string, string][]) ?? null);
        break;
      case 'hydro_header':
        setHydro({
          header: d as unknown as ReportHydroHeader,
          summary: '',
        });
        break;
      case 'patch': {
        const field = String(d.field ?? '');
        if (field === 'exec' && d.value) {
          setSummary((prev) =>
            prev ? { ...prev, executive_summary: String(d.value) } : prev
          );
        } else if (field === 'category' && d.category && d.value) {
          const cat = String(d.category);
          setCats((prev) =>
            prev[cat] ? { ...prev, [cat]: { ...prev[cat], narrative: String(d.value) } } : prev
          );
        } else if (field === 'mitigation' && d.id && d.value) {
          const aid = String(d.id);
          setMigs((prev) => prev.map((m) => (m.id === aid ? { ...m, narrative: String(d.value) } : m)));
        } else if (field === 'hydro' && d.value) {
          setHydro((prev) => (prev ? { ...prev, summary: String(d.value) } : prev));
        }
        break;
      }
      case 'done': {
        setFallback(!!d.fallback_used);
        setMeta((d.meta as ReportMeta) ?? {});
        setStatus('done');
        break;
      }
      default:
        break;
    }
  }, []);

  useEffect(() => {
    if (!payload) return;
    const id = ++requestIdRef.current;

    // Reset pour chaque nouvelle requête.
    setHeader(null);
    setSummary(null);
    setCats({});
    setCatOrder([]);
    setMigs([]);
    setConfidence(null);
    setAppendix(null);
    setHydro(null);
    setFallback(false);
    setMeta({});
    setError(null);
    setStatus('loading');

    const controller = new AbortController();

    async function run(): Promise<void> {
      try {
        const resp = await fetch(`${API}/api/report/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!resp.ok || !resp.body) {
          throw new Error(`HTTP ${resp.status}`);
        }
        setStatus('streaming');
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx = buf.indexOf('\n\n');
          while (idx !== -1) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of block.split('\n')) {
              if (line.startsWith('data:')) {
                const raw = line.slice(5).trim();
                if (!raw) continue;
                try {
                  applyEvent(JSON.parse(raw));
                } catch {
                  /* fragment non JSON → ignoré */
                }
              }
            }
            idx = buf.indexOf('\n\n');
          }
        }
        setStatus((s) => (s === 'done' ? s : 'done'));
      } catch (err: unknown) {
        if (controller.signal.aborted) return;
        if (requestIdRef.current !== id) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
    }

    void run();
    return () => controller.abort();
  }, [payload, applyEvent]);

  return {
    status,
    header,
    summary,
    cats,
    catOrder,
    migs,
    confidence,
    appendix,
    hydro,
    fallback,
    meta,
    error,
  };
}