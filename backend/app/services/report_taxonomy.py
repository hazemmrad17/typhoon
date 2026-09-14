"""Taxonomie des actions de mitigation (étape 3).

C'est la SEULE source des recommandations : chaque entrée relie un signal de
dommage (catégorie + valeur au-dessus d'un seuil) à une action candidate.
L'étape déterministe évalue chaque seuil contre le DamageEstimate ; le modèle
sélectionne et classe depuis cette liste — il n'invente jamais d'action.

Cette table est le principal « contenu » du produit : c'est ici qu'on enrichit
ou ajuste les recommandations, jamais dans le prompt du modèle.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Mitigation:
    id: str
    category: str            # structural | power | road | conduit | vegetation
    text: str
    signal: str              # clé dans le DamageEstimate (champ `.v`)
    threshold: float         # déclencheur si value.v >= threshold
    trigger_note: str        # explication rendue (d'où vient l'action)


MITIGATIONS: tuple[Mitigation, ...] = (
    # ── Réseaux électriques (lignes coupées, km) ──
    Mitigation(
        id="veg_mgmt_lines",
        category="power",
        text="Prioriser la gestion de la végétation le long des tronçons de ligne exposés au vent.",
        signal="downedPowerLines",
        threshold=0.3,
        trigger_note="tronçons de ligne exposés détectés",
    ),
    Mitigation(
        id="line_hardening",
        category="power",
        text="Mettre en place un durcissement temporaire des lignes sur les tronçons les plus vulnérables.",
        signal="downedPowerLines",
        threshold=1.0,
        trigger_note="risque significatif de coupures de ligne",
    ),
    Mitigation(
        id="repair_crews",
        category="power",
        text="Pré-positionner des équipes de réparation à proximité des tronçons à risque.",
        signal="downedPowerLines",
        threshold=1.5,
        trigger_note="forte probabilité de lignes coupées",
    ),
    # ── Conduites / réseaux souterrains (mètres inondés) ──
    Mitigation(
        id="elevate_panels",
        category="conduit",
        text="Surélever les panneaux électriques et équipements des parties basses exposées à l'inondation.",
        signal="floodedConduitM",
        threshold=150,
        trigger_note="conduites submergées au-delà du seuil",
    ),
    Mitigation(
        id="backflow_valves",
        category="conduit",
        text="Installer des clapets anti-retour sur les raccordements de réseau exposés.",
        signal="floodedConduitM",
        threshold=150,
        trigger_note="risque de reflux d'eau dans les conduites",
    ),
    Mitigation(
        id="relocate_belowgrade",
        category="conduit",
        text="Relocaliser les équipements en sous-sol vers les niveaux supérieurs non exposés.",
        signal="floodedConduitM",
        threshold=400,
        trigger_note="submersion étendue des équipements enterrés",
    ),
    # ── Voirie (mètres de route inondés) ──
    Mitigation(
        id="predeploy_pumps",
        category="road",
        text="Pré-déployer des pompes aux points noirs connus pour évacuer l'eau des axes critiques.",
        signal="damagedRoadsM",
        threshold=150,
        trigger_note="voirie submergée identifiée",
    ),
    Mitigation(
        id="road_closures",
        category="road",
        text="Planifier des fermetures temporaires et une signalisation de déviation sur les tronçons inondés.",
        signal="damagedRoadsM",
        threshold=400,
        trigger_note="submersion étendue de la voirie",
    ),
    # ── Végétation (arbres cassés) ──
    Mitigation(
        id="prestorm_pruning",
        category="vegetation",
        text="Lancer un programme d'élagage avant l'événement sur les arbres à proximité des structures.",
        signal="brokenTrees",
        threshold=2,
        trigger_note="risque de chute d'arbres détecté",
    ),
    Mitigation(
        id="priority_removal",
        category="vegetation",
        text="Établir une liste de suppression prioritaire des arbres à risque proches des bâtiments.",
        signal="brokenTrees",
        threshold=5,
        trigger_note="fort risque de casse d'arbres",
    ),
    # ── Structure (bâtiments touchés) ──
    Mitigation(
        id="flood_barriers",
        category="structural",
        text="Déployer des barrières anti-inondation / sacs de sable pour protéger les rez-de-chaussée exposés.",
        signal="damagedBuildings",
        threshold=0.5,
        trigger_note="bâtiments impactés au rez-de-chaussée",
    ),
    Mitigation(
        id="retrofit_review",
        category="structural",
        text="Lancer une revue de renforcement pour les bâtiments au-delà du seuil de dommage structurel.",
        signal="damagedBuildings",
        threshold=1.5,
        trigger_note="dommage structurel important sur plusieurs bâtiments",
    ),
)

_BY_ID: dict[str, Mitigation] = {m.id: m for m in MITIGATIONS}


def mitigation_by_id(action_id: str) -> Mitigation | None:
    return _BY_ID.get(action_id)


def select_mitigations(damage) -> list[Mitigation]:
    """Évalue chaque seuil contre le DamageEstimate → actions applicables.

    Accepte un objet pydantic (DamageModel) ou un dict brut. L'ordre suit la
    sévérité (le nombre d'actions dans chaque catégorie croît avec
    l'intensité), de sorte que la liste rendue est naturellement classée
    par priorité du plus au moins critique.
    """
    if hasattr(damage, "model_dump"):
        damage = damage.model_dump()

    applied: list[Mitigation] = []
    for m in MITIGATIONS:
        field = damage.get(m.signal) or {}
        value = field.get("v", 0.0)
        if value >= m.threshold:
            applied.append(m)
    return applied


# ── Niveaux de risque par catégorie (seuils déterministes) ──
# Chaque catégorie : seuil High / Moderate, champ source et unité affichée.
CATEGORY_RISK: dict[str, dict] = {
    "structural": {
        "label": "Structure (bâtiments)",
        "field": "damagedBuildings",
        "high": 1.5,
        "moderate": 0.5,
        "unit": "bâtiments touchés",
    },
    "power": {
        "label": "Réseaux électriques",
        "field": "downedPowerLines",
        "high": 1.0,
        "moderate": 0.3,
        "unit": "km de ligne",
    },
    "road": {
        "label": "Voirie",
        "field": "damagedRoadsM",
        "high": 400.0,
        "moderate": 150.0,
        "unit": "m inondés",
    },
    "conduit": {
        "label": "Conduites / réseaux enterrés",
        "field": "floodedConduitM",
        "high": 400.0,
        "moderate": 150.0,
        "unit": "m submergés",
    },
    "vegetation": {
        "label": "Végétation / arbres",
        "field": "brokenTrees",
        "high": 5.0,
        "moderate": 2.0,
        "unit": "arbres cassés",
    },
}


def risk_level_for(category: str, value: float) -> str:
    spec = CATEGORY_RISK[category]
    if value >= spec["high"]:
        return "High"
    if value >= spec["moderate"]:
        return "Moderate"
    return "Low"