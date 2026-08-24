"""Tests pour le dashboard climatique opérationnel.

Teste les connecteurs flood, fire_danger, et l'endpoint /api/climate.
"""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, patch, MagicMock


# ── Flood connector ──


class TestFloodConnector:
    """Tests pour app.connectors.flood"""

    def test_risk_level_for_percentile(self):
        """Les percentiles attribuent les bons niveaux de risque."""
        from app.connectors.flood import _risk_level_for_percentile

        assert _risk_level_for_percentile(30)["level"] == "low"
        assert _risk_level_for_percentile(60)["level"] == "moderate"
        assert _risk_level_for_percentile(80)["level"] == "high"
        assert _risk_level_for_percentile(95)["level"] == "critical"

    def test_risk_level_boundary_values(self):
        """Les frontières entre niveaux sont correctes."""
        from app.connectors.flood import _risk_level_for_percentile

        assert _risk_level_for_percentile(50)["level"] == "low"
        assert _risk_level_for_percentile(50.1)["level"] == "moderate"
        assert _risk_level_for_percentile(70)["level"] == "moderate"
        assert _risk_level_for_percentile(70.1)["level"] == "high"
        assert _risk_level_for_percentile(90)["level"] == "high"
        assert _risk_level_for_percentile(90.1)["level"] == "critical"

    @pytest.mark.asyncio
    async def test_fetch_flood_risk_success(self):
        """Le fetch retourne des données structurées en cas de succès API."""
        from app.connectors.flood import fetch_flood_risk

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {
            "daily": {
                "time": ["2025-01-01", "2025-01-02", "2025-01-03"],
                "river_discharge": [10.0, 15.0, 12.0],
            }
        }

        mock_http = MagicMock()
        mock_http.get = AsyncMock(return_value=mock_response)
        mock_cm = MagicMock()
        mock_cm.__aenter__ = AsyncMock(return_value=mock_http)
        mock_cm.__aexit__ = AsyncMock(return_value=False)

        with patch("app.connectors.flood.httpx.AsyncClient", return_value=mock_cm):
            result = await fetch_flood_risk(43.7, 7.2)

        assert isinstance(result, dict)
        assert "current_discharge_m3s" in result
        assert "risk_level" in result
        assert "forecast_30day" in result

    @pytest.mark.asyncio
    async def test_fetch_flood_risk_handles_error(self):
        """Le fetch retourne None en cas d'erreur API."""
        import httpx
        from app.connectors.flood import fetch_flood_risk

        with patch("app.connectors.flood.httpx.AsyncClient") as mock_client:
            instance = MagicMock()
            instance.get = AsyncMock(side_effect=httpx.TimeoutException("timeout"))
            mock_client.return_value.__aenter__ = AsyncMock(return_value=instance)
            mock_client.return_value.__aexit__ = AsyncMock(return_value=False)
            result = await fetch_flood_risk(43.7, 7.2)

        assert result is None


# ── Fire danger connector ──


class TestFireDangerConnector:
    """Tests pour app.connectors.fire_danger"""

    def test_fwi_level_classification(self):
        """Les valeurs FWI sont correctement classifiées."""
        from app.connectors.fire_danger import _fwi_level

        assert _fwi_level(2)["level"] == "low"
        assert _fwi_level(10)["level"] == "moderate"
        assert _fwi_level(20)["level"] == "high"
        assert _fwi_level(40)["level"] == "very_high"
        assert _fwi_level(60)["level"] == "extreme"

    def test_fwi_level_boundary_values(self):
        """Les frontières FWI sont correctes."""
        from app.connectors.fire_danger import _fwi_level

        assert _fwi_level(5)["level"] == "low"
        assert _fwi_level(5.1)["level"] == "moderate"
        assert _fwi_level(15)["level"] == "moderate"
        assert _fwi_level(15.1)["level"] == "high"
        assert _fwi_level(30)["level"] == "high"
        assert _fwi_level(30.1)["level"] == "very_high"

    @pytest.mark.asyncio
    async def test_fetch_fire_danger_success(self):
        """Le fetch retourne des données structurées en cas de succès API."""
        from app.connectors.fire_danger import fetch_fire_danger

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {
            "daily": {
                "time": ["2025-01-01", "2025-01-02", "2025-01-03"],
                "temperature_2m_max": [25.0, 30.0, 28.0],
                "relative_humidity_2m_min": [40.0, 30.0, 35.0],
                "wind_speed_10m_max": [15.0, 20.0, 12.0],
                "precipitation_sum": [0.0, 0.0, 5.0],
            }
        }

        mock_http = MagicMock()
        mock_http.get = AsyncMock(return_value=mock_response)
        mock_cm = MagicMock()
        mock_cm.__aenter__ = AsyncMock(return_value=mock_http)
        mock_cm.__aexit__ = AsyncMock(return_value=False)

        with patch("app.connectors.fire_danger.httpx.AsyncClient", return_value=mock_cm):
            result = await fetch_fire_danger(43.7, 7.2)

        assert isinstance(result, dict)
        assert "current_fwi" in result
        assert "risk_level" in result
        assert "forecast_16day" in result

    @pytest.mark.asyncio
    async def test_fetch_fire_danger_handles_error(self):
        """Le fetch retourne None en cas d'erreur."""
        import httpx
        from app.connectors.fire_danger import fetch_fire_danger

        with patch("app.connectors.fire_danger.httpx.AsyncClient") as mock_client:
            instance = MagicMock()
            instance.get = AsyncMock(side_effect=httpx.TimeoutException("timeout"))
            mock_client.return_value.__aenter__ = AsyncMock(return_value=instance)
            mock_client.return_value.__aexit__ = AsyncMock(return_value=False)
            result = await fetch_fire_danger(43.7, 7.2)

        assert result is None


# ── ERA5-Land connector ──


class TestERA5LandConnector:
    """Tests pour app.connectors.era5_land"""

    def test_soil_level_classification(self):
        """Les valeurs d'humidité du sol sont correctement classifiées."""
        from app.connectors.era5_land import _soil_level

        assert _soil_level(0.05)["level"] == "critical"
        assert _soil_level(0.10)["level"] == "high"
        assert _soil_level(0.15)["level"] == "moderate"
        assert _soil_level(0.25)["level"] == "low"

    @pytest.mark.asyncio
    async def test_fetch_soil_moisture_returns_none_without_data(self):
        """Le fetch retourne None quand l'API ne retourne pas de données."""
        from app.connectors.era5_land import fetch_soil_moisture

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {"daily": {"time": []}}

        mock_http = MagicMock()
        mock_http.get = AsyncMock(return_value=mock_response)
        mock_cm = MagicMock()
        mock_cm.__aenter__ = AsyncMock(return_value=mock_http)
        mock_cm.__aexit__ = AsyncMock(return_value=False)

        with patch("app.connectors.era5_land.httpx.AsyncClient", return_value=mock_cm):
            result = await fetch_soil_moisture(43.7, 7.2)

        assert result is None


# ── Climate API endpoint ──


class TestClimateEndpoint:
    """Tests pour GET /api/climate"""

    def test_invalid_coordinates_rejected(self):
        """Les coordonnées hors limites sont rejetées."""
        from fastapi.testclient import TestClient
        from app.main import app

        client = TestClient(app)
        resp = client.get("/api/climate?lat=999&lon=7.2")
        assert resp.status_code == 422

    def test_valid_coordinates_accepted(self):
        """Les coordonnées valides acceptent la requête (même sans données CDS)."""
        from fastapi.testclient import TestClient
        from app.main import app

        client = TestClient(app)
        resp = client.get("/api/climate?lat=43.7&lon=7.2")
        assert resp.status_code == 200
        data = resp.json()
        assert "lat" in data
        assert "lon" in data
        assert "flood" in data
        assert "fire_danger" in data
        assert "soil_moisture" in data
        assert "metadata" in data
        assert "sources" in data["metadata"]

    def test_response_has_correct_structure(self):
        """La réponse a la structure attendue."""
        from fastapi.testclient import TestClient
        from app.main import app

        client = TestClient(app)
        resp = client.get("/api/climate?lat=48.8566&lon=2.3522")  # Paris
        assert resp.status_code == 200
        data = resp.json()
        assert data["lat"] == 48.8566
        assert data["lon"] == 2.3522
        assert isinstance(data["metadata"]["elapsed_ms"], (int, float))
        assert isinstance(data["metadata"]["sources"], dict)
