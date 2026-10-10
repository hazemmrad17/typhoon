# Logos de la page de garde

## Logo de l'école (ESPRIT)

Déposez le fichier dans ce dossier sous **exactement** l'un de ces noms :

- `esprit.png`  ← recommandé
- `esprit.jpg`
- `esprit.pdf`

La page de garde détecte automatiquement le fichier et l'insère à la place du
cadre en pointillés. Aucune modification de `main.tex` n'est nécessaire.

Tant qu'aucun fichier n'est présent, un cadre explicite s'affiche à la place :

```
┌ ─ ─ ─ ─ ─ ─ ─ ┐
   Logo de l'école
   à déposer dans
     logos/
└ ─ ─ ─ ─ ─ ─ ─ ┘
```

Le rapport compile dans tous les cas.

### Conseils

- **Fond transparent** : le logo est posé sur un fond blanc, donc préférez un
  PNG à fond transparent ou une version en couleurs sur blanc.
- **Hauteur** : le logo est inséré à `2.3 cm` de haut. Un fichier d'environ
  600 px de haut suffit largement pour l'impression.
- **Proportions** : la largeur n'est pas contrainte, un logo très large peut
  dépasser. Si besoin, ajustez l'appel `\reportSchoolLogo[2.3cm]` dans
  `main.tex`, ou remplacez par `\reportSchoolLogo[2.0cm]`.

## Logo Talan

Il est **déjà intégré** et n'a pas besoin de fichier : il est vectorisé
directement en TikZ dans `main.tex`, à partir du SVG officiel présent dans le
dépôt (`frontend/public/vetter-consulting/assets/img/talan-logo-white.svg`).

Le tracé est blanc, donc affiché sur le bandeau bleu foncé en haut de la page de
garde. Il est net à n'importe quel niveau de zoom et ne dépend d'aucun fichier
externe.
