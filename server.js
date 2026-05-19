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

// ── APP ───────────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' }, pingTimeout: 60000, pingInterval: 25000 });

const sessionMiddleware = session({
  secret: SECRET_KEY,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, sameSite: 'lax', maxAge: 86400 * 1000 }
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use('/static', express.static(path.join(__dirname, 'static')));

const env = nunjucks.configure(path.join(__dirname, 'templates'), {
  autoescape: true,
  express: app,
  noCache: false,
});
env.addFilter('tojson', (val) => JSON.stringify(val));
env.addFilter('round', (val, digits) => parseFloat(Number(val).toFixed(digits ?? 0)));
env.addFilter('int', (val) => parseInt(val, 10));
env.addFilter('list', (val) => Array.isArray(val) ? val : Object.keys(val ?? {}));

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

// ── MATCH STATE MACHINE (BO) ─────────────────────────────────────────────────
const matchStates = new Map();

// Liste complète des stages
const ALL_STAGES = ["Battlefield", "Small Battlefield", "Final Destination", "Pokemon Stadium 2", "Town and City", "Smashville", "Hollow Bastion", "Kalos Pokémon League", "Yoshi's Story"];

function getMatchState(challengeId, p1Id, p2Id) {
  if (!matchStates.has(challengeId)) {
    matchStates.set(challengeId, {
      phase: 'character_p1',
      turn: p1Id,
      p1Id: p1Id,
      p2Id: p2Id,
      p1Char: '',
      p2Char: '',
      availableStages: [...ALL_STAGES], // Copie fraîche
      bannedStages: [],
      finalStage: '',
      gameIndex: 0,
      gameResults: [],
      p1GamesWon: 0,
      p2GamesWon: 0,
      pendingProposal: null,
      setFinished: false,
      banCount: 0
    });
  }
  return matchStates.get(challengeId);
}

// Fonction pour réinitialiser la phase de stages pour un nouveau game
function resetStagesForNewGame(state, winnerId) {
  state.availableStages = [...ALL_STAGES];
  state.bannedStages = [];
  state.phase = 'stage_ban';
  // L'ordre des bans alterne : celui qui a PERDU le game précédent commence
  // Pour le premier game, c'est P1 qui commence
  if (state.gameIndex === 0) {
    state.turn = state.p1Id;
  } else {
    // Le perdant du game précédent commence les bans
    state.turn = (winnerId === state.p1Id) ? state.p2Id : state.p1Id;
  }
  state.banCount = 0;
}

// ── DATA HELPERS ──────────────────────────────────────────────────────────────
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
  try {
    const data = await leaderboardData();
    io.emit('leaderboard_update', data);
  } catch (e) { console.error('[emitLeaderboardUpdate]', e); }
}

const chatHistory = new Map();
const CHAT_MAX = 50;

// ── SOCKET.IO EVENTS ─────────────────────────────────────────────────────────
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
    socket.join(`match_${cid}`);
    const history = chatHistory.get(cid) || [];
    if (history.length) socket.emit('chat_history', history);

    const challenges = await sbGet('challenges', `id=eq.${cid}`);
    if (challenges.length) {
      const c = challenges[0];
      const state = getMatchState(cid, c.challenger_id, c.challenged_id);
      socket.emit('match_state', state);
    }
  });

  socket.on('leave_match', (data) => {
    const cid = data?.challenge_id || '';
    if (validateId(cid)) socket.leave(`match_${cid}`);
  });

  socket.on('chat_message', (data) => {
    const uid  = req.session?.user?.id;
    const name = req.session?.user?.username || 'Unknown';
    const cid  = data?.challenge_id || '';
    const text = (data?.text || '').toString().slice(0, 200).trim();
    if (!uid || !validateId(cid) || !text) return;
    const payload = { uid, name, text, ts: new Date().toISOString() };
    if (!chatHistory.has(cid)) chatHistory.set(cid, []);
    const hist = chatHistory.get(cid);
    hist.push(payload);
    if (hist.length > CHAT_MAX) hist.shift();
    io.to(`match_${cid}`).emit('chat_message', payload);
  });

  // ── GESTION DES BANS ──
  socket.on('char_pick', async (data) => {
    const { challenge_id, player_id, char_id, char_name } = data;
    if (!validateId(challenge_id) || !validateId(player_id)) return;
    const challenges = await sbGet('challenges', `id=eq.${challenge_id}`);
    if (!challenges.length) return;
    const c = challenges[0];
    const state = getMatchState(challenge_id, c.challenger_id, c.challenged_id);
    const userId = req.session.user?.id;
    if (userId !== player_id) return;

    if (state.phase === 'character_p1' && player_id === state.p1Id) {
      state.p1Char = char_name;
      state.phase = 'character_p2';
      state.turn = state.p2Id;
      io.to(`match_${challenge_id}`).emit('match_state', state);
      io.to(`match_${challenge_id}`).emit('char_picked', { player_id, char_name });
    } else if (state.phase === 'character_p2' && player_id === state.p2Id) {
      state.p2Char = char_name;
      // Passer à la phase de bans
      state.phase = 'stage_ban';
      state.turn = state.p1Id; // P1 commence les bans
      state.banCount = 0;
      io.to(`match_${challenge_id}`).emit('match_state', state);
      io.to(`match_${challenge_id}`).emit('char_picked', { player_id, char_name });
    }
  });

  socket.on('ban_stage', async (data) => {
    const { challenge_id, stage, by_player } = data;
    if (!validateId(challenge_id) || !stage) return;
    const challenges = await sbGet('challenges', `id=eq.${challenge_id}`);
    if (!challenges.length) return;
    const c = challenges[0];
    const state = getMatchState(challenge_id, c.challenger_id, c.challenged_id);
    const userId = req.session.user?.id;
    if (userId !== by_player || state.phase !== 'stage_ban' || by_player !== state.turn) return;

    const idx = state.availableStages.indexOf(stage);
    if (idx !== -1) {
      state.availableStages.splice(idx, 1);
      state.bannedStages.push(stage);
    }

    state.banCount++;
    
    // Logique des bans: P1 ban 2, P2 ban 4
    if (state.turn === state.p1Id && state.banCount === 2) {
      state.turn = state.p2Id;
      state.banCount = 0;
    } else if (state.turn === state.p2Id && state.banCount === 4) {
      // Fin des bans - il reste 3 stages, on passe au choix du stage final
      state.phase = 'stage_pick';
      state.turn = (state.gameIndex === 0) ? state.p1Id : (state.gameResults[state.gameResults.length-1]?.winner_id === state.p1Id ? state.p2Id : state.p1Id);
      io.to(`match_${challenge_id}`).emit('match_state', state);
      io.to(`match_${challenge_id}`).emit('stage_banned', { stage, by_player });
      return;
    }
    
    io.to(`match_${challenge_id}`).emit('match_state', state);
    io.to(`match_${challenge_id}`).emit('stage_banned', { stage, by_player });
  });

  socket.on('pick_stage', async (data) => {
    const { challenge_id, stage } = data;
    if (!validateId(challenge_id) || !stage) return;
    const challenges = await sbGet('challenges', `id=eq.${challenge_id}`);
    if (!challenges.length) return;
    const c = challenges[0];
    const state = getMatchState(challenge_id, c.challenger_id, c.challenged_id);
    const userId = req.session.user?.id;
    if (state.phase !== 'stage_pick' || userId !== state.turn) return;
    if (!state.availableStages.includes(stage)) return;

    state.finalStage = stage;
    state.phase = 'game_play';
    state.turn = null;
    io.to(`match_${challenge_id}`).emit('match_state', state);
    io.to(`match_${challenge_id}`).emit('stage_picked', { stage, by_player: userId });
  });

  socket.on('propose_game_result', async (data) => {
    const { challenge_id, game_index, winner_id } = data;
    if (!validateId(challenge_id) || !validateId(winner_id)) return;
    const challenges = await sbGet('challenges', `id=eq.${challenge_id}`);
    if (!challenges.length) return;
    const c = challenges[0];
    const state = getMatchState(challenge_id, c.challenger_id, c.challenged_id);
    const userId = req.session.user?.id;
    if (state.phase !== 'game_play' || state.pendingProposal) return;
    if (userId !== state.p1Id && userId !== state.p2Id) return;
    state.pendingProposal = { winner_id, byPlayerId: userId, game_index };
    io.to(`match_${challenge_id}`).emit('match_state', state);
    io.to(`match_${challenge_id}`).emit('game_proposed', { winner_id, by_player: userId, game_index });
  });

  socket.on('confirm_game_result', async (data) => {
    const { challenge_id, game_index, accepted } = data;
    if (!validateId(challenge_id)) return;
    const challenges = await sbGet('challenges', `id=eq.${challenge_id}`);
    if (!challenges.length) return;
    const c = challenges[0];
    const state = getMatchState(challenge_id, c.challenger_id, c.challenged_id);
    const userId = req.session.user?.id;
    if (!state.pendingProposal || state.pendingProposal.game_index !== game_index) return;
    if (userId === state.pendingProposal.byPlayerId) return;

    if (accepted) {
      const winnerId = state.pendingProposal.winner_id;
      state.gameResults.push({ winner_id: winnerId });
      if (winnerId === state.p1Id) state.p1GamesWon++;
      else state.p2GamesWon++;
      
      const maxWins = c.format === 'BO1' ? 1 : c.format === 'BO3' ? 2 : 3;
      
      // Vérifier si le set est terminé
      if (state.p1GamesWon === maxWins || state.p2GamesWon === maxWins) {
        state.setFinished = true;
        state.phase = 'completed';
        // Nettoyer la proposition en attente
        state.pendingProposal = null;
        io.to(`match_${challenge_id}`).emit('match_state', state);
        io.to(`match_${challenge_id}`).emit('game_confirmed', { accepted: true, winner_id: winnerId, game_index, setFinished: true });
        return;
      }
      
      // Passer au game suivant - RÉINITIALISER COMPLÈTEMENT LES STAGES
      state.gameIndex++;
      state.pendingProposal = null;
      
      // Réinitialiser les stages pour le nouveau game
      state.availableStages = [...ALL_STAGES];
      state.bannedStages = [];
      state.finalStage = '';
      state.phase = 'stage_ban';
      // Le perdant du game précédent commence les bans
      state.turn = (winnerId === state.p1Id) ? state.p2Id : state.p1Id;
      state.banCount = 0;
      
      io.to(`match_${challenge_id}`).emit('match_state', state);
      io.to(`match_${challenge_id}`).emit('game_confirmed', { accepted: true, winner_id: winnerId, game_index, setFinished: false });
    } else {
      state.pendingProposal = null;
      io.to(`match_${challenge_id}`).emit('match_state', state);
      io.to(`match_${challenge_id}`).emit('game_confirmed', { accepted: false, game_index });
    }
  });
});

// ── AUTH MIDDLEWARE & ROUTES ───────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

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

app.get('/login', (req, res) => {
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
        main_char: '', secondary_char: '', stocks_taken: 0, stocks_lost: 0 });
    } else {
      await sbPatch('players', { id: uid }, { username: displayName, avatar });
    }
    res.redirect('/dashboard');
  } catch (e) { console.error(e); res.status(500).send('Auth error'); }
});

app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const data   = await dashboardData(userId);
    res.render('dashboard.html', { user: req.session.user, ...data, active_match_ids: Object.keys(data.active_matches) });
  } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

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

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

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
    elo_change: c.elo_change || null });
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

app.post('/challenge/:opponent_id', requireAuth, async (req, res) => {
  const { opponent_id } = req.params;
  if (!validateId(opponent_id)) return res.status(400).json({ error: 'Invalid opponent ID' });
  const userId = req.session.user.id;
  if (userId === opponent_id) return res.status(400).json({ error: "You can't challenge yourself" });
  const opponent = await sbGet('players', `id=eq.${opponent_id}`);
  if (!opponent.length) return res.status(404).json({ error: 'Player not found' });
  const existing = await sbGet('challenges', `status=in.(pending,accepted)&or=(and(challenger_id.eq.${userId},challenged_id.eq.${opponent_id}),and(challenger_id.eq.${opponent_id},challenged_id.eq.${userId}))`);
  if (existing.length) return res.status(400).json({ error: 'A challenge is already pending between you' });
  const fmt = req.body.format || 'BO3';
  if (!VALID_FORMATS.has(fmt)) return res.status(400).json({ error: 'Invalid format' });
  const cid = `ch_${crypto.randomBytes(8).toString('hex')}`;
  await sbPost('challenges', { id: cid, challenger_id: userId, challenger_name: req.session.user.username,
    challenged_id: opponent_id, challenged_name: opponent[0].username, status: 'pending', format: fmt });
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
  res.json({ success: true });
  await sbPatch('challenges', { id: challenge_id }, { status: 'accepted' });
  await Promise.all([emit
