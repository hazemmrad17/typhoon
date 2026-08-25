# =============================================================================
#   Limitation de débit CÔTÉ CLIENT des quotas upstream (FR-23)
#
#   Typhoon protège ses propres quotas fournisseurs : BDNB Open 120 req/min/IP,
#   Géoplateforme 50 req/s/IP (constantes vérifiées le 2026-08-25).
#   Fenêtre glissante par instance ; horloge et sommeil injectables pour des
#   tests déterministes.
# =============================================================================

from __future__ import annotations

import asyncio
import time
from collections import deque

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)


class SlidingWindowLimiter:
    """Fenêtre glissante : au plus `max_events` acquisitions par `window_s`."""

    def __init__(
        self,
        name: str,
        max_events: int,
        window_s: float,
        now_fn=time.monotonic,
        sleep_fn=asyncio.sleep,
    ):
        self.name = name
        self.max_events = max(1, max_events)
        self.window_s = window_s
        self._now = now_fn
        self._sleep = sleep_fn
        self._events: deque[float] = deque()

    async def acquire(self) -> None:
        while True:
            now = self._now()
            cutoff = now - self.window_s
            while self._events and self._events[0] <= cutoff:
                self._events.popleft()
            if len(self._events) < self.max_events:
                self._events.append(now)
                return
            wait = self.window_s - (now - self._events[0])
            logger.debug("limiter %s — pacing %.3fs", self.name, wait)
            await self._sleep(max(wait, 0.001))


# Instances du pipeline — configurées via settings pour rester vérifiables.
BDNB_LIMIT = SlidingWindowLimiter("bdnb", max_events=120, window_s=60.0)
GEO_LIMIT = SlidingWindowLimiter("geoplateforme", max_events=50, window_s=1.0)


def configure_from_settings() -> None:
    """Reconfigure les instances depuis les settings (appelé au boot / tests)."""
    global BDNB_LIMIT, GEO_LIMIT
    BDNB_LIMIT = SlidingWindowLimiter(
        "bdnb", max_events=settings.bdnb_rpm, window_s=60.0
    )
    GEO_LIMIT = SlidingWindowLimiter(
        "geoplateforme", max_events=settings.geoplateforme_rps, window_s=1.0
    )


configure_from_settings()
