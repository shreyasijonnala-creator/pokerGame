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
// Fingerprint of the page files. Tabs still running an older page reload themselves when it changes.
const BUILD = crypto.createHash("sha1")
  .update(fs.readFileSync(path.join(PUBLIC_DIR, "index.html")))
  .update(fs.readFileSync(path.join(PUBLIC_DIR, "app.js")))
  .digest("hex").slice(0, 10);

const BUY = 20;
const SEATS = 15;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const MAX_TABLES = 5000;
const TABLE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // drop tables 30 days after their last change

/* ---------- storage ---------- */
// state.tables[code] = { code, name, hostId, createdAt, updatedAt, ended, endedAt,
//                        players: { [pid]: { name, joinedAt, seated, count } } }
// state.people[pid]  = { hostOf: code|null, playerAt: code|null, history: [finished game summaries] }
let state = { tables: {}, people: {} };

// With DATABASE_URL set, everything is kept in Postgres (one row holding the whole state), so it
// survives restarts and redeploys on hosts that wipe their disk. Otherwise it's a local JSON file.
const DATABASE_URL = process.env.DATABASE_URL || "";
let pool = null;

async function load() {
  let raw = null;
  if (DATABASE_URL) {
    const { Pool } = require("pg");
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    await pool.query("CREATE TABLE IF NOT EXISTS buyin_state (id int PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())");
    const r = await pool.query("SELECT data FROM buyin_state WHERE id = 1");
    raw = r.rows[0] ? r.rows[0].data : null;
  } else {
    try { raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
    catch (e) { if (e.code !== "ENOENT") console.error("Could not read saved tables:", e.message); }
  }
  if (raw && typeof raw === "object") state = { tables: raw.tables || {}, people: raw.people || {} };
}

async function writeState() {
  const json = JSON.stringify(state);
  if (pool) {
    await pool.query(
      "INSERT INTO buyin_state (id, data, updated_at) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()",
      [json]);
  } else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, DATA_FILE);
  }
}

// Saves are batched: at most one write in flight, and changes made meanwhile go in the next one.
let saveTimer = null, saving = null, dirty = false;
function save() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 250);
}
async function flush() {
  clearTimeout(saveTimer);
  if (saving) { await saving; if (!dirty) return; }
  if (!dirty) return;
  dirty = false;
  saving = writeState()
    .catch((e) => { dirty = true; console.error("Could not save tables:", e.message); saveTimer = setTimeout(flush, 2000); })
    .finally(() => { saving = null; });
  await saving;
}

function prune() {
  const cutoff = Date.now() - TABLE_TTL_MS;
  for (const [code, t] of Object.entries(state.tables)) {
    if ((t.updatedAt || t.createdAt) < cutoff) delete state.tables[code];
  }
  for (const [pid, p] of Object.entries(state.people)) {
    if (p.hostOf && !state.tables[p.hostOf]) p.hostOf = null;
    if (p.playerAt && !state.tables[p.playerAt]) p.playerAt = null;
    if (!p.hostOf && !p.playerAt && !(p.history && p.history.length)) delete state.people[pid];
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
    send(ws, { type: "session", you: pid, host: s.host, player: s.player, build: BUILD });
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
    if (current && !current.ended) { syncPerson(pid); return reply({ ok: true }); }
    if (Object.keys(state.tables).length >= MAX_TABLES) prune();
    if (Object.keys(state.tables).length >= MAX_TABLES) return reply({ error: "The site is full right now. Try again later." });
    const code = newCode();
    if (!code) return reply({ error: "Couldn't make a table code. Try again." });
    const now = Date.now();
    state.tables[code] = { code, name: cleanName(msg.name, 60) || newTableName(), hostId: pid, createdAt: now, updatedAt: now, ended: false, players: {} };
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
    archive(t);
    reply({ ok: true });
    touch(t);
  },

  history(pid, msg, reply) {
    const p = state.people[pid];
    reply({ ok: true, games: (p && p.history) || [] });
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

// When a game ends, give the host and every player a summary for their Past games list.
// Summaries are copies, so they outlive the table itself (which is pruned after 30 days).
const HISTORY_MAX = 100;
function archive(t) {
  if (t.archived) return;
  t.archived = true;
  const players = Object.entries(t.players)
    .map(([id, p]) => ({ id, name: p.name, count: p.count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const total = players.reduce((a, p) => a + p.count, 0);
  const base = { code: t.code, name: t.name, createdAt: t.createdAt, endedAt: t.endedAt || t.updatedAt, buy: BUY, total, players };
  const add = (pid, entry) => {
    const me = person(pid);
    me.history = [entry, ...(me.history || []).filter((g) => g.code !== t.code)].slice(0, HISTORY_MAX);
  };
  const hostSeat = t.players[t.hostId];
  add(t.hostId, { ...base, role: "host", mine: hostSeat ? hostSeat.count : null });
  for (const [id, p] of Object.entries(t.players)) if (id !== t.hostId) add(id, { ...base, role: "player", mine: p.count });
  save();
}

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
    if (rel === "index.html") {
      // stamp the page with its version, and make browsers fetch the matching script
      body = body.toString()
        .replace("</head>", `<meta name="build" content="${BUILD}">\n</head>`)
        .replace('src="app.js"', `src="app.js?v=${BUILD}"`);
    }
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
    const reply = (body) => {
      if (msg.type !== "hello") {
        const what = body.error ? `refused: ${body.error}` : "ok";
        console.log(`${new Date().toISOString()} ${msg.type} by ${String(info.pid).slice(0, 6)}${msg.code ? " at " + String(msg.code).slice(0, 5) : ""}: ${what}`);
      }
      send(ws, { type: "reply", id: msg.id, ...body });
    };

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

// Hosts like Render stop the server with SIGTERM on every deploy: save anything pending first.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    try { await flush(); } finally { process.exit(0); }
  });
}

load()
  .then(() => {
    // games that ended before Past games existed still get their summaries
    for (const t of Object.values(state.tables)) if (t.ended) archive(t);
    prune();
    server.listen(PORT, () => console.log(`Buy-In Board running at http://localhost:${PORT} (tables saved to ${pool ? "Postgres" : DATA_FILE})`));
  })
  .catch((e) => {
    console.error("Could not load saved tables:", e.message);
    process.exit(1);
  });
