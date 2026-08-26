# =============================================================================
#   Calculs de rapport de latence (T016) — fonction pure, testée hors-ligne.
# =============================================================================

from __future__ import annotations


def percentile(values: list[float], pct: float) -> float:
    """Percentile par interpolation linéaire (méthode la plus proche rang)."""
    if not values:
        raise ValueError("liste vide")
    if not 0 < pct <= 100:
        raise ValueError("pct doit être dans ]0, 100]")
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    rank = (pct / 100) * (len(ordered) - 1)
    lo = int(rank)
    hi = min(lo + 1, len(ordered) - 1)
    frac = rank - lo
    return ordered[lo] + (ordered[hi] - ordered[lo]) * frac


def build_report(durations_s: list[float], budget_s: float) -> dict:
    """Résumé p50/p95/max + verdict contre le budget (spec §NFR)."""
    if not durations_s:
        raise ValueError("aucune mesure")
    p50 = percentile(durations_s, 50)
    p95 = percentile(durations_s, 95)
    return {
        "n": len(durations_s),
        "p50_s": round(p50, 3),
        "p95_s": round(p95, 3),
        "max_s": round(max(durations_s), 3),
        "budget_s": budget_s,
        "budget_respected": p95 <= budget_s,
    }
