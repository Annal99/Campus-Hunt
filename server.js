'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ---------- CONFIG: Coordinates & settings ----------
const PORT = process.env.PORT || 3000;
const CAMPUS = {
  lat: parseFloat(process.env.CAMPUS_LAT) || 15.567457778604336,
  lng: parseFloat(process.env.CAMPUS_LNG) || 74.02764062556119,
};
const RADIUS = parseFloat(process.env.CAMPUS_RADIUS) || 250;
const MAX_ACTIVE = 3;
const TTL_MS = 3 * 60 * 1000;
const SPAWN_GAP_MS = 25 * 1000;
const CLAIM_RANGE = 120;
const SHOE_IDS = [101, 102, 103, 104];

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
};

// ---------- HTTP Server ----------
const server = http.createServer(function (req, res) {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  if (url.startsWith('/shoes/')) {
    const filename = path.basename(url);
    const file = path.join(__dirname, 'shoes', filename);
    const type = MIME[path.extname(file).toLowerCase()];
    if (!type) {
      res.writeHead(404);
      return res.end('Not found');
    }
    return fs.readFile(file, function (err, buf) {
      if (err) {
        res.writeHead(404);
        return res.end('Not found');
      }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' });
      res.end(buf);
    });
  }

  if (url === '/' || url === '/index.html') {
    return fs.readFile(path.join(__dirname, 'index.html'), function (err, buf) {
      if (err) {
        res.writeHead(500);
        return res.end('index.html not found next to server.js');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  }
  res.writeHead(404);
  res.end('Not found');
});

const wss = new WebSocketServer({ server: server, maxPayload: 10000 });
const clients = new Map();
const legends = new Map();
let nextLegendId = 1, nextPlayerId = 1, nextSpawnAt = 0;

function send(ws, o) {
  if (ws.readyState === 1) ws.send(JSON.stringify(o));
}

function broadcast(o) {
  const s = JSON.stringify(o);
  wss.clients.forEach(function (c) {
    if (c.readyState === 1) c.send(s);
  });
}

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

function setPos(c, m) {
  if (Number.isFinite(m.lat) && Number.isFinite(m.lng)) {
    c.lat = m.lat;
    c.lng = m.lng;
  }
}

function pub(l) {
  return {
    id: l.id,
    shoeId: l.shoeId,
    lat: l.lat,
    lng: l.lng,
    left: Math.max(0, l.expires - Date.now())
  };
}

function spawnLegend() {
  const r = RADIUS * Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2;
  const used = Array.from(legends.values()).map(function (l) { return l.shoeId; });
  const pool = SHOE_IDS.filter(function (s) { return used.indexOf(s) < 0; });
  const list = pool.length ? pool : SHOE_IDS;
  const l = {
    id: nextLegendId++,
    shoeId: list[Math.floor(Math.random() * list.length)],
    lat: CAMPUS.lat + (r * Math.cos(a)) / 110574,
    lng: CAMPUS.lng + (r * Math.sin(a)) / (111320 * Math.cos(CAMPUS.lat * Math.PI / 180)),
    expires: Date.now() + TTL_MS
  };
  legends.set(l.id, l);
  nextSpawnAt = Date.now() + SPAWN_GAP_MS;
  broadcast({ t: 'legend_add', s: pub(l) });
}

wss.on('connection', function (ws) {
  ws.isAlive = true;
  ws.on('pong', function () { ws.isAlive = true; });
  const c = { id: nextPlayerId++, name: 'Runner', lat: null, lng: null };
  clients.set(ws, c);

  send(ws, {
    t: 'welcome',
    id: c.id,
    center: CAMPUS,
    radius: RADIUS,
    players: clients.size,
    legends: Array.from(legends.values()).map(pub)
  });

  if (legends.size === 0) {
    spawnLegend();
    spawnLegend();
  }
  broadcast({ t: 'players', n: clients.size });

  ws.on('message', function (raw) {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'hello') {
      c.name = cleanName(m.name);
      setPos(c, m);
    } else if (m.t === 'pos') {
      setPos(c, m);
    } else if (m.t === 'name') {
      c.name = cleanName(m.name);
    } else if (m.t === 'claim') {
      setPos(c, m);
      const id = Number(m.id), l = legends.get(id);
      if (!l) return send(ws, { t: 'claim_fail', id: id, reason: 'gone' });
      if (c.lat !== null && meters(c, l) > CLAIM_RANGE) return send(ws, { t: 'claim_fail', id: id, reason: 'far' });

      legends.delete(id);
      send(ws, { t: 'claim_ok', id: id, shoeId: l.shoeId, code: 'CAMPUS-LEG-' + code(5) });
      broadcast({ t: 'legend_gone', id: id, reason: 'claimed', by: c.name, byId: c.id, shoeId: l.shoeId });
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
  legends.forEach(function (l, id) {
    if (l.expires <= now) {
      legends.delete(id);
      broadcast({ t: 'legend_gone', id: id, reason: 'expired', shoeId: l.shoeId });
    }
  });
  if (clients.size > 0 && legends.size < MAX_ACTIVE && now >= nextSpawnAt) {
    spawnLegend();
  }
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
});