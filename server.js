'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

/* ============ CONFIG ============ */
const PORT = process.env.PORT || 3000;
const CAMPUS = {
  lat: parseFloat(process.env.CAMPUS_LAT) || 15.56754046058862,
  lng: parseFloat(process.env.CAMPUS_LNG) || 74.02761916789012
};

/* SHOE SPOTS. Each spot is [metres east, metres north] from the campus centre,
   OR a real position like {lat: 15.5676, lng: 74.0277}.
   Tip: right-click a real walkable spot in Google Maps, copy the numbers, and
   replace an entry with {lat:..., lng:...}. Keep spots 25 m or more apart. */
const NORMAL_SPOTS = [
  [50, 0], [25, 43], [-25, 43], [-50, 0], [-25, -43], [25, -43],
  [100, 0], [71, 71], [0, 100], [-71, 71], [-100, 0], [-71, -71], [0, -100], [71, -71]
];
const HIDDEN_SPOTS = [[130, -60], [-120, -110], [45, 110]];
const LEGEND_SPOTS = [[135, 60], [-110, 100], [-150, -40], [70, -135], [-30, -145], [10, 140]];

const NORMAL_MODELS = [1, 2, 7, 8];        // must match CATALOG ids in index.html
const LEGEND_IDS = [101, 102, 103, 104];   // must match LEGENDS ids in index.html

const MAX_ACTIVE = 2;                 // Legendary shoes alive at once
const TTL_MS = 3 * 60 * 1000;         // a Legendary disappears after 3 minutes
const SPAWN_GAP_MS = 30 * 1000;       // gap between Legendary spawns
const SPOT_COOLDOWN_MS = 2 * 60 * 1000; // a spot rests before reuse
const CLAIM_RANGE = 60;               // server-side distance check (metres)

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

/* ============ HELPERS ============ */
function toPos(s) {
  if (Array.isArray(s)) {
    return {
      lat: CAMPUS.lat + s[1] / 110574,
      lng: CAMPUS.lng + s[0] / (111320 * Math.cos(CAMPUS.lat * Math.PI / 180))
    };
  }
  return { lat: s.lat, lng: s.lng };
}
function r6(n) { return Math.round(n * 1e6) / 1e6; }
function meters(a, b) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(x));
}
function code(n) {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < n; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}
function cleanName(n) {
  return String(n || '').replace(/[<>&"'`]/g, '').trim().slice(0, 20) || 'Runner';
}

/* Fixed world sent to every player (normal + hidden). Legendary are live on the server. */
const WORLD = [];
NORMAL_SPOTS.forEach(function (s, i) {
  const p = toPos(s);
  WORLD.push({ id: 'n' + i, kind: 'normal', shoeId: NORMAL_MODELS[i % NORMAL_MODELS.length], lat: r6(p.lat), lng: r6(p.lng) });
});
HIDDEN_SPOTS.forEach(function (s, i) {
  const p = toPos(s);
  WORLD.push({ id: 'h' + i, kind: 'hidden', shoeId: 0, lat: r6(p.lat), lng: r6(p.lng) });
});
const LSPOTS = LEGEND_SPOTS.map(function (s) { const p = toPos(s); return { lat: r6(p.lat), lng: r6(p.lng) }; });
const spotRest = LSPOTS.map(function () { return 0; });

/* ============ HTTP ============ */
const server = http.createServer(function (req, res) {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (url.startsWith('/shoes/')) {
    const file = path.join(__dirname, 'shoes', path.basename(url));
    const type = MIME[path.extname(file).toLowerCase()];
    if (!type) { res.writeHead(404); return res.end('Not found'); }
    return fs.readFile(file, function (err, buf) {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' });
      res.end(buf);
    });
  }
  if (url === '/' || url === '/index.html') {
    return fs.readFile(path.join(__dirname, 'index.html'), function (err, buf) {
      if (err) { res.writeHead(500); return res.end('index.html not found next to server.js'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  }
  res.writeHead(404);
  res.end('Not found');
});

/* ============ LIVE LEGENDARY SHOES ============ */
const wss = new WebSocketServer({ server: server, maxPayload: 10000 });
const clients = new Map();
const legends = new Map();
let nextLegendId = 1, nextPlayerId = 1, nextSpawnAt = 0;

function send(ws, o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); }
function broadcast(o) {
  const s = JSON.stringify(o);
  wss.clients.forEach(function (c) { if (c.readyState === 1) c.send(s); });
}
function pub(l) {
  return { id: l.id, shoeId: l.shoeId, lat: l.lat, lng: l.lng, left: Math.max(0, l.expires - Date.now()) };
}

function spawnLegend() {
  const now = Date.now();
  const busy = Array.from(legends.values()).map(function (l) { return l.spot; });
  const free = [];
  for (let i = 0; i < LSPOTS.length; i++) {
    if (busy.indexOf(i) < 0 && now >= spotRest[i]) free.push(i);
  }
  if (!free.length) return;
  const spot = free[Math.floor(Math.random() * free.length)];
  const used = Array.from(legends.values()).map(function (l) { return l.shoeId; });
  const pool = LEGEND_IDS.filter(function (s) { return used.indexOf(s) < 0; });
  const list = pool.length ? pool : LEGEND_IDS;
  const l = {
    id: nextLegendId++,
    spot: spot,
    shoeId: list[Math.floor(Math.random() * list.length)],
    lat: LSPOTS[spot].lat,
    lng: LSPOTS[spot].lng,
    expires: now + TTL_MS
  };
  legends.set(l.id, l);
  nextSpawnAt = now + SPAWN_GAP_MS;
  broadcast({ t: 'legend_add', s: pub(l) });
}

function endLegend(l, reason, extra) {
  legends.delete(l.id);
  spotRest[l.spot] = Date.now() + SPOT_COOLDOWN_MS;
  broadcast(Object.assign({ t: 'legend_gone', id: l.id, reason: reason, shoeId: l.shoeId }, extra || {}));
}

wss.on('connection', function (ws) {
  ws.isAlive = true;
  ws.on('pong', function () { ws.isAlive = true; });
  const c = { id: nextPlayerId++, name: 'Runner', lat: null, lng: null };
  clients.set(ws, c);

  send(ws, {
    t: 'welcome', id: c.id, center: CAMPUS, players: clients.size,
    spots: WORLD, legends: Array.from(legends.values()).map(pub)
  });
  if (legends.size === 0) { spawnLegend(); }
  broadcast({ t: 'players', n: clients.size });

  ws.on('message', function (raw) {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (Number.isFinite(m.lat) && Number.isFinite(m.lng)) { c.lat = m.lat; c.lng = m.lng; }

    if (m.t === 'hello' || m.t === 'name') {
      if (m.name) c.name = cleanName(m.name);
    } else if (m.t === 'claim') {
      const id = Number(m.id), l = legends.get(id);
      if (!l) return send(ws, { t: 'claim_fail', id: id, reason: 'gone' });
      if (c.lat === null || meters(c, l) > CLAIM_RANGE) return send(ws, { t: 'claim_fail', id: id, reason: 'far' });
      // first valid claim wins
      send(ws, { t: 'claim_ok', id: id, shoeId: l.shoeId, code: 'CAMPUS-LEG-' + code(5) });
      endLegend(l, 'claimed', { by: c.name, byId: c.id });
      nextSpawnAt = Date.now() + 8000;
    }
  });

  ws.on('close', function () {
    clients.delete(ws);
    broadcast({ t: 'players', n: clients.size });
  });
  ws.on('error', function () {});
});

setInterval(function () {
  const now = Date.now();
  Array.from(legends.values()).forEach(function (l) {
    if (l.expires <= now) endLegend(l, 'expired');
  });
  if (clients.size > 0 && legends.size < MAX_ACTIVE && now >= nextSpawnAt) spawnLegend();
}, 1000);

setInterval(function () {
  wss.clients.forEach(function (ws) {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.listen(PORT, '0.0.0.0', function () {
  console.log('Campus Hunt running on port ' + PORT + ' | campus centre ' + CAMPUS.lat + ', ' + CAMPUS.lng);
  console.log('Spots: ' + NORMAL_SPOTS.length + ' normal, ' + HIDDEN_SPOTS.length + ' hidden, ' + LEGEND_SPOTS.length + ' legendary');
});
