# Rapport de stage — Typhoon

Rapport de stage (SummerCamp 2026, Talan) rédigé en LaTeX.

Version **courte** (29 pages) : le problème métier, la réponse technique,
l'architecture en diagrammes UML, les résultats mesurés, puis les points de
douleur qui subsistent avec leur remède.

La version longue précédente (13 chapitres, ~3 600 lignes) est conservée
telle quelle dans `archive-2026-10/` — archive hors vigueur, mais rien n'a été
perdu (elle contient notamment le tracé TikZ complet du logo Talan, réutilisé
ici via `logos/talan-logo.tex`).

## Structure

```
rapport/
  main.tex                  préambule, métadonnées, page de garde, inclusions
  logos/
    talan-logo.tex          logo Talan (tracé vectoriel, extrait de l'archive)
    README.md               où déposer le logo de l'école
  chapitres/
    01-introduction.tex     contexte, acteurs, périmètre et non-périmètre
    02-douleurs.tex         les 7 douleurs métier, en coûts et en risques
    03-reponse.tex          douleur → réponse, invariants, parcours en 4 étapes
    04-architecture.tex     composants + déploiement (UML), contrat, choix
    05-donnees.tex          diagramme de classes, provenance, volumétrie
    06-parcours.tex         cas d'usage + 2 séquences (diagnostic, prose)
    07-robustesse.tex       activité (dégradation) + états de l'absence TRI
    08-resultats.tex        chiffres mesurés, latences, suite de tests, quotas
    09-douleurs-restantes.tex  8 douleurs restantes → remèdes, décisions
    10-conclusion.tex       bilan et ce qui reste ouvert
  annexes/
    A-api.tex               surface d'API et codes de réponse
    B-sources.tex           sources, résolutions, licences, commandes
  archive-2026-10/          version longue (hors vigueur)
```

## Compilation

Le rapport compile avec **Tectonic** (moteur XeTeX, télécharge les paquets à la
demande) et avec XeLaTeX / pdfLaTeX grâce au garde-fou d'encodage du préambule :

```bash
cd rapport
tectonic -X compile main.tex          # recommandé : une seule passe
# ou
pdflatex main && pdflatex main        # deux passes pour le sommaire
# ou
latexmk -pdf main.tex
```

Contrôle de sortie : aucune erreur, aucun « Overfull \hbox » (les figures sont
plafonnées à `\textwidth` par la macro `\figbox`), et 29 pages.

## Page de garde

Toutes les informations académiques sont regroupées dans **un seul bloc** en
haut de `main.tex`, sous le commentaire `MÉTADONNÉES DU RAPPORT`. Modifiez
uniquement ce bloc :

| Macro | Contenu actuel |
|---|---|
| `\reportAuthor` | Hazem Mrad |
| `\reportSchool` / `\reportSchoolLong` | ESPRIT — École Supérieure Privée d'Ingénierie et de Technologie |
| `\reportDegree` / `\reportCycle` | Diplôme d'ingénieur — Cycle d'ingénieur |
| `\reportCompany` / `\reportCompanyLong` | Talan — Groupe Talan, conseil et ingénierie |
| `\reportProgramme` | SummerCamp 2026 |
| `\reportPeriod` | 14 août 2026 – 15 septembre 2026 |
| `\reportAcademicYear` | 2026–2027 |
| `\reportTutorAcademic` | pointillés (à remplir) |
| `\reportTutorCompany` | pointillés (à remplir) |

### À compléter avant impression

1. **Le logo de l'école** — déposez `esprit.png` dans `rapport/logos/`. Sans ce
   fichier, un cadre en pointillés s'affiche et le rapport compile quand même
   (voir [logos/README.md](logos/README.md)).
2. **Les deux tuteurs** — remplacez `\dotfill` par les noms.
3. **L'intitulé du diplôme et la période** — vérifiez qu'ils correspondent à
   votre convention de stage.

Le logo Talan est **déjà intégré** : tracé vectoriel en TikZ, donc net à toute
échelle et sans fichier externe.

## Figures

Les **huit diagrammes** sont dessinés en TikZ — aucune image externe, aucune
dépendance à PlantUML ou Graphviz. Types UML couverts : cas d'usage, composants,
classes, séquence (deux), activité, états, déploiement.

Les captures d'écran de `../docs/screenshots/` ne sont **pas** incluses : elles
datent du 14 septembre 2026 et l'interface a changé depuis (la console de risque
a été retirée le 8 octobre). Les régénérer avant de les remettre, sinon le
rapport montrerait une application qui n'existe plus.

## Notes de rédaction

- Les chiffres du rapport sont **mesurés**, pas estimés : latence du fournisseur
  de prose, nombre de tests, durée de la suite, quotas, états de dégradation
  observés. Ce qui n'a pas pu être mesuré est signalé comme tel dans le texte.
- Le chapitre 9 distingue explicitement les douleurs **résolues** (chapitre 2)
  des douleurs **restantes**, et chaque douleur restante porte son remède.
- Aucun score, aucune bande de risque, aucune recommandation générée n'apparaît
  dans le document — c'est un invariant du produit, appliqué aussi au rapport.
