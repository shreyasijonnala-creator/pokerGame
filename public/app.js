// Buy-In Board client: talks to the server over one WebSocket and renders whichever screen applies.
const BUY = 20, SEATS = 15;
const $ = (id) => document.getElementById(id);
const money = (n) => "$" + n.toLocaleString("en-US");
const PAGE_BUILD = (document.querySelector('meta[name="build"]') || {}).content || null; // stamped in by the server
const SCREENS =["scrLoading", "scrHome", "scrJoin", "scrTable", "scrOver"];
const show = (id) => SCREENS.forEach((s) => ($(s).hidden = s !== id));

/* ---------- this browser's secret token ---------- */
function getToken() {
  const fresh = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  try {
    let t = localStorage.getItem("buyin-token");
    if (!t || !/^[a-f0-9]{32}$/.test(t)) { t = fresh(); localStorage.setItem("buyin-token", t); }
    return t;
  } catch { return fresh(); } // private window: works until the tab closes
}
const TOKEN = getToken();

let me = null, role = null, code = null, table = null;
let sess = { host: null, player: null }; // the table I host and the one I sit at, from the server
const tables = {};                        // latest state of each of those tables
let joinTarget = null;

// Which screen this tab shows: "host", "player" or "home". Kept per tab, so one
// browser can host in one tab and sit at the table in another.
function getView() { try { return sessionStorage.getItem("buyin-view"); } catch { return getView.mem || null; } }
function setView(v) { getView.mem = v; try { v ? sessionStorage.setItem("buyin-view", v) : sessionStorage.removeItem("buyin-view"); } catch {} }

/* ---------- connection ---------- */
let ws = null, nextId = 1, retry = 0;
const pending = new Map();

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onopen = () => { retry = 0; setLive(true); ws.send(JSON.stringify({ type: "hello", token: TOKEN })); };
  ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === "reply") { const p = pending.get(msg.id); if (p) { pending.delete(msg.id); p(msg); } }
    else if (msg.type === "session") onSession(msg);
    else if (msg.type === "table") onTable(msg.table);
  };
  ws.onclose = () => {
    setLive(false);
    pending.forEach((p) => p({ error: "Lost the connection. Try again in a moment." })); pending.clear();
    setTimeout(connect, Math.min(10000, 500 * 2 ** retry++));
  };
}

function request(type, data = {}) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return resolve({ error: "Not connected. Check your internet and try again." });
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ type, id, ...data }));
  });
}

function setLive(on) {
  $("dot").classList.toggle("off", !on);
  if (role) $("roleText").textContent = (role === "host" ? "Host" : "Player") + (on ? " · live" : " · reconnecting");
  if (!on && !$("scrLoading").hidden) $("loadingMsg").textContent = "Connecting to the server…";
}

/* ---------- helpers ---------- */
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), 4500);
}
function ask(title, text, yes) {
  return new Promise((res) => {
    $("confTitle").textContent = title; $("confText").textContent = text; $("confYes").textContent = yes;
    $("confirm").hidden = false; $("confNo").focus();
    const done = (v) => { $("confirm").hidden = true; $("confYes").onclick = $("confNo").onclick = null; res(v); };
    $("confYes").onclick = () => done(true); $("confNo").onclick = () => done(false);
  });
}

/* ---------- server events ---------- */
function onSession(s) {
  // the server has a different version of this page: load it instead of running old code against it
  if (s.build && s.build !== PAGE_BUILD) {
    let tried = null; try { tried = sessionStorage.getItem("buyin-reloaded"); sessionStorage.setItem("buyin-reloaded", s.build); } catch {}
    if (tried !== s.build) { location.reload(); return; } // only once per version, so it can't loop
  }
  me = s.you;
  sess = { host: s.host || null, player: s.player || null };
  pickView(!onSession.seen);
  onSession.seen = true;
}

function onTable(t) {
  if (!t) return;
  tables[t.code] = t;
  if (t.code === code) { table = t; render(); }
  if (!$("scrHome").hidden) renderResume();
}

// Decide what this tab shows from its own choice and what the server says I'm part of.
function pickView(force) {
  const v = getView();
  let r = null, c = null;
  if (v === "home") { /* stay home */ }
  else if (v === "player" && sess.player) { r = "player"; c = sess.player; }
  else if (v === "host" && sess.host) { r = "host"; c = sess.host; }
  else if (sess.host) { r = "host"; c = sess.host; }
  else if (sess.player) { r = "player"; c = sess.player; }

  if (!force && r === role && c === code) { if (!code && !$("scrHome").hidden) renderResume(); return; }
  role = r; code = c; table = c ? tables[c] || null : null;
  if (!code) { if ($("scrJoin").hidden) goHomeScreen(); return; }
  if (table) return render();
  $("loadingMsg").textContent = "Opening table " + code + "…";
  show("scrLoading");
}

function goHomeScreen() { show("scrHome"); renderResume(); }

// On the home screen, offer a way back to a game that's still going.
function renderResume() {
  const h = sess.host && tables[sess.host], p = sess.player && tables[sess.player];
  const hostOpen = h && !h.ended, seatOpen = p && !p.ended;
  $("resume").hidden = !hostOpen && !seatOpen;
  $("resumeHost").hidden = !hostOpen;
  $("resumeSeat").hidden = !seatOpen;
  if (hostOpen) $("resumeHost").textContent = `Return to your table ${h.code}`;
  if (seatOpen) $("resumeSeat").textContent = `Back to your seat at ${p.code}`;
  $("createBtn").querySelector(".big").textContent = hostOpen ? "Your table" : "Create a table";
}

/* ---------- rendering ---------- */
function seatRow(i, p, isHost) {
  const row = document.createElement("div");
  row.className = "seat" + (p ? "" : " empty") + (p && p.id === me ? " me" : "") + (isHost && p ? " host-seat" : "");
  const num = document.createElement("span"); num.className = "num"; num.textContent = i == null ? "–" : i + 1;
  const who = document.createElement("div"); who.className = "who";
  const nm = document.createElement("div"); nm.className = "pname";
  nm.textContent = p ? p.name : "Open seat";
  if (p && p.id === me) { const t = document.createElement("span"); t.className = "tag"; t.textContent = "You"; nm.append(t); }
  who.append(nm);
  const acts = document.createElement("div"); acts.className = "acts";
  if (p) {
    const meta = document.createElement("div"); meta.className = "meta";
    meta.innerHTML = p.count ? `<b>${p.count}</b> × $20 = <b>${money(p.count * BUY)}</b>` : "Waiting for first buy-in";
    who.append(meta);
    if (isHost) {
      const minus = document.createElement("button");
      minus.className = "minus"; minus.textContent = "−"; minus.disabled = p.count === 0;
      minus.setAttribute("aria-label", `Take one buy-in back from ${p.name}`);
      minus.onclick = () => bump(p, -1);
      const add = document.createElement("button");
      add.className = "add"; add.textContent = "+ Add Buy-In";
      add.setAttribute("aria-label", `Add a $20 buy-in for ${p.name}`);
      add.onclick = () => bump(p, 1);
      acts.append(minus, add);
    } else {
      const t = document.createElement("span"); t.className = "ro-total" + (p.count ? "" : " zero");
      t.textContent = money(p.count * BUY); acts.append(t);
    }
  }
  row.append(num, who, acts);
  return row;
}

function render() {
  if (!table) return;
  const isHost = role === "host";
  const total = table.seated.concat(table.left).reduce((a, p) => a + p.count, 0);
  if (table.ended) return renderOver(total);
  show("scrTable");

  $("role").classList.toggle("host", isHost);
  $("roleText").textContent = (isHost ? "Host" : "Player") + " · live";
  $("titleIn").hidden = !isHost; $("titleRo").hidden = isHost;
  if (isHost && document.activeElement !== $("titleIn")) $("titleIn").value = table.name;
  $("titleRo").textContent = table.name;
  $("codeShow").textContent = table.code;

  $("endBtn").hidden = !isHost; $("leaveBtn").hidden = isHost;
  $("tableFoot").textContent = isHost
    ? "Players add themselves with the code. Tap + Add Buy-In for each $20, and − to fix a mistake."
    : "Only the host can add buy-ins. Totals update live.";

  const mine = table.seated.find((p) => p.id === me);
  $("mine").hidden = isHost || !mine;
  if (mine) {
    $("mineTotal").textContent = money(mine.count * BUY);
    $("mineCount").textContent = `${mine.count} buy-in${mine.count === 1 ? "" : "s"} × $20`;
  }

  $("sumPot").textContent = money(total * BUY);
  $("sumCount").textContent = total;
  $("sumPlayers").textContent = `${table.seated.length} / ${SEATS}`;

  const wrap = $("seats"); wrap.textContent = "";
  for (let i = 0; i < SEATS; i++) wrap.append(seatRow(i, table.seated[i], isHost));
  const lw = $("leftSeats"); lw.textContent = "";
  lw.hidden = table.left.length === 0;
  if (table.left.length) {
    const h = document.createElement("p"); h.className = "sub"; h.textContent = "Left the table"; lw.append(h);
    table.left.forEach((p) => lw.append(seatRow(null, p, isHost)));
  }
}

function renderOver(total) {
  show("scrOver");
  $("overTitle").textContent = table.name;
  $("overPot").textContent = money(total * BUY);
  $("overCount").textContent = total;
  const all = table.seated.concat(table.left);
  $("overPlayers").textContent = all.length;
  const wrap = $("overSeats"); wrap.textContent = "";
  all.forEach((p, i) => wrap.append(seatRow(i, p, false)));
}

/* ---------- actions ---------- */
async function bump(p, d) {
  if (role !== "host" || !table) return;
  const next = Math.max(0, p.count + d);
  if (next === p.count) return;
  p.count = next; render(); // show it right away; the server's broadcast confirms
  const r = await request("buyin", { code, player: p.id, delta: d });
  if (r.error) toast(r.error);
}

async function createTable() {
  $("homeErr").textContent = "";
  $("createBtn").disabled = true;
  const r = await request("create"); // if I already host an open table, this just takes me back to it
  $("createBtn").disabled = false;
  if (r.error) { $("homeErr").textContent = r.error; return; }
  setView("host"); pickView();
}

async function findTable(e) {
  e.preventDefault();
  const c = $("codeIn").value.trim().toUpperCase();
  $("codeErr").textContent = "";
  if (!/^[A-Z0-9]{5}$/.test(c)) { $("codeErr").textContent = "Table codes are 5 letters and numbers."; return; }
  $("codeGo").disabled = true;
  const r = await request("lookup", { code: c });
  $("codeGo").disabled = false;
  if (r.error) { $("codeErr").textContent = r.error; return; }
  joinTarget = r.code;
  $("joinTitle").textContent = r.name;
  $("foundMsg").textContent = `Found table ${r.code}. ${r.taken} of ${SEATS} seats taken.`;
  $("codeForm").hidden = true; $("nameForm").hidden = false; $("nameIn").focus();
}

async function takeSeat(e) {
  e.preventDefault();
  const name = $("nameIn").value.trim().replace(/\s+/g, " ").slice(0, 24);
  $("nameErr").textContent = "";
  if (!name) { $("nameErr").textContent = "Enter the name the table should see."; return; }
  if (!joinTarget) return;
  $("nameGo").disabled = true;
  const r = await request("join", { code: joinTarget, name });
  $("nameGo").disabled = false;
  if (r.error) { $("nameErr").textContent = r.error; return; }
  $("scrJoin").hidden = true;
  setView("player"); pickView(true);
}

function resetJoin() {
  joinTarget = null; $("codeForm").hidden = false; $("nameForm").hidden = true;
  $("codeErr").textContent = $("nameErr").textContent = ""; $("joinTitle").textContent = "Enter the table code";
}

/* ---------- events ---------- */
$("helpBtn").onclick = () => { $("help").hidden = false; $("helpClose").focus(); };
$("helpClose").onclick = () => ($("help").hidden = true);
$("help").onclick = (e) => { if (e.target === $("help")) $("help").hidden = true; };
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("help").hidden = true; });

$("createBtn").onclick = createTable;
$("joinBtn").onclick = () => { resetJoin(); $("codeIn").value = ""; $("homeErr").textContent = ""; show("scrJoin"); $("codeIn").focus(); };
$("joinBack").onclick = () => { if (!$("nameForm").hidden) resetJoin(); else goHomeScreen(); };
$("tableHome").onclick = () => { setView("home"); pickView(); };
$("resumeHost").onclick = () => { setView("host"); pickView(); };
$("resumeSeat").onclick = () => { setView("player"); pickView(); };
$("codeForm").onsubmit = findTable;
$("nameForm").onsubmit = takeSeat;
$("codeIn").oninput = (e) => (e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""));

$("titleIn").onchange = async () => {
  const name = $("titleIn").value.trim().slice(0, 60);
  if (!name || !table || name === table.name) { $("titleIn").value = table ? table.name : ""; return; }
  const r = await request("rename", { code, name });
  if (r.error) toast(r.error);
};
$("titleIn").onkeydown = (e) => { if (e.key === "Enter") e.target.blur(); };

$("copyCode").onclick = async () => {
  try { await navigator.clipboard.writeText(code); $("copyCode").textContent = "Copied"; setTimeout(() => ($("copyCode").textContent = "Copy code"), 1500); }
  catch { const r = document.createRange(); r.selectNodeContents($("codeShow")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
};

$("endBtn").onclick = async () => {
  if (!(await ask("End this game?", "Everyone at the table sees the final totals and no more buy-ins can be added.", "End game"))) return;
  const r = await request("end", { code });
  if (r.error) toast(r.error);
};
$("leaveBtn").onclick = async () => {
  if (!(await ask("Leave this game?", "You'll go back to the home screen. Your buy-ins stay on the host's books.", "Leave game"))) return;
  const r = await request("leave");
  if (r.error) toast(r.error);
};
$("overHome").onclick = async () => {
  setView("home");
  const r = await request("home"); // forgets games that have ended
  if (r.error) toast(r.error);
  pickView(true);
};

connect();
