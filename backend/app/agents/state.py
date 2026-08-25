"""
TyphoonState — état simplifié pour la collecte de données brutes.

Plus de StateGraph LangGraph — le collector est appelé directement
par la route API. Ce module est conservé pour la rétrocompatibilité
et la clarté du contrat de sortie.
"""

from __future__ import annotations

from typing import Any, TypedDict


class TyphoonState(TypedDict, total=False):
    # Entrée
    adresse: str
    formulaire: dict[str, Any] | None

    # Écrit par collector_agent
    building_data: dict[str, Any]
