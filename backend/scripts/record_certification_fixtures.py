# =============================================================================
#   T008 â€” Enregistreur de fixtures de certification (FR-11)
#
#   Interroge le WFS GÃ©orisques LIVE pour des points choisis et stocke la
#   rÃ©ponse GML + verdict du connecteur sous tests/fixtures/certification/.
#
#   âš ï¸  Ã‰TAT DES LIEUX : les fixtures enregistrÃ©es prouvent la COHÃ‰RENCE
#   interne (verdict connecteur == point-in-polygon recalculÃ© sur les
#   gÃ©omÃ©tries enregistrÃ©es). La qualification "connu exposÃ© / connu non
#   exposÃ©" contre les cartes officielles du portail reste UNE Ã‰TAPE HUMAINE
#   (cf. plan.md, risque T008) â€” champ "reviewed": false tant qu'elle n'est
#   pas faite.
#
#   Usage :
#     python scripts/record_certification_fixtures.py            # tous les cas
#     python scripts/record_certification_fixtures.py inondation # un seul
# =============================================================================

from __future__ import annotations

import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.connectors.georisques_wfs import (  # noqa: E402
    PPR_TYPE_LAYERS,
    fetch_wfs_layer,
)

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "certification"

# Points candidats â€” Ã  QUALIFIER humainement contre le portail GÃ©orisques.
# Chaque cas : {hazard, layers, point(lon,lat), attente} ; l'attente n'est
# pas crue par les tests tant que reviewed=false.
CASES: list[dict] = [
    {
        "id": "inondation_var_nice",
        "hazard": "inondation",
        "layers": PPR_TYPE_LAYERS["inondation"],
        "lon": 7.2030, "lat": 43.6990,          # vallÃ©e du Var (Nice) â€” candidat EXPOSÃ‰
        "attente": "present_true",
    },
    {
        "id": "inondation_cimiez_nice",
        "hazard": "inondation",
        "layers": PPR_TYPE_LAYERS["inondation"],
        "lon": 7.2780, "lat": 43.7180,          # colline de Cimiez â€” candidat NON EXPOSÃ‰
        "attente": "present_false",
    },
]


async def record_case(case: dict) -> Path | None:
    stamp = datetime.now(timezone.utc).isoformat()
    fixture = {
        "id": case["id"],
        "hazard": case["hazard"],
        "point": {"lon": case["lon"], "lat": case["lat"]},
        "attente": case["attente"],
        "reviewed": False,
        "recorded_at": stamp,
        "layers": {},
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        for layer in case["layers"]:
            features = await fetch_wfs_layer(client, layer, case["lon"], case["lat"])
            if features is None:
                print(f"  [{case['id']}] {layer}: ECHEC (WFS indisponible)")
                return None
            fixture["layers"][layer] = features
            print(f"  [{case['id']}] {layer}: {len(features)} entitÃ©(s)")

    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    out = FIXTURES_DIR / f"{case['id']}.json"
    out.write_text(json.dumps(fixture, ensure_ascii=False), encoding="utf-8")
    print(f"  -> {out.name}")
    return out


async def main(argv: list[str]) -> int:
    only = argv[1] if len(argv) > 1 else None
    ok = True
    for case in CASES:
        if only and case["id"] != only:
            continue
        print(f"Enregistrement : {case['id']} ({case['hazard']})")
        if await record_case(case) is None:
            ok = False
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv)))
