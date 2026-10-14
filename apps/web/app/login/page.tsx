'use client';
import { Suspense, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';

type State = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent'; email: string } | { kind: 'error'; message: string };

const URL_ERRORS: Record<string, string> = {
  INVALID_TOKEN: "Ce lien de connexion est invalide, expiré (15 minutes) ou déjà utilisé. Demande un nouveau lien.",
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function LoginForm() {
  const params = useSearchParams();
  const urlError = params.get('error');
  const [email, setEmail] = useState('');
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = email.trim();
    if (!EMAIL_RE.test(value)) {
      setState({ kind: 'error', message: 'Saisis une adresse e-mail valide.' });
      return;
    }
    setState({ kind: 'sending' });
    try {
      const res = await fetch('/api/auth/sign-in/magic-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: value, callbackURL: '/', newUserCallbackURL: '/onboarding', errorCallbackURL: '/login' }),
      });
      if (res.ok) setState({ kind: 'sent', email: value });
      else if (res.status === 429) setState({ kind: 'error', message: 'Trop de demandes. Réessaie dans une minute.' });
      else if (res.status >= 500) setState({ kind: 'error', message: "Le service n'a pas pu envoyer l'e-mail. Réessaie plus tard." });
      else setState({ kind: 'error', message: 'Demande refusée. Recharge la page et réessaie.' });
    } catch {
      setState({ kind: 'error', message: 'Impossible de joindre le serveur. Vérifie ta connexion.' });
    }
  }

  return (
    <main className="wrap">
      <h1>Connexion</h1>
      {urlError && state.kind === 'idle' && <div className="alert error" role="alert">{URL_ERRORS[urlError] ?? 'La connexion a échoué. Demande un nouveau lien.'}</div>}
      {state.kind === 'sent' ? (
        <div className="card" role="status">
          <h2 style={{ marginTop: 0 }}>Vérifie ta boîte mail</h2>
          <p>
            Si l&apos;adresse <strong>{state.email}</strong> est correcte, un lien de connexion vient d&apos;être envoyé. Il est valable 15 minutes et ne fonctionne qu&apos;une fois.
          </p>
          <p className="hint">Rien reçu ? Regarde les indésirables, puis redemande un lien.</p>
          <button className="secondary" onClick={() => setState({ kind: 'idle' })}>Utiliser une autre adresse / renvoyer</button>
        </div>
      ) : (
        <form onSubmit={submit} noValidate className="card">
          <div className="field">
            <label htmlFor="email">Adresse e-mail</label>
            <input id="email" name="email" type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-describedby="email-help email-error" aria-invalid={state.kind === 'error'} required />
            <span id="email-help" className="hint">Pas de mot de passe : nous t&apos;envoyons un lien de connexion à usage unique.</span>
          </div>
          <div id="email-error" aria-live="polite">{state.kind === 'error' && <div className="alert error" role="alert">{state.message}</div>}</div>
          <button type="submit" disabled={state.kind === 'sending'}>{state.kind === 'sending' ? 'Envoi…' : 'Recevoir mon lien'}</button>
        </form>
      )}
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
