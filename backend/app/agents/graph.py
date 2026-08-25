"""
StateGraph simplifié — collector_agent seul (pas de scoring, pas de jumeau 3D).

Le produit est la fusion de données brutes (Géorisques + BDNB) par
bâtiment. Le moteur de scoring maison et le jumeau numérique
sont supprimés — l'assureur applique son propre modèle actuariel.

Ancien graphe : collector → scoring → recommandations → interpretation → digital_twin
Nouveau graphe : collector → fin
"""

from __future__ import annotations

import time

from app.agents.collector_agent import collect
from app.agents.state import TyphoonState
from app.core.logging import get_logger

logger = get_logger(__name__)


async def _collector_node(state: TyphoonState) -> dict:
    t0 = time.perf_counter()
    building_data = await collect(state["adresse"])
    logger.info("collector_agent (noeud) -- termine en %.2fs", time.perf_counter() - t0)
    return {"building_data": building_data}


# Plus de StateGraph LangGraph — le collector est appelé directement
# par la route API. Ce module est conservé pour la rétrocompatibilité
# des imports existants (state.py, etc.).

async def run_collector(address: str) -> dict:
    """Point d'entrée simplifié : collecte des données brutes."""
    return await collect(address)
