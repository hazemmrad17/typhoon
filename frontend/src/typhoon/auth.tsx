// =============================================================================
//   TYPHOON — Authentification Supabase (SPA, pas de Next.js)
//   Client navigateur @supabase/supabase-js + contexte React :
//     - session restaurée au chargement (getSession + onAuthStateChange)
//     - user dérivé (nom, initiales, email, org, tier, profil métier)
//     - signIn / signUp / signOut / resetPassword
//     - mode démo : si VITE_SUPABASE_* absents, l'app retombe sur MOCK_USER
//       (les tests jsdom et les environnements sans .env continuent de
//       fonctionner sans crash).
// =============================================================================

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { createClient } from '@supabase/supabase-js';
import type { User } from '@supabase/supabase-js';
import { MOCK_USER } from '../components/mockUser';
import type { UserProfile } from './useUserProfile';
import { setUserProfile } from './useUserProfile';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

/** Client Supabase (null si non configuré → mode démo). */
export const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

export interface AuthUser {
  id: string;
  name: string;
  initials: string;
  email: string;
  organization: string;
  tier: string;
  profile: UserProfile;
}

export interface AuthResult {
  error: string | null;
}

export interface AuthContextValue {
  /** Utilisateur connecté — null si non authentifié (mode réel). */
  user: AuthUser | null;
  /** Restauration de session en cours. */
  loading: boolean;
  /** true si Supabase n'est pas configuré → app en mode démo (MOCK_USER). */
  demo: boolean;
  signIn: (email: string, password: string) => Promise<AuthResult>;
  signUp: (email: string, password: string, fullName?: string) => Promise<AuthResult>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<AuthResult>;
  updatePassword: (password: string) => Promise<AuthResult>;
}

/* ── MOCK_USER → AuthUser (mode démo / fallback UI) ── */
function mockToAuthUser(): AuthUser {
  return {
    id: 'demo-user',
    name: MOCK_USER.name,
    initials: MOCK_USER.initials,
    email: MOCK_USER.email,
    organization: MOCK_USER.organization,
    tier: MOCK_USER.tier,
    profile: MOCK_USER.profile,
  };
}

function readLocalProfile(): UserProfile {
  try {
    const p = localStorage.getItem('typhoon-profile') as UserProfile | null;
    if (p && ['promoteur', 'assurance', 'banque'].includes(p)) return p;
  } catch {
    /* ignore */
  }
  return MOCK_USER.profile;
}

function toAuthUser(u: User): AuthUser {
  const meta = u.user_metadata ?? {};
  const name =
    (meta.full_name as string) ||
    (meta.name as string) ||
    (u.email ? u.email.split('@')[0] : '') ||
    'Utilisateur';
  const initials =
    name
      .split(/\s+/)
      .map((p) => p[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || (u.email ? u.email[0].toUpperCase() : '?');
  return {
    id: u.id,
    name,
    initials,
    email: u.email ?? '',
    organization: (meta.organization as string) || MOCK_USER.organization,
    tier: (meta.tier as string) || MOCK_USER.tier,
    profile: (meta.profile as UserProfile) || readLocalProfile(),
  };
}

function friendlyAuthError(message: string | undefined): string {
  if (!message) return 'Une erreur est survenue.';
  const m = message.toLowerCase();
  if (m.includes('invalid login credentials')) return 'E-mail ou mot de passe incorrect.';
  if (m.includes('email not confirmed')) return 'Adresse e-mail non confirmée — vérifiez votre boîte mail.';
  if (m.includes('already registered')) return 'Un compte existe déjà avec cette adresse e-mail.';
  if (m.includes('password should be at least')) return 'Le mot de passe doit contenir au moins 6 caractères.';
  if (m.includes('rate limit')) return 'Trop de tentatives — patientez quelques secondes.';
  if (m.includes('network')) return 'Problème de connexion au serveur d’authentification.';
  return message;
}

/* ── Contexte — valeur par défaut : mode démo (MOCK_USER connecté) ── */
const DEFAULT_VALUE: AuthContextValue = {
  user: mockToAuthUser(),
  loading: false,
  demo: true,
  signIn: async () => ({ error: 'Authentification non configurée (mode démo).' }),
  signUp: async () => ({ error: 'Authentification non configurée (mode démo).' }),
  signOut: async () => {},
  resetPassword: async () => ({ error: 'Authentification non configurée (mode démo).' }),
  updatePassword: async () => ({ error: 'Authentification non configurée (mode démo).' }),
};

const AuthContext = createContext<AuthContextValue>(DEFAULT_VALUE);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(() => (supabase ? null : mockToAuthUser()));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    let mounted = true;
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!mounted) return;
        const u = data.session?.user ?? null;
        setUser(u ? toAuthUser(u) : null);
        if (u?.user_metadata?.profile) setUserProfile(u.user_metadata.profile as UserProfile);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      const u = session?.user ?? null;
      setUser(u ? toAuthUser(u) : null);
      if (u?.user_metadata?.profile) setUserProfile(u.user_metadata.profile as UserProfile);
      setLoading(false);
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string): Promise<AuthResult> => {
    if (!supabase) return { error: 'Authentification non configurée (mode démo).' };
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error ? friendlyAuthError(error.message) : null };
  }, []);

  const signUp = useCallback(
    async (email: string, password: string, fullName?: string): Promise<AuthResult> => {
      if (!supabase) return { error: 'Authentification non configurée (mode démo).' };
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: fullName ? { data: { full_name: fullName } } : undefined,
      });
      return { error: error ? friendlyAuthError(error.message) : null };
    },
    []
  );

  const signOut = useCallback(async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
  }, []);

  const resetPassword = useCallback(async (email: string): Promise<AuthResult> => {
    if (!supabase) return { error: 'Authentification non configurée (mode démo).' };
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/login`,
    });
    return { error: error ? friendlyAuthError(error.message) : null };
  }, []);

  const updatePassword = useCallback(async (password: string): Promise<AuthResult> => {
    if (!supabase) return { error: 'Authentification non configurée (mode démo).' };
    const { error } = await supabase.auth.updateUser({ password });
    return { error: error ? friendlyAuthError(error.message) : null };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      demo: !supabase,
      signIn,
      signUp,
      signOut,
      resetPassword,
      updatePassword,
    }),
    [user, loading, signIn, signUp, signOut, resetPassword, updatePassword]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Hook d'authentification — toujours sûr (retourne le mode démo sans provider). */
export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
