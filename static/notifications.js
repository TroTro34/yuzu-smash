/**
 * Smash YUZU — Global Challenge Notifications (Socket.IO version)
 * Injecte une bannière en haut à gauche dès qu'un nouveau challenge arrive,
 * quelle que soit la page où se trouve le joueur.
 * Nécessite que socket.io.min.js soit chargé AVANT ce fichier.
 */
(function () {
  'use strict';

  const STYLE = `
    #yuzu-notif-stack {
      position: fixed; top: 1.1rem; left: 1.2rem; z-index: 99999;
      display: flex; flex-direction: column; gap: 0.55rem; pointer-events: none;
    }
    .yuzu-notif {
      pointer-events: all; display: flex; align-items: center; gap: 0.75rem;
      background: #0f0f1a; border: 1px solid #e8400a; border-left: 4px solid #ff8000;
      border-radius: 10px; padding: 0.75rem 1.1rem 0.75rem 0.9rem; cursor: pointer;
      box-shadow: 0 4px 24px rgba(232,64,10,0.25), 0 0 0 1px rgba(255,128,0,0.08);
      font-family: 'Rajdhani', 'Segoe UI', sans-serif; font-size: 0.95rem; color: #eeeef5;
      max-width: 320px; transform: translateX(-120%); opacity: 0;
      transition: transform 0.35s cubic-bezier(.22,1,.36,1), opacity 0.3s; position: relative;
    }
    .yuzu-notif.show { transform: translateX(0); opacity: 1; }
    .yuzu-notif-icon { font-size: 1.5rem; flex-shrink: 0; line-height: 1; }
    .yuzu-notif-body { display: flex; flex-direction: column; gap: 0.1rem; flex: 1; min-width: 0; }
    .yuzu-notif-title { font-weight: 700; font-size: 0.92rem; letter-spacing: 0.5px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #ff8000; }
    .yuzu-notif-msg { font-size: 0.88rem; color: #b0b0cc;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .yuzu-notif-close { background: none; border: none; color: #6060a0; font-size: 1rem;
      cursor: pointer; padding: 0 0 0 0.3rem; flex-shrink: 0; line-height: 1; transition: color 0.15s; }
    .yuzu-notif-close:hover { color: #eeeef5; }
    .yuzu-notif-bar { position: absolute; bottom: 0; left: 0; height: 3px;
      background: linear-gradient(90deg, #e8400a, #ff8000); border-radius: 0 0 10px 10px;
      width: 100%; transform-origin: left; animation: yuzu-bar 6s linear forwards; }
    @keyframes yuzu-bar { from { transform: scaleX(1); } to { transform: scaleX(0); } }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = STYLE;
  document.head.appendChild(styleEl);

  const stack = document.createElement('div');
  stack.id = 'yuzu-notif-stack';
  document.body.appendChild(stack);

  function showNotif(challengerName, format) {
    const el = document.createElement('div');
    el.className = 'yuzu-notif';
    el.innerHTML = `
      <div class="yuzu-notif-icon">⚔️</div>
      <div class="yuzu-notif-body">
        <div class="yuzu-notif-title">${escHtml(challengerName)} is challenging you!</div>
        <div class="yuzu-notif-msg">Mode : <strong style="color:#eeeef5">${escHtml(format || 'BO3')}</strong> — tap to respond</div>
      </div>
      <button class="yuzu-notif-close" title="Dismiss">✕</button>
      <div class="yuzu-notif-bar"></div>
    `;
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('yuzu-notif-close')) return;
      window.location.href = '/dashboard#activity';
    });
    el.querySelector('.yuzu-notif-close').addEventListener('click', (e) => {
      e.stopPropagation();
      dismiss(el);
    });
    stack.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
    setTimeout(() => dismiss(el), 6000);
  }

  function dismiss(el) {
    el.classList.remove('show');
    el.style.transform = 'translateX(-120%)';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 380);
  }

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  const seenChallengeIds = new Set();
  let initialized = false;

  if (typeof io === 'undefined') return;

  // Réutilise le socket existant (dashboard.html) ou en crée un nouveau
  const notifSocket = (typeof socket !== 'undefined' && socket && socket.connected !== undefined)
    ? socket
    : io({ transports: ['websocket'], upgrade: false });

  notifSocket.on('connect', () => {
    notifSocket.emit('join_user', {});
  });

  notifSocket.on('dashboard_update', (data) => {
    const received = data.challenges_received || {};
    if (!initialized) {
      Object.keys(received).forEach(id => seenChallengeIds.add(id));
      initialized = true;
      return;
    }
    for (const [cid, c] of Object.entries(received)) {
      if (!seenChallengeIds.has(cid)) {
        showNotif(c.challenger_name, c.format);
        seenChallengeIds.add(cid);
      }
    }
  });

})();
