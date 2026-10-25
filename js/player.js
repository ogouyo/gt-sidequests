import {
  makeApp, signInAnonymously, onAuthStateChanged, signOut,
  linkWithCredential, signInWithEmailAndPassword, EmailAuthProvider,
  doc, collection, onSnapshot, getDoc, runTransaction, updateDoc, addDoc, setDoc, deleteDoc, serverTimestamp,
} from "./firebase.js";
import {
  esc, sizeLabel, questState, slotText, myQuests, coreProgress, canJoin, canLeave, computeScores,
} from "./game.js";

const { auth, db } = makeApp("player");

const S = {
  uid: null, me: undefined, claim: undefined, config: null,
  quests: [], players: new Map(),
  tab: "mine", board: "group",
  sheet: null,          // { kind: 'quest', id } | { kind: 'inbox' }
  secrets: {},          // questId -> { key, text }
  revealed: new Set(),
  busy: false, regError: "", gateMode: "join", linked: false,
};

// PIN login: each player gets a hidden email/password account. The email comes from a random key
// stored on their name, so a removed player can re-register with the same name.
const emailFor = (key) => `p${key}@players.gt-sidequests.app`;
const pwFor = (pin) => `gtsq-${pin}`;
const newKey = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
const cleanName = (n) => n.trim().replace(/\s+/g, " ");

const $root = document.getElementById("root");
const $overlay = document.getElementById("overlay");
const $toast = document.getElementById("toast");

/* ---------- helpers ---------- */
const nameOf = (uid) => S.players.get(uid)?.name || "Someone";
const qById = (id) => S.quests.find((q) => q.id === id);
let toastTimer;
function toast(msg) {
  $toast.innerHTML = `<div class="toast">${esc(msg)}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($toast.innerHTML = ""), 3200);
}
function friendly(e) {
  const m = String(e?.code || e?.message || e);
  if (/invalid-credential|wrong-password|user-not-found|invalid-login/.test(m)) return "Wrong PIN for that name.";
  if (m.includes("too-many-requests")) return "Too many tries. Wait a few minutes and try again.";
  if (m.includes("operation-not-allowed")) return "PIN sign-in isn't switched on yet. Tell Shalom.";
  if (m.includes("network-request-failed")) return "No signal right now. Try again in a moment.";
  if (m.includes("unavailable") || m.includes("offline")) return "No signal right now. Try again in a moment.";
  if (m.includes("permission")) return "That move isn't allowed right now.";
  return e?.message && !e.code ? e.message : "Something went wrong. Try again.";
}
function reason(r) {
  if (r?.startsWith("clash:")) return `You're already teamed with ${nameOf(r.slice(6))} in your other group quest. Mix it up!`;
  return r;
}

/* ---------- auth + data ---------- */
let unsubs = [];
const spinner = `<div class="center"><div class="spinner"></div></div>`;
onAuthStateChanged(auth, (user) => {
  if (!user) {
    S.uid = null;
    unsubs.forEach((f) => f()); unsubs = [];
    $root.innerHTML = spinner; $overlay.innerHTML = "";
    signInAnonymously(auth).catch((e) => {
      $root.innerHTML = `<div class="wrap center"><div><h1>Can't connect</h1><p class="sub">${esc(friendly(e))}</p></div></div>`;
    });
    return;
  }
  S.linked = !user.isAnonymous;
  if (S.uid === user.uid) { render(); return; }
  // A different person on this phone: start fresh.
  unsubs.forEach((f) => f()); unsubs = [];
  Object.assign(S, { uid: user.uid, me: undefined, claim: undefined, secrets: {}, revealed: new Set(), sheet: null, tab: "mine", regError: "" });
  $root.innerHTML = spinner; $overlay.innerHTML = "";
  listen();
});

function listen() {
  const on = (...a) => unsubs.push(onSnapshot(...a));
  on(doc(db, "players", S.uid), (s) => { S.me = s.exists() ? s.data() : null; render(); });
  on(doc(db, "claims", S.uid), (s) => { S.claim = s.exists() ? s.data() : null; render(); }, () => { S.claim = null; render(); });
  on(doc(db, "config", "game"), (s) => { S.config = s.exists() ? s.data() : null; render(); });
  on(collection(db, "players"), (snap) => {
    S.players = new Map(snap.docs.map((d) => [d.id, d.data()]));
    render();
  });
  on(collection(db, "quests"), (snap) => {
    S.quests = snap.docs.map((d) => ({ id: d.id, members: [], twistDone: [], ...d.data() }))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    render();
  });
}

/* ---------- rendering ---------- */
// Keep whatever the player is typing across live re-renders.
function preserve(fn) {
  const active = document.activeElement?.id;
  const vals = {};
  for (const id of ["nameInput", "pinInput", "note", "inboxText"]) { const el = document.getElementById(id); if (el) vals[id] = el.value; }
  const anon = document.getElementById("anon")?.checked;
  fn();
  for (const id in vals) { const el = document.getElementById(id); if (el) el.value = vals[id]; }
  const a = document.getElementById("anon"); if (a && anon !== undefined) a.checked = anon;
  if (active) document.getElementById(active)?.focus();
}

function render() { preserve(renderNow); }
function renderNow() {
  if (S.uid === null || S.me === undefined) return;
  if (!S.me || !S.linked) { renderGate(); renderOverlayNow(); return; }
  const scores = computeScores(S.quests, S.players, S.config);
  const myScore = scores.get(S.uid) || 0;
  let body = "";
  if (S.tab === "mine") body = viewMine();
  if (S.tab === "board") body = viewBoard();
  if (S.tab === "ranks") body = viewRanks(scores);
  $root.innerHTML = `
    <header class="topbar"><div class="wrap">
      <div class="logo">GT <span>SIDEQUESTS</span></div>
      <span class="pill lime">⚡ ${myScore}</span>
    </div></header>
    <main><div class="wrap">${body}</div></main>
    <button class="fab" data-act="inbox">＋ Quest for Shalom</button>
    <nav class="tabbar"><div class="wrap">
      ${tabBtn("mine", "🎯", "My quests")}${tabBtn("board", "🗺️", "Board")}${tabBtn("ranks", "🏆", "Ranks")}
    </div></nav>`;
  renderOverlayNow();
}
const tabBtn = (id, icon, label) => `<button class="tab ${S.tab === id ? "on" : ""}" data-act="tab" data-id="${id}"><b>${icon}</b>${label}</button>`;

function renderGate() {
  const pinField = `<input class="field" id="pinInput" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="4-digit PIN" style="margin-top:10px">`;
  if (S.me && !S.linked) {
    // Signed up before PINs existed: set one once.
    $root.innerHTML = `<div class="wrap"><div class="hero"><h1>Hey ${esc(S.me.name)}</h1>
      <p class="sub">Set a 4-digit PIN. You'll use it with your name to log back in on any phone, or after handing your phone to a friend.</p></div>
      <form data-act="setPin">${pinField}<div class="err">${esc(S.regError)}</div>
      <button class="btn primary" ${S.busy ? "disabled" : ""}>Save my PIN</button></form></div>`;
    return;
  }
  if (S.claim) {
    $root.innerHTML = `<div class="wrap center"><div>
      <div class="spinner" style="margin:0 auto 18px"></div>
      <h1>Hold tight, ${esc(S.claim.name)}</h1>
      <p class="sub">Shalom needs to confirm it's you on this phone. Ping them, then this screen will update by itself.</p>
      <button class="btn ghost" style="margin-top:20px" data-act="cancelClaim">Cancel</button>
    </div></div>`;
    return;
  }
  const join = S.gateMode === "join";
  const rules = S.config?.houseRules || [];
  const seg = (id, label) => `<button type="button" class="${S.gateMode === id ? "on" : ""}" data-act="gateMode" data-id="${id}">${label}</button>`;
  $root.innerHTML = `<div class="wrap">
    <div class="hero"><h1>GT<span>SIDEQUESTS</span></h1>
      <p class="sub">Little missions for the night. Pick your quests, team up with people you don't know yet, cause some (friendly) chaos.</p></div>
    <div class="seg">${seg("join", "I'm new")}${seg("login", "Log in")}</div>
    ${join ? `<h2>House rules</h2><ul class="rules">${rules.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
      <h2>Pick a name and a PIN</h2>` : `<h2>Welcome back</h2>`}
    <form data-act="${join ? "register" : "login"}">
      <input class="field" id="nameInput" maxlength="20" autocomplete="off" placeholder="${join ? "Your name or nickname" : "Your name"}">
      ${pinField}
      <div class="err">${esc(S.regError)}</div>
      <button class="btn primary" ${S.busy ? "disabled" : ""}>${join ? "I agree, let's go" : "Log in"}</button>
    </form>
    ${join ? `<p class="sub" style="margin-top:12px;font-size:13px">Remember your PIN. You'll need it to log back in.</p>` : ""}
    ${S.linked ? `<button class="btn ghost small" style="margin-top:12px" data-act="logout">Start over</button>` : ""}
    <p class="sub" style="margin:18px 0 40px;font-size:13px">Tip: open this link in Chrome or Safari, not inside WhatsApp.</p>
  </div>`;
}

function questCard(q) {
  const mine = q.members.includes(S.uid);
  const st = questState(q);
  const fill = Math.min(100, Math.round((q.members.length / q.max) * 100));
  return `<button class="card ${mine ? "mine" : ""} ${st === "done" ? "done" : ""}" data-act="open" data-id="${q.id}">
    <div class="meta">
      <span class="badge ${q.level}">${q.level}</span>
      <span class="badge">${q.type === "personal" ? "solo" : `👥 ${sizeLabel(q)}`}</span>
      ${q.pool === "bonus" ? `<span class="badge bonus">bonus</span>` : ""}
      ${mine ? `<span class="badge you">you're in</span>` : ""}
    </div>
    <div class="title">${esc(q.title)}</div>
    <div class="blurb">${esc(q.blurb)}</div>
    ${q.type === "group" ? `<div class="meter"><i style="width:${fill}%"></i></div>` : ""}
    <div class="foot">
      <span class="state ${st}">${esc(q.type === "personal" ? (st === "done" ? "Completed" : q.members.length ? "Taken" : "Available") : slotText(q))}</span>
      <span>${q.members.map((m) => esc(nameOf(m))).join(", ")}</span>
    </div>
  </button>`;
}

function viewMine() {
  const m = myQuests(S.quests, S.uid);
  const prog = coreProgress(S.quests, S.uid, S.config);
  const core = [...m.coreGroup, ...m.corePersonal];
  const pips = Array.from({ length: prog.needed }, (_, i) =>
    `<div class="pip ${i < prog.done ? "done" : i < prog.picked ? "picked" : ""}"></div>`).join("");
  const p = S.config?.picking || {};
  const needG = (p.groupQuestsPerPlayer ?? 2) - m.coreGroup.length;
  const needP = (p.personalQuestsPerPlayer ?? 1) - m.corePersonal.length;
  let todo = "";
  if (needG > 0 || needP > 0) {
    const bits = [];
    if (needG > 0) bits.push(`${needG} group quest${needG > 1 ? "s" : ""}`);
    if (needP > 0) bits.push(`${needP} solo quest`);
    todo = `<div class="note">You still need to pick ${bits.join(" and ")}. ${S.config?.pickingOpen ? "" : "Picking is locked, so message Shalom."}</div>
      ${S.config?.pickingOpen ? `<button class="btn primary" style="margin-top:12px" data-act="tab" data-id="board">Go to the board</button>` : ""}`;
  }
  return `
    <h1>Hey ${esc(S.me.name)}</h1>
    <p class="sub">${prog.allDone ? "Core quests cleared. Bonus quests are unlocked on the board." : `${prog.done} of ${prog.needed} core quests done`}</p>
    <div class="progress">${pips}</div>
    ${todo}
    ${core.length ? `<h2>Core quests</h2>${core.map(questCard).join("")}` : ""}
    ${m.bonus.length ? `<h2>Bonus quests</h2>${m.bonus.map(questCard).join("")}` : ""}
    ${!core.length && !m.bonus.length ? `<div class="empty-state">No quests yet. The board is where the fun starts.</div>` : ""}
    <div class="row" style="margin-top:24px">
      <button class="btn ghost small" data-act="rules">📜 House rules</button>
      <button class="btn ghost small" data-act="logout">↩ Log out</button>
    </div>`;
}

function viewBoard() {
  const prog = coreProgress(S.quests, S.uid, S.config);
  const seg = (id, label) => `<button class="${S.board === id ? "on" : ""}" data-act="board" data-id="${id}">${label}</button>`;
  let list = S.quests.filter((q) => q.active);
  if (S.board === "group") list = list.filter((q) => q.pool === "core" && q.type === "group");
  if (S.board === "personal") list = list.filter((q) => q.pool === "core" && q.type === "personal");
  if (S.board === "bonus") list = list.filter((q) => q.pool === "bonus");
  // Mine first, then quests that are closest to starting, then the rest.
  const rank = (q) => {
    if (q.members.includes(S.uid)) return -100;
    if (q.status === "done" || q.members.length >= q.max) return 100;
    if (q.members.length && q.members.length < q.min) return q.min - q.members.length;
    return 10;
  };
  list.sort((a, b) => rank(a) - rank(b));
  const intro = {
    group: "Pick 2. Names show who's already in. Your two group quests need different teammates.",
    personal: "Pick 1. First come, first served.",
    bonus: prog.allDone ? "Extra quests for overachievers." : "🔒 Unlocks when you finish your core quests. You can look though.",
  }[S.board];
  return `
    <h1>Quest board</h1>
    ${S.config?.pickingOpen ? "" : `<div class="note">Picking is locked. Core quests can't be swapped now.</div>`}
    <div class="seg">${seg("group", "Group")}${seg("personal", "Solo")}${seg("bonus", prog.allDone ? "Bonus" : "Bonus 🔒")}</div>
    <p class="sub" style="margin-bottom:14px">${intro}</p>
    ${list.map(questCard).join("") || `<div class="empty-state">Nothing here yet.</div>`}`;
}

function viewRanks(scores) {
  const rows = [...S.players.entries()]
    .map(([uid, p]) => ({ uid, name: p.name, score: scores.get(uid) || 0, prog: coreProgress(S.quests, uid, S.config) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const feed = S.quests.filter((q) => q.status === "done")
    .sort((a, b) => (b.completedAt?.seconds || 0) - (a.completedAt?.seconds || 0)).slice(0, 25);
  return `
    <h1>Leaderboard</h1>
    <h2>Players</h2>
    <div class="list">${rows.map((r, i) => `<div class="rank">
      <span class="n">${i + 1}</span>
      <span class="who">${esc(r.name)}${r.uid === S.uid ? " (you)" : ""}<small>${r.prog.done}/${r.prog.needed} core done</small></span>
      <span class="pts">${r.score}</span></div>`).join("")}</div>
    <h2>Recently completed</h2>
    ${feed.length ? `<div class="list">${feed.map((q) => `<div class="feed">
      <b>${q.members.map((m) => esc(nameOf(m))).join(" & ")}</b> completed <b>${esc(q.title)}</b>
      ${q.note ? `<q>${esc(q.note)}</q>` : ""}</div>`).join("")}</div>` : `<div class="empty-state">Nothing completed yet. Be first.</div>`}`;
}

/* ---------- overlay (quest sheet + inbox) ---------- */
function renderOverlay() { preserve(renderOverlayNow); }
function renderOverlayNow() {
  if (!S.sheet || !S.me) { $overlay.innerHTML = ""; return; }
  let inner = "";
  if (S.sheet.kind === "quest") {
    const q = qById(S.sheet.id);
    if (!q) { S.sheet = null; $overlay.innerHTML = ""; return; }
    inner = questSheet(q);
  } else if (S.sheet.kind === "rules") {
    inner = `<h3>House rules</h3><ul class="rules">${(S.config?.houseRules || []).map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`;
  } else if (S.sheet.kind === "inbox") {
    inner = `<h3>Give Shalom a sidequest</h3>
      <p class="sub">Anything fun and harmless. If Shalom completes it, you get ${S.config?.points?.hostQuestReward ?? 10} points.</p>
      <textarea class="field" id="inboxText" maxlength="500" placeholder="e.g. Start a conga line during the next song"></textarea>
      <label class="check"><input type="checkbox" id="anon"> Send anonymously (no points)</label>
      <button class="btn pink" data-act="sendInbox" ${S.busy ? "disabled" : ""}>Send it</button>`;
  }
  $overlay.innerHTML = `<div class="scrim" data-act="close"></div>
    <div class="sheet" role="dialog"><div class="grab"></div>
      <button class="iconbtn closex" data-act="close" aria-label="Close">✕</button>
      <div class="wrap">${inner}</div></div>`;
}

function questSheet(q) {
  const mine = q.members.includes(S.uid);
  const st = questState(q);
  const team = q.type === "group"
    ? `<div class="box"><div class="label">Team · ${esc(slotText(q))}</div><div class="chips">
        ${q.members.map((m) => `<span class="chip ${m === S.uid ? "me" : ""}">${esc(nameOf(m))}</span>`).join("")}
        ${Array.from({ length: Math.max(0, q.min - q.members.length) }, () => `<span class="chip empty">needed</span>`).join("")}
        ${Array.from({ length: q.max - Math.max(q.min, q.members.length) }, () => `<span class="chip empty">optional</span>`).join("")}
      </div></div>`
    : "";
  let twist = "";
  if (mine && (q.twistCount || 0) > 0) {
    if (st === "forming") {
      twist = `<div class="box secret"><div class="label">🤫 Secret twist</div>Unlocks once your team has ${q.min} people.</div>`;
    } else {
      const sec = loadSecret(q);
      const ticked = (q.twistDone || []).includes(S.uid);
      twist = `<div class="box secret"><div class="label">🤫 Secret twist · +${S.config?.points?.twistBonus ?? 10} pts</div>
        ${sec === undefined ? "Loading…" : sec === null ? "No twist for you on this one." :
          `<div class="reveal ${S.revealed.has(q.id) ? "shown" : ""}" data-act="reveal">${esc(sec)}</div><p class="sub" style="font-size:13px">Tap to reveal. Don't show your teammates.</p>
           <label class="check"><input type="checkbox" data-act="twist" ${ticked ? "checked" : ""}> I pulled off my twist</label>`}
      </div>`;
    }
  }
  let action = "";
  if (!mine) {
    const r = canJoin(q, S.uid, S.quests, S.config);
    action = r.ok
      ? `<button class="btn primary" data-act="join" ${S.busy ? "disabled" : ""}>${q.type === "group" ? "Join this quest" : "Take this quest"}</button>`
      : `<div class="note">${esc(reason(r.reason))}</div>`;
  } else if (st === "done") {
    action = `<div class="box win"><div class="label">✓ Completed${q.completedBy ? ` · marked by ${esc(nameOf(q.completedBy))}` : ""}</div>${q.note ? esc(q.note) : "No note."}</div>
      <button class="btn ghost small" data-act="undo">Undo, we're not done</button>`;
  } else if (st === "forming") {
    action = `<div class="note">Waiting for ${q.min - q.members.length} more ${q.min - q.members.length > 1 ? "people" : "person"} to join. Hype it in the group chat.</div>`;
  } else {
    action = `<textarea class="field" id="note" maxlength="280" placeholder="What happened? (optional, shows on the leaderboard)"></textarea>
      <button class="btn primary" data-act="complete" ${S.busy ? "disabled" : ""}>Mark as complete</button>`;
  }
  const leave = mine && canLeave(q, S.uid, S.config)
    ? `<button class="btn ghost small danger" data-act="leave">Leave this quest</button>` : "";
  return `
    <div class="meta"><span class="badge ${q.level}">${q.level}</span>
      <span class="badge">${q.type === "personal" ? "solo" : `👥 ${sizeLabel(q)} players`}</span>
      <span class="badge">${esc(q.category || "")}</span>
      ${q.pool === "bonus" ? `<span class="badge bonus">bonus</span>` : ""}</div>
    <h3>${esc(q.title)}</h3>
    <p class="sub">${esc(q.blurb)}</p>
    ${team}
    <div class="box"><div class="label">How to play</div><ol>${(q.instructions || []).map((i) => `<li>${esc(i)}</li>`).join("")}</ol></div>
    <div class="box win"><div class="label">Done when</div>${esc(q.doneWhen)}</div>
    ${twist}
    ${action}
    ${leave}`;
}

function loadSecret(q) {
  const idx = q.twistCount === 1 ? 0 : q.members.indexOf(S.uid);
  const key = `${idx}|${q.members.length}`;
  const cached = S.secrets[q.id];
  if (cached && cached.key === key) return cached.text;
  if (idx < 0 || idx >= q.twistCount) { S.secrets[q.id] = { key, text: null }; return null; }
  S.secrets[q.id] = { key, text: undefined };
  getDoc(doc(db, "questSecrets", q.id, "slots", String(idx)))
    .then((s) => { S.secrets[q.id] = { key, text: s.exists() ? s.data().text : null }; renderOverlay(); })
    .catch(() => { S.secrets[q.id] = { key, text: null }; renderOverlay(); });
  return undefined;
}

/* ---------- actions ---------- */
async function busy(fn) {
  if (S.busy) return;
  S.busy = true; render();
  try { await fn(); } catch (e) { console.error(e); toast(friendly(e)); }
  S.busy = false; render();
}

function readForm() {
  const name = cleanName(document.getElementById("nameInput")?.value || "");
  const pin = (document.getElementById("pinInput")?.value || "").trim();
  S.regError = "";
  if (document.getElementById("nameInput") && (name.length < 2 || name.length > 20)) S.regError = "Use a name with 2 to 20 characters.";
  else if (!/^\d{4}$/.test(pin)) S.regError = "Your PIN must be exactly 4 digits.";
  if (S.regError) { render(); return null; }
  return { name, lower: name.toLowerCase(), pin };
}

async function register() {
  const f = readForm(); if (!f) return;
  await busy(async () => {
    const user = auth.currentUser;
    const nref = doc(db, "names", f.lower);
    if ((await getDoc(nref)).exists()) { S.regError = `"${f.name}" is taken. If that's you, tap Log in.`; return; }
    const key = newKey();
    await linkWithCredential(user, EmailAuthProvider.credential(emailFor(key), pwFor(f.pin)));
    S.linked = true;
    await runTransaction(db, async (tx) => {
      if ((await tx.get(nref)).exists()) throw new Error(`"${f.name}" was just taken. Tap Start over and pick another name.`);
      tx.set(doc(db, "players", user.uid), { name: f.name, nameLower: f.lower, createdAt: serverTimestamp(), adjust: 0 });
      tx.set(nref, { uid: user.uid, key });
    });
  });
}

async function login() {
  const f = readForm(); if (!f) return;
  await busy(async () => {
    const ns = await getDoc(doc(db, "names", f.lower));
    if (!ns.exists()) { S.regError = `No player called "${f.name}". Check the spelling, or tap I'm new.`; return; }
    if (!ns.data().key) { S.regError = `${f.name} hasn't set a PIN yet. Open the app on your original phone first, or ask Shalom.`; return; }
    try { await signInWithEmailAndPassword(auth, emailFor(ns.data().key), pwFor(f.pin)); }
    catch (e) { S.regError = friendly(e); }
  });
}

async function setPin() {
  const f = readForm(); if (!f) return;
  await busy(async () => {
    const key = newKey();
    await linkWithCredential(auth.currentUser, EmailAuthProvider.credential(emailFor(key), pwFor(f.pin)));
    await updateDoc(doc(db, "names", S.me.nameLower), { key });
    S.linked = true;
    toast("PIN saved 🔐");
  });
}

async function logout() {
  if (!window.confirm("Log out? You'll need your name and PIN to get back in.")) return;
  await signOut(auth);
}

async function join(id) {
  await busy(async () => {
    await runTransaction(db, async (tx) => {
      const ref = doc(db, "quests", id);
      const snap = await tx.get(ref);
      const q = { id, members: [], ...snap.data() };
      const others = S.quests.filter((x) => x.id !== id);
      const r = canJoin(q, S.uid, [...others, q], S.config);
      if (!r.ok) throw new Error(reason(r.reason));
      tx.update(ref, { members: [...q.members, S.uid] });
    });
    toast("You're in! ⚡");
  });
}

async function leave(id) {
  if (!confirmLeave()) return;
  await busy(async () => {
    await runTransaction(db, async (tx) => {
      const ref = doc(db, "quests", id);
      const snap = await tx.get(ref);
      tx.update(ref, { members: snap.data().members.filter((m) => m !== S.uid) });
    });
    S.sheet = null;
    toast("Left the quest.");
  });
}
function confirmLeave() { return window.confirm("Leave this quest? Your spot opens up for someone else."); }

async function complete(id) {
  const note = (document.getElementById("note")?.value || "").trim().slice(0, 280);
  await busy(async () => {
    await updateDoc(doc(db, "quests", id), { status: "done", note, completedBy: S.uid, completedAt: serverTimestamp() });
    toast("Quest complete! 🎉");
  });
}

async function undo(id) {
  await busy(() => updateDoc(doc(db, "quests", id), { status: "open", note: "", completedBy: null, completedAt: null }));
}

async function toggleTwist(id, on) {
  const q = qById(id);
  const list = (q.twistDone || []).filter((u) => u !== S.uid);
  if (on) list.push(S.uid);
  try { await updateDoc(doc(db, "quests", id), { twistDone: list }); } catch (e) { toast(friendly(e)); }
}

async function sendInbox() {
  const text = document.getElementById("inboxText").value.trim();
  const anon = document.getElementById("anon").checked;
  if (!text) { toast("Write a quest first."); return; }
  await busy(async () => {
    await addDoc(collection(db, "inbox"), {
      fromUid: anon ? null : S.uid, fromName: anon ? null : S.me.name,
      text: text.slice(0, 500), createdAt: serverTimestamp(), status: "new",
    });
    S.sheet = null;
    toast("Sent to Shalom 📨");
  });
}

/* ---------- events ---------- */
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const act = t.dataset.act;
  const qid = S.sheet?.id;
  if (act === "tab") { S.tab = t.dataset.id; S.sheet = null; render(); window.scrollTo(0, 0); }
  else if (act === "board") { S.board = t.dataset.id; render(); }
  else if (act === "open") { S.sheet = { kind: "quest", id: t.dataset.id }; renderOverlay(); }
  else if (act === "close") { S.sheet = null; renderOverlay(); }
  else if (act === "inbox") { S.sheet = { kind: "inbox" }; renderOverlay(); }
  else if (act === "rules") { S.sheet = { kind: "rules" }; renderOverlay(); }
  else if (act === "reveal") { t.classList.toggle("shown"); S.revealed[t.classList.contains("shown") ? "add" : "delete"](qid); }
  else if (act === "join") join(qid);
  else if (act === "leave") leave(qid);
  else if (act === "complete") complete(qid);
  else if (act === "undo") undo(qid);
  else if (act === "sendInbox") sendInbox();
  else if (act === "logout") logout();
  else if (act === "gateMode") { S.gateMode = t.dataset.id; S.regError = ""; render(); }
  else if (act === "cancelClaim") deleteDoc(doc(db, "claims", S.uid)).catch((er) => toast(friendly(er)));
});
document.addEventListener("change", (e) => {
  if (e.target.dataset.act === "twist") toggleTwist(S.sheet.id, e.target.checked);
});
document.addEventListener("submit", (e) => {
  const act = e.target.dataset.act;
  if (["register", "login", "setPin"].includes(act)) e.preventDefault();
  if (act === "register") register();
  if (act === "login") login();
  if (act === "setPin") setPin();
});
