import { redirect } from 'next/navigation';
import { getMe, getPreferences } from '../_lib/server-api';

export default async function Home() {
  const [me, prefs] = await Promise.all([getMe(), getPreferences()]);
  if (me.status !== 'ok' || prefs.status !== 'ok') return null; // layout already handled anon/down
  if (!me.data.onboardingCompleted) redirect('/onboarding');
  const name = prefs.data.firstName;
  return (
    <main className="wrap">
      <h1>Bonjour {name}</h1>
      <div className="alert warn" role="status">
        <strong>Alertes immédiates : non actives.</strong> Les notifications Push ne sont pas encore configurées ; tu as choisi « application ouverte seulement ». Aucune alerte ne te sera envoyée hors de cette application.
      </div>
      <section className="card" aria-labelledby="next">
        <h2 id="next" style={{ marginTop: 0 }}>Prochain cours</h2>
        <p className="empty">Aucun cours programmé. La programmation de cours n&apos;est pas encore disponible dans cette version.</p>
      </section>
      <section className="card" aria-labelledby="live">
        <h2 id="live" style={{ marginTop: 0 }}>Cours en direct</h2>
        <p className="empty">Aucun cours en cours : l&apos;assistant ne suit rien actuellement.</p>
      </section>
      <section className="card" aria-labelledby="last">
        <h2 id="last" style={{ marginTop: 0 }}>Derniers cours</h2>
        <p className="empty">Aucun cours terminé, donc aucun compte rendu.</p>
      </section>
      <section className="card" aria-labelledby="todo">
        <h2 id="todo" style={{ marginTop: 0 }}>Travaux à faire</h2>
        <p className="empty">Aucun devoir détecté.</p>
      </section>
    </main>
  );
}
