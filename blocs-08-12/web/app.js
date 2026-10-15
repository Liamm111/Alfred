// PWA Alfred — onboarding Web Push. Règle : AUCUNE demande de permission, AUCUN abonnement et AUCUNE ouverture de Zoom
// sans un geste explicite de l'utilisateur (clic sur « Activer » / sur « Ouvrir Zoom »).
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const ua = navigator.userAgent || '';
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* navigation privée */ } },
  };

  // Jeton d'appairage donné dans le fragment (#pair=…) : jamais envoyé au serveur par la navigation, retiré de l'URL.
  const m = /pair=([\w-]+)/.exec(location.hash);
  if (m) { store.set('pair', m[1]); history.replaceState(null, '', location.pathname + location.search); }

  function render() {
    $('st-device').textContent = isIOS ? (standalone ? 'iPhone — app installée' : 'iPhone — non installée') : 'Navigateur';
    $('st-perm').textContent = 'Notification' in window ? ({ default: 'pas encore demandée', granted: 'accordée', denied: 'refusée' }[Notification.permission] ?? Notification.permission) : 'non supportée';
    const btn = $('enable-btn');
    $('ios-install').hidden = !(isIOS && !standalone);
    if (!supported) { btn.disabled = true; $('enable-msg').textContent = "Ce navigateur ne gère pas les notifications push."; return; }
    if (isIOS && !standalone) { btn.disabled = true; $('enable-msg').textContent = "Installez d'abord l'app sur l'écran d'accueil (étape 1)."; return; }
    if (!store.get('pair')) { btn.disabled = true; $('enable-msg').textContent = "Ouvrez le lien d'appairage affiché par l'app Mac."; return; }
    if (Notification.permission === 'denied') { btn.disabled = true; $('enable-msg').textContent = "Refusé. Réglages › Notifications › Alfred pour réactiver."; return; }
    btn.disabled = false;
  }

  async function enable() {
    const msg = $('enable-msg'); const btn = $('enable-btn'); btn.disabled = true;
    try {
      const perm = await Notification.requestPermission(); // seule demande de permission du code, déclenchée par le clic
      if (perm !== 'granted') { msg.textContent = 'Autorisation non accordée.'; render(); return; }
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const { key } = await (await fetch('/api/vapid-public-key')).json();
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const r = await fetch('/api/subscribe', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + store.get('pair') }, body: JSON.stringify({ subscription: sub.toJSON() }) });
      msg.textContent = r.ok ? 'Notifications activées sur cet appareil.' : 'Échec de l’enregistrement (' + r.status + ').';
      $('st-sub').textContent = r.ok ? 'enregistrée' : 'refusée par le serveur';
    } catch (e) { msg.textContent = 'Erreur : ' + (e && e.message ? e.message : e); }
    render();
  }

  $('enable-btn').addEventListener('click', enable);

  // Page ouverte depuis une notification : afficher la demande, signaler « vu ». Zoom reste derrière un toucher.
  const q = new URLSearchParams(location.search);
  if (q.get('t')) {
    fetch('/api/seen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: q.get('t') }), keepalive: true }).catch(() => {});
    $('alert').hidden = false;
    $('alert-title').textContent = q.get('title') || 'Vous êtes sollicité';
    $('alert-body').textContent = q.get('body') || '';
    const z = q.get('zoom');
    if (z && /^https:\/\/([\w-]+\.)?zoom\.us\/j\/\d+/.test(z)) { const a = $('open-zoom'); a.href = z; a.hidden = false; }
  }
  render();
})();
