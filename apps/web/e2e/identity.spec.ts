import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { latestLinkFor } from './support';

const SHOTS = 'test-results/screens';
mkdirSync(SHOTS, { recursive: true });

test('identity journey (single browser context so cookies persist)', async ({ page, context }, info) => {
  const email = `e2e-${info.project.name}@example.test`;
  let firstLink = '';
  const shot = (pg: Page, name: string, project: string) => pg.screenshot({ path: `${SHOTS}/${name}-${project}.png`, fullPage: true });


  await test.step('anonymous visitor cannot see any private page', async () => {
    for (const path of ['/', '/settings', '/onboarding']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login$/);
    }
    await expect(page.getByRole('heading', { name: 'Connexion' })).toBeVisible();
    await shot(page, '01-login-empty', info.project.name);
  });

  await test.step('invalid e-mail shows an actionable error', async () => {
    await page.goto('/login');
    await page.getByLabel('Adresse e-mail').fill('pas-un-email');
    await page.getByRole('button', { name: 'Recevoir mon lien' }).click();
    await expect(page.locator('.alert.error')).toContainText('adresse e-mail valide');
    await shot(page, '02-login-error', info.project.name);
  });

  await test.step('magic link → onboarding (empty state), validation errors, completion', async () => {
    const p = info.project.name;
    const t0 = Date.now();
    await page.goto('/login');
    await page.getByLabel('Adresse e-mail').fill(email);
    await page.getByRole('button', { name: 'Recevoir mon lien' }).click();
    await expect(page.getByRole('heading', { name: 'Vérifie ta boîte mail' })).toBeVisible();
    await shot(page, '03-login-sent', p);

    firstLink = await latestLinkFor(email, t0);
    await page.goto(firstLink);
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByText("Aucun nom d'appel")).toBeVisible();
    await shot(page, '04-onboarding-empty', p);

    // alias validation (client) and server-side validation (missing first name, push not verifiable → must accept in-app only)
    await page.getByLabel('Ajouter un nom d’appel').fill('a');
    await page.getByRole('button', { name: 'Ajouter' }).click();
    await expect(page.locator('.alert.error')).toContainText('trop court');
    await page.getByRole('button', { name: 'Terminer la configuration' }).click();
    await expect(page.locator('.alert.error').last()).toContainText('Prénom');
    await shot(page, '05-onboarding-error', p);

    await page.getByLabel('Prénom').fill('Liam');
    await page.getByLabel('Ajouter un nom d’appel').fill('Éloïse');
    await page.getByRole('button', { name: 'Ajouter' }).click();
    await page.getByLabel('Ajouter un nom d’appel').fill('éloise');
    await page.getByRole('button', { name: 'Ajouter' }).click();
    await expect(page.locator('.alert.error').first()).toContainText('existe déjà');
    await page.getByLabel('Ajouter un nom d’appel').fill('Monsieur Pioline');
    await page.getByRole('button', { name: 'Ajouter' }).click();
    await page.getByLabel('Fuseau horaire de référence').selectOption('America/Toronto');
    await page.getByRole('button', { name: 'Terminer la configuration' }).click();
    await expect(page.locator('.alert.error').last()).toContainText('Push'); // not accepted yet → honest refusal
    await page.getByLabel(/J'accepte « application ouverte seulement »/).check();
    await page.getByRole('button', { name: 'Terminer la configuration' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: 'Bonjour Liam' })).toBeVisible();
    await expect(page.getByText('Alertes immédiates : non actives')).toBeVisible();
    await expect(page.getByText('Aucun cours programmé')).toBeVisible();
    await shot(page, '06-home-empty', p);
  });

  await test.step('settings show persisted values and the current session', async () => {
    await page.goto('/settings');
    await expect(page.getByLabel('Fuseau horaire de référence')).toHaveValue('America/Toronto');
    await expect(page.getByText('reconnu comme « eloise »')).toBeVisible();
    await expect(page.getByText('Cette session')).toBeVisible();
    await shot(page, '07-settings', info.project.name);
  });

  await test.step('used link is refused with a clear message; logout kills the session', async () => {
    await page.goto(firstLink); // already consumed
    await expect(page).toHaveURL(/\/login\?error=INVALID_TOKEN/);
    await expect(page.locator('.alert.error')).toContainText('invalide, expiré');
    await shot(page, '08-login-link-expired', info.project.name);

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Bonjour Liam' })).toBeVisible(); // session from the previous test is still alive
    await page.getByRole('button', { name: 'Se déconnecter' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/login$/);
  });

  await test.step('re-login restores preferences without onboarding', async () => {
    const t0 = Date.now();
    await page.goto('/login');
    await page.getByLabel('Adresse e-mail').fill(email);
    await page.getByRole('button', { name: 'Recevoir mon lien' }).click();
    await page.goto(await latestLinkFor(email, t0));
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: 'Bonjour Liam' })).toBeVisible();
    await page.goto('/settings');
    await expect(page.getByLabel('Prénom')).toHaveValue('Liam');
    await expect(page.getByLabel('Fuseau horaire de référence')).toHaveValue('America/Toronto');
    await expect(page.getByText('reconnu comme « monsieur pioline »')).toBeVisible();
    await shot(page, '09-settings-after-relogin', info.project.name);
  });

  await test.step('service down is explicit, not a blank page', async () => {
    await context.route('**/api/me/preferences', (r) => r.abort());
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.locator('.alert.error')).toContainText('Impossible de joindre le serveur');
  });
});
