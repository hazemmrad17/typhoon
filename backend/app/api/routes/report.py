"""Routes du rapport de risque (étape 3).

  POST /api/report          — rendu complet (markdown + html) de façon
                              déterministe (cache inclus). Conservée pour
                              compat & tests.
  POST /api/report/stream   — flux SSE : les sections déterministes partent
                              immédiatement, la prose Mistral (mistral-large)
                              arrive ensuite en « patch » validés, puis « done ».
                              Le cache est rejoué à l'identique en flux.

L'appel Mistral est optionnel et n'empêche jamais le rendu : sans clé ou si
l'API échoue, fallback_used=True et le rapport reste complet (100 % template).
"""

from __future__ import annotations

from fastapi import APIRouter, Response
from fastapi.responses import StreamingResponse

from app.core.logging import get_logger
from app.schemas.report import ReportRequest, ReportResponse
from app.services.report_agent import generate_report, stream_report

logger = get_logger(__name__)
router = APIRouter()

_STREAM_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Content-Type": "text/event-stream; charset=utf-8",
}


@router.post("/api/report", response_model=ReportResponse)
async def create_report(payload: ReportRequest) -> ReportResponse:
    logger.info(
        "POST /api/report  secteur=%r scénario=%s", payload.sector, payload.scenario.key
    )
    return await generate_report(payload)


@router.post("/api/report/stream")
async def stream_report_route(payload: ReportRequest) -> Response:
    logger.info(
        "POST /api/report/stream  secteur=%r scénario=%s",
        payload.sector,
        payload.scenario.key,
    )

    async def _gen():
        async for ev in stream_report(payload):
            yield f"data: {ev}\n\n"

    return StreamingResponse(_gen(), media_type="text/event-stream", headers=_STREAM_HEADERS)