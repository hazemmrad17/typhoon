"""Connecteur Mistral — appel déterministe et contraint (étape 3).

Paramètres de reproductibilité :
  · temperature = 0
  · top_p = 1
  · random_seed = constante fixe (SAMPLING_SEED)
  · response_format = {"type": "json_object"} → sortie structurée, pas de
    texte libre non validable.
  · stream = True pour le rendu incrémental du rapport (SSE côté route).

Le connecteur est strictement optionnel : s'il n'y a pas de clé, si l'appel
échoue ou si la sortie n'est pas du JSON valide, il retourne None et le
service retombe sur le rendu 100 % template (aucune prose LLM).
"""

from __future__ import annotations

import json
from typing import AsyncIterator

import httpx

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)

MISTRAL_API_URL = "https://api.mistral.ai/v1/chat/completions"
SAMPLING_SEED = 1337

_HEADERS_CACHE: dict[str, str] | None = None


def _headers() -> dict[str, str] | None:
    global _HEADERS_CACHE
    key = settings.mistral_api_key
    if not key:
        return None
    if _HEADERS_CACHE is None:
        _HEADERS_CACHE = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }
    return _HEADERS_CACHE


def _base_payload(system_prompt: str, user_message: str) -> dict:
    return {
        # Modèle réglable (settings.mistral_model) : l'accès à un modèle donné
        # dépend de l'abonnement, un modèle non autorisé répond 403 et le
        # service bascule sur le template — mieux vaut pouvoir le corriger par
        # configuration que par redéploiement.
        "model": settings.mistral_model,
        "temperature": 0,
        "top_p": 1,
        "random_seed": SAMPLING_SEED,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
    }


def _parse_json(content: str) -> dict | None:
    try:
        parsed = json.loads(content)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError as exc:
        logger.warning("Sortie Mistral non exploitable (JSON) : %s", exc)
        return None


async def mistral_structured_json(
    system_prompt: str,
    user_message: str,
    *,
    timeout: float = 30.0,
) -> dict | None:
    """Appelle Mistral en mode JSON strict (non stream) et retourne le dict.

    Retourne None sur : clé manquante, erreur réseau, statut non-2xx,
    sortie non-JSON ou schéma invalide — l'appelant choisit le repli.
    """
    headers = _headers()
    if headers is None:
        logger.warning("MISTRAL_API_KEY absente — rendu template (sans prose LLM)")
        return None

    payload = _base_payload(system_prompt, user_message)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(MISTRAL_API_URL, headers=headers, json=payload)
            resp.raise_for_status()
            body = resp.json()
    except (httpx.HTTPError, ValueError) as exc:  # réseau / HTTP / JSON
        logger.warning("Échec appel Mistral : %s", exc)
        return None

    try:
        content = body["choices"][0]["message"]["content"]
        return _parse_json(content)
    except (KeyError, IndexError, TypeError) as exc:
        logger.warning("Sortie Mistral non exploitable : %s", exc)
        return None


async def mistral_stream_json(
    system_prompt: str,
    user_message: str,
    *,
    timeout: float = 30.0,
) -> AsyncIterator[str]:
    """Appelle Mistral en mode JSON strict + stream et produit les morceaux
    de la chaîne JSON au fil de l'eau.

    Chaque itération cède le fragment de `content` reçu depuis l'API. L'appelant
    doit concaténer ces fragments puis parser le JSON complet une fois le flux
    terminé (la sortie JSON n'est valide qu'en fin de flux). Ne lève jamais pour
    une erreur d'appel : il lève une exception `RuntimeError` uniquement sur un
    statut non-2xx ou un flux illisible, afin que l'appelant puisse retomber sur
    le template.
    """
    headers = _headers()
    if headers is None:
        logger.warning("MISTRAL_API_KEY absente — rendu template (sans prose LLM)")
        return

    payload = _base_payload(system_prompt, user_message)
    payload["stream"] = True
    # NB : `include_usage` (option OpenAI) est refusé 422 par l'API Mistral
    # (extra_forbidden) — ne pas l'envoyer.

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream(
                "POST", MISTRAL_API_URL, headers=headers, json=payload
            ) as resp:
                if resp.status_code != 200:
                    raise RuntimeError(f"Mistral HTTP {resp.status_code}")
                async for line in resp.aiter_lines():
                    line = line.strip()
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    try:
                        delta = chunk["choices"][0]["delta"].get("content") or ""
                    except (KeyError, IndexError, TypeError):
                        continue
                    if delta:
                        yield delta
    except httpx.HTTPError as exc:
        logger.warning("Échec stream Mistral : %s", exc)
        raise RuntimeError("stream Mistral indisponible") from exc