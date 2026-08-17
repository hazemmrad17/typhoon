/**
 * Utilisateur simulé (aucune donnée réelle) — partagé entre la sidenav du
 * /zone (pied d'écran) et la page « Paramètres du compte ».
 *
 * L'ancienne « coquille application » (barre latérale globale avec footer
 * mavatar) a été supprimée : le produit vit dans la landing, /zone, le
 * viewer BIM et la page de paramètres seule.
 *
 * `profile` pilote la vue /zone (Phase A multi-profils) : ordre du stepper,
 * features (FEATURES[profile] dans Zone.tsx) et entrées de sidenav. Le
 * promoteur reste la vue par défaut — rien ne change pour lui.
 */

export type UserProfile = 'promoteur' | 'assurance' | 'banque';

export const MOCK_USER = {
  name: 'Julien Martin',
  initials: 'JM',
  email: 'julien.martin@typhoon.fr',
  organization: 'Typhon SARL',
  tier: 'Pro',
  profile: 'promoteur' as UserProfile,
};
