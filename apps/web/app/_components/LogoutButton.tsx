'use client';
import { useState } from 'react';

export function LogoutButton() {
  const [busy, setBusy] = useState(false);
  async function logout() {
    setBusy(true);
    try {
      await fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    } finally {
      window.location.assign('/login');
    }
  }
  return <button className="secondary" onClick={logout} disabled={busy} aria-label="Se déconnecter">{busy ? 'Déconnexion…' : 'Se déconnecter'}</button>;
}
