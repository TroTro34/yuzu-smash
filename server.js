'use strict';

// ════════════════════════════════════════════════════════════════════════════
//  DEV MODE — set DEV_MODE=true to run locally without Supabase/Discord OAuth.
//
//  Usage:
//    DEV_MODE=true node server.js
//    (or just:  node dev-launcher.js)
//
//  Two fake players are pre-seeded. Open two browsers/tabs:
//    Browser A (normal)    → http://localhost:10000/dev-login?player=1  (admin)
//    Browser B (incognito) → http://localhost:10000/dev-login?player=2
//
//  Useful dev routes:
//    /dev-login          chooser page (click to instantly log in)
//    /dev-login?player=1 instant login as Player1
//    /dev-login?player=2 instant login as Player2
//    /dev-state          dump entire in-memory store as JSON
//    /dev-reset          reset challenges/matches, keep players
// ════════════════════════════════════════════════════════════════════════════

const DEV_MODE = process.env.DEV_MODE === 'true' || process.env.DEV_MODE === '1';

if (DEV_MODE) {
  // Stub out mandatory env vars so server.js doesn't exit(1)
  process.env.SECRET_KEY              = process.env.SECRET_KEY              || 'dev_secret_local';
  process.env.KOFI_VERIFICATION_TOKEN = process.env.KOFI_VERIFICATION_TOKEN || 'dev_kofi_token';
  process.env.DISCORD_CLIENT_SECRET   = process.env.DISCORD_CLIENT_SECRET   || 'dev_discord_secret';
  process.env.SUPABASE_URL            = process.env.SUPABASE_URL            || 'http://localhost:1';
  process.env.SUPABASE_KEY            = process.env.SUPABASE_KEY            || 'dev_supabase_key';
  process.env.REDIRECT_URI            = process.env.REDIRECT_URI            || 'http://localhost:10000/callback';
  process.env.ADMIN_DISCORD_ID        = process.env.ADMIN_DISCORD_ID        || 'dev_player1';
  process.env.NODE_ENV                = 'development';
}

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
if (!SECRET_KEY) { console.error('SECRET_KEY missing'); process.exit(1); }

const KOFI_VERIFICATION_TOKEN = process.env.KOFI_VERIFICATION_TOKEN;
if (!KOFI_VERIFICATION_TOKEN) { console.error('KOFI_VERIFICATION_TOKEN missing'); process.exit(1); }

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
const DISCORD_LFM_ROLE_ID    = process.env.DISCORD_LFM_ROLE_ID || '1100475756653596773';

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
      console.warn('[Ko-fi Webhook] Unexpected payload:', JSON.stringify(req.body).slice(0, 200));
      return res.status(400).send('Missing data field');
    }

    if (payload.verification_token !== KOFI_VERIFICATION_TOKEN) {
      console.warn('[Ko-fi Webhook] Invalid token received:', payload.verification_token);
      return res.status(401).send('Invalid verification token');
    }

    if (payload.type !== 'Shop Order' && payload.type !== 'Donation') {
      console.log('[Ko-fi Webhook] Ignored type:', payload.type);
      return res.status(200).send('OK');
    }

    const amountRaw = parseFloat(payload.amount || '0');
    const currency  = (payload.currency || 'EUR').toUpperCase();
  
    let pack = KOFI_PACKS.find(p => Math.abs(p.amount - amountRaw) < 0.01);
    if (!pack) {
      console.warn('[Ko-fi Webhook] Unrecognized amount:', amountRaw, '— fallback pack_500 for test');
      pack = KOFI_PACKS[0];
    }

    const txId = payload.kofi_transaction_id || payload.message_id || null;
    if (!txId) {
      console.warn('[Ko-fi Webhook] No kofi_transaction_id in payload');
      return res.status(200).send('No transaction ID');
    }

    const existing = await sbGet('kofi_transactions', `kofi_transaction_id=eq.${encodeURIComponent(txId)}`);
    if (existing && existing.length) {
      console.log('[Ko-fi Webhook] Transaction already recorded:', txId);
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
      console.error('[Ko-fi Webhook] Failed to insert into Supabase for tx:', txId);
      return res.status(500).send('DB error');
    }

    console.log(`✅ [Ko-fi] Transaction stored (pending): ${txId} — ${pack.coins} RCoins — ${amountRaw}€`);
    return res.status(200).send('OK');

  } catch (err) {
    console.error('[Ko-fi Webhook] Unexpected error:', err);
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
    return res.status(400).json({ error: 'missing_tx', message: 'Invalid link — use the link received in your Ko-fi email.' });
  }

  try {

    const txRows = await sbGet('kofi_transactions', `kofi_transaction_id=eq.${encodeURIComponent(tx_id)}`);
    if (!txRows || !txRows.length) {
      return res.status(404).json({ error: 'not_found', message: 'Transaction not found. Make sure you are using the link received from Ko-fi.' });
    }

    const tx = txRows[0];

    if (tx.status === 'claimed') {
      return res.status(409).json({ error: 'already_claimed', message: 'These RCoins have already been claimed.' });
    }

    const claimed = await sbPatchIf(
      'kofi_transactions',
      { kofi_transaction_id: tx.kofi_transaction_id, status: 'pending' },
      { status: 'claimed', claimed_by: userId, claimed_at: new Date().toISOString() }
    );

    if (!claimed) {
      return res.status(409).json({ error: 'already_claimed', message: 'These RCoins have already been claimed.' });
    }

    const playerRows = await sbGet('players', `id=eq.${userId}`);
    if (!playerRows || !playerRows.length) {

      await sbPatch('kofi_transactions', { kofi_transaction_id: tx.kofi_transaction_id }, { status: 'pending', claimed_by: null, claimed_at: null });
      return res.status(404).json({ error: 'player_not_found', message: 'Your player account could not be found.' });
    }

    const player   = playerRows[0];
    const current  = player.rcoins || 0;
    const added    = tx.coins;
    const newTotal = current + added;

    const ok = await sbPatch('players', { id: userId }, { rcoins: newTotal });
    if (!ok) {

      await sbPatch('kofi_transactions', { kofi_transaction_id: tx.kofi_transaction_id }, { status: 'pending', claimed_by: null, claimed_at: null });
      return res.status(500).json({ error: 'db_error', message: 'DB error during credit — please try again.' });
    }

    io.to(`user_${userId}`).emit('rcoins_update', { new_balance: newTotal, added });

    console.log(`✅ [Redeem] ${added} RCoins credited to ${userId} (${player.username || userId}) — tx: ${tx.kofi_transaction_id} — total: ${newTotal}`);
    return res.json({ success: true, added, new_balance: newTotal });

  } catch (err) {
    console.error('[/api/redeem] Error:', err);
    return res.status(500).json({ error: 'internal', message: 'Unexpected server error.' });
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
  return num.toLocaleString('en-US');
});

function sbHeaders() {
  return {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };
}

// ── DEV_MODE: in-memory store replacing Supabase ─────────────────────────────
const _devStore = DEV_MODE ? (() => {
  const DEV_PLAYERS_SEED = [
    { id:'dev_player1', username:'Player1', avatar:null, points:1200, wins:5, losses:3,
      matches_played:8, main_char:'mario', secondary_char:'pikachu', stocks_taken:20,
      stocks_lost:14, rcoins:500, owned_banners:[], is_admin:true, is_banned:false,
      ban_reason:null, yuzu_pseudo:null, char_stats:{}, banner_dash:null, banner_lb:null },
    { id:'dev_player2', username:'Player2', avatar:null, points:1050, wins:3, losses:5,
      matches_played:8, main_char:'link', secondary_char:'', stocks_taken:14,
      stocks_lost:20, rcoins:200, owned_banners:[], is_admin:false, is_banned:false,
      ban_reason:null, yuzu_pseudo:null, char_stats:{}, banner_dash:null, banner_lb:null },
  ];
  const s = {
    players: new Map(DEV_PLAYERS_SEED.map(p => [p.id, {...p}])),
    matches: new Map(), challenges: new Map(), kofi_transactions: new Map(),
    banners: new Map(), lfm_posts: new Map(), whatsup_posts: new Map(),
    dm_messages: new Map(), suggestions: new Map(), reports: new Map(), game_results: new Map(),
  };
  s._seed = DEV_PLAYERS_SEED;
  return s;
})() : null;

function _devParseParams(paramStr) {
  const filters = {}; let order=null, limit=null, select=null;
  for (const part of (paramStr||'').split('&')) {
    if (!part) continue;
    if (part.startsWith('order='))  { order  = part.slice(6); continue; }
    if (part.startsWith('limit='))  { limit  = parseInt(part.slice(6)); continue; }
    if (part.startsWith('select=')) { select = part.slice(7); continue; }
    if (part.startsWith('or='))     { filters['_or'] = part.slice(3); continue; }
    const ei = part.indexOf('='); if (ei===-1) continue;
    const field = part.slice(0,ei), rest=part.slice(ei+1), di=rest.indexOf('.');
    filters[field] = di===-1 ? {op:'eq',val:rest} : {op:rest.slice(0,di),val:decodeURIComponent(rest.slice(di+1))};
  }
  return {filters,order,limit,select};
}

function _devMatch(row,field,{op,val}) {
  const rv=row[field];
  if(op==='eq')  return String(rv)===String(val);
  if(op==='neq') return String(rv)!==String(val);
  if(op==='gt')  return Number(rv)>Number(val);
  if(op==='gte') return Number(rv)>=Number(val);
  if(op==='lt')  return Number(rv)<Number(val);
  if(op==='lte') return Number(rv)<=Number(val);
  if(op==='in')  { const items=val.replace(/^\(|\)$/g,'').split(',').map(s=>s.trim()); return items.includes(String(rv)); }
  if(op==='is')  return val==='null'?rv==null:rv!=null;
  return true;
}

function _devOrFilter(rows, orStr) {
  const inner = orStr.replace(/^\(|\)$/g,'');
  const clauses=[]; let depth=0,buf='';
  for(const ch of inner) {
    if(ch==='('){depth++;buf+=ch;}else if(ch===')'){depth--;buf+=ch;}
    else if(ch===','&&depth===0){clauses.push(buf);buf='';}else buf+=ch;
  }
  if(buf) clauses.push(buf);
  return rows.filter(row=>clauses.some(clause=>{
    if(clause.startsWith('and(')){
      const sub=clause.slice(4,-1).split(',');
      return sub.every(s=>{
        const parts=s.split('.'); if(parts.length<3)return true;
        const [f,op,...vp]=parts; return _devMatch(row,f,{op,val:vp.join('.')});
      });
    }
    const parts=clause.split('.'); if(parts.length<3) return false;
    const [f,op,...vp]=parts; return _devMatch(row,f,{op,val:vp.join('.')});
  }));
}

function _devQuery(table, paramStr='') {
  const map=_devStore[table]; if(!map) return [];
  const {filters,order,limit,select}=_devParseParams(paramStr);
  let rows=[...map.values()].filter(row=>{
    for(const [f,cond] of Object.entries(filters)){if(f==='_or')continue;if(!_devMatch(row,f,cond))return false;}
    return true;
  });
  if(filters['_or']) rows=_devOrFilter(rows,filters['_or']);
  if(order){const [col,dir]=order.split('.');rows.sort((a,b)=>{const cmp=String(a[col]??'').localeCompare(String(b[col]??''),undefined,{numeric:true});return dir==='desc'?-cmp:cmp;});}
  if(limit) rows=rows.slice(0,limit);
  if(select&&select!=='*'){const flds=select.split(',').map(s=>s.trim());rows=rows.map(r=>Object.fromEntries(flds.map(f=>[f,r[f]])));}
  return rows;
}
// ─────────────────────────────────────────────────────────────────────────────

async function sbGet(table, params = '') {
  if (DEV_MODE) return _devQuery(table, params);
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, { headers: sbHeaders() });
    return r.ok ? r.json() : [];
  } catch { return []; }
}

async function sbPost(table, data) {
  if (DEV_MODE) {
    if (!_devStore[table]) _devStore[table] = new Map();
    const row = {...data};
    const key = row.id || row.kofi_transaction_id || crypto.randomBytes(8).toString('hex');
    _devStore[table].set(key, row);
    return [row];
  }
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST', headers: sbHeaders(), body: JSON.stringify(data)
    });
    if (!r.ok) console.error(`[sbPost ERROR] ${table}: ${r.status} ${await r.text()}`);
    return r.ok ? r.json() : null;
  } catch (e) { console.error('[sbPost]', e); return null; }
}

async function sbPatch(table, match, data) {
  if (DEV_MODE) {
    const map = _devStore[table]; if(!map) return false;
    let found=false;
    for(const row of map.values()){
      let ok=true;
      for(const [k,v] of Object.entries(match)){if(String(row[k])!==String(v)){ok=false;break;}}
      if(ok){Object.assign(row,data);found=true;}
    }
    return found;
  }
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
  if (DEV_MODE) {
    const map = _devStore[table]; if(!map) return false;
    const OPERATORS = new Set(['lt','gt','lte','gte','neq','like','ilike','is','in']);
    let found=false;
    for(const row of map.values()){
      let ok=true;
      for(const [k,v] of Object.entries(match)){
        const s=String(v), op=s.split('.')[0];
        const cond = OPERATORS.has(op) ? {op, val:s.slice(op.length+1)} : {op:'eq', val:s};
        if(!_devMatch(row,k,cond)){ok=false;break;}
      }
      if(ok){Object.assign(row,data);found=true;}
    }
    return found;
  }
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
  if (DEV_MODE) {
    const map = _devStore[table]; if(!map) return true;
    const OPERATORS = new Set(['lt','gt','lte','gte','neq','like','ilike','is','in']);
    for(const [key,row] of map.entries()){
      let ok=true;
      for(const [k,v] of Object.entries(match)){
        const s=String(v), op=s.split('.')[0];
        const cond = OPERATORS.has(op) ? {op, val:s.slice(op.length+1)} : {op:'eq', val:s};
        if(!_devMatch(row,k,cond)){ok=false;break;}
      }
      if(ok) map.delete(key);
    }
    return true;
  }
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

// ── CHAR STATS ────────────────────────────────────────────────────────────────
// ── GAME RESULTS — insère les games détaillées dans la table `game_results` ──
// Appelée après chaque match validé (BO ou admin).
// challengerId = p1 (challenger), challengedId = p2 (challenged)
async function saveGameResults(challengeId, matchId, challengerId, challengedId, boGames, fallbackWinnerChar, fallbackLoserId, fallbackLoserChar) {
  const rows = [];

  if (Array.isArray(boGames) && boGames.length > 0) {
    // Mode BO — on a le détail complet par game
    boGames.forEach((g, i) => {
      rows.push({
        id:           `gr_${require('crypto').randomBytes(6).toString('hex')}`,
        challenge_id: challengeId,
        match_id:     matchId || null,
        game_number:  i + 1,
        p1_id:        challengerId,
        p2_id:        challengedId,
        p1_char:      g.p1char || null,
        p2_char:      g.p2char || null,
        stage:        g.stage  || null,
        winner:       g.winner || null,   // 'p1' | 'p2'
        played_at:    new Date().toISOString(),
      });
    });
  } else if (fallbackWinnerChar || fallbackLoserChar) {
    // Fallback mode STOCKS ou décision admin — 1 seule ligne sans stage
    // On détermine qui est p1/p2 selon challengerId
    const winnerIsP1 = fallbackLoserId === challengedId;
    rows.push({
      id:           `gr_${require('crypto').randomBytes(6).toString('hex')}`,
      challenge_id: challengeId,
      match_id:     matchId || null,
      game_number:  1,
      p1_id:        challengerId,
      p2_id:        challengedId,
      p1_char:      winnerIsP1 ? fallbackWinnerChar : fallbackLoserChar,
      p2_char:      winnerIsP1 ? fallbackLoserChar  : fallbackWinnerChar,
      stage:        null,
      winner:       winnerIsP1 ? 'p1' : 'p2',
      played_at:    new Date().toISOString(),
    });
  }

  if (!rows.length) return;

  // Insert chaque ligne (Supabase REST ne supporte pas le bulk insert avec return=representation facilement)
  await Promise.all(rows.map(row => sbPost('game_results', row)));
}

// ── CHAR STATS — recalcule char_stats depuis game_results pour un joueur ──────
// Plus besoin de lire/merger manuellement : on relit toutes les game_results
// du joueur et on recalcule from scratch pour éviter toute corruption.
async function rebuildCharStats(playerId) {
  try {
    const rows = await sbGet('game_results',
      `or=(p1_id.eq.${playerId},p2_id.eq.${playerId})`
    );
    if (!rows || !rows.length) {
      await sbPatch('players', { id: playerId }, { char_stats: {} });
      return;
    }

    const stats = {}; // { char: { wins, losses, games, stages: { stage: count } } }

    for (const g of rows) {
      const isP1   = g.p1_id === playerId;
      const myChar = isP1 ? g.p1_char : g.p2_char;
      if (!myChar) continue;
      const won    = (isP1 && g.winner === 'p1') || (!isP1 && g.winner === 'p2');

      if (!stats[myChar]) stats[myChar] = { wins: 0, losses: 0, games: 0, stages: {} };
      stats[myChar].games++;
      if (won) stats[myChar].wins++;
      else     stats[myChar].losses++;
      // "stages" alimente la section "WINS BY STAGE" côté client : ne compter
      // que les games GAGNÉES sur ce stage, pas tous les games joués.
      if (g.stage && won) {
        stats[myChar].stages[g.stage] = (stats[myChar].stages[g.stage] || 0) + 1;
      }
    }

    await sbPatch('players', { id: playerId }, { char_stats: stats });
  } catch (e) {
    console.error('[rebuildCharStats]', playerId, e);
  }
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

// Cache du dernier état de phase BO par match — permet de resynchroniser
// un joueur qui arrive en retard ou dont la session storage est vide.
const boPhaseCache = new Map();

// ── CHAT — stocké dans Supabase, table dm_messages ───────────────────────────
// room_id = "dm_AAA_BBB" (IDs triés) pour DM, "match_XXX" pour match chat
// Nettoyage automatique des messages > 24h via job toutes les heures

function dmRoomId(a, b) { return 'dm_' + [a, b].sort().join('_'); }

async function getMessagesFromDb(roomId, limit = 100) {
  try {
    const rows = await sbGet('dm_messages', `room_id=eq.${encodeURIComponent(roomId)}&order=ts.asc&limit=${limit}`);
    return rows || [];
  } catch { return []; }
}

async function saveMessageToDb(roomId, payload) {
  try {
    const id = 'msg_' + require('crypto').randomBytes(8).toString('hex');
    await sbPost('dm_messages', {
      id,
      room_id:      roomId,
      uid:          payload.uid,
      name:         payload.name,
      text:         payload.text,
      reply_to:     payload.replyTo || null,
      ts:           payload.ts,
      source:       payload.source || 'dm',
      challenge_id: payload.challenge_id || null,
    });
  } catch (e) { console.error('[saveMessageToDb]', e); }
}

async function cleanOldMessages() {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await sbDelete('dm_messages', { ts: `lt.${cutoff}` });
    console.log('[cleanOldMessages] Messages older than 24h deleted');
  } catch (e) { console.error('[cleanOldMessages]', e); }
}

// Cleanup every hour
setInterval(cleanOldMessages, 60 * 60 * 1000);

// Copy match messages into the DM room between the two players.
// This is now a fallback for messages sent before the unified chat was active.
// During an active match, messages are saved to both rooms in real-time.
async function copyMatchMsgsToDmRoom(challengeId, player1Id, player2Id) {
  try {
    const roomId = dmRoomId(player1Id, player2Id);
    const msgs = await sbGet('dm_messages', `room_id=eq.match_${encodeURIComponent(challengeId)}&order=ts.asc`);
    if (!msgs || !msgs.length) return;
    // Only copy messages not already in the DM room (avoid duplicates)
    const existing = await sbGet('dm_messages', `room_id=eq.${encodeURIComponent(roomId)}&challenge_id=eq.${encodeURIComponent(challengeId)}&select=id`);
    const existingIds = new Set((existing || []).map(m => m.id));
    let copied = 0;
    for (const m of msgs) {
      if (existingIds.has(m.id)) continue; // already copied in real-time
      const newId = 'msg_' + require('crypto').randomBytes(8).toString('hex');
      await sbPost('dm_messages', {
        id:           newId,
        room_id:      roomId,
        uid:          m.uid,
        name:         m.name,
        text:         m.text,
        reply_to:     m.reply_to || null,
        ts:           m.ts,
        source:       'match',
        challenge_id: challengeId,
      });
      copied++;
    }
    if (copied > 0) console.log(`[copyMatchMsgsToDmRoom] ${copied} messages copied for challenge ${challengeId}`);
  } catch (e) { console.error('[copyMatchMsgsToDmRoom]', e); }
}

// Typing state: Map<roomId, Map<uid, timeoutHandle>>
const typingState = new Map();

function setTyping(roomId, uid, name, io_instance) {
  if (!typingState.has(roomId)) typingState.set(roomId, new Map());
  const room = typingState.get(roomId);
  if (room.has(uid)) clearTimeout(room.get(uid).timer);
  const timer = setTimeout(() => {
    room.delete(uid);
    io_instance.to(roomId).emit('typing_update', { roomId, typing: [...room.entries()].map(([k, v]) => ({ uid: k, name: v.name })) });
  }, 3000);
  room.set(uid, { timer, name });
  io_instance.to(roomId).emit('typing_update', { roomId, typing: [...room.entries()].map(([k, v]) => ({ uid: k, name: v.name })) });
}

function clearTyping(roomId, uid, io_instance) {
  const room = typingState.get(roomId);
  if (!room || !room.has(uid)) return;
  clearTimeout(room.get(uid).timer);
  room.delete(uid);
  io_instance.to(roomId).emit('typing_update', { roomId, typing: [...room.entries()].map(([k, v]) => ({ uid: k, name: v.name })) });
}

const chatRateMap = new Map();
const dmRateMap   = new Map();

function isDmRateLimited(uid) {
  const now = Date.now();
  const entry = dmRateMap.get(uid) || { count: 0, windowStart: now };
  if (now - entry.windowStart > CHAT_RATE_LIMIT_WINDOW) { entry.count = 0; entry.windowStart = now; }
  entry.count++;
  dmRateMap.set(uid, entry);
  return entry.count > CHAT_RATE_LIMIT_COUNT;
}

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

// ── MATCH PRESENCE — délai de grâce avant de prévenir l'adversaire ──────────
// Une coupure websocket (réseau, veille mobile, etc.) déclenche 'disconnect'
// même si le joueur n'a pas vraiment quitté. On attend quelques secondes pour
// voir s'il revient (join_match) avant de notifier l'autre joueur.
const pendingLeaveTimers = new Map(); // key: `${challenge_id}:${uid}` → Timeout
const MATCH_LEAVE_GRACE_MS = 8000;

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
    socket._lastMatchRoom = cid; // track for disconnect notification
    socket._matchUid = uid;      // track for disconnect grace-period lookup

    // Si un 'opponent_left' était en attente (déconnexion récente) pour CE joueur
    // sur CE match, on l'annule — il s'agissait d'une coupure temporaire — et on
    // prévient l'adversaire qu'il est bien revenu.
    const timerKey = `${cid}:${uid}`;
    if (pendingLeaveTimers.has(timerKey)) {
      clearTimeout(pendingLeaveTimers.get(timerKey));
      pendingLeaveTimers.delete(timerKey);
      socket.to(`match_${cid}`).emit('opponent_rejoined', { challenge_id: cid });
    }

    // Charger l'historique depuis Supabase
    const history = await getMessagesFromDb(`match_${cid}`);
    socket.emit('chat_history', history);
    const cachedPhase = boPhaseCache.get(cid);
    if (cachedPhase) socket.emit('bo_phase_update', cachedPhase);
  });

  socket.on('leave_match', (data) => {
    const cid = data?.challenge_id || '';
    if (validateId(cid)) socket.leave(`match_${cid}`);
  });

  // ── REMATCH via socket ────────────────────────────────────────────────────
  // Pure relay — pas de création ici, juste broadcast à l'adversaire.
  // La création réelle se fait via POST /api/rematch quand les deux acceptent.
  socket.on('rematch_request', (data) => {
    const uid = req.session?.user?.id;
    const cid = data?.challenge_id || '';
    if (!uid || !validateId(cid)) return;
    socket.to(`match_${cid}`).emit('rematch_request', { challenge_id: cid });
  });

  socket.on('rematch_cancel', (data) => {
    const uid = req.session?.user?.id;
    const cid = data?.challenge_id || '';
    if (!uid || !validateId(cid)) return;
    socket.to(`match_${cid}`).emit('rematch_cancelled', { challenge_id: cid });
  });

  // ── PLAYER LEAVING MATCH PAGE ─────────────────────────────────────────────
  // Emitted explicitly via beforeunload (vraie fermeture/navigation volontaire) :
  // pas besoin de délai de grâce ici, c'est une action explicite de l'utilisateur.
  socket.on('match_leave', (data) => {
    const uid = req.session?.user?.id;
    const cid = data?.challenge_id || '';
    if (!uid || !validateId(cid)) return;
    socket._lastMatchRoom = cid; // track for disconnect fallback
    socket._explicitLeave = true; // évite un double opponent_left via le disconnect qui suivra
    socket.to(`match_${cid}`).emit('opponent_left', { challenge_id: cid });
    socket.leave(`match_${cid}`);
  });

  socket.on('disconnect', () => {
    // Coupure du socket (réseau, veille, refresh...) — pas forcément un vrai départ.
    // Si match_leave a déjà notifié explicitement, on ne fait rien de plus.
    if (socket._explicitLeave) return;
    const cid = socket._lastMatchRoom;
    const uid = socket._matchUid;
    if (!cid || !validateId(cid) || !uid) return;

    const timerKey = `${cid}:${uid}`;
    // Si un timer existe déjà pour cette clé (cas limite), on le remplace.
    if (pendingLeaveTimers.has(timerKey)) clearTimeout(pendingLeaveTimers.get(timerKey));

    const timer = setTimeout(() => {
      pendingLeaveTimers.delete(timerKey);
      socket.to(`match_${cid}`).emit('opponent_left', { challenge_id: cid });
    }, MATCH_LEAVE_GRACE_MS);
    pendingLeaveTimers.set(timerKey, timer);
  });

  socket.on('bo_phase_update', (data) => {
    const cid = data && data.challenge_id;
    if (!cid) return;

    boPhaseCache.set(cid, data);
    socket.to(`match_${cid}`).emit('bo_phase_update', data);
  });

  socket.on('chat_message', async (data) => {
    const uid  = req.session?.user?.id;
    const name = req.session?.user?.username || 'Unknown';
    const cid  = data?.challenge_id || '';
    const text = (data?.text || '').toString().slice(0, 200).trim();
    if (!uid || !validateId(cid) || !text) return;
    if (isChatRateLimited(uid)) return;
    clearTyping(`match_${cid}`, uid, io);
    const replyTo = data?.reply_to ? {
      uid:  String(data.reply_to.uid  || '').slice(0, 80),
      name: String(data.reply_to.name || '').slice(0, 80),
      text: String(data.reply_to.text || '').slice(0, 80),
    } : null;
    const payload = { uid, name, text, ts: new Date().toISOString(), source: 'match', challenge_id: cid, ...(replyTo ? { replyTo } : {}) };
    // Save to Supabase in the match room
    await saveMessageToDb(`match_${cid}`, payload);
    // Broadcast to match room (match chat sidebar)
    io.to(`match_${cid}`).emit('chat_message', payload);

    // Also broadcast to the DM room between the two players in real-time
    // so match chat and DM share a unified message thread
    try {
      const challenges = await sbGet('challenges', `id=eq.${cid}`);
      if (challenges.length) {
        const c = challenges[0];
        const dmRoom = dmRoomId(c.challenger_id, c.challenged_id);
        // Save a copy in the DM room too (so DM history includes match messages)
        await saveMessageToDb(dmRoom, { ...payload });
        // Emit to DM room so the other player sees it live in DM as well
        io.to(dmRoom).emit('dm_message', { roomId: dmRoom, ...payload });
        // Also update typing in the shared DM room
        clearTyping(dmRoom, uid, io);
      }
    } catch (e) { console.error('[chat_message dm broadcast]', e); }
  });

  socket.on('chat_typing', async (data) => {
    const uid  = req.session?.user?.id;
    const name = req.session?.user?.username || 'Unknown';
    const cid  = data?.challenge_id || '';
    if (!uid || !validateId(cid)) return;
    setTyping(`match_${cid}`, uid, name, io);
    // Also propagate typing to the DM room
    try {
      const challenges = await sbGet('challenges', `id=eq.${cid}`);
      if (challenges.length) {
        const c = challenges[0];
        const dmRoom = dmRoomId(c.challenger_id, c.challenged_id);
        setTyping(dmRoom, uid, name, io);
      }
    } catch (e) { /* silent */ }
  });

  // DM CHAT
  socket.on('dm_join', async (data) => {
    const uid = req.session?.user?.id;
    const otherId = data?.other_id || '';
    if (!uid || !validateId(otherId)) return;
    const [myRow, otherRow] = await Promise.all([
      sbGet('players', `id=eq.${uid}`),
      sbGet('players', `id=eq.${otherId}`),
    ]);
    if (!myRow.length || !otherRow.length) return;
    const roomId = dmRoomId(uid, otherId);
    socket.join(roomId);
    // Load DM history from Supabase (already includes match messages written there in real-time)
    const history = await getMessagesFromDb(roomId, 100);
    socket.emit('dm_history', { roomId, messages: history });
  });

  socket.on('dm_leave', (data) => {
    const uid = req.session?.user?.id;
    const otherId = data?.other_id || '';
    if (!uid || !validateId(otherId)) return;
    const roomId = dmRoomId(uid, otherId);
    clearTyping(roomId, uid, io);
    socket.leave(roomId);
  });

  socket.on('dm_typing', async (data) => {
    const uid  = req.session?.user?.id;
    const name = req.session?.user?.username || 'Unknown';
    const otherId = data?.other_id || '';
    if (!uid || !validateId(otherId)) return;
    const roomId = dmRoomId(uid, otherId);
    setTyping(roomId, uid, name, io);
    // Also propagate typing to the active match room if one exists
    try {
      const activeChallenges = await sbGet('challenges',
        `status=in.(accepted)&or=(and(challenger_id=eq.${uid},challenged_id=eq.${otherId}),and(challenger_id=eq.${otherId},challenged_id=eq.${uid}))`
      );
      if (activeChallenges && activeChallenges.length) {
        setTyping(`match_${activeChallenges[0].id}`, uid, name, io);
      }
    } catch (e) { /* silent */ }
  });

  socket.on('dm_message', async (data) => {
    const uid  = req.session?.user?.id;
    const name = req.session?.user?.username || 'Unknown';
    const otherId = data?.other_id || '';
    const text    = (data?.text || '').toString().slice(0, 200).trim();
    if (!uid || !validateId(otherId) || !text) return;
    if (isDmRateLimited(uid)) return;
    const roomId = dmRoomId(uid, otherId);
    clearTyping(roomId, uid, io);
    const replyTo = data?.reply_to ? {
      uid:  String(data.reply_to.uid  || '').slice(0, 80),
      name: String(data.reply_to.name || '').slice(0, 80),
      text: String(data.reply_to.text || '').slice(0, 80),
    } : null;
    const payload = { uid, name, text, ts: new Date().toISOString(), source: 'dm', ...(replyTo ? { replyTo } : {}) };
    // Save to Supabase DM room
    await saveMessageToDb(roomId, payload);
    io.to(roomId).emit('dm_message', { roomId, ...payload });

    // Notif popup pour le receveur (même s'il n'est pas dans la room DM)
    io.to(`user_${otherId}`).emit('dm_notification', {
      from_id:   uid,
      from_name: name,
      text:      text.slice(0, 80),
    });

    // If there is an active match between these two players, also forward to match room
    try {
      const activeChallenges = await sbGet('challenges',
        `status=in.(accepted)&or=(and(challenger_id=eq.${uid},challenged_id=eq.${otherId}),and(challenger_id=eq.${otherId},challenged_id=eq.${uid}))`
      );
      if (activeChallenges && activeChallenges.length) {
        const c = activeChallenges[0];
        const matchPayload = { ...payload, source: 'dm', challenge_id: c.id };
        io.to(`match_${c.id}`).emit('chat_message', matchPayload);
      }
    } catch (e) { /* silent */ }
  });
});

async function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  if (DEV_MODE) return next(); // skip Supabase ban-check in dev mode
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
    const expiredPosts = await sbGet('lfm_posts', `expires_at=lt.${now}`);
    if (expiredPosts.length) {
      await sbDelete('lfm_posts', { expires_at: `lt.${now}` });
      expiredPosts.forEach(p => {
        if (p.discord_message_id) deleteDiscordLfmMessage(p.discord_message_id).catch(() => {});
      });
    }
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

// ── CHARACTERS PAGE ───────────────────────────────────────────────────────────
// Shows only the logged-in player's own char_stats.

app.get('/characters', requireAuth, async (req, res) => {
  try {
    const playerRows = await sbGet('players', `id=eq.${req.session.user.id}`);
    const player = playerRows[0] || null;
    const charStats = (player && player.char_stats && typeof player.char_stats === 'object')
      ? player.char_stats
      : {};

    res.render('characters.html', {
      user: req.session.user,
      char_stats: charStats,
      current_user_rcoins: player?.rcoins || 0,
    });
  } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

// ── DEV MODE: fake login routes ───────────────────────────────────────────────
if (DEV_MODE) {
  app.get('/dev-login', (req, res) => {
    const p = req.query.player;
    if (p === '1' || p === '2') {
      const player = _devStore._seed[parseInt(p) - 1];
      req.session.user = { id: player.id, username: player.username, avatar: null };
      return res.redirect('/dashboard');
    }
    res.send(`<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><title>DEV LOGIN</title>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Rajdhani:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  :root{--bg:#0a0a0f;--accent:#f04a00;--text:#e8e8f0;--muted:#6b6b8a;--card:#13131a}
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:var(--bg);color:var(--text);font-family:'Rajdhani',sans-serif;
       min-height:100vh;display:flex;align-items:center;justify-content:center}
  .box{background:var(--card);border:1px solid #222;border-radius:12px;
       padding:3rem 4rem;text-align:center;max-width:500px;width:100%}
  .tag{background:#f04a0022;color:var(--accent);font-size:.75rem;font-weight:700;
       letter-spacing:2px;padding:.3rem .8rem;border-radius:4px;display:inline-block;margin-bottom:1.5rem}
  h1{font-family:'Bebas Neue',sans-serif;font-size:2.5rem;letter-spacing:3px;margin-bottom:.5rem}
  p{color:var(--muted);margin-bottom:2rem;font-size:1rem}
  .players{display:flex;gap:1rem;justify-content:center;flex-wrap:wrap}
  .pc{background:#0a0a0f;border:1px solid #333;border-radius:10px;padding:1.5rem 2rem;flex:1;min-width:160px}
  .av{width:56px;height:56px;border-radius:50%;background:#f04a00;display:flex;align-items:center;
      justify-content:center;font-family:'Bebas Neue',sans-serif;font-size:1.6rem;margin:0 auto 1rem}
  .av.p2{background:#5865F2}
  .pname{font-weight:700;font-size:1.1rem;margin-bottom:.25rem}
  .ppts{color:var(--muted);font-size:.85rem;margin-bottom:1rem}
  .badge{font-size:.7rem;background:#f04a0033;color:var(--accent);padding:.2rem .5rem;
         border-radius:3px;font-weight:700;letter-spacing:1px}
  a.btn{display:block;margin-top:1rem;background:var(--accent);color:#fff;
        padding:.7rem 1rem;border-radius:6px;text-decoration:none;font-weight:700;font-size:1rem}
  a.btn:hover{opacity:.85}
  a.btn.p2{background:#5865F2}
  .hint{margin-top:2rem;font-size:.8rem;color:var(--muted);line-height:1.8}
  .hint code{background:#1a1a2e;padding:.1rem .4rem;border-radius:3px;color:#a0a0c0}
</style></head><body>
<div class="box">
  <div class="tag">⚙ DEV MODE</div>
  <h1>CHOISIR UN JOUEUR</h1>
  <p>Ouvre <strong>deux onglets / navigateurs</strong> différents pour simuler 2 joueurs.</p>
  <div class="players">
    <div class="pc">
      <div class="av">P1</div>
      <div class="pname">Player1</div>
      <div class="ppts">1200 pts · 5W 3L</div>
      <div class="badge">ADMIN</div>
      <a href="/dev-login?player=1" class="btn">Se connecter</a>
    </div>
    <div class="pc">
      <div class="av p2">P2</div>
      <div class="pname">Player2</div>
      <div class="ppts">1050 pts · 3W 5L</div>
      <a href="/dev-login?player=2" class="btn p2">Se connecter</a>
    </div>
  </div>
  <div class="hint">
    Navigateur A (normal) → <code>/dev-login?player=1</code><br>
    Navigateur B (incognito) → <code>/dev-login?player=2</code><br><br>
    Données en RAM — reset au redémarrage du serveur.<br>
    <code>/dev-state</code> → voir tout le store &nbsp;|&nbsp; <code>/dev-reset</code> → remettre à zéro
  </div>
</div>
</body></html>`);
  });

  app.get('/dev-state', (req, res) => {
    const snap = {};
    for (const [t, map] of Object.entries(_devStore)) {
      if (map instanceof Map) snap[t] = [...map.values()];
    }
    res.json(snap);
  });

  app.get('/dev-reset', (req, res) => {
    _devStore.challenges.clear();
    _devStore.matches.clear();
    _devStore.lfm_posts.clear();
    _devStore.dm_messages.clear();
    _devStore.reports.clear();
    for (const p of _devStore._seed) _devStore.players.set(p.id, {...p});
    req.session.destroy(() => {});
    res.send('<p style="font:1rem monospace;padding:2rem;color:#e8e8f0;background:#0a0a0f;min-height:100vh">✅ Store reset. <a href="/dev-login" style="color:#f04a00">→ login</a></p>');
  });
}
// ─────────────────────────────────────────────────────────────────────────────

app.get('/login', loginLimiter, (req, res) => {
  if (DEV_MODE) return res.redirect('/dev-login');
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

// ── DM PAGE ──────────────────────────────────────────────────────────────────
app.get('/dm/:other_id', requireAuth, async (req, res) => {
  const { other_id } = req.params;
  if (!validateId(other_id)) return res.redirect('/dashboard');
  const uid = req.session.user.id;
  if (uid === other_id) return res.redirect('/dashboard');
  try {
    const [otherRows, myRow] = await Promise.all([
      sbGet('players', `id=eq.${other_id}`),
      sbGet('players', `id=eq.${uid}`),
    ]);
    if (!otherRows.length) return res.redirect('/dashboard');
    res.render('dm.html', {
      user: req.session.user,
      me: myRow[0] || {},
      other: otherRows[0],
    });
  } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

// ── REMATCH ───────────────────────────────────────────────────────────────────
// Crée un nouveau challenge accepted entre les deux mêmes joueurs avec le même format.
// Appelé par le joueur qui confirme le rematch (les deux ont cliqué "Rematch" côté socket).
app.post('/api/rematch', authApiLimiter, requireAuth, async (req, res) => {
  const { challenge_id } = req.body || {};
  if (!challenge_id || !validateId(challenge_id))
    return res.status(400).json({ error: 'Invalid challenge ID' });

  const userId = req.session.user.id;
  const challenges = await sbGet('challenges', `id=eq.${challenge_id}`);
  if (!challenges.length) return res.status(404).json({ error: 'Original match not found' });
  const c = challenges[0];

  if (![c.challenger_id, c.challenged_id].includes(userId))
    return res.status(403).json({ error: 'Not part of this match' });
  if (c.status !== 'completed')
    return res.status(400).json({ error: 'Match not completed yet' });

  // Vérifier qu'aucun match actif entre eux n'existe déjà
  const existing = await sbGet('challenges',
    `status=in.(pending,accepted,reported)&or=(and(challenger_id.eq.${c.challenger_id},challenged_id.eq.${c.challenged_id}),and(challenger_id.eq.${c.challenged_id},challenged_id.eq.${c.challenger_id}))`
  );
  if (existing.length) return res.status(400).json({ error: 'A match between you two is already active' });

  const newId = `ch_${crypto.randomBytes(8).toString('hex')}`;
  await sbPost('challenges', {
    id: newId,
    challenger_id:   c.challenger_id,
    challenger_name: c.challenger_name,
    challenged_id:   c.challenged_id,
    challenged_name: c.challenged_name,
    status:          'accepted',
    format:          c.format,
    accepted_at:     new Date().toISOString(),
  });

  // Prévenir les deux joueurs via socket
  io.to(`match_${challenge_id}`).emit('rematch_redirect', { challenge_id, new_challenge_id: newId });
  io.to(`user_${c.challenger_id}`).emit('match_redirect', { challenge_id: newId, p1: c.challenger_name, p2: c.challenged_name });
  io.to(`user_${c.challenged_id}`).emit('match_redirect', { challenge_id: newId, p1: c.challenger_name, p2: c.challenged_name });

  await Promise.all([emitDashboardUpdate(c.challenger_id), emitDashboardUpdate(c.challenged_id)]);
  res.json({ success: true, new_challenge_id: newId });
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

  // Notifie le challenger (popup + son côté client via notifications.js) — sans ça,
  // J1 n'a aucun signal que son défi a été accepté tant qu'il ne regarde pas le dashboard.
  io.to(`user_${c.challenger_id}`).emit('challenge_accepted', {
    opponent_name: c.challenged_name,
    challenge_id,
  });

  const [danglingChallengerPosts, danglingChallengedPosts] = await Promise.all([
    sbGet('lfm_posts', `player_id=eq.${c.challenger_id}`),
    sbGet('lfm_posts', `player_id=eq.${c.challenged_id}`),
  ]);
  await Promise.all([
    sbDelete('lfm_posts', { player_id: c.challenger_id }),
    sbDelete('lfm_posts', { player_id: c.challenged_id }),
  ]);
  // Pas le flow "accept LFM post" direct — juste un nettoyage de posts devenus obsolètes,
  // donc on supprime simplement les messages Discord correspondants (pas de "Match found").
  [...danglingChallengerPosts, ...danglingChallengedPosts].forEach(p => {
    if (p.discord_message_id) deleteDiscordLfmMessage(p.discord_message_id).catch(() => {});
  });
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

// ── CANCEL ACCEPTED MATCH (avant tout résultat soumis) ───────────────────────
// N'importe lequel des deux joueurs peut annuler tant qu'aucun résultat n'a
// été soumis (games_history vide ou absent → score 0-0).
app.post('/challenge/:challenge_id/cancel_match', requireAuth, async (req, res) => {
  const { challenge_id } = req.params;
  if (!validateId(challenge_id)) return res.status(400).json({ error: 'Invalid ID' });
  const userId = req.session.user.id;
  const challenges = await sbGet('challenges', `id=eq.${challenge_id}`);
  if (!challenges.length) return res.status(404).json({ error: 'Not found' });
  const c = challenges[0];
  if (![c.challenger_id, c.challenged_id].includes(userId))
    return res.status(403).json({ error: 'Not part of this match' });
  if (c.status !== 'accepted')
    return res.status(400).json({ error: 'Match is not in accepted state' });

  // Vérifier que personne n'a soumis de résultat de game (games_history vide)
  const report = (typeof c.report === 'object' && c.report) ? c.report : {};
  const gamesHistory = Array.isArray(report.games_history) ? report.games_history : [];
  if (gamesHistory.length > 0)
    return res.status(400).json({ error: 'Cannot cancel — at least one game result has already been submitted.' });

  await sbDelete('challenges', { id: challenge_id });
  boPhaseCache.delete(challenge_id);

  const msg = { type: 'match_cancelled', challenge_id,
    message: '\u{1F6AB} Match cancelled by a player — returning to dashboard.' };
  io.to(`user_${c.challenger_id}`).emit('match_timeout', msg);
  io.to(`user_${c.challenged_id}`).emit('match_timeout', msg);
  await Promise.all([emitDashboardUpdate(c.challenger_id), emitDashboardUpdate(c.challenged_id)]);
  res.json({ success: true });
});

// ── DISCORD WEBHOOK — LFM NOTIFICATION ───────────────────────────────────────
// Sends a message to a Discord channel when a player posts a "Find a Match" ad.
// On accept → le message est édité en "Match found" avec les deux joueurs.
// Sur suppression (manuelle ou auto-expiration) → le message est supprimé.

const DISCORD_LFM_WEBHOOK_DISABLED = true; // ← passe à false pour réactiver le webhook Discord LFM

function discordAvatarUrl(userId, avatarId) {
  return avatarId ? `https://cdn.discordapp.com/avatars/${userId}/${avatarId}.png?size=64` : undefined;
}

// Renvoie l'id du message Discord créé (ou null si désactivé / échec / pas de wait).
async function sendDiscordLfmNotification({ playerName, avatarId, playerId, format, mode, message, points }) {
  if (DISCORD_LFM_WEBHOOK_DISABLED) return null;
  if (!DISCORD_LFM_WEBHOOK_URL) return null;
  try {
    const avatarUrl = discordAvatarUrl(playerId, avatarId);

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

    // ?wait=true : Discord renvoie l'objet du message créé (avec son id),
    // indispensable pour pouvoir l'éditer/le supprimer plus tard.
    const res = await fetch(`${DISCORD_LFM_WEBHOOK_URL}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '',
        allowed_mentions: { parse: [] },
        embeds: [embed],
      }),
    });
    if (!res.ok) {
      console.error('[Discord LFM Webhook] Send failed:', res.status, await res.text().catch(() => ''));
      return null;
    }
    const sent = await res.json().catch(() => null);
    return sent?.id || null;
  } catch (e) {
    console.error('[Discord LFM Webhook] Error:', e);
    return null;
  }
}

// Édite le message Discord en "Match found" avec les deux joueurs (nom + avatar).
async function editDiscordLfmMatchFound(messageId, { p1Id, p1Name, p1AvatarId, p2Id, p2Name, p2AvatarId }) {
  if (DISCORD_LFM_WEBHOOK_DISABLED) return;
  if (!DISCORD_LFM_WEBHOOK_URL || !messageId) return;
  try {
    const p1AvatarUrl = discordAvatarUrl(p1Id, p1AvatarId);
    const p2AvatarUrl = discordAvatarUrl(p2Id, p2AvatarId);

    const embed = {
      color: 0x3ddc84,
      author: {
        name: `✅ Match found — ${p1Name} vs ${p2Name}`,
        icon_url: p1AvatarUrl || p2AvatarUrl || undefined,
      },
      description: '─────────────────────────',
      thumbnail: p2AvatarUrl ? { url: p2AvatarUrl } : undefined,
      fields: [
        { name: '🟠 Player 1', value: p1Name, inline: true },
        { name: '🔵 Player 2', value: p2Name, inline: true },
      ],
      footer: { text: '─────────────────────────\nSmash YUZU • Match found' },
      timestamp: new Date().toISOString(),
    };

    const res = await fetch(`${DISCORD_LFM_WEBHOOK_URL}/messages/${messageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '', embeds: [embed] }),
    });
    if (!res.ok) {
      console.error('[Discord LFM Webhook] Edit failed:', res.status, await res.text().catch(() => ''));
    }
  } catch (e) {
    console.error('[Discord LFM Webhook] Edit error:', e);
  }
}

// Supprime le message Discord (annulation manuelle par le poster, ou expiration auto).
async function deleteDiscordLfmMessage(messageId) {
  if (DISCORD_LFM_WEBHOOK_DISABLED) return;
  if (!DISCORD_LFM_WEBHOOK_URL || !messageId) return;
  try {
    const res = await fetch(`${DISCORD_LFM_WEBHOOK_URL}/messages/${messageId}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) {
      console.error('[Discord LFM Webhook] Delete failed:', res.status, await res.text().catch(() => ''));
    }
  } catch (e) {
    console.error('[Discord LFM Webhook] Delete error:', e);
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

    if (existingPost.length) {
      await sbDelete('lfm_posts', { player_id: userId });
      if (existingPost[0].discord_message_id) {
        deleteDiscordLfmMessage(existingPost[0].discord_message_id).catch(() => {});
      }
    }

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
    }).then(async (discordMessageId) => {
      if (discordMessageId) {
        await sbPatch('lfm_posts', { id: postId }, { discord_message_id: discordMessageId });
      }
    }).catch(e => console.error('[LFM Discord] failed to store message id:', e));
  } finally {
    lfmPostingInProgress.delete(userId);
  }
});

app.post('/lfm/:post_id/accept', requireAuth, async (req, res) => {
  const { post_id } = req.params;
  if (!validateId(post_id)) return res.status(400).json({ error: 'Invalid ID' });
  const userId = req.session.user.id;
  const [posts, userOwnPosts] = await Promise.all([
    sbGet('lfm_posts', `id=eq.${post_id}`),
    sbGet('lfm_posts', `player_id=eq.${userId}`), // l'éventuel post de l'accepteur, à nettoyer aussi
  ]);
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

  // Discord : le post accepté devient "✅ Match found" avec les deux joueurs (noms + avatars).
  if (post.discord_message_id) {
    editDiscordLfmMatchFound(post.discord_message_id, {
      p1Id: post.player_id, p1Name: post.player_name, p1AvatarId: post.player_avatar,
      p2Id: userId, p2Name: myDisplayName2, p2AvatarId: req.session.user.avatar,
    }).catch(() => {});
  }
  // Si l'accepteur avait lui aussi un post LFM en cours, son message Discord est simplement supprimé.
  userOwnPosts.forEach(p => {
    if (p.discord_message_id) deleteDiscordLfmMessage(p.discord_message_id).catch(() => {});
  });

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
  if (posts[0].discord_message_id) {
    deleteDiscordLfmMessage(posts[0].discord_message_id).catch(() => {});
  }
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
    chat_history_snapshot: [],
    screenshot,
  });
    boPhaseCache.delete(challenge_id);

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

  const adminMatchRows = await sbGet('matches', `challenge_id=eq.${report.challenge_id}&order=date.desc&limit=1`);
  const adminMatchId   = adminMatchRows.length ? adminMatchRows[0].id : null;
  await saveGameResults(report.challenge_id, adminMatchId, report.challenger_id, report.challenged_id, [], winner.main_char || null, loser_id, loser.main_char || null);
  await Promise.all([rebuildCharStats(winner_id), rebuildCharStats(loser_id)]);
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
        games_history: req.body.games_history || null,
        bo_games: req.body.bo_games || null,
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
        boPhaseCache.delete(challenge_id);
        // Copier les messages du match dans le fil DM des deux joueurs
        await copyMatchMsgsToDmRoom(challenge_id, c.challenger_id, c.challenged_id);
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
        const boGames = Array.isArray(report.bo_games) ? report.bo_games : [];
        // Récupérer le match_id inséré juste avant
        const matchRows = await sbGet('matches', `challenge_id=eq.${challenge_id}&order=date.desc&limit=1`);
        const matchId   = matchRows.length ? matchRows[0].id : null;
        await saveGameResults(challenge_id, matchId, c.challenger_id, c.challenged_id, boGames, winner.main_char || null, loser_id, loser.main_char || null);
        await Promise.all([rebuildCharStats(winner_id), rebuildCharStats(loser_id)]);
        await new Promise(r => setTimeout(r, 300));
        await emitLeaderboardUpdate();
        boPhaseCache.delete(challenge_id);
        // Copier les messages du match dans le fil DM des deux joueurs
        await copyMatchMsgsToDmRoom(challenge_id, c.challenger_id, c.challenged_id);
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
        title: `[AUTO] ${c.challenger_name} vs ${c.challenged_name} — no result submitted`,
        reason: 'timeout_no_result',
        chat_history_snapshot: [],
      });
    boPhaseCache.delete(c.id);
      const msg = { type: 'match_timeout', outcome: 'draw', challenge_id: c.id,
        message: '⏱ Time\'s up — no result submitted. Match set to DRAW, an admin will decide.' };
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
        chat_history_snapshot: [],
      });
    boPhaseCache.delete(c.id);
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
  if (!pack) return res.status(400).json({ error: 'Invalid pack' });

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
  if (DEV_MODE) {
    console.log('\n🛠  DEV MODE actif — données en RAM, pas de Supabase/Discord');
    console.log(`   → Login :   http://localhost:${PORT}/dev-login`);
    console.log(`   → Store :   http://localhost:${PORT}/dev-state`);
    console.log(`   → Reset :   http://localhost:${PORT}/dev-reset\n`);
  }

  resolveDeadMatches();
  setInterval(resolveDeadMatches, DEAD_MATCH_CHECK_INTERVAL);
});
