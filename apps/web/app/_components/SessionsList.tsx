'use client';
import { useState } from 'react';
import type { SessionInfo } from '@alfred/core/shared';

export function SessionsList({ initial }: { initial: SessionInfo[] }) {
  const [items, setItems] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  async function revoke(id: string) {
    setError(null);
    try {
      const res = await fetch(`/api/me/sessions/${id}`, { method: 'DELETE' });
      if (res.status === 204 || res.status === 404) setItems((l) => l.filter((s) => s.id !== id));
      else setError('La session n’a pas pu être révoquée.');
    } catch {
      setError('Impossible de joindre le serveur.');
    }
  }

  return (
    <div className="card">
      {error && <div className="alert error" role="alert">{error}</div>}
      <ul className="plain" aria-label="Sessions ouvertes">
        {items.map((s) => (
          <li key={s.id}>
            <span>
              {s.current && <span className="badge">Cette session</span>} {s.userAgent ? s.userAgent.slice(0, 60) : 'Appareil inconnu'}
              <br />
              <span className="hint">Ouverte le {new Date(s.createdAt).toLocaleString('fr-FR')}</span>
            </span>
            {!s.current && <button className="danger" onClick={() => revoke(s.id)} aria-label={`Révoquer la session ouverte le ${new Date(s.createdAt).toLocaleString('fr-FR')}`}>Révoquer</button>}
          </li>
        ))}
      </ul>
    </div>
  );
}
