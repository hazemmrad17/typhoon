# =============================================================================
#   T016 — percentile() / build_report() : math pure, déterministe.
# =============================================================================

import pytest

from app.services.latency_report import build_report, percentile


def test_percentile_single_value():
    assert percentile([5.0], 95) == 5.0


def test_percentile_median_of_three():
    assert percentile([1.0, 2.0, 3.0], 50) == 2.0


def test_percentile_p95_interpolates():
    vals = list(range(1, 101))  # 1..100
    p95 = percentile([float(v) for v in vals], 95)
    assert 94.5 <= p95 <= 96.0


def test_percentile_rejects_empty_and_bounds():
    with pytest.raises(ValueError):
        percentile([], 50)
    with pytest.raises(ValueError):
        percentile([1.0], 0)
    with pytest.raises(ValueError):
        percentile([1.0], 101)


def test_build_report_verdict_against_budget():
    report = build_report([1.0] * 10 + [20.0], budget_s=10.0)  # un outlier
    assert report["n"] == 11
    assert report["p50_s"] == 1.0
    assert report["max_s"] == 20.0
    # l'outlier ne doit pas faire échouer le budget si le p95 tient
    assert report["budget_respected"] is True


def test_build_report_breach_detected():
    report = build_report([12.0] * 20, budget_s=10.0)
    assert report["budget_respected"] is False
