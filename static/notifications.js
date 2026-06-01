/**
 * notifications.js — Smash YUZU
 * Notifications OS (Web Notifications API) + son pour :
 *   • MATCH FOUND  (event socket : match_redirect)
 *   • Challenge reçu (event socket : dashboard_update avec nouveaux challenges_received)
 *
 * Ce fichier est inclus en dernier dans chaque page.
 * Il réutilise window.socket exposé par la page hôte — aucun socket supplémentaire.
 * Le MP3 est mis en cache navigateur (servi depuis /static/) : un seul téléchargement par client.
 */

(function () {
  'use strict';

  /* ── Config ─────────────────────────────────────────────────────── */
  const SOUND_URL      = '/static/melee-menu-select.mp3';
  const ICON_URL       = '/static/favicon.png';
  const SEEN_KEY       = 'yuzu_seen_challenges';   // sessionStorage — partagé avec dashboard.html
  const MATCH_NOTIF_ID = 'yuzu_match_found';        // tag de notification (remplace la précédente)

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

  /* ── Permissions ─────────────────────────────────────────────────── */
  function requestPermission(cb) {
    if (!('Notification' in window)) { if (cb) cb(false); return; }
    if (Notification.permission === 'granted') { if (cb) cb(true); return; }
    if (Notification.permission === 'denied')  { if (cb) cb(false); return; }
    Notification.requestPermission().then(p => { if (cb) cb(p === 'granted'); });
  }

  function canNotify() {
    return ('Notification' in window) && Notification.permission === 'granted';
  }

  /* ── Afficher une notification OS ───────────────────────────────── */
  function showNotif(title, body, tag, onClick) {
    if (!canNotify()) return;
    try {
      const n = new Notification(title, {
        body,
        icon:           ICON_URL,
        badge:          ICON_URL,
        tag:            tag || 'yuzu',
        renotify:       true,
        requireInteraction: false,
      });
      if (typeof onClick === 'function') {
        n.onclick = function () { window.focus(); onClick(); n.close(); };
      }
      /* Auto-fermeture après 6 s */
      setTimeout(() => { try { n.close(); } catch(_) {} }, 6000);
    } catch (_) {}
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

  /* ── Logique principale ─────────────────────────────────────────── */
  function handleMatchFound(data) {
    const p1  = data && data.p1 ? data.p1 : '???';
    const p2  = data && data.p2 ? data.p2 : '???';
    const cid = data && data.challenge_id;

    playSound();

    /* Si l'overlay plein-écran est déjà visible (l'utilisateur voit le VS),
       la notif OS serait détruite par la redirection dans ~2.5s — inutile. */
    const overlay = document.getElementById('match-found-overlay');
    if (overlay && overlay.classList.contains('visible')) return;

    /* La permission doit avoir été demandée au moment du clic (postLFM/acceptLFM).
       On n'appelle plus requestPermission() ici : ce callback socket n'est pas
       un geste utilisateur et le navigateur le refuserait silencieusement. */
    if (!canNotify()) return;

    showNotif(
      '⚔ MATCH FOUND',
      p1 + ' vs ' + p2,
      MATCH_NOTIF_ID,
      function () {
        if (cid) window.location.href = '/match/' + cid;
        else     window.location.href = '/dashboard';
      }
    );
  }

  function handleDashboardUpdate(data) {
    if (!data || !data.challenges_received) return;
    const seen = getSeenSet();
    const newChallenges = Object.entries(data.challenges_received).filter(([cid]) => !seen.has(cid));
    if (!newChallenges.length) return;

    /* Marquer immédiatement pour éviter les doublons */
    newChallenges.forEach(([cid]) => markSeen(cid));

    /* Son + notif pour chaque nouveau challenge (en pratique toujours 1) */
    newChallenges.forEach(([cid, c]) => {
      playSound();
      requestPermission(function (ok) {
        if (!ok) return;
        showNotif(
          '🎮 Challenge reçu !',
          (c.challenger_name || '???') + ' te défie — ' + (c.format || ''),
          'yuzu_challenge_' + cid,
          function () { window.location.href = '/dashboard'; }
        );
      });
    });
  }

  /* ── Attacher les listeners sur window.socket ────────────────────
     window.socket est exposé par la page hôte AVANT le chargement de ce fichier.
     Si ce n'est pas encore disponible (page sans socket), on n'attache rien.
  ─────────────────────────────────────────────────────────────────── */
  function attach(sock) {
    /* match_redirect : émis quand un LFM est accepté (les deux joueurs sont redirigés) */
    sock.on('match_redirect', handleMatchFound);

    /* dashboard_update : émis régulièrement — on filtre les nouveaux challenges_received */
    sock.on('dashboard_update', handleDashboardUpdate);
  }

  /* Pré-charger le son dès que l'utilisateur interagit avec la page
     (contourne la politique autoplay sans demander tout de suite) */
  document.addEventListener('click', function onFirstClick() {
    getAudio(); /* déclenche le préchargement */
    document.removeEventListener('click', onFirstClick);
  }, { once: true });

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
