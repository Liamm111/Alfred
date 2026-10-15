import { redirect } from 'next/navigation';
import { getPreferences } from '../../_lib/server-api';
import { PreferencesForm } from '../../_components/PreferencesForm';

export default async function Onboarding() {
  const prefs = await getPreferences();
  if (prefs.status !== 'ok') return null;
  if (prefs.data.onboardingCompleted) redirect('/');
  return (
    <main className="wrap">
      <h1>Bienvenue — configure ton assistant</h1>
      <p className="hint">Deux minutes. Tu pourras tout modifier ensuite dans Paramètres.</p>
      <PreferencesForm initial={prefs.data} mode="onboarding" />
    </main>
  );
}
