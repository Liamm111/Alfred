import { RtmsController } from './rtms-controller.js';
import { createAssociationClient } from './association-client.js';

const BACKEND = document.querySelector('meta[name="alfred-backend"]')?.content ?? '';
const LABELS = {
  initializing: 'Initialisation…', unavailable: 'Zoom Apps indisponible : ouvrez cette app dans le client Zoom Desktop.',
  guest: 'Mode invité : RTMS indisponible. Connectez-vous à Zoom.', not_in_meeting: 'Ouvrez cette app pendant une réunion.',
  unsupported: 'Version de Zoom trop ancienne ou RTMS non supporté.', ready: 'Prêt. Rien n’est démarré tant que vous ne cliquez pas.',
  associating: 'Association de la session…', awaiting_host: 'En attente de l’approbation de l’hôte…',
  started: 'RTMS actif.', paused: 'RTMS en pause.', denied: 'Refusé par l’hôte.', disabled: 'RTMS désactivé (compte/hôte/admin).',
  timeout: 'Pas de réponse de l’hôte (délai dépassé).', association_failed: 'Association refusée : code expiré ou invalide.',
  stopped: 'RTMS arrêté.', error: 'Erreur inattendue.',
};
const $ = (id) => document.getElementById(id);
const ctl = new RtmsController({
  zoomSdk: globalThis.zoomSdk, association: createAssociationClient({ baseUrl: BACKEND }),
  onChange: (state) => {
    $('status').textContent = LABELS[state] ?? state; $('status').dataset.state = state;
    $('start').disabled = !['ready', 'stopped', 'denied', 'timeout', 'association_failed'].includes(state);
    $('stop').disabled = !['started', 'paused', 'awaiting_host'].includes(state);
  },
});
const param = new URLSearchParams(location.search).get('n'); if (param) $('nonce').value = param.toUpperCase();
$('start').addEventListener('click', () => ctl.requestStart({ nonce: $('nonce').value.trim().toUpperCase() }));
$('stop').addEventListener('click', () => ctl.stop());
ctl.init();
globalThis.__alfredCtl = ctl; // used by the MANUAL_REAL_ZOOM participant-list check
