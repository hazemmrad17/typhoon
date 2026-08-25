# =============================================================================
#   T011 — Limitation côté client des quotas upstream (FR-23)
#
#   Constantes vérifiées le 2026-08-25 : BDNB Open 120 req/min/IP ;
#   Géoplateforme géocodage 50 req/s/IP.
#   Logique testée de façon déterministe : horloge injectée, sommeil capturé.
# =============================================================================

from __future__ import annotations

import pytest

from app.services.limits import SlidingWindowLimiter


class _FakeClock:
    def __init__(self):
        self.t = 100.0
        self.sleeps: list[float] = []

    async def sleep(self, d):
        # avance l'horloge du délai demandé (comportement réel)
        self.t += d
        self.sleeps.append(d)

    def now(self):
        return self.t


@pytest.mark.asyncio
async def test_burst_within_limit_never_sleeps():
    clock = _FakeClock()
    limiter = SlidingWindowLimiter("test", max_events=3, window_s=1.0,
                                   now_fn=clock.now, sleep_fn=clock.sleep)
    for _ in range(3):
        await limiter.acquire()
    assert clock.sleeps == []


@pytest.mark.asyncio
async def test_burst_over_limit_paces_until_slot_frees():
    clock = _FakeClock()
    limiter = SlidingWindowLimiter("test", max_events=2, window_s=1.0,
                                   now_fn=clock.now, sleep_fn=clock.sleep)
    await limiter.acquire()          # t=100
    await limiter.acquire()          # t=100
    await limiter.acquire()          # doit attendre la libération du 1er slot
    assert len(clock.sleeps) == 1
    assert clock.sleeps[0] > 0


@pytest.mark.asyncio
async def test_window_slides_older_events_expire():
    clock = _FakeClock()
    limiter = SlidingWindowLimiter("test", max_events=1, window_s=10.0,
                                   now_fn=clock.now, sleep_fn=clock.sleep)
    await limiter.acquire()
    clock.t += 11.0                  # l'événement est sorti de la fenêtre
    await limiter.acquire()
    assert clock.sleeps == []


@pytest.mark.asyncio
async def test_pipeline_limiters_configured(monkeypatch):
    """Les deux limiteurs du pipeline existent avec les constantes officielles."""
    from app.services import limits as L

    monkeypatch.setattr("app.core.config.settings.bdnb_rpm", 120)
    monkeypatch.setattr("app.core.config.settings.geoplateforme_rps", 50)
    L.configure_from_settings()
    assert L.BDNB_LIMIT.max_events == 120 and L.BDNB_LIMIT.window_s == 60.0
    assert L.GEO_LIMIT.max_events == 50 and L.GEO_LIMIT.window_s == 1.0
