'use client';
import { useMemo, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { normalizeAlias, MAX_ALIASES, type Preferences } from '@alfred/core/shared';

type Status = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string };

const FIELD_LABELS: Record<string, string> = { firstName: 'Prénom', aliases: 'Noms d’appel', timezone: 'Fuseau horaire', alertPreferences: 'Alertes', retentionVerbatimDays: 'Rétention des transcriptions', retentionSummaryDays: 'Rétention des résumés' };
function friendly(message?: string): string {
  if (!message) return 'Enregistrement impossible.';
  const m = /^([A-Za-z]+)(?:\.\d+)?: (.*)$/.exec(message);
  return m && m[1] && FIELD_LABELS[m[1]] ? `${FIELD_LABELS[m[1]]} : ${m[2]}` : message;
}

function timezones(): string[] {
  const list = Intl.supportedValuesOf('timeZone');
  return list.includes('UTC') ? list : ['UTC', ...list];
}

export function PreferencesForm({ initial, mode }: { initial: Preferences; mode: 'onboarding' | 'settings' }) {
  const router = useRouter();
  const [firstName, setFirstName] = useState(initial.firstName);
  const [aliases, setAliases] = useState<string[]>(initial.aliases.map((a) => a.raw));
  const [aliasDraft, setAliasDraft] = useState('');
  const [aliasError, setAliasError] = useState<string | null>(null);
  const [timezone, setTimezone] = useState(initial.timezone);
  const [summaryLanguage, setSummaryLanguage] = useState(initial.summaryLanguage);
  const [privacy, setPrivacy] = useState(initial.alertPreferences.notificationPrivacy);
  const [acceptInApp, setAcceptInApp] = useState(initial.alertPreferences.acceptInAppOnly);
  const [verbatimDays, setVerbatimDays] = useState(String(initial.retentionVerbatimDays));
  const [summaryDays, setSummaryDays] = useState(String(initial.retentionSummaryDays));
  const [version, setVersion] = useState<number | undefined>(initial.isDefault ? undefined : initial.version);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const zones = useMemo(timezones, []);

  function addAlias() {
    const v = aliasDraft.trim().replace(/\s+/g, ' ');
    if (v.length < 2) return setAliasError('Alias trop court (2 caractères minimum).');
    if (aliases.length >= MAX_ALIASES) return setAliasError(`${MAX_ALIASES} alias maximum.`);
    if (aliases.some((a) => normalizeAlias(a) === normalizeAlias(v))) return setAliasError('Cet alias existe déjà (sans tenir compte des accents/majuscules).');
    setAliases([...aliases, v]);
    setAliasDraft('');
    setAliasError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setStatus({ kind: 'saving' });
    const body = {
      firstName,
      aliases,
      locale: 'fr',
      summaryLanguage,
      timezone,
      // Push cannot be verified yet in this version: the only honest mode is "in-app only", accepted explicitly.
      alertPreferences: { mode: 'in_app_only', notificationPrivacy: privacy, acceptInAppOnly: acceptInApp },
      retentionVerbatimDays: Number(verbatimDays),
      retentionSummaryDays: Number(summaryDays),
      completeOnboarding: mode === 'onboarding',
      ...(version !== undefined ? { version } : {}),
    };
    try {
      const res = await fetch('/api/me/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (res.status === 401) return void window.location.assign('/login');
      const json = (await res.json()) as { message?: string; version?: number };
      if (!res.ok) return setStatus({ kind: 'error', message: friendly(json.message) });
      setVersion(json.version);
      setStatus({ kind: 'saved' });
      if (mode === 'onboarding') {
        router.push('/');
        router.refresh();
      }
    } catch {
      setStatus({ kind: 'error', message: 'Impossible de joindre le serveur. Tes saisies sont conservées ; réessaie.' });
    }
  }

  return (
    <form onSubmit={submit} noValidate aria-label="Préférences">
      <div className="field">
        <label htmlFor="firstName">Prénom</label>
        <input id="firstName" type="text" autoComplete="given-name" value={firstName} onChange={(e) => setFirstName(e.target.value)} required />
        <span className="hint">Utilisé pour reconnaître quand on t&apos;appelle pendant le cours. L&apos;assistant ne parle jamais à ta place.</span>
      </div>

      <fieldset>
        <legend>Noms d&apos;appel</legend>
        <p className="hint">Les noms par lesquels un enseignant pourrait t&apos;interpeller (prénom, nom, surnom, prononciation approximative). Comparaison exacte, sans accents ni majuscules.</p>
        <div className="row">
          <input id="aliasDraft" type="text" aria-label="Ajouter un nom d’appel" value={aliasDraft} onChange={(e) => setAliasDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addAlias(); } }} aria-describedby="alias-error" />
          <button type="button" className="secondary" onClick={addAlias}>Ajouter</button>
        </div>
        <div id="alias-error" aria-live="polite">{aliasError && <div className="alert error" role="alert">{aliasError}</div>}</div>
        {aliases.length === 0 ? (
          <p className="empty">Aucun nom d&apos;appel : sans alias, aucune sollicitation ne pourra être détectée.</p>
        ) : (
          <ul className="chips" aria-label="Noms d’appel enregistrés">
            {aliases.map((a) => (
              <li key={a}>
                <span>{a} <span className="hint">(reconnu comme « {normalizeAlias(a)} »)</span></span>
                <button type="button" className="secondary" aria-label={`Retirer l’alias ${a}`} onClick={() => setAliases(aliases.filter((x) => x !== a))}>×</button>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      <div className="field">
        <label htmlFor="timezone">Fuseau horaire de référence</label>
        <select id="timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
          {zones.map((z) => <option key={z} value={z}>{z}</option>)}
        </select>
      </div>

      <div className="field">
        <label htmlFor="locale">Langue de l&apos;interface</label>
        <select id="locale" value="fr" disabled aria-describedby="locale-hint"><option value="fr">Français</option></select>
        <span id="locale-hint" className="hint">Seul le français est disponible dans cette version.</span>
      </div>
      <div className="field">
        <label htmlFor="summaryLanguage">Langue des résumés</label>
        <select id="summaryLanguage" value={summaryLanguage} onChange={(e) => setSummaryLanguage(e.target.value as 'fr' | 'en')}>
          <option value="fr">Français</option>
          <option value="en">English</option>
        </select>
      </div>

      <fieldset>
        <legend>Alertes</legend>
        <div className="alert warn" role="note">
          Les notifications Push (alerte immédiate sur iPhone) ne sont <strong>pas encore disponibles</strong>. Tu seras prévenu <strong>dans l&apos;application seulement</strong>, sans garantie d&apos;instantanéité.
        </div>
        <label className="choice">
          <input type="checkbox" checked={acceptInApp} onChange={(e) => setAcceptInApp(e.target.checked)} />
          <span>J&apos;accepte « application ouverte seulement » (alertes non instantanées){mode === 'onboarding' ? ' — obligatoire pour continuer' : ''}.</span>
        </label>
        <div className="field">
          <label htmlFor="privacy">Aperçu des notifications</label>
          <select id="privacy" value={privacy} onChange={(e) => setPrivacy(e.target.value as 'discreet' | 'detailed')}>
            <option value="discreet">Discret (recommandé) : « On te sollicite pendant ton cours »</option>
            <option value="detailed">Détaillé : extrait de la question visible sur l’écran verrouillé</option>
          </select>
          {privacy === 'detailed' && <span className="hint" role="note">Attention : le texte de la question pourrait être lu par une personne proche de ton téléphone.</span>}
        </div>
      </fieldset>

      <fieldset>
        <legend>Rétention</legend>
        <div className="field">
          <label htmlFor="verbatim">Transcriptions (jours, 1–365)</label>
          <input id="verbatim" type="number" min={1} max={365} inputMode="numeric" value={verbatimDays} onChange={(e) => setVerbatimDays(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="summaryDays">Résumés et devoirs (jours, 1–1095)</label>
          <input id="summaryDays" type="number" min={1} max={1095} inputMode="numeric" value={summaryDays} onChange={(e) => setSummaryDays(e.target.value)} />
          <span className="hint">Valeurs par défaut proposées : 30 / 90 jours, à confirmer selon la base légale applicable.</span>
        </div>
      </fieldset>

      <div aria-live="polite">
        {status.kind === 'error' && <div className="alert error" role="alert">{status.message}</div>}
        {status.kind === 'saved' && mode === 'settings' && <div className="alert ok" role="status">Préférences enregistrées.</div>}
      </div>
      <button type="submit" disabled={status.kind === 'saving'}>
        {status.kind === 'saving' ? 'Enregistrement…' : mode === 'onboarding' ? 'Terminer la configuration' : 'Enregistrer'}
      </button>
    </form>
  );
}
