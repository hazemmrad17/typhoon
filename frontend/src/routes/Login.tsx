// =============================================================================
//   TYPHOON — /login : authentification Supabase (connexion / inscription /
//   mot de passe oublié). Style Material 3 aligné sur le reste de l'app
//   (tokens --md-sys-* du thème). Mode démo (Supabase non configuré) :
//   un bouton « Continuer en démo » permet de passer sans compte.
// =============================================================================

import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../typhoon/auth';
import { useTyphoonTheme } from '../typhoon/useTyphoonTheme';

type Mode = 'signin' | 'signup' | 'reset';

export function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, loading, demo, signIn, signUp, resetPassword } = useAuth();
  const { theme } = useTyphoonTheme();

  const from = (location.state as { from?: string } | null)?.from;

  const [mode, setMode] = useState<Mode>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /* Ref pour chaque champ — le `input` de Lit est dans un shadow DOM ; le
     onInput de React ne le capte pas (même limite que le champ adresse de
     /zone). On écoute l'événement nativement au montage. */
  const nameRef = useRef<HTMLElement | null>(null);
  const emailRef = useRef<HTMLElement | null>(null);
  const passwordRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const bind = (ref: React.RefObject<HTMLElement | null>, setter: (v: string) => void) => {
      const el = ref.current;
      if (!el) return;
      const onInput = () => setter((el as unknown as { value: string }).value);
      el.addEventListener('input', onInput);
      return () => el.removeEventListener('input', onInput);
    };
    const unsubs = [
      bind(nameRef, setName),
      bind(emailRef, setEmail),
      bind(passwordRef, setPassword),
    ];
    return () => unsubs.forEach((u) => u?.());
  }, [mode]);

  /* Déjà connecté → retour à la page d'origine (ou dashboard). */
  useEffect(() => {
    if (!loading && user && !demo) {
      navigate(from || '/dashboard', { replace: true });
    }
  }, [user, loading, demo, from, navigate]);

  const switchMode = (m: Mode) => {
    setMode(m);
    setError(null);
    setNotice(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);

    if (mode === 'reset') {
      if (!email.trim()) {
        setError('Saisissez votre adresse e-mail.');
        return;
      }
      setBusy(true);
      const { error: err } = await resetPassword(email.trim());
      setBusy(false);
      if (err) setError(err);
      else {
        setNotice('Un lien de réinitialisation vient d’être envoyé à votre adresse e-mail.');
        setMode('signin');
      }
      return;
    }

    if (!email.trim() || !password) {
      setError('Renseignez votre e-mail et votre mot de passe.');
      return;
    }

    setBusy(true);
    if (mode === 'signin') {
      const { error: err } = await signIn(email.trim(), password);
      setBusy(false);
      if (err) setError(err);
      /* Succès : onAuthStateChange met à jour le user → l'effet ci-dessus navigue. */
    } else {
      const { error: err } = await signUp(email.trim(), password, name.trim() || undefined);
      setBusy(false);
      if (err) setError(err);
      else {
        setNotice(
          'Compte créé ! Un e-mail de confirmation a été envoyé — vérifiez votre boîte de réception, puis connectez-vous.'
        );
        setMode('signin');
        setPassword('');
      }
    }
  };

  const title =
    mode === 'signin'
      ? 'Connexion'
      : mode === 'signup'
        ? 'Créer un compte'
        : 'Réinitialiser le mot de passe';

  return (
    <main
      className={`login-page${theme === 'light' ? ' theme-light' : ''}`}
      data-theme={theme}
    >
      <div className="login-shell">
        <div className="login-card">
          <div className="login-brand">
            <span className="login-wordmark" aria-hidden="true" />
            <h1>{title}</h1>
            <p className="login-sub">
              {mode === 'signin'
                ? 'Accédez à vos diagnostics, portfolio et watchlist.'
                : mode === 'signup'
                  ? 'Créez votre compte pour démarrer.'
                  : 'Entrez votre e-mail pour recevoir un lien.'}
            </p>
          </div>

          {error && (
            <div className="login-alert login-alert--error" role="alert">
              <md-icon>error</md-icon>
              <span>{error}</span>
            </div>
          )}
          {notice && (
            <div className="login-alert login-alert--notice" role="status">
              <md-icon>info</md-icon>
              <span>{notice}</span>
            </div>
          )}

          <form className="login-form" onSubmit={submit}>
            {mode === 'signup' && (
              <md-outlined-text-field
                ref={nameRef}
                label="Nom complet"
                type="text"
                autocomplete="name"
              />
            )}

            <md-outlined-text-field
              ref={emailRef}
              label="Adresse e-mail"
              type="email"
              autocomplete="email"
            />

            {mode !== 'reset' && (
              <md-outlined-text-field
                ref={passwordRef}
                label="Mot de passe"
                type="password"
                autocomplete={mode === 'signin' ? 'current-password' : 'new-password'}
              />
            )}

            <md-filled-button
              className="login-submit"
              type="submit"
              disabled={busy}
            >
              {busy
                ? 'Un instant…'
                : mode === 'signin'
                  ? 'Se connecter'
                  : mode === 'signup'
                    ? 'Créer le compte'
                    : 'Envoyer le lien'}
            </md-filled-button>
          </form>

          {mode === 'signin' && (
            <button
              type="button"
              className="login-link"
              onClick={() => switchMode('reset')}
            >
              Mot de passe oublié ?
            </button>
          )}

          <div className="login-switch">
            {mode !== 'reset' ? (
              <button type="button" className="login-link" onClick={() => switchMode(mode === 'signin' ? 'signup' : 'signin')}>
                {mode === 'signin' ? 'Pas encore de compte ? Créer un compte' : 'Déjà un compte ? Se connecter'}
              </button>
            ) : (
              <button type="button" className="login-link" onClick={() => switchMode('signin')}>
                Retour à la connexion
              </button>
            )}
          </div>

          {demo && (
            <div className="login-demo">
              <md-icon>science</md-icon>
              <div>
                <strong>Mode démo</strong>
                <span>Authentification non configurée — continuez sans compte.</span>
              </div>
              <md-filled-button onClick={() => navigate(from || '/dashboard', { replace: true })}>
                Continuer en démo
              </md-filled-button>
            </div>
          )}
        </div>

        <button type="button" className="login-back" onClick={() => navigate('/')}>
          <md-icon>arrow_back</md-icon>
          Retour à l’accueil
        </button>
      </div>
    </main>
  );
}
