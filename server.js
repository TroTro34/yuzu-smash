'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const session    = require('express-session');
const nunjucks   = require('nunjucks');
const crypto     = require('crypto');
const fetch      = require('node-fetch');
const path       = require('path');

// ── CONFIG ────────────────────────────────────────────────────────────────────

const SECRET_KEY          = process.env.SECRET_KEY;
if (!SECRET_KEY) { console.error('SECRET_KEY manquant'); process.exit(1); }

const CLIENT_ID           = '1504467669712240861';
const CLIENT_SECRET       = process.env.DISCORD_CLIENT_SECRET || '';
const GUILD_ID            = '1051577844318339172';
const REDIRECT_URI        = process.env.REDIRECT_URI || 'https://yuzu-smash.onrender.com/callback';
const SUPABASE_URL        = process.env.SUPABASE_URL || '';
const SUPABASE_KEY        = process.env.SUPABASE_KEY || '';
const ADMIN_DISCORD_ID    = process.env.ADMIN_DISCORD_ID || '';

const DISCORD_AUTH_URL = `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify%20guilds%20guilds.members.read`;

const ELO_K          = 32;
const VALID_FORMATS  = new Set(['BO1', 'BO3', 'BO5', 'STOCKS']);
const VALID_MODES    = new Set(['sets', 'stocks']);
const MAX_CHAR_NAME  = 32;
const MAX_MESSAGE    = 200;
const MAX_STOCKS     = 8;
const VALID_ID_RE    = /^[a-zA-Z0-9_\-]+$/;

// ── ANTI-SPAM / DEAD MATCH CONFIG ────────────────────────────────────────────
// Délai avant qu'un match "accepted" sans résultat soumis soit annulé (draw)
const MATCH_ACCEPTED_TIMEOUT_MS  = 2 * 60 * 60 * 1000; // 2h
// Délai avant qu'un match "reported" sans confirmation soit auto-validé
const MATCH_REPORTED_TIMEOUT_MS  = 30 * 60 * 1000;      // 30min
// Intervalle de vérification du nettoyeur
const DEAD_MATCH_CHECK_INTERVAL  = 5 * 60 * 1000;        // toutes les 5min
// Max challenges pending envoyés simultanément par un joueur
const MAX_PENDING_CHALLENGES_SENT = 1;
// Rate-limit chat Socket.IO : N messages par fenêtre
const CHAT_RATE_LIMIT_COUNT  = 5;
const CHAT_RATE_LIMIT_WINDOW = 4000; // ms

// ── APP ───────────────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' }, pingTimeout: 60000, pingInterval: 25000 });

// Sessions
const sessionMiddleware = session({
  secret: SECRET_KEY,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, sameSite: 'lax', maxAge: 86400 * 1000 }
});
app.use(sessionMiddleware);

// Share session with Socket.IO
io.engine.use(sessionMiddleware);

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Static files
app.use('/static', express.static(path.join(__dirname, 'static')));

// Templates (Nunjucks — compatible avec les fichiers HTML Jinja2)
const env = nunjucks.configure(path.join(__dirname, 'templates'), {
  autoescape: true,
  express: app,
  noCache: false,
});

// Filtre tojson pour compatibilité Jinja
env.addFilter('tojson', function(val) { return new nunjucks.runtime.SafeString(JSON.stringify(val)); });
env.addFilter('round', (val, digits) => parseFloat(Number(val).toFixed(digits ?? 0)));
env.addFilter('int', (val) => parseInt(val, 10));
env.addFilter('list', (val) => Array.isArray(val) ? val : Object.keys(val ?? {}));
// datefmt: converts ISO string "2024-01-15T18:30:00Z" → "2024-01-15 18:30"
env.addFilter('datefmt', (val) => {
  if (!val) return '';
  return String(val).slice(0, 16).replace('T', ' ');
});

// ── SUPABASE HELPERS ──────────────────────────────────────────────────────────

function sbHeaders() {
  return {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };
}

async function sbGet(table, params = '') {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, { headers: sbHeaders() });
    return r.ok ? r.json() : [];
  } catch { return []; }
}

async function sbPost(table, data) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST', headers: sbHeaders(), body: JSON.stringify(data)
    });
    if (!r.ok) console.error(`[sbPost ERROR] ${table}: ${r.status} ${await r.text()}`);
    return r.ok ? r.json() : null;
  } catch (e) { console.error('[sbPost]', e); return null; }
}

async function sbPatch(table, match, data) {
  try {
    const params = Object.entries(match).map(([k, v]) => `${k}=eq.${v}`).join('&');
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
      method: 'PATCH', headers: sbHeaders(), body: JSON.stringify(data)
    });
    if (!r.ok) console.error(`[sbPatch ERROR] ${table}: ${r.status} ${await r.text()}`);
    return r.ok;
  } catch (e) { console.error('[sbPatch]', e); return false; }
}

async function sbDelete(table, match) {
  try {
    const OPERATORS = new Set(['lt','gt','lte','gte','neq','like','ilike','is','in']);
    const parts = Object.entries(match).map(([k, v]) => {
      const s = String(v);
      const op = s.split('.')[0];
      return OPERATORS.has(op) ? `${k}=${s}` : `${k}=eq.${s}`;
    });
    const params = parts.join('&');
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
      method: 'DELETE', headers: sbHeaders()
    });
    return r.ok;
  } catch (e) { console.error('[sbDelete]', e); return false; }
}

async function getPlayerMatches(userId, limit = 10) {
  const [wins, losses] = await Promise.all([
    sbGet('matches', `winner_id=eq.${userId}&order=date.desc&limit=${limit}`),
    sbGet('matches', `loser_id=eq.${userId}&order=date.desc&limit=${limit}`),
  ]);
  const seen = new Set();
  const merged = [];
  for (const m of [...(wins||[]), ...(losses||[])]) {
    if (!seen.has(m.id)) { seen.add(m.id); merged.push(m); }
  }
  merged.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return merged.slice(0, limit);
}

// ── ELO ───────────────────────────────────────────────────────────────────────

function calcElo(wp, lp) {
  const expected = 1 / (1 + 10 ** ((lp - wp) / 400));
  return Math.max(Math.round(ELO_K * (1 - expected)), 1);
}

function calcEloStocks(wp, lp, wSt, lSt) {
  const expected = 1 / (1 + 10 ** ((lp - wp) / 400));
  const base = ELO_K * (1 - expected);
  const total = wSt + lSt;
  const diffRatio = total > 0 ? (wSt - lSt) / total : 0;
  return Math.max(Math.round(base * (1.0 + diffRatio * 0.5)), 1);
}

// ── VALIDATION ────────────────────────────────────────────────────────────────

function validateId(v) { return v && VALID_ID_RE.test(String(v)); }
function sanitizeStr(v, max) { return String(v || '').trim().slice(0, max); }
function validateStocks(v) {
  const n = parseInt(v, 10);
  return (!isNaN(n) && n >= 0 && n <= MAX_STOCKS) ? n : null;
}

// ── DATA ──────────────────────────────────────────────────────────────────────

async function dashboardData(userId, excludeChallengeIds = []) {
  const [players, allChallenges, myMatches] = await Promise.all([
    sbGet('players', 'order=points.desc'),
    sbGet('challenges', 'status=in.(pending,accepted,reported)'),
    getPlayerMatches(userId, 10),
  ]);
  const player = players.find(p => p.id === userId) || null;
  const rank   = players.findIndex(p => p.id === userId) + 1 || null;

  const challengesReceived = {};
  const challengesSent     = {};
  const activeMatches      = {};
  const awaitingConf       = {};
  const excludeSet = new Set(excludeChallengeIds);

  for (const c of allChallenges) {
    if (excludeSet.has(c.id)) continue;
    if (c.challenged_id === userId && c.status === 'pending')
      challengesReceived[c.id] = c;
    if (c.challenger_id === userId && c.status === 'pending')
      challengesSent[c.id] = c;
    if (c.status === 'accepted' && [c.challenger_id, c.challenged_id].includes(userId))
      activeMatches[c.id] = c;
    if (c.status === 'reported' && c.reported_by !== userId && [c.challenger_id, c.challenged_id].includes(userId))
      awaitingConf[c.id] = c;
  }

  return { player, players, rank,
    challenges_received: challengesReceived,
    challenges_sent: challengesSent,
    active_matches: activeMatches,
    awaiting_confirmation: awaitingConf,
    my_matches: myMatches };
}

async function leaderboardData() {
  const now = new Date().toISOString();
  const [players, recentMatches, lfmPosts] = await Promise.all([
    sbGet('players', 'order=points.desc'),
    sbGet('matches', 'order=date.desc&limit=10'),
    sbGet('lfm_posts', `expires_at=gt.${now}&order=created_at.desc`),
  ]);
  return { players, recent_matches: recentMatches, lfm_posts: lfmPosts };
}

// ── SOCKET.IO EMITTERS ────────────────────────────────────────────────────────

async function emitDashboardUpdate(userId, excludeChallengeIds = []) {
  try {
    const data = await dashboardData(userId, excludeChallengeIds);
    io.to(`user_${userId}`).emit('dashboard_update', data);
  } catch (e) { console.error('[emitDashboardUpdate]', e); }
}

async function emitMatchUpdate(challengeId, override = {}) {
  try {
    const challenges = await sbGet('challenges', `id=eq.${challengeId}`);
    if (!challenges.length) return;
    const c = challenges[0];
    const report = typeof c.report === 'object' ? c.report : {};
    const payload = {
      challenge_id: challengeId,
      status:      override.status      ?? c.status,
      reported_by: override.reported_by ?? c.reported_by,
      report:      c.report,
      winner_id:   override.winner_id   ?? report?.winner_id  ?? null,
      score:       override.score       ?? report?.score       ?? null,
      elo_change:  override.elo_change  ?? c.elo_change        ?? null,
    };
    // Envoi dans la room match ET directement à chaque joueur (comme les notifications)
    // → garanti même si un joueur a perdu sa room après reconnexion
    io.to(`match_${challengeId}`).emit('match_update', payload);
    io.to(`user_${c.challenger_id}`).emit('match_update', payload);
    io.to(`user_${c.challenged_id}`).emit('match_update', payload);
    // Si le match vient d'être complété, exclure ce challenge du dashboard_update
    // pour éviter la race condition Supabase (le PATCH completed pas encore lisible)
    const excludeIds = (payload.status === 'completed' || payload.status === 'disputed')
      ? [challengeId]
      : [];
    await Promise.all([c.challenger_id, c.challenged_id].map(uid => emitDashboardUpdate(uid, excludeIds)));
  } catch (e) { console.error('[emitMatchUpdate]', e); }
}

async function emitLeaderboardUpdate() {
  try {
    const data = await leaderboardData();
    io.emit('leaderboard_update', data);
  } catch (e) { console.error('[emitLeaderboardUpdate]', e); }
}

// ── SOCKET.IO EVENTS ──────────────────────────────────────────────────────────

// In-memory chat history per match (max 50 messages)
const chatHistory = new Map();
const CHAT_MAX = 50;
// Rate-limit chat : { uid -> { count, windowStart } }
const chatRateMap = new Map();

function isChatRateLimited(uid) {
  const now = Date.now();
  const entry = chatRateMap.get(uid) || { count: 0, windowStart: now };
  if (now - entry.windowStart > CHAT_RATE_LIMIT_WINDOW) {
    entry.count = 0; entry.windowStart = now;
  }
  entry.count++;
  chatRateMap.set(uid, entry);
  return entry.count > CHAT_RATE_LIMIT_COUNT;
}

io.on('connection', (socket) => {
  const req = socket.request;

  socket.on('join_user', async (data, cb) => {
    const uid = req.session?.user?.id;
    if (uid) {
      socket.join(`user_${uid}`);
      if (typeof cb === 'function') cb(true);
      // Émettre immédiatement un dashboard_update propre avec les IDs exclus
      // fournis par le client (matchs terminés qu'il connaît déjà)
      // → résout la race condition quand J2 arrive sur /dashboard après confirmation
      const excludeIds = Array.isArray(data?.exclude) ? data.exclude.filter(v => validateId(String(v))) : [];
      try {
        const dashData = await dashboardData(uid, excludeIds);
        socket.emit('dashboard_update', dashData);
      } catch (e) { console.error('[join_user dashboard_update]', e); }
    } else {
      if (typeof cb === 'function') cb(false);
    }
  });

  socket.on('join_match', async (data) => {
    const cid = data?.challenge_id || '';
    if (!validateId(cid)) return;
    const uid = req.session?.user?.id;
    if (!uid) return;
    // Vérifier que l'utilisateur est bien un des deux joueurs du match
    const challenges = await sbGet('challenges', `id=eq.${cid}`);
    if (!challenges.length) return;
    const c = challenges[0];
    if (![c.challenger_id, c.challenged_id].includes(uid)) return;
    socket.join(`match_${cid}`);
    const history = chatHistory.get(cid) || [];
    if (history.length) socket.emit('chat_history', history);
  });

  socket.on('leave_match', (data) => {
    const cid = data?.challenge_id || '';
    if (validateId(cid)) socket.leave(`match_${cid}`);
  });

  // Relai des transitions de phase BO entre les deux joueurs
  socket.on('bo_phase_update', (data) => {
    const cid = data && data.challenge_id;
    if (!cid) return;
    // Rediffuser à toute la room sauf l'émetteur
    socket.to(`match_${cid}`).emit('bo_phase_update', data);
  });

  socket.on('chat_message', (data) => {
    const uid  = req.session?.user?.id;
    const name = req.session?.user?.username || 'Unknown';
    const cid  = data?.challenge_id || '';
    const text = (data?.text || '').toString().slice(0, 200).trim();
    if (!uid || !validateId(cid) || !text) return;
    if (isChatRateLimited(uid)) return; // silencieux côté serveur
    const payload = { uid, name, text, ts: new Date().toISOString() };
    if (!chatHistory.has(cid)) chatHistory.set(cid, []);
    const hist = chatHistory.get(cid);
    hist.push(payload);
    if (hist.length > CHAT_MAX) hist.shift();
    io.to(`match_${cid}`).emit('chat_message', payload);
  });
});

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

// ── ROUTES ────────────────────────────────────────────────────────────────────

// Index
app.get('/', async (req, res) => {
  try {
    const now = new Date().toISOString();
    await sbDelete('lfm_posts', { expires_at: `lt.${now}` });
    const [players, matches, lfm] = await Promise.all([
      sbGet('players', 'order=points.desc'),
      sbGet('matches', 'order=date.desc&limit=10'),
      sbGet('lfm_posts', 'order=created_at.desc'),
    ]);
    res.render('index.html', { user: req.session.user || null, players, recent_matches: matches, lfm_posts: lfm });
  } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

// Login
app.get('/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauth_state = state;
  res.redirect(DISCORD_AUTH_URL + `&state=${state}`);
});

// OAuth Callback
app.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  const expected = req.session.oauth_state;
  delete req.session.oauth_state;
  if (!state || state !== expected) return res.status(403).send('Invalid state — possible CSRF attack.');
  if (!code) return res.redirect('/');

  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
    });
    if (!tokenRes.ok) return res.status(400).send(`Discord Error: ${await tokenRes.text()}`);
    const { access_token: token } = await tokenRes.json();
    const headers = { Authorization: `Bearer ${token}` };

    const [userData, guilds, memberData] = await Promise.all([
      fetch('https://discord.com/api/users/@me', { headers }).then(r => r.json()),
      fetch('https://discord.com/api/users/@me/guilds', { headers }).then(r => r.json()),
      fetch(`https://discord.com/api/users/@me/guilds/${GUILD_ID}/member`, { headers }).then(r => r.json()),
    ]);

    if (!guilds.find(g => g.id === GUILD_ID)) return res.render('not_member.html');

    const displayName = memberData.nick || userData.global_name || userData.username;
    const avatar      = userData.avatar || null;
    const uid         = userData.id;

    req.session.user = { id: uid, username: displayName, avatar };

    const existing = await sbGet('players', `id=eq.${uid}`);
    if (!existing.length) {
      await sbPost('players', { id: uid, username: displayName, avatar,
        points: 1000, wins: 0, losses: 0, matches_played: 0,
        main_char: '', secondary_char: '', stocks_taken: 0, stocks_lost: 0 });
    } else {
      // Check ban before updating profile
      if (existing[0].is_banned) {
        req.session.destroy(() => {});
        return res.render('banned.html', {
          user_id: uid,
          ban_reason: existing[0].ban_reason || null,
        });
      }
      await sbPatch('players', { id: uid }, { username: displayName, avatar });
    }
    res.redirect('/dashboard');
  } catch (e) { console.error(e); res.status(500).send('Auth error'); }
});

// Dashboard
app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const [data, playerRow] = await Promise.all([
      dashboardData(userId),
      sbGet('players', `id=eq.${userId}`),
    ]);
    const is_admin = playerRow.length && playerRow[0].is_admin ? true : false;
    res.render('dashboard.html', { user: req.session.user, ...data, active_match_ids: Object.keys(data.active_matches), is_admin });
  } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

// Player profile
app.get('/player/:player_id', async (req, res) => {
  const { player_id } = req.params;
  if (req.session.user?.id === player_id) return res.redirect('/dashboard');
  try {
    const [players, myMatches] = await Promise.all([
      sbGet('players', 'order=points.desc'),
      getPlayerMatches(player_id, 10),
    ]);
    const player = players.find(p => p.id === player_id);
    if (!player) return res.redirect('/');
    const rank = players.findIndex(p => p.id === player_id) + 1;
    res.render('player_profile.html', { user: req.session.user || null, player, rank, my_matches: myMatches });
  } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

// Match page
app.get('/match/:challenge_id', requireAuth, async (req, res) => {
  const { challenge_id } = req.params;
  if (!validateId(challenge_id)) return res.redirect('/dashboard');
  const userId = req.session.user.id;
  try {
    const challenges = await sbGet('challenges', `id=eq.${challenge_id}`);
    if (!challenges.length) return res.redirect('/dashboard');
    const c = challenges[0];
    if (![c.challenger_id, c.challenged_id].includes(userId)) return res.redirect('/dashboard');
    if (!['accepted', 'reported'].includes(c.status)) return res.redirect('/dashboard');
    const [challenger, challenged] = await Promise.all([
      sbGet('players', `id=eq.${c.challenger_id}`),
      sbGet('players', `id=eq.${c.challenged_id}`),
    ]);
    if (!challenger.length || !challenged.length) return res.redirect('/dashboard');
    res.render('match.html', { user: req.session.user, challenge: c, challenger: challenger[0], challenged: challenged[0] });
  } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ── API ───────────────────────────────────────────────────────────────────────

app.get('/api/dashboard', requireAuth, async (req, res) => {
  try { res.json(await dashboardData(req.session.user.id)); }
  catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/leaderboard', async (req, res) => {
  try { res.json(await leaderboardData()); }
  catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/lfm', async (req, res) => {
  const now = new Date().toISOString();
  res.json(await sbGet('lfm_posts', `expires_at=gt.${now}&order=created_at.desc`));
});

app.get('/api/players/search', async (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  let players = await sbGet('players', 'order=points.desc');
  if (q) players = players.filter(p => p.username.toLowerCase().includes(q));
  res.json(players);
});

app.get('/api/match_status/:challenge_id', requireAuth, async (req, res) => {
  const { challenge_id } = req.params;
  if (!validateId(challenge_id)) return res.status(400).json({ error: 'Invalid ID' });
  const challenges = await sbGet('challenges', `id=eq.${challenge_id}`);
  if (!challenges.length) return res.status(404).json({ error: 'Not found' });
  const c = challenges[0];
  const report = typeof c.report === 'object' ? c.report : {};
  res.json({ status: c.status, reported_by: c.reported_by, report: c.report,
    winner_id: report?.winner_id || null, score: report?.score || null,
    elo_change: c.elo_change || null, accepted_at: c.accepted_at || null,
    reported_at: c.reported_at || null });
});

app.post('/api/update_profile', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const update = {};
  if (req.body.main_char      !== undefined) update.main_char      = sanitizeStr(req.body.main_char,      MAX_CHAR_NAME);
  if (req.body.secondary_char !== undefined) update.secondary_char = sanitizeStr(req.body.secondary_char, MAX_CHAR_NAME);
  if (!Object.keys(update).length) return res.json({ success: true });
  await sbPatch('players', { id: userId }, update);
  res.json({ success: true });
});

// ── CHALLENGES ────────────────────────────────────────────────────────────────

app.post('/challenge/:opponent_id', requireAuth, async (req, res) => {
  const { opponent_id } = req.params;
  if (!validateId(opponent_id)) return res.status(400).json({ error: 'Invalid opponent ID' });
  const userId = req.session.user.id;
  if (userId === opponent_id) return res.status(400).json({ error: "You can't challenge yourself" });
  const opponent = await sbGet('players', `id=eq.${opponent_id}`);
  if (!opponent.length) return res.status(404).json({ error: 'Player not found' });
  const existing = await sbGet('challenges', `status=in.(pending,accepted)&or=(and(challenger_id.eq.${userId},challenged_id.eq.${opponent_id}),and(challenger_id.eq.${opponent_id},challenged_id.eq.${userId}))`);
  if (existing.length) return res.status(400).json({ error: 'A challenge is already pending between you' });

  // Anti-spam : un seul challenge envoyé en pending à la fois
  const sentPending = await sbGet('challenges', `challenger_id=eq.${userId}&status=eq.pending`);
  if (sentPending.length >= MAX_PENDING_CHALLENGES_SENT)
    return res.status(429).json({ error: `You already have a pending challenge — cancel it first.` });
  const fmt = req.body.format || 'BO3';
  if (!VALID_FORMATS.has(fmt)) return res.status(400).json({ error: 'Invalid format' });
  const cid = `ch_${crypto.randomBytes(8).toString('hex')}`;
  await sbPost('challenges', { id: cid, challenger_id: userId, challenger_name: req.session.user.username,
    challenged_id: opponent_id, challenged_name: opponent[0].username, status: 'pending', format: fmt });
  // Notify challenged player with dedicated event for popup
  io.to(`user_${opponent_id}`).emit('new_challenge', {
    challenger_name: req.session.user.username,
    format: fmt,
    challenge_id: cid,
  });
  await Promise.all([emitDashboardUpdate(opponent_id), emitDashboardUpdate(userId)]);
  res.json({ success: true });
});

app.post('/challenge/:challenge_id/accept', requireAuth, async (req, res) => {
  const { challenge_id } = req.params;
  if (!validateId(challenge_id)) return res.status(400).json({ error: 'Invalid ID' });
  const userId = req.session.user.id;
  const challenges = await sbGet('challenges', `id=eq.${challenge_id}`);
  if (!challenges.length) return res.status(404).json({ error: 'Not found' });
  const c = challenges[0];
  if (c.challenged_id !== userId) return res.status(403).json({ error: 'Not your challenge' });
  if (c.status !== 'pending') return res.status(400).json({ error: 'Not pending' });
  res.json({ success: true }); // Réponse immédiate
  await sbPatch('challenges', { id: challenge_id }, { status: 'accepted', accepted_at: new Date().toISOString() });
  await Promise.all([emitDashboardUpdate(c.challenger_id), emitDashboardUpdate(c.challenged_id)]);
});

app.post('/challenge/:challenge_id/decline', requireAuth, async (req, res) => {
  const { challenge_id } = req.params;
  if (!validateId(challenge_id)) return res.status(400).json({ error: 'Invalid ID' });
  const userId = req.session.user.id;
  const challenges = await sbGet('challenges', `id=eq.${challenge_id}`);
  if (!challenges.length) return res.status(404).json({ error: 'Not found' });
  const c = challenges[0];
  if (c.challenged_id !== userId) return res.status(403).json({ error: 'Not your challenge' });
  if (c.status !== 'pending') return res.status(400).json({ error: 'Not pending' });
  await sbPatch('challenges', { id: challenge_id }, { status: 'declined' });
  await Promise.all([emitDashboardUpdate(c.challenger_id), emitDashboardUpdate(c.challenged_id)]);
  res.json({ success: true });
});

app.post('/challenge/:challenge_id/cancel', requireAuth, async (req, res) => {
  const { challenge_id } = req.params;
  if (!validateId(challenge_id)) return res.status(400).json({ error: 'Invalid ID' });
  const userId = req.session.user.id;
  const challenges = await sbGet('challenges', `id=eq.${challenge_id}`);
  if (!challenges.length) return res.status(404).json({ error: 'Not found' });
  const c = challenges[0];
  if (c.challenger_id !== userId) return res.status(403).json({ error: 'Only the challenger can cancel' });
  if (c.status !== 'pending') return res.status(400).json({ error: 'Not pending' });
  await sbDelete('challenges', { id: challenge_id });
  await Promise.all([emitDashboardUpdate(c.challenged_id), emitDashboardUpdate(c.challenger_id)]);
  res.json({ success: true });
});

// ── LFM ───────────────────────────────────────────────────────────────────────

app.post('/lfm', requireAuth, async (req, res) => {
  const userId  = req.session.user.id;
  const fmt     = req.body.format || 'BO3';
  const mode    = req.body.mode || 'sets';
  if (!VALID_FORMATS.has(fmt)) return res.status(400).json({ error: 'Invalid format' });
  if (!VALID_MODES.has(mode))  return res.status(400).json({ error: 'Invalid mode' });

  // Anti-spam : pas de LFM si déjà dans un match actif ou en challenge pending/accepted
  const activeC = await sbGet('challenges',
    `status=in.(pending,accepted,reported)&or=(challenger_id.eq.${userId},challenged_id.eq.${userId})`);
  if (activeC.length) return res.status(400).json({ error: 'You already have an active challenge or match — finish it first.' });
  const message = sanitizeStr(req.body.message || '', MAX_MESSAGE);
  await sbDelete('lfm_posts', { player_id: userId });
  const player  = await sbGet('players', `id=eq.${userId}`);
  const pts     = player[0]?.points || 1000;
  const main    = player[0]?.main_char || '';
  const avatar  = req.session.user.avatar || '';
  const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const postId  = `lfm_${crypto.randomBytes(8).toString('hex')}`;
  await sbPost('lfm_posts', { id: postId, player_id: userId,
    player_name: req.session.user.username, player_avatar: avatar,
    player_points: pts, main_char: main, format: fmt, mode, message,
    created_at: new Date().toISOString(), expires_at: expires });
  res.json({ success: true });
  await emitLeaderboardUpdate(); // mise à jour temps réel pour tous
});

app.post('/lfm/:post_id/accept', requireAuth, async (req, res) => {
  const { post_id } = req.params;
  if (!validateId(post_id)) return res.status(400).json({ error: 'Invalid ID' });
  const userId = req.session.user.id;
  const posts  = await sbGet('lfm_posts', `id=eq.${post_id}`);
  if (!posts.length) return res.status(404).json({ error: 'Not found' });
  const post = posts[0];
  if (post.player_id === userId) return res.status(400).json({ error: "Can't accept your own post" });
  const cid = `ch_${crypto.randomBytes(8).toString('hex')}`;
  res.json({ success: true, challenge_id: cid }); // Réponse immédiate
  await sbPost('challenges', { id: cid, challenger_id: userId,
    challenger_name: req.session.user.username, challenged_id: post.player_id,
    challenged_name: post.player_name, status: 'accepted', format: post.format });
  await sbDelete('lfm_posts', { id: post_id });
  // Redirect BOTH players to the match page via Socket.IO
  io.to(`user_${userId}`).emit('match_redirect', { challenge_id: cid, p1: req.session.user.username, p2: post.player_name });
  io.to(`user_${post.player_id}`).emit('match_redirect', { challenge_id: cid, p1: req.session.user.username, p2: post.player_name });
  await Promise.all([emitDashboardUpdate(userId), emitDashboardUpdate(post.player_id), emitLeaderboardUpdate()]);
});

app.post('/lfm/:post_id/cancel', requireAuth, async (req, res) => {
  const { post_id } = req.params;
  if (!validateId(post_id)) return res.status(400).json({ error: 'Invalid ID' });
  const userId = req.session.user.id;
  const posts  = await sbGet('lfm_posts', `id=eq.${post_id}`);
  if (!posts.length) return res.status(404).json({ error: 'Not found' });
  if (posts[0].player_id !== userId) return res.status(403).json({ error: 'Not your post' });
  await sbDelete('lfm_posts', { id: post_id });
  res.json({ success: true });
  await emitLeaderboardUpdate(); // mise à jour temps réel pour tous
});

// ── REPORT (joueur) ───────────────────────────────────────────────────────────

app.post('/report/:challenge_id', requireAuth, async (req, res) => {
  const { challenge_id } = req.params;
  if (!validateId(challenge_id)) return res.status(400).json({ error: 'Invalid ID' });
  const userId = req.session.user.id;

  const challenges = await sbGet('challenges', `id=eq.${challenge_id}`);
  if (!challenges.length) return res.status(404).json({ error: 'Not found' });
  const c = challenges[0];
  if (![c.challenger_id, c.challenged_id].includes(userId))
    return res.status(403).json({ error: 'Not part of this match' });
  if (!['accepted', 'reported'].includes(c.status))
    return res.status(400).json({ error: 'Cannot report this match' });

  const title = sanitizeStr(req.body.title || '', 120) ||
    `${c.challenger_name} vs ${c.challenged_name}`;

  // Draw immédiat
  await sbPatch('challenges', { id: challenge_id }, { status: 'draw_reported' });

  // Créer le signalement avec snapshot du chat
  await createReport({
    challenge_id, challenger_id: c.challenger_id, challenged_id: c.challenged_id,
    format: c.format, title,
    reason: 'player_report',
    chat_history_snapshot: chatHistory.get(challenge_id) || [],
  });
  chatHistory.delete(challenge_id);

  // Notifier les deux joueurs
  const msg = { type: 'match_timeout', outcome: 'draw', challenge_id,
    message: '🚩 Match signalé — résultat en DRAW en attendant la décision admin.' };
  io.to(`user_${c.challenger_id}`).emit('match_timeout', msg);
  io.to(`user_${c.challenged_id}`).emit('match_timeout', msg);
  await Promise.all([emitDashboardUpdate(c.challenger_id), emitDashboardUpdate(c.challenged_id)]);

  res.json({ success: true });
});

// ── ADMIN MIDDLEWARE ──────────────────────────────────────────────────────────

async function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  const players = await sbGet('players', `id=eq.${req.session.user.id}`);
  if (!players.length || !players[0].is_admin)
    return res.status(403).render('not_member.html');
  req.adminPlayer = players[0];
  next();
}

// ── ADMIN — PAGE SIGNALEMENTS ─────────────────────────────────────────────────

app.get('/admin/reports', requireAdmin, async (req, res) => {
  try {
    const [openReports, allPlayers] = await Promise.all([
      sbGet('reports', 'order=created_at.desc'),
      sbGet('players', 'order=points.desc'),
    ]);
    const playersMap = Object.fromEntries(allPlayers.map(p => [p.id, p]));
    // Enrich each report with p1/p2 player snapshots and normalized status
    const enriched = openReports.map(r => {
      const p1 = playersMap[r.challenger_id] || { username: r.challenger_id, points: '?', wins: 0, losses: 0 };
      const p2 = playersMap[r.challenged_id] || { username: r.challenged_id, points: '?', wins: 0, losses: 0 };
      const normalizedStatus = r.status === 'resolved' ? 'resolved' : 'open';
      const winnerUsername = r.winner_id ? (playersMap[r.winner_id] || {}).username || r.winner_id : null;
      return { ...r, p1, p2, status: normalizedStatus, winner_username: winnerUsername };
    });
    res.render('admin_reports.html', {
      user: req.session.user,
      is_admin: true,
      reports: enriched,
      players_map: playersMap,
      players: allPlayers,
    });
  } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

app.post('/admin/reports/:report_id/resolve', requireAdmin, async (req, res) => {
  const { report_id } = req.params;
  if (!validateId(report_id)) return res.status(400).json({ error: 'Invalid ID' });

  const reports = await sbGet('reports', `id=eq.${report_id}`);
  if (!reports.length) return res.status(404).json({ error: 'Not found' });
  const report = reports[0];
  if (report.status === 'resolved') return res.status(400).json({ error: 'Already resolved' });

  const { winner_id } = req.body;
  if (!winner_id) {
    // Clôturer sans vainqueur (draw confirmé)
    await sbPatch('reports', { id: report_id }, {
      status: 'resolved', resolved_by: req.session.user.id,
      resolved_at: new Date().toISOString(), resolution: 'draw'
    });
    return res.json({ success: true, resolution: 'draw' });
  }

  if (![report.challenger_id, report.challenged_id].includes(winner_id))
    return res.status(400).json({ error: 'Invalid winner' });

  const loser_id = winner_id === report.challenger_id ? report.challenged_id : report.challenger_id;
  const [winnerArr, loserArr] = await Promise.all([
    sbGet('players', `id=eq.${winner_id}`),
    sbGet('players', `id=eq.${loser_id}`),
  ]);
  if (!winnerArr.length || !loserArr.length)
    return res.status(404).json({ error: 'Player not found' });

  const winner = winnerArr[0], loser = loserArr[0];
  const eloGain = calcElo(winner.points, loser.points);

  await Promise.all([
    sbPatch('players', { id: winner_id }, {
      points: winner.points + eloGain, wins: winner.wins + 1,
      matches_played: winner.matches_played + 1,
    }),
    sbPatch('players', { id: loser_id }, {
      points: Math.max(0, loser.points - eloGain), losses: loser.losses + 1,
      matches_played: loser.matches_played + 1,
    }),
    sbPost('matches', {
      challenge_id: report.challenge_id, winner_id, winner_name: winner.username,
      winner_main: winner.main_char || '', loser_id, loser_name: loser.username,
      loser_main: loser.main_char || '', score: 'W-L (admin)',
      format: report.format || 'BO3', elo_change: eloGain, date: new Date().toISOString(),
    }),
    sbPatch('challenges', { id: report.challenge_id }, { status: 'completed' }),
    sbPatch('reports', { id: report_id }, {
      status: 'resolved', resolved_by: req.session.user.id,
      resolved_at: new Date().toISOString(), resolution: 'winner',
      winner_id, elo_change: eloGain,
    }),
  ]);

  await emitLeaderboardUpdate();
  await Promise.all([emitDashboardUpdate(winner_id), emitDashboardUpdate(loser_id)]);
  // Notifier les joueurs de la décision admin
  const notify = (uid, won) => io.to(`user_${uid}`).emit('admin_decision', {
    challenge_id: report.challenge_id,
    message: won
      ? `✅ Décision admin : vous remportez le match (+${eloGain} ELO).`
      : `❌ Décision admin : vous perdez le match (−${eloGain} ELO).`,
    won, elo_change: eloGain,
  });
  notify(winner_id, true);
  notify(loser_id, false);

  res.json({ success: true, resolution: 'winner', elo_change: eloGain });
});


// ── ADMIN — BAN / UNBAN ───────────────────────────────────────────────────────

app.post("/admin/ban", requireAdmin, async (req, res) => {
  const { player_id, reason } = req.body;
  if (!validateId(player_id)) return res.status(400).json({ error: "Invalid player ID" });
  if (player_id === req.session.user.id)
    return res.status(400).json({ error: "You cannot ban yourself" });
  const players = await sbGet("players", `id=eq.${player_id}`);
  if (!players.length) return res.status(404).json({ error: "Player not found" });
  if (players[0].is_banned) return res.status(400).json({ error: "Player is already banned" });
  if (players[0].is_admin) return res.status(403).json({ error: "Cannot ban another admin" });
  const banReason = sanitizeStr(reason || "", 200) || null;
  await sbPatch("players", { id: player_id }, {
    is_banned: true, ban_reason: banReason,
    banned_at: new Date().toISOString(), banned_by: req.session.user.id,
  });
  const activeChallenges = await sbGet("challenges",
    `status=in.(pending,accepted,reported)&or=(challenger_id.eq.${player_id},challenged_id.eq.${player_id})`);
  for (const c of activeChallenges) {
    await sbPatch("challenges", { id: c.id }, { status: "cancelled" });
    const otherId = c.challenger_id === player_id ? c.challenged_id : c.challenger_id;
    io.to(`user_${otherId}`).emit("match_timeout", { type: "match_cancelled", challenge_id: c.id,
      message: "u26a0 Your opponent has been banned. The match has been cancelled." });
    await emitDashboardUpdate(otherId);
  }
  console.log(`[ADMIN] ${req.session.user.username} banned player ${player_id}`);
  res.json({ success: true });
});

app.post("/admin/unban", requireAdmin, async (req, res) => {
  const { player_id } = req.body;
  if (!validateId(player_id)) return res.status(400).json({ error: "Invalid player ID" });
  const players = await sbGet("players", `id=eq.${player_id}`);
  if (!players.length) return res.status(404).json({ error: "Player not found" });
  if (!players[0].is_banned) return res.status(400).json({ error: "Player is not banned" });
  await sbPatch("players", { id: player_id }, {
    is_banned: false, ban_reason: null, banned_at: null, banned_by: null,
  });
  console.log(`[ADMIN] ${req.session.user.username} unbanned player ${player_id}`);
  res.json({ success: true });
});

// ── RESULT SUBMISSION ─────────────────────────────────────────────────────────

app.post('/result/:challenge_id', requireAuth, async (req, res) => {
  const { challenge_id } = req.params;
  if (!validateId(challenge_id)) return res.status(400).json({ error: 'Invalid ID' });
  const userId     = req.session.user.id;
  const challenges = await sbGet('challenges', `id=eq.${challenge_id}`);
  if (!challenges.length) return res.status(404).json({ error: 'Not found' });
  const c = challenges[0];
  if (![c.challenger_id, c.challenged_id].includes(userId)) return res.status(403).json({ error: 'Not part of this match' });

  const { winner_id, score: rawScore } = req.body;
  const isStocks = c.format === 'STOCKS';

  // En mode STOCKS : le front envoie les TOTAUX CUMULÉS sur l'ensemble des matchs.
  // On calcule le delta = total saisi - total précédemment enregistré.
  let wStRaw = parseInt(req.body.winner_stocks_taken ?? 0, 10);
  let lStRaw = parseInt(req.body.loser_stocks_taken  ?? 0, 10);
  if (isNaN(wStRaw) || isNaN(lStRaw) || wStRaw < 0 || lStRaw < 0) {
    return res.status(400).json({ error: 'Stocks must be >= 0' });
  }

  let wSt = wStRaw, lSt = lStRaw;
  let scoreStr;

  if (isStocks) {
    const prev = (typeof c.report === 'object' && c.report) ? c.report : {};
    const prevW = prev.winner_stocks_total || 0;
    const prevL = prev.loser_stocks_total  || 0;
    wSt = Math.max(0, wStRaw - prevW); // delta pour ce match
    lSt = Math.max(0, lStRaw - prevL);
    scoreStr = `${wStRaw}-${lStRaw}`; // score = totaux pour l'affichage
  } else {
    const v1 = validateStocks(wStRaw), v2 = validateStocks(lStRaw);
    if (v1 === null || v2 === null) return res.status(400).json({ error: `Stocks must be 0–${MAX_STOCKS}` });
    scoreStr = sanitizeStr(rawScore || '', 20);
  }

  if (![c.challenger_id, c.challenged_id].includes(winner_id)) return res.status(400).json({ error: 'Invalid winner' });
  const loser_id = winner_id === c.challenger_id ? c.challenged_id : c.challenger_id;

  if (c.status === 'accepted') {
    await sbPatch('challenges', { id: challenge_id }, {
      status: 'reported', reported_by: userId, reported_at: new Date().toISOString(),
      report: {
        winner_id, score: scoreStr,
        winner_stocks_taken: wSt, loser_stocks_taken: lSt,
        winner_stocks_total: wStRaw, loser_stocks_total: lStRaw,
        is_stocks_mode: isStocks
      }
    });
    await emitMatchUpdate(challenge_id);
    return res.json({ success: true, message: 'Result submitted! Waiting for opponent confirmation.' });
  }

  if (c.status === 'reported' && c.reported_by !== userId) {
    const report = typeof c.report === 'object' ? c.report : {};
    if (String(winner_id) === String(report.winner_id)) {
      const [winnerArr, loserArr] = await Promise.all([
        sbGet('players', `id=eq.${winner_id}`),
        sbGet('players', `id=eq.${loser_id}`),
      ]);
      if (winnerArr.length && loserArr.length) {
        const winner = winnerArr[0], loser = loserArr[0];
        const wp = winner.points, lp = loser.points;
        const eloGain = report.is_stocks_mode
          ? calcEloStocks(wp, lp, report.winner_stocks_taken || 0, report.loser_stocks_taken || 0)
          : calcElo(wp, lp);
        await Promise.all([
          sbPatch('players', { id: winner_id }, { points: wp + eloGain, wins: winner.wins + 1,
            matches_played: winner.matches_played + 1,
            stocks_taken: (winner.stocks_taken || 0) + (report.winner_stocks_taken || 0) }),
          sbPatch('players', { id: loser_id }, { points: Math.max(0, lp - eloGain), losses: loser.losses + 1,
            matches_played: loser.matches_played + 1,
            stocks_lost: (loser.stocks_lost || 0) + (report.loser_stocks_taken || 0) }),
          sbPost('matches', { challenge_id, winner_id, winner_name: winner.username,
            winner_main: winner.main_char || '', loser_id, loser_name: loser.username,
            loser_main: loser.main_char || '', score: report.score || scoreStr,
            format: c.format, elo_change: eloGain, date: new Date().toISOString() }),
          sbPatch('challenges', { id: challenge_id }, { status: 'completed' }),
        ]);
        // Petit délai pour laisser Supabase propager le PATCH avant les re-queries
        await new Promise(r => setTimeout(r, 300));
        await emitMatchUpdate(challenge_id, {
          status: 'completed',
          winner_id,
          score: report.score || scoreStr,
          elo_change: eloGain,
        });
        await emitLeaderboardUpdate();
        chatHistory.delete(challenge_id); // clear chat history on match end
        return res.json({ success: true, message: `Match validated! +${eloGain} ELO for the winner.`, elo_change: eloGain, winner_id });
      }
    } else {
      await sbPatch('challenges', { id: challenge_id }, { status: 'disputed' });
      await new Promise(r => setTimeout(r, 300));
      await emitMatchUpdate(challenge_id);
      return res.json({ success: true, message: 'Conflict detected! Contact an admin.' });
    }
  }

  res.status(400).json({ error: 'Invalid action' });
});

// ── DEAD MATCH CLEANUP ────────────────────────────────────────────────────────
// Tournant en arrière-plan, résout les matchs abandonnés :
//   • status=accepted  depuis > 2h  → DRAW + signalement admin
//   • status=reported  depuis > 30min → DRAW + signalement admin (plus de forfait auto)

async function createReport({ challenge_id, challenger_id, challenged_id, format, title, reason, chat_history_snapshot }) {
  const rid = `rep_${crypto.randomBytes(8).toString('hex')}`;
  await sbPost('reports', {
    id: rid, challenge_id, challenger_id, challenged_id, format,
    title: title || 'Signalement sans titre',
    reason: reason || 'unknown',
    chat_history: chat_history_snapshot || [],
    status: 'open',
    created_at: new Date().toISOString(),
  });
  return rid;
}

async function resolveDeadMatches() {
  try {
    const now = new Date();

    // ── 1. Matchs accepted expirés → DRAW + signalement ───────────────────────
    const acceptedExpiry = new Date(now - MATCH_ACCEPTED_TIMEOUT_MS).toISOString();
    const deadAccepted = await sbGet('challenges',
      `status=eq.accepted&accepted_at=lt.${acceptedExpiry}`);

    for (const c of deadAccepted) {
      console.log(`[DeadMatch] DRAW (timeout accepted): ${c.id}`);
      await sbPatch('challenges', { id: c.id }, { status: 'draw_timeout' });
      await createReport({
        challenge_id: c.id, challenger_id: c.challenger_id, challenged_id: c.challenged_id,
        format: c.format,
        title: `[AUTO] ${c.challenger_name} vs ${c.challenged_name} — aucun résultat soumis`,
        reason: 'timeout_no_result',
        chat_history_snapshot: chatHistory.get(c.id) || [],
      });
      chatHistory.delete(c.id);
      const msg = { type: 'match_timeout', outcome: 'draw', challenge_id: c.id,
        message: '⏱ Temps écoulé — aucun résultat soumis. Match annulé (DRAW), un admin peut trancher.' };
      io.to(`user_${c.challenger_id}`).emit('match_timeout', msg);
      io.to(`user_${c.challenged_id}`).emit('match_timeout', msg);
      await Promise.all([emitDashboardUpdate(c.challenger_id), emitDashboardUpdate(c.challenged_id)]);
    }

    // ── 2. Matchs reported expirés → DRAW + signalement ──────────────────────
    const reportedExpiry = new Date(now - MATCH_REPORTED_TIMEOUT_MS).toISOString();
    const deadReported = await sbGet('challenges',
      `status=eq.reported&reported_at=lt.${reportedExpiry}`);

    for (const c of deadReported) {
      const report = typeof c.report === 'object' && c.report ? c.report : {};
      console.log(`[DeadMatch] DRAW (timeout reported): ${c.id}`);
      await sbPatch('challenges', { id: c.id }, { status: 'draw_timeout' });
      await createReport({
        challenge_id: c.id, challenger_id: c.challenger_id, challenged_id: c.challenged_id,
        format: c.format,
        title: `[AUTO] ${c.challenger_name} vs ${c.challenged_name} — confirmation expirée`,
        reason: 'timeout_no_confirm',
        chat_history_snapshot: chatHistory.get(c.id) || [],
      });
      chatHistory.delete(c.id);
      const msg = { type: 'match_timeout', outcome: 'draw', challenge_id: c.id,
        message: '⏱ Confirmation non reçue à temps — match en DRAW. Un admin va trancher.' };
      io.to(`user_${c.challenger_id}`).emit('match_timeout', msg);
      io.to(`user_${c.challenged_id}`).emit('match_timeout', msg);
      await Promise.all([emitDashboardUpdate(c.challenger_id), emitDashboardUpdate(c.challenged_id)]);
    }
  } catch (e) {
    console.error('[resolveDeadMatches]', e);
  }
}

// ── START ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`⚔ Smash YUZU running on port ${PORT}`);
  // Lancer le nettoyeur de matchs morts au démarrage puis toutes les 5 min
  resolveDeadMatches();
  setInterval(resolveDeadMatches, DEAD_MATCH_CHECK_INTERVAL);
});
