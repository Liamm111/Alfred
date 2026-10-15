// Service worker Alfred. iOS/Safari exige qu'un push affiche TOUJOURS une notification visible (sinon l'abonnement est révoqué).
'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch { p = {}; }
  const urgent = p.level === 'urgent';
  const title = p.title || 'Alfred';
  const options = {
    body: p.body || '',
    tag: p.tag || 'alfred',          // une notification par question : la rétractation / l'upgrade REMPLACE la précédente
    renotify: p.kind !== 'retract',  // re-sonner sur un upgrade, pas sur l'annulation
    requireInteraction: urgent,
    data: { token: p.delivery_token || null, title, body: p.body || '', zoom: p.open_url || null },
  };
  const ack = p.delivery_token
    ? fetch('/api/ack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: p.delivery_token }), keepalive: true }).catch(() => {})
    : Promise.resolve();
  event.waitUntil(Promise.all([self.registration.showNotification(title, options), ack]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  // On n'ouvre QUE notre propre page (même origine). Zoom n'est ouvert que par un toucher sur le lien de cette page.
  const params = new URLSearchParams();
  if (d.token) params.set('t', d.token);
  if (d.title) params.set('title', d.title);
  if (d.body) params.set('body', d.body);
  if (d.zoom) params.set('zoom', d.zoom);
  event.waitUntil(self.clients.openWindow('/?' + params.toString()));
});
