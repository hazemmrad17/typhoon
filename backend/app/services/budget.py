# =============================================================================
#   Budget mensuel d'appels BDNB (FR-28)
#
#   Garde-fou du quota Open tier : le LOT est rejeté (429 budget_epuise)
#   quand l'enveloppe est épuisée ; la requête unitaire interactive n'est
#   JAMAIS bloquée par lui en v1. Compteur process-local, réinitialisé au
#   changement de mois.
# =============================================================================

from __future__ import annotations

from datetime import datetime, timezone


def _current_month() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m")


_state: dict[str, int] = {}
_month: str | None = None


def _rollover_if_needed() -> None:
    global _month
    current = _current_month()
    if _month != current:
        _month = current
        _state.clear()


def consumed() -> int:
    _rollover_if_needed()
    return _state.get("bdnb", 0)


def remaining(budget: int) -> int:
    _rollover_if_needed()
    return max(0, budget - _state.get("bdnb", 0))


def consume(n: int = 1) -> bool:
    """Incrémente le compteur. Retourne False si l'enveloppe est dépassée
    (l'appel est alors compté comme refusé — pas de crédit négatif)."""
    _rollover_if_needed()
    from app.core.config import settings

    if _state.get("bdnb", 0) + n > settings.bdnb_monthly_budget:
        return False
    _state["bdnb"] = _state.get("bdnb", 0) + n
    return True


def reset(month: str | None = None) -> None:
    """Réinitialisation (tests / changement de mois forcé)."""
    global _month
    _state.clear()
    _month = month
