'use strict';
/*
 * Caution Bacheliers Thiès — serveur avec paiement PayTech.
 * Aucune dépendance : Node 18 ou plus suffit (http, fs, crypto, fetch intégrés).
 * Les clés PayTech restent dans les variables d'environnement, jamais dans le navigateur.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Lecture d'un fichier .env simple (CLE=valeur), sans écraser l'environnement existant.
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach((l) => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (e) { /* pas de .env : on utilise l'environnement */ }

const C = {
  port: Number(process.env.PORT) || 3000,
  base: (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  key: process.env.PAYTECH_API_KEY || '',
  secret: process.env.PAYTECH_API_SECRET || '',
  env: process.env.PAYTECH_ENV === 'prod' ? 'prod' : 'test',
  url: process.env.PAYTECH_URL || 'https://paytech.sn/api/payment/request-payment',
  amount: Number(process.env.CAUTION_FCFA) || 15000,
  adminPass: process.env.ADMIN_PASSWORD || '',
  // Paiement manuel par Wave : le bachelier envoie l'argent à ce numéro, l'administrateur confirme.
  wave: String(process.env.WAVE_NUMERO || '').replace(/\D/g, '').replace(/^221/, ''),
  waveNom: String(process.env.WAVE_NOM || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60),
};
// SasPay : clé secrète sk_test_... (essais) ou sk_live_... (vrais paiements).
C.sasKey = String(process.env.SASPAY_API_KEY || '').trim();
C.sasTest = !/^sk_live_/.test(C.sasKey);
C.sasBase = (process.env.SASPAY_URL || (C.sasTest ? 'https://sandbox-api.saspay.me/api/v1' : 'https://api.saspay.me/api/v1')).replace(/\/$/, '');
C.sasFrais = ['ADD_ON', 'DEDUCTED'].includes(process.env.SASPAY_FRAIS) ? process.env.SASPAY_FRAIS : '';
// Mode de paiement : MODE_PAIEMENT=saspay | paytech | manuel. Sans cette variable : manuel si WAVE_NUMERO, sinon SasPay si une clé existe, sinon PayTech.
const MODES = ['saspay', 'paytech', 'manuel'];
C.mode = MODES.includes(process.env.MODE_PAIEMENT) ? process.env.MODE_PAIEMENT
  : (C.wave ? 'manuel' : (C.sasKey ? 'saspay' : 'paytech'));
// Étiquette enregistrée sur chaque dossier : "test" ou "prod" (ou "manuel").
const envLabel = () => (C.mode === 'manuel' ? 'manuel' : C.mode === 'saspay' ? (C.sasTest ? 'test' : 'prod') : C.env);

/* ---------- Stockage : un fichier JSON, écrit de façon atomique ---------- */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'inscriptions.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
let DB = {};
try { DB = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { DB = {}; }
function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(DB, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

/* ---------- Utilitaires ---------- */
const digits = (s) => String(s || '').replace(/\D/g, '').replace(/^221/, '');
const phoneOk = (s) => /^7[05678]\d{7}$/.test(digits(s));
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max || 120);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function makeRef() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let r = 'CB26-';
    for (let i = 0; i < 6; i++) r += a[crypto.randomInt(a.length)];
    if (!DB[r]) return r;
  }
}
function send(res, code, body, type) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, {
    'Content-Type': type || (isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8'),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('trop gros')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function parseBody(req, raw) {
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/json')) return JSON.parse(raw || '{}');
  return Object.fromEntries(new URLSearchParams(raw));
}
// Limite simple : 20 demandes par minute et par adresse IP.
const hits = new Map();
function limited(ip) {
  const now = Date.now(), arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 20;
}

/* ---------- Validation de l'inscription ---------- */
const SERIES = ['L', 'S1', 'S2', 'S3', 'G', 'T1', 'T2', 'Autre série'];
const MENTIONS = ['Passable', 'Assez bien', 'Bien', 'Très bien'];
function validate(b) {
  const f = {
    prenom: clean(b.prenom, 60), nom: clean(b.nom, 60), naissance: clean(b.naissance, 10),
    tel: digits(b.tel), table: clean(b.table, 20), serie: clean(b.serie, 20), mention: clean(b.mention, 20),
    ville: clean(b.ville, 60), lycee: clean(b.lycee, 100), etab: clean(b.etab, 100),
    tuteur: clean(b.tuteur, 80), teltuteur: digits(b.teltuteur), email: clean(b.email, 100).toLowerCase(),
  };
  const e = [];
  if (!f.prenom || !f.nom) e.push('nom');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.naissance)) e.push('naissance');
  if (!phoneOk(f.tel)) e.push('tel');
  if (f.table.length < 3) e.push('table');
  if (!SERIES.includes(f.serie)) e.push('serie');
  if (!MENTIONS.includes(f.mention)) e.push('mention');
  if (!f.ville || !f.lycee || !f.etab) e.push('lycee');
  if (!f.tuteur) e.push('tuteur');
  if (!phoneOk(f.teltuteur)) e.push('teltuteur');
  if (C.mode === 'saspay' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email)) e.push('email');
  return { f, errors: e };
}

/* ---------- Appel PayTech : création de la demande de paiement ---------- */
async function requestPayment(rec) {
  const r = await fetch(C.url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', API_KEY: C.key, API_SECRET: C.secret },
    body: JSON.stringify({
      item_name: 'Caution nouveau bachelier',
      item_price: C.amount,
      currency: 'XOF',
      ref_command: rec.ref,
      command_name: 'Caution ' + rec.ref + ' - ' + rec.prenom + ' ' + rec.nom,
      env: C.env,
      ipn_url: C.base + '/api/ipn',
      success_url: C.base + '/?ref=' + rec.ref + '&retour=succes',
      cancel_url: C.base + '/?ref=' + rec.ref + '&retour=annule',
    }),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch (e) { j = null; }
  if (!r.ok || !j || !(j.success === 1 || j.success === true) || !j.redirect_url) {
    throw new Error('PayTech a refusé la demande (HTTP ' + r.status + ') : ' + text.slice(0, 300));
  }
  return j;
}

/* ---------- SasPay : page de paiement hébergée (checkout) ---------- */
async function requestSaspay(rec) {
  const body = {
    amount: C.amount.toFixed(2),
    currency: 'XOF',
    description: 'Caution ' + rec.ref,
    customer_email: rec.email,
    customer_name: rec.prenom + ' ' + rec.nom,
    country: 'SN',
    return_url: C.base + '/?ref=' + rec.ref + '&retour=succes',
    metadata: { ref: rec.ref },
  };
  if (C.sasFrais) body.fee_charge_mode = C.sasFrais;
  const r = await fetch(C.sasBase + '/checkout-sessions/', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + C.sasKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch (e) { j = null; }
  const d = j && j.data && typeof j.data === 'object' ? j.data : j;
  if (!r.ok || !d || !d.id || !d.checkout_url) {
    throw new Error('SasPay a refusé la demande (HTTP ' + r.status + ') : ' + text.slice(0, 300));
  }
  if (d.amount != null && Number(d.amount) !== C.amount) {
    throw new Error('SasPay a renvoyé un montant inattendu : ' + d.amount);
  }
  if (!/^https:\/\//.test(String(d.checkout_url))) throw new Error('Adresse de paiement SasPay invalide.');
  return d;
}
// On ne fait jamais confiance au navigateur : le statut est relu chez SasPay avec notre clé secrète.
const lastCheck = new Map();
async function refreshOne(rec) {
  if (!rec || !rec.sasId || !C.sasKey || rec.statut === 'Payé') return;
  const now = Date.now();
  if (now - (lastCheck.get(rec.ref) || 0) < 3000) return;
  lastCheck.set(rec.ref, now);
  try {
    const r = await fetch(C.sasBase + '/checkout-sessions/' + encodeURIComponent(rec.sasId) + '/status/', {
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + C.sasKey },
      signal: AbortSignal.timeout(8000),
    });
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch (e) { j = null; }
    const d = j && j.data && typeof j.data === 'object' ? j.data : j;
    if (!r.ok || !d) { console.error('[SasPay] statut HTTP ' + r.status + ' : ' + text.slice(0, 200)); return; }
    const st = String(d.status || '').toUpperCase(), ts = String(d.transaction_status || '').toUpperCase();
    if (st === 'PAID' && (!ts || ts === 'SUCCESS')) {
      rec.statut = 'Payé'; rec.paidAt = new Date().toISOString(); rec.mode = 'SasPay';
      rec.txref = clean(d.transaction_reference, 80); save();
    } else if (['EXPIRED', 'CANCELLED', 'CANCELED'].includes(st)) {
      if (rec.statut !== 'Annulé') { rec.statut = 'Annulé'; save(); }
    } else if (!['', 'OPEN', 'PENDING', 'CREATED', 'INITIATED', 'PAID'].includes(st)) {
      console.log('[SasPay] statut non prévu : ' + st + ' / ' + ts);
    }
  } catch (e) { console.error('[SasPay] statut :', e.message); }
}
async function refreshPending() {
  if (!C.sasKey) return;
  const now = Date.now();
  const list = Object.values(DB).filter((r) => r.sasId && r.statut !== 'Payé' && now - Date.parse(r.createdAt) < 2 * 86400000).slice(0, 40);
  await Promise.all(list.map(refreshOne));
}

/* ---------- Routes ---------- */
async function handleApi(req, res, url) {
  const ip = req.socket.remoteAddress || '';

  // 1. Le bachelier envoie ses informations : on crée le dossier puis la demande de paiement.
  if (req.method === 'POST' && url.pathname === '/api/inscriptions') {
    if (limited(ip)) return send(res, 429, { erreur: 'Trop de demandes. Réessayez dans une minute.' });
    if ((C.mode === 'paytech' && (!C.key || !C.secret)) || (C.mode === 'saspay' && !C.sasKey)) return send(res, 500, { erreur: 'Le paiement n\'est pas configuré sur le serveur.' });
    let body; try { body = parseBody(req, await readBody(req)); } catch (e) { return send(res, 400, { erreur: 'Requête illisible.' }); }
    const { f, errors } = validate(body);
    if (errors.length) return send(res, 422, { erreur: 'Informations incomplètes ou invalides.', champs: errors });
    const rec = Object.assign({ ref: makeRef() }, f, { montant: C.amount, statut: C.mode === 'manuel' ? 'En attente de paiement' : 'En attente', env: envLabel(), createdAt: new Date().toISOString() });
    DB[rec.ref] = rec; save();
    if (C.mode === 'manuel') return send(res, 200, { ref: rec.ref, mode: 'manuel' });
    try {
      if (C.mode === 'saspay') {
        const d = await requestSaspay(rec);
        rec.sasId = String(d.id); save();
        return send(res, 200, { ref: rec.ref, redirect_url: d.checkout_url });
      }
      const j = await requestPayment(rec);
      rec.token = j.token || null; save();
      return send(res, 200, { ref: rec.ref, redirect_url: j.redirect_url });
    } catch (e) {
      rec.statut = 'Échec de création'; rec.erreur = String(e.message).slice(0, 300); save();
      console.error('[' + (C.mode === 'saspay' ? 'SasPay' : 'PayTech') + ']', e.message);
      return send(res, 502, { erreur: 'Le service de paiement ne répond pas. Réessayez dans un instant.' });
    }
  }

  // 2. PayTech confirme le paiement (IPN). On vérifie que l'appel vient bien de PayTech.
  if (req.method === 'POST' && url.pathname === '/api/ipn') {
    let b; try { b = parseBody(req, await readBody(req)); } catch (e) { return send(res, 400, 'IPN KO'); }
    const fromPaytech = b.api_key_sha256 && b.api_secret_sha256 &&
      safeEqual(b.api_key_sha256, sha256(C.key)) && safeEqual(b.api_secret_sha256, sha256(C.secret));
    if (!fromPaytech) return send(res, 403, 'IPN KO NOT FROM PAYTECH');
    const rec = DB[clean(b.ref_command, 30)];
    if (!rec) return send(res, 404, 'IPN KO UNKNOWN REF');
    if (b.type_event && b.type_event !== 'sale_complete') {
      if (rec.statut !== 'Payé') { rec.statut = 'Annulé'; save(); }
      return send(res, 200, 'IPN OK');
    }
    if (Number(b.item_price) !== rec.montant) {
      rec.statut = 'Montant à vérifier'; rec.erreur = 'IPN reçu avec item_price=' + b.item_price; save();
      return send(res, 200, 'IPN OK');
    }
    if (rec.statut !== 'Payé') {
      rec.statut = 'Payé'; rec.paidAt = new Date().toISOString();
      rec.mode = clean(b.payment_method, 40); rec.numpay = digits(b.client_phone); save();
    }
    return send(res, 200, 'IPN OK');
  }

  // 3. La page de confirmation demande l'état d'un dossier (sans donnée personnelle sensible).
  if (req.method === 'GET' && url.pathname === '/api/statut') {
    const rec = DB[clean(url.searchParams.get('ref'), 30)];
    if (!rec) return send(res, 404, { erreur: 'Dossier introuvable.' });
    await refreshOne(rec);
    return send(res, 200, {
      ref: rec.ref, statut: rec.statut, montant: rec.montant, mode: rec.mode || null, env: rec.env,
      nom: rec.prenom + ' ' + rec.nom, etab: rec.etab, table: rec.table, paidAt: rec.paidAt || null,
      manuel: rec.env === 'manuel',
      wave: rec.env === 'manuel' && rec.statut !== 'Payé' ? C.wave : null,
      waveNom: rec.env === 'manuel' && rec.statut !== 'Payé' ? C.waveNom : null,
    });
  }

  // 3b. Configuration publique : mode de paiement et montant.
  if (req.method === 'GET' && url.pathname === '/api/config') {
    return send(res, 200, { mode: C.mode, montant: C.amount });
  }

  // 3c. Paiement manuel : le bachelier déclare avoir envoyé l'argent par Wave.
  if (req.method === 'POST' && url.pathname === '/api/declarer') {
    if (limited(ip)) return send(res, 429, { erreur: 'Trop de demandes. Réessayez dans une minute.' });
    let b; try { b = parseBody(req, await readBody(req)); } catch (e) { return send(res, 400, { erreur: 'Requête illisible.' }); }
    const rec = DB[clean(b.ref, 30)];
    if (!rec || rec.env !== 'manuel') return send(res, 404, { erreur: 'Dossier introuvable.' });
    if (rec.statut === 'Payé') return send(res, 200, { statut: rec.statut });
    const payeur = digits(b.payeur);
    if (!phoneOk(payeur)) return send(res, 422, { erreur: 'Numéro Wave invalide : 9 chiffres commençant par 70, 75, 76, 77 ou 78.' });
    const txid = clean(b.txid, 40).replace(/[^A-Za-z0-9_\-]/g, '');
    rec.doublon = !!txid && Object.values(DB).some((r) => r.ref !== rec.ref && r.txid === txid);
    rec.payeur = payeur; rec.txid = txid; rec.statut = 'Paiement déclaré'; rec.declaredAt = new Date().toISOString();
    save();
    return send(res, 200, { statut: rec.statut });
  }

  // 4. Administration : mot de passe en Basic Auth.
  if (url.pathname === '/api/admin/inscriptions' || url.pathname === '/api/admin/statut') {
    if (!C.adminPass) return send(res, 403, { erreur: 'ADMIN_PASSWORD n\'est pas défini sur le serveur.' });
    if (limited(ip)) return send(res, 429, { erreur: 'Trop de tentatives.' });
    const h = String(req.headers.authorization || '');
    const given = h.startsWith('Basic ') ? Buffer.from(h.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':') : '';
    if (!safeEqual(sha256(given), sha256(C.adminPass))) return send(res, 401, { erreur: 'Mot de passe incorrect.' });

    if (req.method === 'GET' && url.pathname === '/api/admin/inscriptions') {
      await refreshPending();
      const rows = Object.values(DB).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return send(res, 200, { montant: C.amount, env: envLabel(), inscriptions: rows });
    }

    // Confirmer ou refuser un paiement après vérification dans l'historique Wave.
    if (req.method === 'POST' && url.pathname === '/api/admin/statut') {
      let b; try { b = parseBody(req, await readBody(req)); } catch (e) { return send(res, 400, { erreur: 'Requête illisible.' }); }
      const rec = DB[clean(b.ref, 30)];
      if (!rec) return send(res, 404, { erreur: 'Dossier introuvable.' });
      if (b.statut === 'Payé') {
        rec.statut = 'Payé'; rec.paidAt = new Date().toISOString();
        if (rec.env === 'manuel') rec.mode = 'Wave (manuel)';
      } else if (b.statut === 'Non reçu') {
        rec.statut = 'Non reçu'; delete rec.paidAt;
      } else {
        return send(res, 422, { erreur: 'Statut invalide.' });
      }
      save();
      return send(res, 200, { ref: rec.ref, statut: rec.statut });
    }
  }

  return send(res, 404, { erreur: 'Route inconnue.' });
}

/* ---------- Fichiers statiques ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
// Deux dispositions possibles : pages dans le dossier "public", ou à côté de server.js.
// À côté de server.js, seules index.html et admin.html sont servies (jamais server.js ni .env).
const PUB = path.join(__dirname, 'public');
const HAS_PUB = fs.existsSync(PUB);
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  if (p === '/admin') p = '/admin.html';
  let file;
  if (HAS_PUB) {
    file = path.join(PUB, path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
    if (!file.startsWith(PUB)) return send(res, 403, 'Interdit');
  } else {
    if (p !== '/index.html' && p !== '/admin.html') return send(res, 404, 'Page introuvable');
    file = path.join(__dirname, p);
  }
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Page introuvable');
    send(res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream');
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  Promise.resolve(url.pathname.startsWith('/api/') ? handleApi(req, res, url) : serveStatic(req, res, url))
    .catch((e) => { console.error(e); if (!res.headersSent) send(res, 500, { erreur: 'Erreur interne.' }); });
}).listen(C.port, () => {
  console.log('Caution Bacheliers : ' + C.base + ' (port ' + C.port + ', paiement ' + (C.mode === 'manuel' ? 'manuel par Wave' : C.mode === 'saspay' ? 'SasPay ' + (C.sasTest ? 'test' : 'production') : 'PayTech ' + C.env) + ', caution ' + C.amount + ' FCFA)');
  setInterval(() => { refreshPending().catch(() => {}); }, 60000);
  if (C.mode === 'saspay' && !C.sasKey) console.warn('Attention : SASPAY_API_KEY manquant.');
  if (C.mode === 'paytech' && (!C.key || !C.secret)) console.warn('Attention : PAYTECH_API_KEY / PAYTECH_API_SECRET manquants.');
  if (!C.adminPass) console.warn('Attention : ADMIN_PASSWORD manquant, l\'administration est désactivée.');
});
