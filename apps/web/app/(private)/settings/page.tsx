import { getPreferences, getSessions } from '../../_lib/server-api';
import { PreferencesForm } from '../../_components/PreferencesForm';
import { SessionsList } from '../../_components/SessionsList';

export default async function Settings() {
  const [prefs, sessions] = await Promise.all([getPreferences(), getSessions()]);
  if (prefs.status !== 'ok') return null;
  return (
    <main className="wrap">
      <h1>Paramètres</h1>
      <PreferencesForm initial={prefs.data} mode="settings" />
      <h2>Sessions ouvertes</h2>
      {sessions.status === 'ok' ? <SessionsList initial={sessions.data} /> : <div className="alert error" role="alert">Impossible de charger les sessions.</div>}
      <h2>Compte et données</h2>
      <p className="hint">Suppression du compte et des données : non disponible dans cette version (prévue avec la purge des données). Tu peux déjà te déconnecter et révoquer tes sessions.</p>
    </main>
  );
}
