// ── notifications.js ─────────────────────────────────────────────────────────
// Gère les popups de notification globales (coin top-left) sur toutes les pages.
// Fonctionne avec le socket partagé via window.socket (défini par chaque page).
//
// Events écoutés :
//   new_challenge      → invitation de match reçue
//   challenge_accepted → ton défi vient d'être accepté
//   match_redirect     → ton annonce LFM (post de match) vient d'être acceptée
//   dm_notification     → message DM reçu hors de la page DM
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── Styles injectés une seule fois ───────────────────────────────────────
  const STYLE = `
    #notif-container {
      position: fixed;
      top: 1rem;
      left: 1rem;
      z-index: 9999;
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
      pointer-events: none;
      max-width: 320px;
    }
    .notif-popup {
      pointer-events: all;
      background: #0f0f1a;
      border: 1px solid #252540;
      border-radius: 10px;
      padding: 0.75rem 1rem;
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      box-shadow: 0 4px 24px rgba(0,0,0,0.5);
      cursor: pointer;
      position: relative;
      overflow: hidden;
      opacity: 0;
      transform: translateX(-16px);
      transition: opacity 0.25s ease, transform 0.25s ease;
      min-width: 260px;
    }
    .notif-popup.show {
      opacity: 1;
      transform: translateX(0);
    }
    .notif-popup.hide {
      opacity: 0;
      transform: translateX(-16px);
      transition: opacity 0.2s ease, transform 0.2s ease;
    }
    .notif-popup::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 2px;
    }
    .notif-popup.type-challenge::before {
      background: linear-gradient(90deg, #e8400a, #ff8000);
    }
    .notif-popup.type-dm::before {
      background: linear-gradient(90deg, #4f8ef7, #7c60ff);
    }
    .notif-icon {
      font-size: 1.5rem;
      flex-shrink: 0;
      line-height: 1;
      margin-top: 0.1rem;
    }
    .notif-body {
      flex: 1;
      min-width: 0;
    }
    .notif-title {
      font-family: 'Bebas Neue', 'Impact', sans-serif;
      font-size: 0.85rem;
      letter-spacing: 2px;
      margin-bottom: 0.2rem;
    }
    .notif-popup.type-challenge .notif-title { color: #ff8000; }
    .notif-popup.type-dm        .notif-title { color: #4f8ef7; }
    .notif-text {
      font-family: 'Rajdhani', sans-serif;
      font-size: 0.88rem;
      color: #eeeef5;
      line-height: 1.35;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .notif-sub {
      font-size: 0.72rem;
      color: #6060a0;
      margin-top: 0.15rem;
      letter-spacing: 0.5px;
    }
    .notif-close {
      position: absolute;
      top: 0.4rem; right: 0.5rem;
      background: none; border: none;
      color: #6060a0; font-size: 0.9rem;
      cursor: pointer; line-height: 1;
      padding: 0;
      transition: color 0.15s;
    }
    .notif-close:hover { color: #eeeef5; }
    .notif-progress {
      position: absolute;
      bottom: 0; left: 0;
      height: 2px;
      background: rgba(255,255,255,0.15);
      transition: width linear;
    }
    .notif-popup.type-challenge .notif-progress { background: rgba(232,64,10,0.4); }
    .notif-popup.type-dm        .notif-progress { background: rgba(79,142,247,0.4); }
  `;

  function injectStyles() {
    if (document.getElementById('notif-styles')) return;
    const s = document.createElement('style');
    s.id = 'notif-styles';
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  function getContainer() {
    let c = document.getElementById('notif-container');
    if (!c) {
      c = document.createElement('div');
      c.id = 'notif-container';
      document.body.appendChild(c);
    }
    return c;
  }

  // ── Durée d'affichage en ms ───────────────────────────────────────────────
  const DURATION = 6000;

  // ── Son de notification ───────────────────────────────────────────────────
  // Un seul élément Audio réutilisé (currentTime reset à chaque lecture pour
  // permettre des notifs rapprochées sans attendre la fin du son précédent).
  let _notifAudio = null;
  let _audioUnlocked = false;
  function getAudio() {
    if (!_notifAudio) {
      _notifAudio = new Audio('/static/melee-menu-select.mp3');
      _notifAudio.volume = 0.5;
    }
    return _notifAudio;
  }
  // "Déverrouille" l'audio dès la première interaction utilisateur sur la page
  // (clic, touch, ou touche clavier — peu importe sur quoi). Les navigateurs
  // autorisent ensuite play() déclenché par du code asynchrone (socket event),
  // alors qu'ils le bloquent tant qu'aucune interaction n'a eu lieu.
  // Indispensable pour le flow "find a match" : un joueur qui poste un LFM et
  // attend passivement (sans re-cliquer sur la page) perdrait sinon le son
  // d'alerte quand l'adversaire accepte, car le navigateur considère qu'il n'y
  // a "pas d'interaction récente" au moment où la notif arrive.
  function unlockAudio() {
    if (_audioUnlocked) return;
    _audioUnlocked = true;
    try {
      const a = getAudio();
      a.muted = true;
      const p = a.play();
      if (p && typeof p.then === 'function') {
        p.then(() => { a.pause(); a.currentTime = 0; a.muted = false; })
         .catch(() => { a.muted = false; _audioUnlocked = false; }); // retentera à la prochaine interaction
      } else {
        a.muted = false;
      }
    } catch (e) { _audioUnlocked = false; }
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(evt =>
    document.addEventListener(evt, unlockAudio, { once: true, passive: true })
  );

  function playSound() {
    try {
      const a = getAudio();
      a.currentTime = 0;
      // play() renvoie une Promise qui peut être rejetée si le navigateur
      // bloque l'autoplay. unlockAudio() ci-dessus couvre l'essentiel des cas,
      // mais on ignore quand même un éventuel rejet résiduel pour ne pas
      // polluer la console.
      const p = a.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { /* silent */ }
  }

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ── showNotif(type, icon, title, text, sub, href) ─────────────────────────
  // type : 'challenge' | 'dm'
  // href : URL to navigate to on click (optional)
  function showNotif(type, icon, title, text, sub, href) {
    injectStyles();
    playSound();
    const container = getContainer();

    const popup = document.createElement('div');
    popup.className = `notif-popup type-${type}`;
    popup.innerHTML = `
      <div class="notif-icon">${icon}</div>
      <div class="notif-body">
        <div class="notif-title">${esc(title)}</div>
        <div class="notif-text">${esc(text)}</div>
        ${sub ? `<div class="notif-sub">${esc(sub)}</div>` : ''}
      </div>
      <button class="notif-close" title="Dismiss">✕</button>
      <div class="notif-progress" style="width:100%;"></div>
    `;

    // Click on body → navigate
    if (href) {
      popup.style.cursor = 'pointer';
      popup.addEventListener('click', (e) => {
        if (e.target.classList.contains('notif-close')) return;
        window.location.href = href;
      });
    }

    // Close button
    popup.querySelector('.notif-close').addEventListener('click', (e) => {
      e.stopPropagation();
      dismiss(popup);
    });

    container.appendChild(popup);

    // Slide in
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { popup.classList.add('show'); });
    });

    // Progress bar shrink
    const bar = popup.querySelector('.notif-progress');
    bar.style.transition = `width ${DURATION}ms linear`;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { bar.style.width = '0%'; });
    });

    // Auto-dismiss
    const timer = setTimeout(() => dismiss(popup), DURATION);
    popup._notifTimer = timer;
  }

  function dismiss(popup) {
    clearTimeout(popup._notifTimer);
    popup.classList.remove('show');
    popup.classList.add('hide');
    popup.addEventListener('transitionend', () => popup.remove(), { once: true });
  }

  // ── Attach listeners once socket is ready ────────────────────────────────
  function attachListeners(socket) {
    // Évite de double-attacher
    if (socket._notifAttached) return;
    socket._notifAttached = true;

    // ── new_challenge ────────────────────────────────────────────────────
    socket.on('new_challenge', (d) => {
      if (!d) return;
      const name   = d.challenger_name || 'Someone';
      const format = d.format || '';
      const cid    = d.challenge_id;
      showNotif(
        'challenge',
        '⚔',
        'CHALLENGE RECEIVED',
        `${name} challenged you to a ${format} match!`,
        'Click to go to your dashboard',
        '/dashboard'
      );
    });

    // ── challenge_accepted ───────────────────────────────────────────────
    socket.on('challenge_accepted', (d) => {
      if (!d) return;
      const name = d.opponent_name || 'Your opponent';
      const cid  = d.challenge_id;
      showNotif(
        'challenge',
        '✅',
        'CHALLENGE ACCEPTED',
        `${name} accepted your challenge!`,
        'Click to go to your match',
        cid ? '/match/' + cid : '/dashboard'
      );
    });

    // ── match_redirect ────────────────────────────────────────────────────
    // Émis quand quelqu'un accepte ton annonce LFM (post de match sur index).
    // Doit jouer le son même si on n'est pas sur index.html / onglet inactif.
    socket.on('match_redirect', (d) => {
      if (!d) return;
      // Si on est en train d'accepter nous-même (acceptLFM sur index), c'est déjà
      // géré par son propre listener avec son propre overlay — on ne fait rien ici.
      if (window._lfmAccepting) return;

      const hasOwnOverlay = !!document.getElementById('match-found-overlay');
      if (hasOwnOverlay) {
        // La page (index.html) gère déjà l'affichage de l'overlay "match found" :
        // on se contente de jouer le son pour ne pas dupliquer le visuel.
        playSound();
        return;
      }

      // Sur les autres pages (dashboard, match, dm...), pas d'overlay dédié :
      // on affiche une popup classique, qui joue le son automatiquement.
      const p1  = (d.p1) || 'Player 1';
      const p2  = (d.p2) || 'Player 2';
      const cid = d.challenge_id;
      showNotif(
        'challenge',
        '🎮',
        'MATCH FOUND',
        `${p1} vs ${p2}`,
        'Click to go to your match',
        cid ? '/match/' + cid : '/dashboard'
      );
    });

    // ── dm_notification ──────────────────────────────────────────────────
    socket.on('dm_notification', (d) => {
      if (!d) return;
      const name = d.from_name || 'Someone';
      const text = d.text || '';
      const href = d.from_id ? `/dm/${d.from_id}` : '/dashboard';
      showNotif(
        'dm',
        '💬',
        'NEW MESSAGE',
        `${name}: ${text}`,
        'Click to open the conversation',
        href
      );
    });
  }

  // ── Bootstrap — attend que window.socket soit disponible ─────────────────
  function bootstrap() {
    if (window.socket) {
      attachListeners(window.socket);
      return;
    }
    // Polling léger : certaines pages créent leur socket après DOMContentLoaded
    let attempts = 0;
    const interval = setInterval(() => {
      if (window.socket) {
        clearInterval(interval);
        attachListeners(window.socket);
      } else if (++attempts > 40) {
        // Après 4s sans socket, on abandonne
        clearInterval(interval);
      }
    }, 100);
  }

  // Exposé pour que d'autres scripts (ex: acceptLFM dans index.html) puissent
  // jouer le même son via le même élément Audio déjà déverrouillé.
  window.playNotifSound = playSound;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
