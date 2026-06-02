'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const session    = require('express-session');
const nunjucks   = require('nunjucks');
const crypto     = require('crypto');
const fetch      = require('node-fetch');
const path       = require('path');
const rateLimit   = require('express-rate-limit');

const SECRET_KEY          = process.env.SECRET_KEY;
if (!SECRET_KEY) { console.error('SECRET_KEY manquant'); process.exit(1); }

const KOFI_VERIFICATION_TOKEN = process.env.KOFI_VERIFICATION_TOKEN;
if (!KOFI_VERIFICATION_TOKEN) { console.error('KOFI_VERIFICATION_TOKEN manquant'); process.exit(1); }

const KOFI_PACKS = [
  { amount: 2.00, coins: 500,  label: '500 RCoins',  emoji: '💜', id: 'pack_500'  },
  { amount: 5.00, coins: 2000, label: '2000 RCoins', emoji: '⭐', id: 'pack_2000' },
];

const RCOIN_PACKS = [
  { id: 'pack_500',  coins: 500,  price_euros: 2.00, label: '500 RCoins',  emoji: '💜', kofi_url: 'https://ko-fi.com/s/fc3ccb0369' },
  { id: 'pack_2000', coins: 2000, price_euros: 5.00, label: '2000 RCoins', emoji: '⭐', kofi_url: 'https://ko-fi.com/s/63ab51d2f4' },
];

const CLIENT_ID           = '1504467669712240861';
const CLIENT_SECRET       = process.env.DISCORD_CLIENT_SECRET || '';
const GUILD_ID            = '1051577844318339172';
const REDIRECT_URI        = process.env.REDIRECT_URI || 'https://yuzu-smash.onrender.com/callback';
const SUPABASE_URL        = process.env.SUPABASE_URL || '';
const SUPABASE_KEY        = process.env.SUPABASE_KEY || '';
const ADMIN_DISCORD_ID    = process.env.ADMIN_DISCORD_ID || '';
const DISCORD_LFM_WEBHOOK_URL = process.env.DISCORD_LFM_WEBHOOK_URL || '';

const DISCORD_AUTH_URL = `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify%20guilds%20guilds.members.read`;

const ELO_K          = 32;
const VALID_FORMATS  = new Set(['BO1', 'BO3', 'BO5', 'STOCKS']);
const VALID_MODES    = new Set(['sets', 'stocks']);
const MAX_CHAR_NAME  = 32;
const MAX_MESSAGE    = 200;
const MAX_STOCKS     = 8;
const VALID_ID_RE    = /^[a-zA-Z0-9_\-]+$/;

const MATCH_ACCEPTED_TIMEOUT_MS  = 2 * 60 * 60 * 1000; 

const MATCH_REPORTED_TIMEOUT_MS  = 30 * 60 * 1000;      

const DEAD_MATCH_CHECK_INTERVAL  = 5 * 60 * 1000;        

const MAX_PENDING_CHALLENGES_SENT = 1;

const CHAT_RATE_LIMIT_COUNT  = 5;
const CHAT_RATE_LIMIT_WINDOW = 4000; 

const app    = express();
app.set("trust proxy", 1); 
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' }, pingTimeout: 60000, pingInterval: 25000 });

const sessionMiddleware = session({
  secret: SECRET_KEY,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV !== 'development', httpOnly: true, sameSite: process.env.NODE_ENV !== 'development' ? 'none' : 'lax', maxAge: 86400 * 1000 }
});
app.use(sessionMiddleware);

const jsonDefault = express.json();
const jsonLarge   = express.json({ limit: '10mb' });
app.use((req, res, next) => {
  if (req.path.startsWith('/report/') || req.path.startsWith('/admin/whatsup') || req.path.startsWith('/admin/shop/banner'))
    return jsonLarge(req, res, next);
  return jsonDefault(req, res, next);
});
app.use(express.urlencoded({ extended: false }));

io.engine.use(sessionMiddleware);

app.post('/webhook/kofi', async (req, res) => {
  try {

    let payload;
    if (req.body && req.body.data) {
      try { payload = JSON.parse(req.body.data); }
      catch { return res.status(400).send('Invalid JSON in data field'); }
    } else if (req.body && req.body.verification_token) {
      payload = req.body;
    } else {
      console.warn('[Ko-fi Webhook] Payload inattendu:', JSON.stringify(req.body).slice(0, 200));
      return res.status(400).send('Missing data field');
    }

    if (payload.verification_token !== KOFI_VERIFICATION_TOKEN) {
      console.warn('[Ko-fi Webhook] Token invalide reçu:', payload.verification_token);
      return res.status(401).send('Invalid verification token');
    }

    if (payload.type !== 'Shop Order' && payload.type !== 'Donation') {
      console.log('[Ko-fi Webhook] Type ignoré:', payload.type);
      return res.status(200).send('OK');
    }

    const amountRaw = parseFloat(payload.amount || '0');
    const currency  = (payload.currency || 'EUR').toUpperCase();
  
    let pack = KOFI_PACKS.find(p => Math.abs(p.amount - amountRaw) < 0.01);
    if (!pack) {
      console.warn('[Ko-fi Webhook] Montant non reconnu:', amountRaw, '— fallback pack_500 pour test');
      pack = KOFI_PACKS[0];
    }

    const txId = payload.kofi_transaction_id || payload.message_id || null;
    if (!txId) {
      console.warn('[Ko-fi Webhook] Pas de kofi_transaction_id dans le payload');
      return res.status(200).send('No transaction ID');
    }

    const existing = await sbGet('kofi_transactions', `kofi_transaction_id=eq.${encodeURIComponent(txId)}`);
    if (existing && existing.length) {
      console.log('[Ko-fi Webhook] Transaction déjà enregistrée:', txId);
      return res.status(200).send('Already recorded');
    }

    const ok = await sbPost('kofi_transactions', {
      kofi_transaction_id: txId,
      coins:               pack.coins,
      pack_id:             pack.id,
      amount_eur:          amountRaw,
      status:              'pending',
      kofi_email:          payload.email || null,
      kofi_from_name:      payload.from_name || null,
      created_at:          new Date().toISOString(),
    });

    if (!ok) {
      console.error('[Ko-fi Webhook] Échec de l\'insertion Supabase pour tx:', txId);
      return res.status(500).send('DB error');
    }

    console.log(`✅ [Ko-fi] Transaction stockée (pending) : ${txId} — ${pack.coins} RCoins — ${amountRaw}€`);
    return res.status(200).send('OK');

  } catch (err) {
    console.error('[Ko-fi Webhook] Erreur inattendue:', err);
    return res.status(500).send('Internal error');
  }
});

app.get('/redeem', async (req, res) => {
  const txId = req.query.tx || null;

  if (!req.session.user) {
    req.session.returnTo = `/redeem${txId ? '?tx=' + encodeURIComponent(txId) : ''}`;
    return res.redirect('/login');
  }
  try {
    const playerRows = await sbGet('players', `id=eq.${req.session.user.id}`);
    const player = playerRows[0] || null;

    let txInfo = null;
    if (txId) {
      const txRows = await sbGet('kofi_transactions', `kofi_transaction_id=eq.${encodeURIComponent(txId)}`);
      if (txRows && txRows.length) txInfo = txRows[0];
    }
    res.render('redeem.html', { user: req.session.user, player, tx_id: txId, tx_info: txInfo });
  } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

app.post('/api/redeem', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });

  const userId = req.session.user.id;
  const { tx_id } = req.body || {};

  if (!tx_id || typeof tx_id !== 'string' || tx_id.length > 200) {
    return res.status(400).json({ error: 'missing_tx', message: 'Lien invalide — utilise le lien reçu dans ton email Ko-fi.' });
  }

  try {

    const txRows = await sbGet('kofi_transactions', `kofi_transaction_id=eq.${encodeURIComponent(tx_id)}`);
    if (!txRows || !txRows.length) {
      return res.status(404).json({ error: 'not_found', message: 'Transaction introuvable. Vérifie que tu utilises bien le lien reçu par Ko-fi.' });
    }

    const tx = txRows[0];

    if (tx.status === 'claimed') {
      return res.status(409).json({ error: 'already_claimed', message: 'Ces RCoins ont déjà été réclamés.' });
    }

    const claimed = await sbPatchIf(
      'kofi_transactions',
      { kofi_transaction_id: tx.kofi_transaction_id, status: 'pending' },
      { status: 'claimed', claimed_by: userId, claimed_at: new Date().toISOString() }
    );

    if (!claimed) {
      return res.status(409).json({ error: 'already_claimed', message: 'Ces RCoins ont déjà été réclamés.' });
    }

    const playerRows = await sbGet('players', `id=eq.${userId}`);
    if (!playerRows || !playerRows.length) {

      await sbPatch('kofi_transactions', { kofi_transaction_id: tx.kofi_transaction_id }, { status: 'pending', claimed_by: null, claimed_at: null });
      return res.status(404).json({ error: 'player_not_found', message: 'Ton compte joueur est introuvable.' });
    }

    const player   = playerRows[0];
    const current  = player.rcoins || 0;
    const added    = tx.coins;
    const newTotal = current + added;

    const ok = await sbPatch('players', { id: userId }, { rcoins: newTotal });
    if (!ok) {

      await sbPatch('kofi_transactions', { kofi_transaction_id: tx.kofi_transaction_id }, { status: 'pending', claimed_by: null, claimed_at: null });
      return res.status(500).json({ error: 'db_error', message: 'Erreur DB lors du crédit — réessaie.' });
    }

    io.to(`user_${userId}`).emit('rcoins_update', { new_balance: newTotal, added });

    console.log(`✅ [Redeem] ${added} RCoins crédités à ${userId} (${player.username || userId}) — tx: ${tx.kofi_transaction_id} — total: ${newTotal}`);
    return res.json({ success: true, added, new_balance: newTotal });

  } catch (err) {
    console.error('[/api/redeem] Erreur:', err);
    return res.status(500).json({ error: 'internal', message: 'Erreur serveur inattendue.' });
  }
});

const publicApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down." },
});

const authApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down." },
});

const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  message: { error: "Too many login attempts, try again later." },
});

app.use('/static', express.static(path.join(__dirname, 'static')));

const env = nunjucks.configure(path.join(__dirname, 'templates'), {
  autoescape: true,
  express: app,
  noCache: false,
});

env.addFilter('tojson', function(val) { return new nunjucks.runtime.SafeString(JSON.stringify(val)); });
env.addFilter('round', (val, digits) => parseFloat(Number(val).toFixed(digits ?? 0)));
env.addFilter('int', (val) => parseInt(val, 10));
env.addFilter('list', (val) => Array.isArray(val) ? val : Object.keys(val ?? {}));

env.addFilter('selectattr', function(arr, attr, op, val) {
  if (!Array.isArray(arr)) return [];
  if (op === 'equalto') return arr.filter(item => item[attr] === val);
  return arr;
});

env.addFilter('datefmt', (val) => {
  if (!val) return '';
  return String(val).slice(0, 16).replace('T', ' ');
});

env.addFilter('format', function(val, pattern) {
  if (val === null || val === undefined) return '';
  const num = Number(val);
  if (isNaN(num)) return String(val);
  if (pattern) {
    const decimals = (pattern.match(/0/g) || []).length;
    return num.toFixed(decimals);
  }
  return num.toLocaleString('fr-FR');
});

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

async function sbPatchIf(table, match, data) {
  try {
    const OPERATORS = new Set(['lt','gt','lte','gte','neq','like','ilike','is','in']);
    const params = Object.entries(match).map(([k, v]) => {
      const s = String(v);
      const op = s.split('.')[0];
      return OPERATORS.has(op) ? `${k}=${s}` : `${k}=eq.${s}`;
    }).join('&');
    const headers = { ...sbHeaders(), 'Prefer': 'return=minimal,count=exact' };
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
      method: 'PATCH', headers, body: JSON.stringify(data)
    });
    if (!r.ok) { console.error(`[sbPatchIf ERROR] ${table}: ${r.status} ${await r.text()}`); return false; }

    const cr = r.headers.get('content-range') || '';
    const count = parseInt(cr.split('/')[1] ?? '1', 10);
    return count > 0;
  } catch (e) { console.error('[sbPatchIf]', e); return false; }
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

function validateId(v) { return v && VALID_ID_RE.test(String(v)); }
function sanitizeStr(v, max) { return String(v || '').trim().slice(0, max); }
function validateStocks(v) {
  const n = parseInt(v, 10);
  return (!isNaN(n) && n >= 0 && n <= MAX_STOCKS) ? n : null;
}

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

// ── LEADERBOARD CACHE ────────────────────────────────────────────────────────
// Évite de re-fetch Supabase à chaque connexion cliente.
// Le cache est invalidé immédiatement dès qu'un vrai changement se produit,
// donc les mises à jour restent instantanées. Le TTL (30s) n'est qu'un filet
// de sécurité contre le spam direct de /api/leaderboard.
let _lbCache     = null;
let _lbCacheTime = 0;
const LB_CACHE_TTL = 30_000; // 30 secondes

async function leaderboardData() {
  const now = Date.now();
  if (_lbCache && (now - _lbCacheTime) < LB_CACHE_TTL) return _lbCache;
  const nowIso = new Date().toISOString();
  const [players, recentMatches, lfmPosts, bannersArr] = await Promise.all([
    sbGet('players', 'order=points.desc'),
    sbGet('matches', 'order=date.desc&limit=10'),
    sbGet('lfm_posts', `expires_at=gt.${nowIso}&order=created_at.desc`),
    sbGet('banners', 'select=id,img_dash,img_lb,img_dash_gif,img_lb_gif'),
  ]);
  const banners_map = Object.fromEntries(bannersArr.map(b => [b.id, b]));
  _lbCache     = { players, recent_matches: recentMatches, lfm_posts: lfmPosts, banners_map };
  _lbCacheTime = Date.now();
  return _lbCache;
}

function invalidateLeaderboardCache() {
  _lbCache = null;
}

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

    io.to(`match_${challengeId}`).emit('match_update', payload);
    io.to(`user_${c.challenger_id}`).emit('match_update', payload);
    io.to(`user_${c.challenged_id}`).emit('match_update', payload);

    const excludeIds = (payload.status === 'completed' || payload.status === 'disputed')
      ? [challengeId]
      : [];
    await Promise.all([c.challenger_id, c.challenged_id].map(uid => emitDashboardUpdate(uid, excludeIds)));
  } catch (e) { console.error('[emitMatchUpdate]', e); }
}

async function emitLeaderboardUpdate() {
  // Invalide le cache AVANT d'émettre — les clients re-fetchent /api/leaderboard
  // et obtiennent des données fraîches de Supabase, pas le cache périmé.
  invalidateLeaderboardCache();
  io.emit('leaderboard_changed');
}

const chatHistory = new Map();
const CHAT_MAX = 50;

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

  socket.on('bo_phase_update', (data) => {
    const cid = data && data.challenge_id;
    if (!cid) return;

    socket.to(`match_${cid}`).emit('bo_phase_update', data);
  });

  socket.on('chat_message', (data) => {
    const uid  = req.session?.user?.id;
    const name = req.session?.user?.username || 'Unknown';
    const cid  = data?.challenge_id || '';
    const text = (data?.text || '').toString().slice(0, 200).trim();
    if (!uid || !validateId(cid) || !text) return;
    if (isChatRateLimited(uid)) return; 
    const payload = { uid, name, text, ts: new Date().toISOString() };
    if (!chatHistory.has(cid)) chatHistory.set(cid, []);
    const hist = chatHistory.get(cid);
    hist.push(payload);
    if (hist.length > CHAT_MAX) hist.shift();
    io.to(`match_${cid}`).emit('chat_message', payload);
  });
});

async function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  try {
    const players = await sbGet("players", `id=eq.${req.session.user.id}`);
    if (!players.length) { req.session.destroy(() => {}); return res.redirect("/login"); }
    if (players[0].is_banned) {
      const uid = req.session.user.id;
      const banReason = players[0].ban_reason || null;
      req.session.destroy(() => {});
      if (req.path.startsWith("/api/") || req.method !== "GET") {
        return res.status(403).json({ error: "Your account has been banned." });
      }
      return res.render("banned.html", { user_id: uid, ban_reason: banReason });
    }
  } catch (e) { console.error("[requireAuth ban check]", e); }
  next();
}

app.get('/', async (req, res) => {
  try {
    const now = new Date().toISOString();
    await sbDelete('lfm_posts', { expires_at: `lt.${now}` });
    const [players, matches, lfm, bannersArr] = await Promise.all([
      sbGet('players', 'order=points.desc'),
      sbGet('matches', 'order=date.desc&limit=10'),
      sbGet('lfm_posts', 'order=created_at.desc'),
      sbGet('banners', 'select=id,img_dash,img_lb,img_dash_gif,img_lb_gif'),
    ]);
    const banners_map = Object.fromEntries(bannersArr.map(b => [b.id, b]));
    res.render('index.html', { user: req.session.user || null, players, recent_matches: matches, lfm_posts: lfm, banners_map });
  } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

app.get('/ranking', publicApiLimiter, async (req, res) => {
  try {
    const allPlayers = await sbGet('players', 'order=points.desc');
    // Only show players who have played at least one game
    const players = allPlayers.filter(p => (p.matches_played || 0) > 0);
    res.render('ranking.html', { user: req.session.user || null, players });
  } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

app.get('/login', loginLimiter, (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauth_state = state;
  res.redirect(DISCORD_AUTH_URL + `&state=${state}`);
});

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
        main_char: '', secondary_char: '', stocks_taken: 0, stocks_lost: 0, rcoins: 0, owned_banners: [] });
    } else {

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

app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const [data, playerRow, banners] = await Promise.all([
      dashboardData(userId),
      sbGet('players', `id=eq.${userId}`),
      sbGet('banners', 'select=id,img_dash,img_lb,img_dash_gif,img_lb_gif'),
    ]);
    const is_admin = playerRow.length && playerRow[0].is_admin ? true : false;
    const banners_map = Object.fromEntries(banners.map(b => [b.id, b]));
    res.render('dashboard.html', { user: req.session.user, ...data, active_match_ids: Object.keys(data.active_matches), pending_challenge_ids: Object.keys(data.challenges_sent), is_admin, banners, banners_map });
  } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

app.get('/player/:player_id', async (req, res) => {
  const { player_id } = req.params;
  if (req.session.user?.id === player_id) return res.redirect('/dashboard');
  try {
    const [players, myMatches, bannersArr] = await Promise.all([
      sbGet('players', 'order=points.desc'),
      getPlayerMatches(player_id, 10),
      sbGet('banners', 'select=id,img_dash,img_lb,img_dash_gif,img_lb_gif'),
    ]);
    const player = players.find(p => p.id === player_id);
    if (!player) return res.redirect('/');
    const rank = players.findIndex(p => p.id === player_id) + 1;
    const banners_map = Object.fromEntries(bannersArr.map(b => [b.id, b]));

    const currentUserPlayer = req.session.user ? players.find(p => p.id === req.session.user.id) : null;
    res.render('player_profile.html', { user: req.session.user || null, player, rank, my_matches: myMatches, banners_map, current_user_rcoins: currentUserPlayer?.rcoins || 0 });
  } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

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
    const [challenger, challenged, bannersArr] = await Promise.all([
      sbGet('players', `id=eq.${c.challenger_id}`),
      sbGet('players', `id=eq.${c.challenged_id}`),
      sbGet('banners', 'select=id,img_dash,img_lb,img_dash_gif,img_lb_gif'),
    ]);
    if (!challenger.length || !challenged.length) return res.redirect('/dashboard');
    const banners_map = Object.fromEntries(bannersArr.map(b => [b.id, b]));
    res.render('match.html', { user: req.session.user, challenge: c, challenger: challenger[0], challenged: challenged[0], banners_map });
  } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/api/dashboard', requireAuth, async (req, res) => {
  try { res.json(await dashboardData(req.session.user.id)); }
  catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/leaderboard', publicApiLimiter, async (req, res) => {
  try { res.json(await leaderboardData()); }
  catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/lfm', publicApiLimiter, async (req, res) => {
  const now = new Date().toISOString();
  res.json(await sbGet('lfm_posts', `expires_at=gt.${now}&order=created_at.desc`));
});

app.get('/api/active-matches', publicApiLimiter, async (req, res) => {
  try {
    const matches = await sbGet('challenges', 'status=eq.accepted&order=accepted_at.desc');
    if (!matches.length) return res.json([]);
    // Collect all player IDs involved
    const ids = [...new Set(matches.flatMap(m => [m.challenger_id, m.challenged_id]).filter(Boolean))];
    const players = await sbGet('players', `id=in.(${ids.join(',')})`);
    const pMap = Object.fromEntries(players.map(p => [p.id, p]));
    const enriched = matches.map(m => ({
      ...m,
      challenger_discord_name: pMap[m.challenger_id]?.username || m.challenger_name,
      challenger_avatar:       pMap[m.challenger_id]?.avatar   || null,
      challenged_discord_name: pMap[m.challenged_id]?.username || m.challenged_name,
      challenged_avatar:       pMap[m.challenged_id]?.avatar   || null,
    }));
    res.json(enriched);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/players/search', publicApiLimiter, async (req, res) => {
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
  if (req.body.yuzu_pseudo    !== undefined) {
    const pseudo = sanitizeStr(req.body.yuzu_pseudo, 32);
    update.yuzu_pseudo = pseudo || null;
  }
  if (!Object.keys(update).length) return res.json({ success: true });
  await sbPatch('players', { id: userId }, update);
  res.json({ success: true });
});

app.post('/challenge/:opponent_id', authApiLimiter, requireAuth, async (req, res) => {
  const { opponent_id } = req.params;
  if (!validateId(opponent_id)) return res.status(400).json({ error: 'Invalid opponent ID' });
  const userId = req.session.user.id;
  if (userId === opponent_id) return res.status(400).json({ error: "You can't challenge yourself" });
  const opponent = await sbGet('players', `id=eq.${opponent_id}`);
  if (!opponent.length) return res.status(404).json({ error: 'Player not found' });
  const existing = await sbGet('challenges', `status=in.(pending,accepted)&or=(and(challenger_id.eq.${userId},challenged_id.eq.${opponent_id}),and(challenger_id.eq.${opponent_id},challenged_id.eq.${userId}))`);
  if (existing.length) return res.status(400).json({ error: 'A challenge is already pending between you' });

  const sentPending = await sbGet('challenges', `challenger_id=eq.${userId}&status=eq.pending`);
  if (sentPending.length >= MAX_PENDING_CHALLENGES_SENT)
    return res.status(429).json({ error: `You already have a pending challenge — cancel it first.` });
  const fmt = req.body.format || 'BO3';
  if (!VALID_FORMATS.has(fmt)) return res.status(400).json({ error: 'Invalid format' });
  const cid = `ch_${crypto.randomBytes(8).toString('hex')}`;
  const myPlayer = await sbGet('players', `id=eq.${userId}`);
  const myDisplayName = myPlayer[0]?.yuzu_pseudo || req.session.user.username;
  const oppDisplayName = opponent[0].yuzu_pseudo || opponent[0].username;
  await sbPost('challenges', { id: cid, challenger_id: userId, challenger_name: myDisplayName,
    challenged_id: opponent_id, challenged_name: oppDisplayName, status: 'pending', format: fmt });

  io.to(`user_${opponent_id}`).emit('new_challenge', {
    challenger_name: myDisplayName,
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
  res.json({ success: true }); 
  await sbPatch('challenges', { id: challenge_id }, { status: 'accepted', accepted_at: new Date().toISOString() });

  await Promise.all([
    sbDelete('lfm_posts', { player_id: c.challenger_id }),
    sbDelete('lfm_posts', { player_id: c.challenged_id }),
  ]);
  await Promise.all([emitDashboardUpdate(c.challenger_id), emitDashboardUpdate(c.challenged_id), emitLeaderboardUpdate()]);
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

// ── DISCORD WEBHOOK — LFM NOTIFICATION ───────────────────────────────────────
// Sends a message to a Discord channel when a player posts a "Find a Match" ad.

async function sendDiscordLfmNotification({ playerName, avatarId, playerId, format, mode, message, points }) {
  if (!DISCORD_LFM_WEBHOOK_URL) return;
  try {
    const avatarUrl = avatarId
      ? `https://cdn.discordapp.com/avatars/${playerId}/${avatarId}.png?size=64`
      : null;

    const formatLabel = { BO1: 'Best of 1', BO3: 'Best of 3', BO5: 'Best of 5', STOCKS: 'Stocks' }[format] || format;
    const modeLabel   = mode === 'stocks' ? 'Stocks' : 'Sets';
    const siteUrl     = REDIRECT_URI.replace('/callback', '');

    const fields = [
      { name: '🎮 Format', value: formatLabel, inline: true },
      { name: '⚙️ Mode',   value: modeLabel,   inline: true },
      { name: '📊 Points', value: String(points || 1000), inline: true },
    ];
    if (message) fields.push({ name: '💬 Message', value: message, inline: false });
    fields.push({ name: '🔗 Site', value: `[Accept on Smash YUZU](${siteUrl})`, inline: false });

    const embed = {
      color: 0xf04a00,
      author: {
        name: `⚔️ ${playerName} is looking for a match!`,
        icon_url: avatarUrl || undefined,
      },
      description: '─────────────────────────',
      fields,
      footer: { text: '─────────────────────────\nSmash YUZU • Find a Match' },
      timestamp: new Date().toISOString(),
    };

    await fetch(DISCORD_LFM_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
  } catch (e) {
    console.error('[Discord LFM Webhook] Error:', e);
  }
}

const lfmPostingInProgress = new Set();

app.post('/lfm', requireAuth, async (req, res) => {
  const userId  = req.session.user.id;
  const fmt     = req.body.format || 'BO3';
  const mode    = req.body.mode || 'sets';
  if (!VALID_FORMATS.has(fmt)) return res.status(400).json({ error: 'Invalid format' });
  if (!VALID_MODES.has(mode))  return res.status(400).json({ error: 'Invalid mode' });

  if (lfmPostingInProgress.has(userId))
    return res.status(429).json({ error: 'Request already in progress — please wait.' });
  lfmPostingInProgress.add(userId);

  try {

    const [activeC, existingPost] = await Promise.all([
      sbGet('challenges', `status=in.(pending,accepted,reported)&or=(challenger_id.eq.${userId},challenged_id.eq.${userId})`),
      sbGet('lfm_posts', `player_id=eq.${userId}`),
    ]);
    if (activeC.length) return res.status(400).json({ error: 'You already have an active challenge or match — finish it first.' });

    if (existingPost.length) await sbDelete('lfm_posts', { player_id: userId });

    const message = sanitizeStr(req.body.message || '', MAX_MESSAGE);
    const player  = await sbGet('players', `id=eq.${userId}`);
    const pts     = player[0]?.points || 1000;
    const main    = player[0]?.main_char || '';
    const avatar  = req.session.user.avatar || '';
    const discordName = req.session.user.username;
    const displayName = player[0]?.yuzu_pseudo || discordName;
    const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const postId  = `lfm_${crypto.randomBytes(8).toString('hex')}`;
    await sbPost('lfm_posts', { id: postId, player_id: userId,
      player_name: displayName, player_discord_name: discordName, player_avatar: avatar,
      player_points: pts, main_char: main, format: fmt, mode, message,
      created_at: new Date().toISOString(), expires_at: expires });
    res.json({ success: true });
    await emitLeaderboardUpdate(); 
    sendDiscordLfmNotification({
      playerName: displayName,
      avatarId:   avatar,
      playerId:   userId,
      format:     fmt,
      mode,
      message,
      points:     pts,
    });
  } finally {
    lfmPostingInProgress.delete(userId);
  }
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
  const myPlayer2 = await sbGet('players', `id=eq.${userId}`);
  const myDisplayName2 = myPlayer2[0]?.yuzu_pseudo || req.session.user.username;

  await sbPost('challenges', { id: cid, challenger_id: userId,
    challenger_name: myDisplayName2, challenged_id: post.player_id,
    challenged_name: post.player_name, status: 'accepted', format: post.format,
    accepted_at: new Date().toISOString() });

  await Promise.all([
    sbDelete('lfm_posts', { id: post_id }),
    sbDelete('lfm_posts', { player_id: userId }),
    sbDelete('lfm_posts', { player_id: post.player_id }),
  ]);

  res.json({ success: true, challenge_id: cid });

  io.to(`user_${userId}`).emit('match_redirect', { challenge_id: cid, p1: myDisplayName2, p2: post.player_name });
  io.to(`user_${post.player_id}`).emit('match_redirect', { challenge_id: cid, p1: myDisplayName2, p2: post.player_name });
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
  await emitLeaderboardUpdate(); 
});

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

  let screenshot = null;
  const raw = req.body.screenshot;
  if (raw && typeof raw === 'string' && raw.startsWith('data:image/') && raw.length <= 5.5 * 1024 * 1024) {
    screenshot = raw;
  }

  await sbPatch('challenges', { id: challenge_id }, { status: 'draw_reported' });

  await createReport({
    challenge_id, challenger_id: c.challenger_id, challenged_id: c.challenged_id,
    format: c.format, title,
    reason: 'player_report',
    chat_history_snapshot: chatHistory.get(challenge_id) || [],
    screenshot,
  });
  chatHistory.delete(challenge_id);

  const msg = { type: 'match_timeout', outcome: 'draw', challenge_id,
    message: '🚩 Match signalé — résultat en DRAW en attendant la décision admin.' };
  io.to(`user_${c.challenger_id}`).emit('match_timeout', msg);
  io.to(`user_${c.challenged_id}`).emit('match_timeout', msg);
  await Promise.all([emitDashboardUpdate(c.challenger_id), emitDashboardUpdate(c.challenged_id)]);

  res.json({ success: true });
});

async function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  const players = await sbGet('players', `id=eq.${req.session.user.id}`);
  if (!players.length || !players[0].is_admin)
    return res.status(403).render('not_member.html');
  req.adminPlayer = players[0];
  next();
}

app.get('/admin/report-screenshot/:report_id', requireAdmin, async (req, res) => {
  const { report_id } = req.params;
  if (!validateId(report_id)) return res.status(400).send('Invalid ID');
  const reports = await sbGet('reports', `id=eq.${report_id}`);
  if (!reports.length) return res.status(404).send('Not found');
  const screenshot = reports[0].screenshot;
  if (!screenshot || !screenshot.startsWith('data:image/')) return res.status(404).send('No screenshot');

  const [header, b64] = screenshot.split(',');
  const mime = header.replace('data:', '').replace(';base64', '');
  const buf  = Buffer.from(b64, 'base64');
  res.set('Content-Type', mime);
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(buf);
});

app.get('/admin/reports', requireAdmin, async (req, res) => {
  try {
    const [openReports, allPlayers] = await Promise.all([
      sbGet('reports', 'order=created_at.desc'),
      sbGet('players', 'order=points.desc'),
    ]);
    const playersMap = Object.fromEntries(allPlayers.map(p => [p.id, p]));

    const enriched = openReports.map(r => {
      const p1 = playersMap[r.challenger_id] || { username: r.challenger_id, points: '?', wins: 0, losses: 0 };
      const p2 = playersMap[r.challenged_id] || { username: r.challenged_id, points: '?', wins: 0, losses: 0 };
      const normalizedStatus = r.status === 'resolved' ? 'resolved' : 'open';
      const winnerUsername = r.winner_id ? (playersMap[r.winner_id] || {}).username || r.winner_id : null;

      const has_screenshot = !!(r.screenshot && r.screenshot.startsWith('data:image/'));
      const { screenshot: _drop, ...rClean } = r; 
      return { ...rClean, p1, p2, status: normalizedStatus, winner_username: winnerUsername, has_screenshot };
    });
    const suggestions = await sbGet('suggestions', 'order=created_at.desc').catch(() => []);
    res.render('admin_reports.html', {
      user: req.session.user,
      is_admin: true,
      reports: enriched,
      players_map: playersMap,
      players: allPlayers,
      suggestions: suggestions || [],
      _tab: 'reports',
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

app.post('/api/save_progress/:challenge_id', requireAuth, async (req, res) => {
  const { challenge_id } = req.params;
  if (!validateId(challenge_id)) return res.status(400).json({ error: 'Invalid ID' });
  const userId = req.session.user.id;
  const challenges = await sbGet('challenges', `id=eq.${challenge_id}`);
  if (!challenges.length) return res.status(404).json({ error: 'Not found' });
  const c = challenges[0];
  if (![c.challenger_id, c.challenged_id].includes(userId))
    return res.status(403).json({ error: 'Not part of this match' });
  if (c.status !== 'accepted') return res.json({ success: true }); 
  const { games_history } = req.body;
  if (!Array.isArray(games_history)) return res.status(400).json({ error: 'Invalid data' });
  const prev = (typeof c.report === 'object' && c.report) ? c.report : {};
  await sbPatch('challenges', { id: challenge_id }, {
    report: { ...prev, games_history }
  });
  return res.json({ success: true });
});

app.post('/result/:challenge_id', authApiLimiter, requireAuth, async (req, res) => {
  const { challenge_id } = req.params;
  if (!validateId(challenge_id)) return res.status(400).json({ error: 'Invalid ID' });
  const userId     = req.session.user.id;
  const challenges = await sbGet('challenges', `id=eq.${challenge_id}`);
  if (!challenges.length) return res.status(404).json({ error: 'Not found' });
  const c = challenges[0];
  if (![c.challenger_id, c.challenged_id].includes(userId)) return res.status(403).json({ error: 'Not part of this match' });

  const { winner_id, score: rawScore } = req.body;
  const isStocks = c.format === 'STOCKS';

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
    wSt = Math.max(0, wStRaw - prevW); 
    lSt = Math.max(0, lStRaw - prevL);
    scoreStr = sanitizeStr(rawScore || '', 20) || `${wStRaw}-${lStRaw}`; 
  } else {
    const v1 = validateStocks(wStRaw), v2 = validateStocks(lStRaw);
    if (v1 === null || v2 === null) return res.status(400).json({ error: `Stocks must be 0–${MAX_STOCKS}` });
    scoreStr = sanitizeStr(rawScore || '', 20);
  }

  if (![c.challenger_id, c.challenged_id].includes(winner_id) && winner_id !== null && winner_id !== undefined && winner_id !== '') return res.status(400).json({ error: 'Invalid winner' });
  const isDraw  = !winner_id;
  const loser_id = isDraw ? null : (winner_id === c.challenger_id ? c.challenged_id : c.challenger_id);

  if (c.status === 'accepted') {

    const won = await sbPatchIf('challenges', { id: challenge_id, status: 'accepted' }, {
      status: 'reported', reported_by: userId, reported_at: new Date().toISOString(),
      report: {
        winner_id: isDraw ? null : winner_id, score: scoreStr,
        winner_stocks_taken: wSt, loser_stocks_taken: lSt,
        winner_stocks_total: wStRaw, loser_stocks_total: lStRaw,
        is_stocks_mode: isStocks,
        games_history: req.body.games_history || null
      }
    });

    if (won) {

      await emitMatchUpdate(challenge_id);
      return res.json({ success: true, message: 'Result submitted! Waiting for opponent confirmation.' });
    }

    const fresh = await sbGet('challenges', `id=eq.${challenge_id}`);
    if (!fresh.length) return res.status(404).json({ error: 'Not found' });
    const cf = fresh[0];
    if (cf.status !== 'reported' || cf.reported_by === userId) {

      return res.json({ success: true, message: 'Result submitted! Waiting for opponent confirmation.' });
    }

    Object.assign(c, cf);
  }

  if (c.status === 'reported' && c.reported_by !== userId) {
    const report = typeof c.report === 'object' ? c.report : {};
    const reportedWinnerId = report.winner_id || null;
    const submittedWinnerId = isDraw ? null : winner_id;
    if (String(submittedWinnerId) === String(reportedWinnerId)) {
      if (isDraw) {

        await Promise.all([
          sbPatch('challenges', { id: challenge_id }, { status: 'completed' }),
          sbPost('matches', { challenge_id, winner_id: null, winner_name: 'DRAW',
            winner_main: '', loser_id: null, loser_name: 'DRAW',
            loser_main: '', score: scoreStr || '0-0',
            format: c.format, elo_change: 0, date: new Date().toISOString() }),
        ]);
        await new Promise(r => setTimeout(r, 300));
        await emitMatchUpdate(challenge_id, { status: 'completed', winner_id: null, score: scoreStr || '0-0', elo_change: 0 });
        await emitLeaderboardUpdate();
        chatHistory.delete(challenge_id);
        return res.json({ success: true, message: 'Match ended in a draw. No ELO change.', elo_change: 0, winner_id: null });
      }
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
        await new Promise(r => setTimeout(r, 300));
        await emitMatchUpdate(challenge_id, {
          status: 'completed', winner_id, score: report.score || scoreStr, elo_change: eloGain,
        });
        await emitLeaderboardUpdate();
        chatHistory.delete(challenge_id);
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

async function createReport({ challenge_id, challenger_id, challenged_id, format, title, reason, chat_history_snapshot, screenshot }) {
  const rid = `rep_${crypto.randomBytes(8).toString('hex')}`;
  const payload = {
    id: rid, challenge_id, challenger_id, challenged_id, format,
    title: title || 'Signalement sans titre',
    reason: reason || 'unknown',
    chat_history: chat_history_snapshot || [],
    status: 'open',
    created_at: new Date().toISOString(),
  };

  if (screenshot && typeof screenshot === 'string' && screenshot.startsWith('data:image/')) {
    payload.screenshot = screenshot;
  }
  await sbPost('reports', payload);
  return rid;
}

async function resolveDeadMatches() {
  try {
    const now = new Date();

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

const VALID_RARITIES = new Set(['common', 'rare', 'epic', 'legendary']);
const RARITY_PRICES = { common: 100, rare: 500, epic: 1500, legendary: 2000 };
const MAX_BANNER_IMG_BYTES     = 2 * 1024 * 1024; 
const MAX_BANNER_GIF_BYTES     = 5 * 1024 * 1024; 
const VALID_BANNER_MIME_STATIC = new Set(['data:image/png;', 'data:image/jpeg;', 'data:image/webp;']);

function validateBannerImg(raw) {
  if (!raw || typeof raw !== 'string') return null;
  if (!raw.startsWith('data:image/')) return null;

  if (raw.startsWith('data:image/gif;')) return null;
  if (raw.length > Math.ceil(MAX_BANNER_IMG_BYTES * 1.4)) return null;
  return raw;
}

function validateBannerGif(raw) {
  if (!raw || typeof raw !== 'string') return null;
  if (!raw.startsWith('data:image/gif;')) return null;
  if (raw.length > Math.ceil(MAX_BANNER_GIF_BYTES * 1.4)) return null;
  return raw;
}

app.get('/wallet', async (req, res) => {
  try {
    let player = null;
    if (req.session.user) {
      const rows = await sbGet('players', `id=eq.${req.session.user.id}`);
      player = rows[0] || null;
    }
    res.render('wallet.html', { user: req.session.user || null, player });
  } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

app.get('/shop', async (req, res) => {
  try {
    const banners = await sbGet('banners', 'order=created_at.desc');
    let player = null;
    if (req.session.user) {
      const rows = await sbGet('players', `id=eq.${req.session.user.id}`);
      player = rows[0] || null;
    }
    res.render('shop.html', { user: req.session.user || null, banners, player });
  } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

app.post('/shop/equip', requireAuth, async (req, res) => {
  const { banner_id, slot } = req.body;
  if (!slot || !['dash', 'lb'].includes(slot))
    return res.status(400).json({ error: 'Invalid slot' });
  if (!banner_id || !validateId(String(banner_id)))
    return res.status(400).json({ error: 'Invalid banner ID' });
  const banners = await sbGet('banners', `id=eq.${banner_id}`);
  if (!banners.length) return res.status(404).json({ error: 'Banner not found' });
  const field = slot === 'dash' ? 'banner_dash' : 'banner_lb';
  await sbPatch('players', { id: req.session.user.id }, { [field]: banner_id });
  res.json({ success: true });
});

app.post('/shop/unequip', requireAuth, async (req, res) => {
  const { slot } = req.body;
  if (!slot || !['dash', 'lb'].includes(slot))
    return res.status(400).json({ error: 'Invalid slot' });
  const field = slot === 'dash' ? 'banner_dash' : 'banner_lb';
  await sbPatch('players', { id: req.session.user.id }, { [field]: null });
  res.json({ success: true });
});

app.post('/shop/banner-opacity', authApiLimiter, requireAuth, async (req, res) => {
  const { banner_id, opacity } = req.body;
  if (!banner_id || !validateId(String(banner_id)))
    return res.status(400).json({ error: 'Invalid banner ID' });
  const opVal = parseInt(opacity, 10);
  if (isNaN(opVal) || opVal < 10 || opVal > 100)
    return res.status(400).json({ error: 'Opacity must be between 10 and 100' });

  const playerRows = await sbGet('players', `id=eq.${req.session.user.id}`);
  if (!playerRows.length) return res.status(404).json({ error: 'Player not found' });
  const player = playerRows[0];
  const owned = Array.isArray(player.owned_banners) ? player.owned_banners : [];
  if (!owned.includes(banner_id))
    return res.status(403).json({ error: 'You do not own this banner' });

  const currentOpacity = (typeof player.banner_opacity === 'object' && player.banner_opacity) ? player.banner_opacity : {};
  const newOpacity = { ...currentOpacity, [banner_id]: opVal };
  await sbPatch('players', { id: req.session.user.id }, { banner_opacity: newOpacity });
  res.json({ success: true });
});

app.post('/shop/buy', authApiLimiter, requireAuth, async (req, res) => {
  const { banner_id } = req.body;
  if (!banner_id || !validateId(String(banner_id)))
    return res.status(400).json({ error: 'Invalid banner ID' });

  const [banners, playerRows] = await Promise.all([
    sbGet('banners', `id=eq.${banner_id}`),
    sbGet('players', `id=eq.${req.session.user.id}`),
  ]);
  if (!banners.length)   return res.status(404).json({ error: 'Banner not found' });
  if (!playerRows.length) return res.status(404).json({ error: 'Player not found' });

  const banner = banners[0];
  const player = playerRows[0];
  const price  = RARITY_PRICES[banner.rarity];
  if (!price) return res.status(400).json({ error: 'Unknown rarity' });

  const owned = Array.isArray(player.owned_banners) ? player.owned_banners : [];
  if (owned.includes(banner_id))
    return res.status(400).json({ error: 'You already own this banner' });

  const rcoins = player.rcoins || 0;
  if (rcoins < price)
    return res.status(400).json({ error: `Not enough RCoins (need ${price}, have ${rcoins})` });

  const newBalance = rcoins - price;
  const newOwned   = [...owned, banner_id];

  const won = await sbPatchIf("players",
    { id: req.session.user.id, rcoins: `gte.${price}` },
    { rcoins: newBalance, owned_banners: newOwned }
  );
  if (!won) {
    const fresh = await sbGet("players", `id=eq.${req.session.user.id}`);
    const fp = fresh[0] || {};
    const fo = Array.isArray(fp.owned_banners) ? fp.owned_banners : [];
    if (fo.includes(banner_id)) return res.status(400).json({ error: "You already own this banner" });
    return res.status(400).json({ error: `Not enough RCoins (need ${price}, have ${fp.rcoins || 0})` });
  }
  res.json({ success: true, new_balance: newBalance });
});

app.post('/shop/buy-coins', authApiLimiter, requireAuth, async (req, res) => {
  const { pack_id } = req.body;
  const pack = RCOIN_PACKS.find(p => p.id === pack_id);
  if (!pack) return res.status(400).json({ error: 'Pack invalide' });

  res.json({
    url:       pack.kofi_url,
    discord_id: req.session.user.id,
    pack_id:    pack.id,
    coins:      pack.coins,
  });
});

// ── SUGGESTIONS ──────────────────────────────────────────────────────────────
// Players can submit suggestions (visible to admins with author info)

app.post('/api/suggestions', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const text = (req.body.text || '').trim().slice(0, 600);
  if (!text) return res.status(400).json({ error: 'Empty suggestion' });
  try {
    const playerRows = await sbGet('players', `id=eq.${userId}`);
    const username = playerRows[0]?.username || req.session.user.username || userId;
    const id = `sug_${crypto.randomBytes(8).toString('hex')}`;
    await sbPost('suggestions', {
      id, player_id: userId, username,
      text, created_at: new Date().toISOString(),
    });
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.get('/admin/suggestions', requireAdmin, async (req, res) => {
  try {
    const suggestions = await sbGet('suggestions', 'order=created_at.desc');
    res.render('admin_reports.html', {
      user: req.session.user,
      is_admin: true,
      suggestions: suggestions || [],
      _tab: 'suggestions',
    });
  } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

app.delete('/admin/suggestions/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (!validateId(id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    await sbDelete('suggestions', { id });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'DB error' }); }
});

app.get('/api/whatsup', async (req, res) => {
  try {
    const posts = await sbGet('whatsup_posts', 'order=position.asc,created_at.asc');
    res.json({ posts: posts || [] });
  } catch(e) { res.json({ posts: [] }); }
});

app.post('/admin/whatsup', requireAdmin, async (req, res) => {
  const { text, image, bg_color, text_color, duration } = req.body;
  if (!text && !image) return res.status(400).json({ error: 'text or image required' });
  const id = `wu_${require('crypto').randomBytes(6).toString('hex')}`;

  const existing = await sbGet('whatsup_posts', 'order=position.desc&limit=1');
  const position = existing && existing.length ? (existing[0].position || 0) + 1 : 0;
  await sbPost('whatsup_posts', {
    id, text: text || null,
    image: image || null,          
    bg_color: bg_color || null,
    text_color: text_color || null,
    duration: parseInt(duration) || 5,
    position,
    created_at: new Date().toISOString()
  });
  io.emit('whatsup_update'); 
  res.json({ success: true, id });
});

app.patch('/admin/whatsup/:post_id', requireAdmin, async (req, res) => {
  const { post_id } = req.params;
  const { text, image, bg_color, text_color, duration, position } = req.body;
  const update = {};
  if (text     !== undefined) update.text      = text;
  if (image    !== undefined) update.image     = image;
  if (bg_color !== undefined) update.bg_color  = bg_color;
  if (text_color !== undefined) update.text_color = text_color;
  if (duration !== undefined) update.duration  = parseInt(duration) || 5;
  if (position !== undefined) update.position  = parseInt(position);
  await sbPatch('whatsup_posts', { id: post_id }, update);
  io.emit('whatsup_update');
  res.json({ success: true });
});

app.delete('/admin/whatsup/:post_id', requireAdmin, async (req, res) => {
  const { post_id } = req.params;
  await sbDelete('whatsup_posts', { id: post_id });
  io.emit('whatsup_update');
  res.json({ success: true });
});

app.post('/admin/whatsup/reorder', requireAdmin, async (req, res) => {
  const { order } = req.body; 
  if (!Array.isArray(order)) return res.status(400).json({ error: 'invalid' });
  await Promise.all(order.map(({ id, position }) =>
    sbPatch('whatsup_posts', { id }, { position: parseInt(position) })
  ));
  io.emit('whatsup_update');
  res.json({ success: true });
});
app.get('/admin/shop', requireAdmin, async (req, res) => {
  try {
    const banners = await sbGet('banners', 'order=created_at.desc');
    const players = await sbGet('players', 'select=banner_dash,banner_lb');
    const counts  = {};
    for (const p of players) {
      if (p.banner_dash) counts[p.banner_dash] = (counts[p.banner_dash] || 0) + 1;
      if (p.banner_lb)   counts[p.banner_lb]   = (counts[p.banner_lb]   || 0) + 1;
    }
    const enriched = banners.map(b => ({ ...b, equipped_count: counts[b.id] || 0 }));
    res.render('admin_shop.html', { user: req.session.user, is_admin: true, banners: enriched });
  } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

app.post('/admin/shop/banner', requireAdmin, async (req, res) => {
  const name   = sanitizeStr(req.body.name || '', 60);
  const rarity = req.body.rarity || 'common';
  if (!name)                       return res.status(400).json({ error: 'Name is required' });
  if (!VALID_RARITIES.has(rarity)) return res.status(400).json({ error: 'Invalid rarity' });
  const img_dash     = validateBannerImg(req.body.img_dash);
  const img_lb       = validateBannerImg(req.body.img_lb);
  const img_dash_gif = validateBannerGif(req.body.img_dash_gif);
  const img_lb_gif   = validateBannerGif(req.body.img_lb_gif);
  if (!img_dash && !img_lb && !img_dash_gif && !img_lb_gif)
    return res.status(400).json({ error: 'At least one image is required' });
  const bid = `ban_${crypto.randomBytes(8).toString('hex')}`;
  await sbPost('banners', {
    id: bid, name, rarity,
    img_dash:     img_dash     || null,
    img_lb:       img_lb       || null,
    img_dash_gif: img_dash_gif || null,
    img_lb_gif:   img_lb_gif   || null,
    created_by: req.session.user.id,
    created_at: new Date().toISOString(),
  });
  res.json({ success: true, banner: { id: bid, name, rarity, img_dash, img_lb, img_dash_gif, img_lb_gif } });
});

app.delete('/admin/shop/banner/:banner_id', requireAdmin, async (req, res) => {
  const { banner_id } = req.params;
  if (!validateId(banner_id)) return res.status(400).json({ error: 'Invalid ID' });
  const banners = await sbGet('banners', `id=eq.${banner_id}`);
  if (!banners.length) return res.status(404).json({ error: 'Banner not found' });

  await Promise.all([
    sbPatch('players', { banner_dash: banner_id }, { banner_dash: null }),
    sbPatch('players', { banner_lb:   banner_id }, { banner_lb:   null }),
  ]);
  await sbDelete('banners', { id: banner_id });
  res.json({ success: true });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`⚔ Smash YUZU running on port ${PORT}`);

  resolveDeadMatches();
  setInterval(resolveDeadMatches, DEAD_MATCH_CHECK_INTERVAL);
});
