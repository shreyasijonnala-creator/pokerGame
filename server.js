// Buy-In Board server: serves the page and keeps every table in sync over WebSockets.
// Anyone can create or join a table. Each browser holds a secret token; the server
// only lets a table's creator (its host) add buy-ins, rename it, or end it.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "tables.json");
const PUBLIC_DIR = path.join(__dirname, "public");

const BUY = 20;
const SEATS = 15;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const MAX_TABLES = 5000;
const TABLE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // drop tables 30 days after their last change

/* ---------- storage ---------- */
// state.tables[code] = { code, name, hostId, createdAt, updatedAt, ended, endedAt,
//                        players: { [pid]: { name, joinedAt, seated, count } } }
// state.people[pid]  = { hostOf: code|null, playerAt: code|null }
let state = { tables: {}, people: {} };

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (raw && typeof raw === "object") state = { tables: raw.tables || {}, people: raw.people || {} };
  } catch (e) {
    if (e.code !== "ENOENT") console.error("Could not read saved tables:", e.message);
  }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, DATA_FILE);
  }, 250);
}

function prune() {
  const cutoff = Date.now() - TABLE_TTL_MS;
  for (const [code, t] of Object.entries(state.tables)) {
    if ((t.updatedAt || t.createdAt) < cutoff) delete state.tables[code];
  }
  for (const [pid, p] of Object.entries(state.people)) {
    if (p.hostOf && !state.tables[p.hostOf]) p.hostOf = null;
    if (p.playerAt && !state.tables[p.playerAt]) p.playerAt = null;
    if (!p.hostOf && !p.playerAt) delete state.people[pid];
  }
  save();
}

/* ---------- helpers ---------- */
// A browser's public id is derived from its secret token, so the token never leaves that browser.
const pidOf = (token) => crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
const person = (pid) => (state.people[pid] ||= { hostOf: null, playerAt: null });
const cleanName = (s, n) => String(s || "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, n);

function newCode() {
  for (let i = 0; i < 50; i++) {
    const bytes = crypto.randomBytes(5);
    const code = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
    if (!state.tables[code]) return code;
  }
  return null;
}

function newTableName() {
  const adj = ["Lucky", "Wild", "Midnight", "Royal", "Silver", "Golden", "Copper", "Velvet", "Back Room", "Low Stakes"];
  const noun = ["River", "Flop", "Turn", "Ace", "Kicker", "Full House", "Straight", "Pocket Pair", "Big Blind", "Showdown"];
  const pick = (l) => l[crypto.randomInt(l.length)];
  const d = new Date();
  const date = `${String(d.getDate()).padStart(2, "0")}-${d.toLocaleString("en-US", { month: "short" })}-${d.getFullYear()}`;
  return `${pick(adj)} ${pick(noun)} ${date}`;
}

// What a client may see of a table: names and counts, never tokens.
function publicTable(t) {
  const seated = Object.entries(t.players)
    .filter(([, p]) => p.seated)
    .sort((a, b) => a[1].joinedAt - b[1].joinedAt)
    .map(([id, p]) => ({ id, name: p.name, count: p.count }));
  const left = Object.entries(t.players)
    .filter(([, p]) => !p.seated && p.count > 0)
    .map(([id, p]) => ({ id, name: p.name, count: p.count }));
  return { code: t.code, name: t.name, ended: t.ended, buy: BUY, seats: SEATS, seated, left };
}

/* ---------- sockets ---------- */
const sockets = new Map(); // ws -> { pid, codes }

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// A person can host one table and sit at one table (their own included) at the same time.
// Each browser tab picks which of the two it shows.
function sessionFor(pid) {
  const p = state.people[pid] || {};
  return {
    host: p.hostOf && state.tables[p.hostOf] ? p.hostOf : null,
    player: p.playerAt && state.tables[p.playerAt] ? p.playerAt : null,
  };
}

// Send each of this person's open tabs their session and tables.
function syncPerson(pid) {
  const s = sessionFor(pid);
  const codes = [...new Set([s.host, s.player].filter(Boolean))];
  for (const [ws, info] of sockets) {
    if (info.pid !== pid) continue;
    info.codes = codes;
    send(ws, { type: "session", you: pid, host: s.host, player: s.player });
    for (const c of codes) send(ws, { type: "table", table: publicTable(state.tables[c]) });
  }
}

function broadcast(code) {
  const t = state.tables[code];
  if (!t) return;
  const msg = JSON.stringify({ type: "table", table: publicTable(t) });
  for (const [ws, info] of sockets) if (info.codes.includes(code) && ws.readyState === ws.OPEN) ws.send(msg);
}

function touch(t) { t.updatedAt = Date.now(); save(); broadcast(t.code); }

/* ---------- actions ---------- */
const handlers = {
  create(pid, msg, reply) {
    const me = person(pid);
    const current = me.hostOf && state.tables[me.hostOf];
    if (current && !current.ended) return reply({ ok: true });
    if (Object.keys(state.tables).length >= MAX_TABLES) prune();
    if (Object.keys(state.tables).length >= MAX_TABLES) return reply({ error: "The site is full right now. Try again later." });
    const code = newCode();
    if (!code) return reply({ error: "Couldn't make a table code. Try again." });
    const now = Date.now();
    state.tables[code] = { code, name: newTableName(), hostId: pid, createdAt: now, updatedAt: now, ended: false, players: {} };
    me.hostOf = code;
    save();
    syncPerson(pid); // session first, so the reply arrives after the browser knows its new table
    reply({ ok: true });
  },

  lookup(pid, msg, reply) {
    const code = String(msg.code || "").toUpperCase();
    const t = state.tables[code];
    if (!t) return reply({ error: `No table with code ${code}. Check the code with your host.` });
    if (t.ended) return reply({ error: "That game has already ended. Ask the host for the new code." });
    const taken = Object.values(t.players).filter((p) => p.seated).length;
    const mine = t.players[pid] && t.players[pid].seated;
    if (!mine && taken >= SEATS) return reply({ error: "That table is full. All 15 seats are taken." });
    reply({ ok: true, code, name: t.name, taken });
  },

  join(pid, msg, reply) {
    const code = String(msg.code || "").toUpperCase();
    const name = cleanName(msg.name, 24);
    const t = state.tables[code];
    if (!name) return reply({ error: "Enter the name the table should see." });
    if (!t || t.ended) return reply({ error: "That table isn't open anymore." });
    const seatedCount = Object.values(t.players).filter((p) => p.seated).length;
    const existing = t.players[pid];
    if (!(existing && existing.seated) && seatedCount >= SEATS) return reply({ error: "That table is full. All 15 seats are taken." });
    // leave any other table first
    const me = person(pid);
    if (me.playerAt && me.playerAt !== code) leaveTable(pid, me.playerAt);
    t.players[pid] = { name, joinedAt: existing && existing.seated ? existing.joinedAt : Date.now(), seated: true, count: existing ? existing.count : 0 };
    me.playerAt = code;
    touch(t);
    syncPerson(pid);
    reply({ ok: true });
  },

  buyin(pid, msg, reply) {
    const t = hostTable(pid, msg, reply);
    if (!t) return;
    const p = t.players[String(msg.player || "")];
    if (!p) return reply({ error: "That player isn't at this table." });
    const delta = msg.delta === 1 ? 1 : msg.delta === -1 ? -1 : 0;
    if (!delta) return reply({ error: "Unknown change." });
    p.count = Math.max(0, p.count + delta);
    reply({ ok: true });
    touch(t);
  },

  rename(pid, msg, reply) {
    const t = hostTable(pid, msg, reply);
    if (!t) return;
    const name = cleanName(msg.name, 60);
    if (!name) return reply({ error: "Give the table a name." });
    t.name = name;
    reply({ ok: true });
    touch(t);
  },

  end(pid, msg, reply) {
    const t = hostTable(pid, msg, reply);
    if (!t) return;
    t.ended = true;
    t.endedAt = Date.now();
    reply({ ok: true });
    touch(t);
  },

  leave(pid, msg, reply) {
    const me = person(pid);
    if (me.playerAt) leaveTable(pid, me.playerAt);
    me.playerAt = null;
    save();
    reply({ ok: true });
    syncPerson(pid);
  },

  home(pid, msg, reply) {
    // after a game ends: clear whichever role this person had
    const me = person(pid);
    if (me.hostOf && state.tables[me.hostOf] && state.tables[me.hostOf].ended) me.hostOf = null;
    if (me.playerAt) {
      const t = state.tables[me.playerAt];
      if (!t || t.ended) me.playerAt = null;
    }
    save();
    reply({ ok: true });
    syncPerson(pid);
  },
};

function hostTable(pid, msg, reply) {
  const t = state.tables[String(msg.code || "").toUpperCase()];
  if (!t) { reply({ error: "That table isn't available." }); return null; }
  if (t.hostId !== pid) { reply({ error: "Only the host can do that." }); return null; }
  if (t.ended) { reply({ error: "This game has ended." }); return null; }
  return t;
}

function leaveTable(pid, code) {
  const t = state.tables[code];
  if (!t || !t.players[pid]) return;
  if (t.players[pid].count > 0) t.players[pid].seated = false; // keep their buy-ins on the books
  else delete t.players[pid];
  touch(t);
}

/* ---------- http ---------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/healthz") { res.writeHead(200); return res.end("ok"); }
  const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(body);
  });
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4096 });

wss.on("connection", (ws) => {
  sockets.set(ws, { pid: null, codes: [] });
  let budget = 30; // simple flood guard: 30 messages, refilled 10 per second
  const refill = setInterval(() => (budget = Math.min(30, budget + 10)), 1000);

  ws.on("message", (raw) => {
    if (--budget < 0) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    const info = sockets.get(ws);
    const reply = (body) => send(ws, { type: "reply", id: msg.id, ...body });

    if (msg.type === "hello") {
      const token = String(msg.token || "");
      if (!/^[a-f0-9]{32,64}$/.test(token)) return reply({ error: "Bad session. Reload the page." });
      info.pid = pidOf(token);
      return syncPerson(info.pid);
    }
    if (!info.pid) return reply({ error: "Still connecting. Try again." });
    const h = Object.prototype.hasOwnProperty.call(handlers, msg.type) && handlers[msg.type];
    if (!h) return reply({ error: "Unknown request." });
    try { h(info.pid, msg, reply); }
    catch (e) { console.error(e); reply({ error: "Something went wrong on the server. Try again." }); }
  });

  ws.on("close", () => { clearInterval(refill); sockets.delete(ws); });
});

// keep idle connections alive through proxies
setInterval(() => { for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.ping(); }, 25000);
setInterval(prune, 1000 * 60 * 60);

load();
prune();
server.listen(PORT, () => console.log(`Buy-In Board running at http://localhost:${PORT}`));
