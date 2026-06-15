/**
 * notifications.js — Smash YUZU
 * Petits encarts ("toasts") in-page, en haut à gauche de l'écran, + son, pour :
 *   • Challenge reçu via "Find a Player"  (event socket : dashboard_update → challenges_received)
 *   • Nouveau message DM / chat de match  (event socket : dm_message / chat_message)
 *
 * Cliquer sur un encart redirige :
 *   • Challenge reçu      → /dashboard
 *   • Message reçu        → /dm/<other_id>
 *
 * Ce fichier est inclus en dernier dans chaque page.
 * Il réutilise window.socket exposé par la page hôte — aucun socket supplémentaire.
 * Le MP3 est mis en cache navigateur (servi depuis /static/) : un seul téléchargement par client.
 *
 * Variables globales attendues, exposées par la page hôte avant ce script :
 *   window.socket           — instance Socket.IO partagée
 *   window.YUZU_USER_ID      — id du joueur connecté (pour ignorer ses propres messages)
 *   window.YUZU_OPEN_DM_ROOM — (optionnel, dm.html) roomId de la conversation actuellement ouverte
 */

(function () {
  'use strict';

  /* ── Config ─────────────────────────────────────────────────────── */
  const SOUND_URL = '/static/melee-menu-select.mp3';
  const SEEN_KEY  = 'yuzu_seen_challenges'; // sessionStorage — partagé avec dashboard.html
  const TOAST_TTL = 6000; // durée d'affichage en ms

  /* ── Audio (préchargé une fois, mis en cache par le navigateur) ── */
  let audio = null;
  function getAudio() {
    if (!audio) {
      audio = new Audio(SOUND_URL);
      audio.preload = 'auto';
    }
    return audio;
  }

  function playSound() {
    try {
      const a = getAudio();
      a.currentTime = 0;
      a.play().catch(() => {/* autoplay bloqué — silencieux */});
    } catch (_) {}
  }

  /* Précharger le son dès le premier clic (geste utilisateur requis pour l'audio) */
  document.addEventListener('click', function onFirstClick() {
    getAudio();
  }, { once: true });

  /* ── Conteneur des toasts (en haut à gauche) ─────────────────────── */
  let container = null;
  function getContainer() {
    if (container && document.body.contains(container)) return container;
    container = document.createElement('div');
    container.id = 'yuzu-toast-container';
    container.style.cssText = [
      'position:fixed',
      'top:1rem',
      'left:1rem',
      'z-index:99999',
      'display:flex',
      'flex-direction:column',
      'gap:0.6rem',
      'max-width:340px',
      'pointer-events:none',
    ].join(';');
    document.body.appendChild(container);

    /* Styles d'animation injectés une seule fois */
    if (!document.getElementById('yuzu-toast-style')) {
      const style = document.createElement('style');
      style.id = 'yuzu-toast-style';
      style.textContent = `
        @keyframes yuzu-toast-in {
          from { opacity: 0; transform: translateX(-24px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        @keyframes yuzu-toast-out {
          from { opacity: 1; transform: translateX(0); }
          to   { opacity: 0; transform: translateX(-24px); }
        }
        .yuzu-toast {
          pointer-events: auto;
          cursor: pointer;
          background: #14141f;
          border: 1px solid #2a2a3d;
          border-left: 3px solid #f04a00;
          border-radius: 8px;
          padding: 0.7rem 0.9rem;
          color: #e8e8f0;
          font-family: 'Rajdhani', sans-serif;
          box-shadow: 0 8px 24px rgba(0,0,0,0.45);
          animation: yuzu-toast-in 0.3s cubic-bezier(.22,1,.36,1) both;
          transition: opacity 0.25s ease, transform 0.25s ease;
        }
        .yuzu-toast:hover { border-left-color: #ff6a1a; background: #1a1a28; }
        .yuzu-toast .yuzu-toast-title {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 1rem;
          letter-spacing: 1px;
          color: #f04a00;
          margin-bottom: 0.2rem;
        }
        .yuzu-toast .yuzu-toast-body {
          font-size: 0.9rem;
          color: #c8c8da;
          line-height: 1.3;
        }
        .yuzu-toast.yuzu-toast-closing {
          animation: yuzu-toast-out 0.25s ease both;
        }
      `;
      document.head.appendChild(style);
    }

    return container;
  }

  /* ── Afficher un toast in-page ─────────────────────────────────── */
  function showToast(title, body, onClick) {
    const cont = getContainer();
    const el = document.createElement('div');
    el.className = 'yuzu-toast';
    el.innerHTML =
      '<div class="yuzu-toast-title"></div>' +
      '<div class="yuzu-toast-body"></div>';
    el.querySelector('.yuzu-toast-title').textContent = title;
    el.querySelector('.yuzu-toast-body').textContent  = body;

    function close() {
      el.classList.add('yuzu-toast-closing');
      setTimeout(() => { try { el.remove(); } catch (_) {} }, 250);
    }

    el.addEventListener('click', function () {
      close();
      if (typeof onClick === 'function') onClick();
    });

    cont.appendChild(el);
    setTimeout(close, TOAST_TTL);
  }

  /* ── Gestion des challenges déjà vus ────────────────────────────── */
  function getSeenSet() {
    try { return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) || '[]')); }
    catch (_) { return new Set(); }
  }
  function markSeen(id) {
    try {
      const s = getSeenSet();
      s.add(id);
      sessionStorage.setItem(SEEN_KEY, JSON.stringify([...s]));
    } catch (_) {}
  }

  /* ── Challenge reçu via "Find a Player" ──────────────────────────
     event socket : dashboard_update → { challenges_received: { [cid]: c } }
  ─────────────────────────────────────────────────────────────────── */
  function handleDashboardUpdate(data) {
    if (!data || !data.challenges_received) return;
    const seen = getSeenSet();
    const newChallenges = Object.entries(data.challenges_received).filter(([cid]) => !seen.has(cid));
    if (!newChallenges.length) return;

    /* Marquer immédiatement pour éviter les doublons */
    newChallenges.forEach(([cid]) => markSeen(cid));

    newChallenges.forEach(([cid, c]) => {
      playSound();
      showToast(
        '⚔ Challenge reçu !',
        (c.challenger_name || '???') + ' te défie — ' + (c.format || ''),
        function () { window.location.href = '/dashboard'; }
      );
    });
  }

  /* ── Nouveau message (DM ou chat de match relayé en DM) ──────────
     event socket : dm_message → { roomId, uid, name, text, ... }
                    chat_message → { challenge_id, uid, name, text, ... }
  ─────────────────────────────────────────────────────────────────── */
  function handleDmMessage(data) {
    if (!data) return;
    const myId = window.YUZU_USER_ID;

    /* Ne pas se notifier soi-même */
    if (myId && data.uid === myId) return;

    /* Si la conversation concernée est déjà ouverte et l'onglet au premier plan, pas de toast */
    if (window.YUZU_OPEN_DM_ROOM && data.roomId === window.YUZU_OPEN_DM_ROOM && document.hasFocus()) return;

    const sender = data.name || '???';
    const body   = (data.text || '').slice(0, 100) || 'Nouveau message';

    playSound();
    showToast(
      '💬 ' + sender,
      body,
      function () {
        let otherId = '';
        if (data.roomId) {
          const ids = String(data.roomId).replace(/^dm_/, '').split('_');
          otherId = ids.find(id => id !== myId) || ids[0] || '';
        }
        window.location.href = otherId ? '/dm/' + otherId : '/dashboard';
      }
    );
  }

  function handleMatchChatMessage(data) {
    if (!data) return;
    const myId = window.YUZU_USER_ID;
    if (myId && data.uid === myId) return;

    /* Si l'onglet est au premier plan, l'utilisateur voit déjà le chat du match */
    if (document.hasFocus()) return;

    const sender = data.name || '???';
    const body   = (data.text || '').slice(0, 100) || 'Nouveau message';

    playSound();
    showToast(
      '💬 ' + sender,
      body,
      function () { window.focus(); }
    );
  }

  /* ── Attacher les listeners sur window.socket ────────────────────
     window.socket est exposé par la page hôte AVANT le chargement de ce fichier.
     Si ce n'est pas encore disponible (page sans socket), on n'attache rien.
  ─────────────────────────────────────────────────────────────────── */
  function attach(sock) {
    /* dashboard_update : émis régulièrement — on filtre les nouveaux challenges_received */
    sock.on('dashboard_update', handleDashboardUpdate);

    /* dm_message : nouveau message privé reçu */
    sock.on('dm_message', handleDmMessage);

    /* chat_message : nouveau message dans le chat d'un match */
    sock.on('chat_message', handleMatchChatMessage);
  }

  /* Attente que window.socket soit disponible */
  if (window.socket) {
    attach(window.socket);
  } else {
    /* Fallback : poll léger (max 5 s) si le socket est initialisé après ce script */
    let attempts = 0;
    const poll = setInterval(function () {
      if (window.socket) { attach(window.socket); clearInterval(poll); }
      if (++attempts >= 50) clearInterval(poll); /* abandon après 5 s */
    }, 100);
  }

})();
