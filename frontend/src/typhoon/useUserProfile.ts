import { useCallback, useState, useSyncExternalStore } from 'react';
import { MOCK_USER } from '../components/mockUser';
import type { UserProfile } from '../components/mockUser';

export type { UserProfile };

export const PROFILES: UserProfile[] = ['promoteur', 'assurance', 'banque'];

export const PROFILE_LABELS: Record<UserProfile, string> = {
  promoteur: 'Promoteur immobilier',
  assurance: 'Assurance',
  banque: 'Banque',
};

function readProfile(): UserProfile {
  try {
    const p = localStorage.getItem('typhoon-profile') as UserProfile | null;
    if (p && PROFILES.includes(p)) return p;
  } catch {
    /* localStorage unavailable */
  }
  return MOCK_USER.profile;
}

let profile: UserProfile = readProfile();
const listeners = new Set<() => void>();

function getSnapshot(): UserProfile {
  return profile;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setProfile(next: UserProfile) {
  profile = next;
  try {
    localStorage.setItem('typhoon-profile', next);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

/**
 * Setter module-level exposé pour synchroniser le profil depuis une source
 * externe (ex. Supabase user_metadata après restauration de session).
 */
export function setUserProfile(next: UserProfile) {
  setProfile(next);
}

/**
 * Profil métier de l'utilisateur (Phase A multi-profils). Persisté en
 * localStorage comme le thème ; retombe sur MOCK_USER.profile par défaut
 * (le promoteur reste la vue par défaut — rien ne change pour lui).
 */
export function useUserProfile() {
  const value = useSyncExternalStore(subscribe, getSnapshot);
  const [panelOpen, setPanelOpen] = useState(false);
  const changeProfile = useCallback((next: UserProfile) => {
    setProfile(next);
    setPanelOpen(false);
  }, []);
  return {
    profile: value,
    changeProfile,
    panelOpen,
    setPanelOpen,
  };
}

