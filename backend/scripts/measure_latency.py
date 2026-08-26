# =============================================================================
#   T016 — Harnais de mesure de latence (POST /diagnostic/adresse)
#
#   Prérequis : le backend tourne (uvicorn) avec des clés API configurées si
#   l'auth est active. Mesure N diagnostics contre des adresses réelles.
#
#   Usage :
#     python scripts/measure_latency.py --n 100 --url http://127.0.0.1:8000
#     python scripts/measure_latency.py --addresses mes_adresses.txt
#
#   Verdict : p95 <= 10 s (budget spec §NFR). En cas de dépassement, la
#   tâche conditionnelle T017 (parallélisation des couches WFS) s'ouvre.
# =============================================================================

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.latency_report import build_report  # noqa: E402

BUDGET_S = 10.0

DEFAULT_ADDRESSES = [
    "10 Rue de Rivoli, 75004 Paris",
    "1 Promenade des Anglais, 06000 Nice",
    "Place Bellecour, 69002 Lyon",
    "La Canebière, 13001 Marseille",
    "12 Rue Sainte-Catherine, 33000 Bordeaux",
]


async def measure(url: str, api_key: str | None, addresses: list[str], n: int) -> list[float]:
    durations: list[float] = []
    headers = {"X-API-Key": api_key} if api_key else {}
    async with httpx.AsyncClient(timeout=30.0, headers=headers) as client:
        i = 0
        while len(durations) < n:
            adresse = addresses[i % len(addresses)]
            i += 1
            t0 = time.perf_counter()
            try:
                resp = await client.post(
                    f"{url}/diagnostic/adresse",
                    json={"adresse": adresse},
                )
            except httpx.HTTPError as exc:
                print(f"  réseau : {type(exc).__name__} — ignoré")
                continue
            dt = time.perf_counter() - t0
            if resp.status_code == 200:
                durations.append(dt)
                print(f"  [{len(durations)}/{n}] {dt:.2f}s — {adresse[:50]}")
            else:
                print(f"  HTTP {resp.status_code} pour {adresse[:50]} — ignoré")
    return durations


async def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Mesure p50/p95 du diagnostic unitaire.")
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    parser.add_argument("--api-key", default=None)
    parser.add_argument("--n", type=int, default=30, help="nombre de mesures (défaut 30)")
    parser.add_argument("--budget", type=float, default=BUDGET_S)
    parser.add_argument("--addresses", help="fichier texte, une adresse par ligne")
    args = parser.parse_args()

    addresses = DEFAULT_ADDRESSES
    if args.addresses:
        lines = Path(args.addresses).read_text(encoding="utf-8").splitlines()
        addresses = [l.strip() for l in lines if l.strip()]
    if not addresses:
        print("aucune adresse fournie", file=sys.stderr)
        return 1

    n = max(args.n, len(addresses))
    print(f"Mesure de {n} diagnostics contre {args.url} (budget {args.budget}s)…")
    durations = await measure(args.url, args.api_key, addresses, n)
    if len(durations) < 5:
        print("trop peu de mesures valides — verdict impossible", file=sys.stderr)
        return 1

    report = build_report(durations, args.budget)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    if not report["budget_respected"]:
        print("\n⚠ BUDGET DÉPASSÉ — ouvrir T017 (parallélisation des couches WFS).")
        return 2
    print("\n✓ budget respecté.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv)))
