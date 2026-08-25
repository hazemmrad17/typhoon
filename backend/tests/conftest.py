# =============================================================================
#   Fixtures partagées — isolation d'état entre tests.
#
#   Le cache résultat, les compteurs de budget et les limiteurs de débit sont
#   des états module-niveau : réinitialisés avant CHAQUE test pour éviter toute
#   pollution croisée.
# =============================================================================

import pytest


@pytest.fixture(autouse=True)
def _reset_service_state():
    from app.services import canonical
    from app.services import budget

    canonical._RESULT_CACHE.clear()
    budget.reset()
    yield
    canonical._RESULT_CACHE.clear()
    budget.reset()
