import {
  makeApp, signInAnonymously, onAuthStateChanged, signOut,
  linkWithCredential, signInWithEmailAndPassword, EmailAuthProvider,
  doc, collection, onSnapshot, getDoc, runTransaction, updateDoc, addDoc, setDoc, deleteDoc, serverTimestamp,
  query, where, orderBy, limitToLast, writeBatch, increment,
} from "./firebase.js";
import { questChatId, dmChatId, ms, messagesHtml, keepScroll, GROUP_CHAT } from "./chat.js";
import {
  esc, sizeLabel, questState, slotText, myQuests, coreProgress, canJoin, canLeave, computeScores,
  HOST_NAME, filterSort, activeFilterCount, DEFAULT_VIEW, DARE_CAP, countedDares, DEFAULT_POINTS,
} from "./game.js";

const { auth, db } = makeApp("player");

const S = {
  uid: null, me: undefined, claim: undefined, config: null,
  quests: [], players: new Map(),
  tab: "mine", board: "group",
  view: { ...DEFAULT_VIEW }, viewOpen: false,
  sheet: null,          // { kind: 'quest', id } | { kind: 'inbox' }
  secrets: {},          // questId -> { key, text }
  revealed: new Set(),
  busy: false, regError: "", gateMode: "join", linked: false,
  dmChats: new Map(),     // chatId -> chat doc (private messages)
  questChats: new Map(),  // chatId -> chat doc (team chats for my quests)
  msgs: [],               // messages of the open chat
  groupChat: null,        // the Everyone chat doc
  dares: [],              // all dares (who/status only)
  dareText: {},           // dareId -> { title, details } (only mine)
  myRequest: undefined,   // my bring-list doc
};
const PRESETS = [["💧", "Water"], ["🍬", "Gum"], ["🩴", "Slippers"], ["💊", "Painkillers"]];
let questChatUnsubs = new Map();
let msgUnsub = null;

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
const nameOf = (uid) => (uid === "admin" ? HOST_NAME : S.players.get(uid)?.name || "Someone");
const fmtTime = (t) => new Date(ms(t)).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const requestsOpen = () => !!S.config?.requestDeadline && Date.now() < ms(S.config.requestDeadline);
const qById = (id) => S.quests.find((q) => q.id === id);
let toastTimer;
function toast(msg, ms = 3200) {
  $toast.innerHTML = `<div class="toast">${esc(msg)}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($toast.innerHTML = ""), ms);
}
// B2: small ⓘ hints that explain something on tap, without taking up space.
const HINTS = {
  twist: "Some quests hide a secret twist that only you can see. Pull it off without your team noticing, then tick it for +10.",
  noRepeat: "Your two group quests can't share a teammate, so you end up meeting more people.",
  space: "Hides quests that are already full or taken.",
  bonus: "Bonus quests unlock once your 3 core quests are done. Anyone can also add their own with ＋.",
  dares: `Only your first ${DARE_CAP} completed dares earn points. After that they're just for fun.`,
  doneWhen: "This is what counts as finished. When it's true, any team member can tap Mark as complete.",
};
const hint = (k) => `<button class="hint" data-act="hint" data-k="${k}" aria-label="What's this?">ⓘ</button>`;
const GUIDE = [
  ["🎯", "Pick your quests", "Head to the Board and pick 2 group quests and 1 solo quest. Your two group quests need different teammates, so you'll meet new people."],
  ["🤝", "Team up", "A group quest starts once enough people join. Plan in its team chat. Some quests hide a secret twist only you can see: pull it off for +10."],
  ["✅", "Do it, then mark it done", "Check \"Done when\", go do it, then tap Mark as complete. Finish your 3 core quests to unlock bonus quests."],
  ["✨", "Extras", `Chat with everyone in 💬. Suggest sidequests with ＋. Find house rules, your bring list and this guide in ☰. Always kind, safe and consensual.`],
];
function friendly(e) {
  const m = String(e?.code || e?.message || e);
  const code = e?.code ? ` (${String(e.code).replace(/^(auth|firestore)\//, "")})` : "";
  if (/provider-already-linked|credential-already-in-use|email-already-in-use/.test(m)) return "This phone is half signed in. Tap Start over below, then try again." + code;
  if (m.includes("resource-exhausted") || m.includes("quota")) return `The game hit its free daily limit. Tell ${HOST_NAME}.` + code;
  if (/invalid-credential|wrong-password|user-not-found|invalid-login/.test(m)) return "Wrong PIN for that name.";
  if (m.includes("too-many-requests")) return "Too many tries. Wait a few minutes and try again.";
  if (m.includes("operation-not-allowed")) return `PIN sign-in isn't switched on yet. Tell ${HOST_NAME}.`;
  if (m.includes("network-request-failed")) return "No signal right now. Try again in a moment.";
  if (m.includes("unavailable") || m.includes("offline")) return "No signal right now. Try again in a moment.";
  if (m.includes("permission")) return "That move isn't allowed right now." + code;
  return e?.message && !e.code ? e.message : "Something went wrong. Try again." + code;
}
function reason(r) {
  if (r?.startsWith("clash:")) return `You're already teamed with ${nameOf(r.slice(6))} in your other group quest. Mix it up!`;
  return r;
}

/* ---------- auth + data ---------- */
// Make sure there's a signed-in (at least anonymous) session before touching the database.
let anonPending = null;
async function ensureSession() {
  await auth.authStateReady();
  if (auth.currentUser) return auth.currentUser;
  if (!anonPending) anonPending = signInAnonymously(auth).finally(() => { anonPending = null; });
  return (await anonPending).user;
}
const TRANSIENT = /aborted|unavailable|deadline-exceeded|internal|network-request-failed|offline/;
async function withRetry(fn) {
  try { return await fn(); }
  catch (e) {
    if (!TRANSIENT.test(String(e?.code || e?.message))) throw e;
    await new Promise((r) => setTimeout(r, 900));
    return fn();
  }
}
let unsubs = [];
const spinner = `<div class="center"><div class="spinner"></div></div>`;
onAuthStateChanged(auth, (user) => {
  if (!user) {
    S.uid = null;
    unsubs.forEach((f) => f()); unsubs = [];
    questChatUnsubs.forEach((f) => f()); questChatUnsubs = new Map();
    if (msgUnsub) { msgUnsub(); msgUnsub = null; }
    $root.innerHTML = spinner; $overlay.innerHTML = "";
    ensureSession().catch((e) => {
      $root.innerHTML = `<div class="wrap center"><div><h1>Can't connect</h1><p class="sub">${esc(friendly(e))}</p></div></div>`;
    });
    return;
  }
  S.linked = !user.isAnonymous;
  if (S.uid === user.uid) { render(); return; }
  // A different person on this phone: start fresh.
  unsubs.forEach((f) => f()); unsubs = [];
  Object.assign(S, { guideChecked: false, uid: user.uid, me: undefined, claim: undefined, secrets: {}, revealed: new Set(), sheet: null, tab: "mine", regError: "", dmChats: new Map(), questChats: new Map(), msgs: [], groupChat: null, dares: [], dareText: {}, myRequest: undefined });
  questChatUnsubs.forEach((f) => f()); questChatUnsubs = new Map();
  if (msgUnsub) { msgUnsub(); msgUnsub = null; }
  $root.innerHTML = spinner; $overlay.innerHTML = "";
  listen();
  startSession();
});

function listen() {
  const on = (...a) => unsubs.push(onSnapshot(...a));
  on(doc(db, "players", S.uid), (s) => { S.me = s.exists() ? s.data() : null; render(); }, () => {});
  on(doc(db, "claims", S.uid), (s) => { S.claim = s.exists() ? s.data() : null; render(); }, () => { S.claim = null; render(); });
  on(doc(db, "config", "game"), (s) => { S.config = s.exists() ? s.data() : null; render(); });
  on(collection(db, "players"), (snap) => {
    S.players = new Map(snap.docs.map((d) => [d.id, d.data()]));
    render();
  });
  on(collection(db, "quests"), (snap) => {
    S.quests = snap.docs.map((d) => ({ id: d.id, members: [], twistDone: [], ...d.data() }))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    syncQuestChats();
    render();
  });
  on(query(collection(db, "chats"), where("members", "array-contains", S.uid)), (snap) => {
    S.dmChats = new Map(snap.docs.map((d) => [d.id, d.data()]));
    render();
  }, () => {});
  on(doc(db, "chats", GROUP_CHAT), (s) => { S.groupChat = s.exists() ? s.data() : null; render(); }, () => {});
  on(collection(db, "dares"), (snap) => {
    S.dares = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
    render();
  }, () => {});
  on(doc(db, "requests", S.uid), (s) => { S.myRequest = s.exists() ? s.data() : null; render(); }, () => { S.myRequest = null; });
}

// Watch the team chat of every group quest I'm in (for unread dots).
function syncQuestChats() {
  const want = new Set(S.quests.filter((q) => q.type === "group" && q.members.includes(S.uid)).map((q) => questChatId(q.id)));
  for (const [id, off] of questChatUnsubs) if (!want.has(id)) { off(); questChatUnsubs.delete(id); S.questChats.delete(id); }
  for (const id of want) {
    if (questChatUnsubs.has(id)) continue;
    questChatUnsubs.set(id, onSnapshot(doc(db, "chats", id), (s) => {
      if (s.exists()) S.questChats.set(id, s.data()); else S.questChats.delete(id);
      render();
    }, () => {}));
  }
}

/* ---------- chat ---------- */
const seenKey = (id) => `gtsq:seen:${S.uid}:${id}`;
function seenAt(id) { try { return Number(localStorage.getItem(seenKey(id))) || 0; } catch { return 0; } }
function markSeen(id) { try { localStorage.setItem(seenKey(id), String(Date.now())); } catch {} }
function isUnread(id, chat) { return !!chat && chat.lastFrom !== S.uid && ms(chat.lastAt) > seenAt(id); }
function unreadCount() {
  let n = 0;
  for (const [id, c] of [...S.dmChats, ...S.questChats, [GROUP_CHAT, S.groupChat]]) if (isUnread(id, c) && S.sheet?.id !== id) n++;
  return n;
}
function chatTitle(id) {
  if (id === GROUP_CHAT) return "📣 Everyone";
  if (id.startsWith("q_")) return qById(id.slice(2))?.title || "Team chat";
  const other = id.slice(2).split("_").find((u) => u !== S.uid);
  return nameOf(other);
}
function openChat(id) {
  if (msgUnsub) msgUnsub();
  S.msgs = [];
  S.sheet = { kind: "chat", id };
  markSeen(id);
  msgUnsub = onSnapshot(query(collection(db, "chats", id, "messages"), orderBy("at"), limitToLast(300)), (snap) => {
    S.msgs = snap.docs.map((d) => d.data({ serverTimestamps: "estimate" }));
    if (S.sheet?.id === id) markSeen(id);
    render();
  }, (e) => toast(friendly(e)));
  render();
}
function closeChat() { if (msgUnsub) { msgUnsub(); msgUnsub = null; } S.msgs = []; }

async function sendMsg() {
  const el = document.getElementById("chatInput");
  const text = (el?.value || "").trim().slice(0, 500);
  if (!text) return;
  el.value = "";
  const id = S.sheet.id;
  const b = writeBatch(db);
  b.set(doc(collection(db, "chats", id, "messages")), { from: S.uid, text, at: serverTimestamp() });
  const meta = { lastAt: serverTimestamp(), lastFrom: S.uid, lastText: text.slice(0, 80) };
  if (id.startsWith("d_")) meta.members = id.slice(2).split("_");
  b.set(doc(db, "chats", id), meta);
  b.commit().catch((e) => { toast(friendly(e)); });
  el.focus();
}

function viewChats() {
  const row = (id, chat, title, sub) => `<button class="hrow chatrow" data-act="chat" data-id="${id}">
    <div class="grow"><b>${esc(title)}</b><small>${esc(chat?.lastText ? `${chat.lastFrom === S.uid ? "You: " : ""}${chat.lastText}` : sub)}</small></div>
    ${isUnread(id, chat) ? `<span class="dot"></span>` : ""}</button>`;
  const mineQ = S.quests.filter((q) => q.type === "group" && q.members.includes(S.uid));
  const dms = [...S.dmChats.entries()].sort((a, b) => ms(b[1].lastAt) - ms(a[1].lastAt));
  return `
    <h1>Chats</h1>
    <div class="caution">⚠️ Chats can be read by ${HOST_NAME}. Be warned!</div>
    <h2>Group</h2>
    <div class="list">${row(GROUP_CHAT, S.groupChat, chatTitle(GROUP_CHAT), `Everyone playing, plus announcements from ${HOST_NAME}`)}</div>
    <h2>Team chats</h2>
    ${mineQ.length ? `<div class="list">${mineQ.map((q) => row(questChatId(q.id), S.questChats.get(questChatId(q.id)), q.title, "Chat with your team")).join("")}</div>`
      : `<div class="empty-state">Join a group quest on the Board and its team chat shows up here.</div>`}
    <h2>Private messages</h2>
    ${dms.length ? `<div class="list">${dms.map(([id, c]) => row(id, c, chatTitle(id), "")).join("")}</div>` : `<div class="empty-state">No private chats yet. Tap ✉️ next to anyone on Ranks, or start one below.</div>`}
    <button class="btn" style="margin-top:12px" data-act="pickPlayer">✉️ New message</button>`;
}

/* ---------- rendering ---------- */
// Keep whatever the player is typing across live re-renders.
function preserve(fn) {
  const active = document.activeElement?.id;
  const vals = {};
  for (const id of ["nameInput", "pinInput", "note", "inboxText", "chatInput", "sgTitle", "sgDetails", "sgTo", "sgSize"]) { const el = document.getElementById(id); if (el) vals[id] = el.value; }
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
  const scores = computeScores(S.quests, S.players, S.config, S.dares);
  const myScore = scores.get(S.uid) || 0;
  // B1: show the walkthrough once per player on this phone.
  if (!S.sheet && !S.guideChecked) {
    S.guideChecked = true;
    let seen = false;
    try { seen = !!localStorage.getItem(`gtsq:guided:${S.uid}`); } catch {}
    if (!seen) S.sheet = { kind: "guide", step: 0 };
  }
  let body = "";
  if (S.tab === "mine") body = viewMine();
  if (S.tab === "board") body = viewBoard();
  if (S.tab === "ranks") body = viewRanks(scores);
  if (S.tab === "chats") body = viewChats();
  const unread = unreadCount();
  $root.innerHTML = `
    <header class="topbar"><div class="wrap">
      <div class="logo">GT <span>SIDEQUESTS</span></div>
      <span class="pill lime">⚡ ${myScore}</span>
      <button class="iconbtn plus" data-act="suggest" aria-label="Suggest a sidequest">＋</button>
      <button class="iconbtn" data-act="menu" aria-label="Menu">☰</button>
    </div></header>
    <main><div class="wrap">${body}</div></main>
    <nav class="tabbar"><div class="wrap">
      ${tabBtn("mine", "🎯", "My quests", openDaresForMe().length)}${tabBtn("board", "🗺️", "Board")}${tabBtn("chats", "💬", "Chats", unread)}${tabBtn("ranks", "🏆", "Ranks")}
    </div></nav>`;
  renderOverlayNow();
}
const tabBtn = (id, icon, label, badge = 0) => `<button class="tab ${S.tab === id ? "on" : ""}" data-act="tab" data-id="${id}"><b>${icon}${badge ? `<i class="badgecount">${badge}</i>` : ""}</b>${label}</button>`;

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
      <p class="sub">${HOST_NAME} needs to confirm it's you on this phone. Ping them, then this screen will update by itself.</p>
      <button class="btn ghost" style="margin-top:20px" data-act="cancelClaim">Cancel</button>
    </div></div>`;
    return;
  }
  const join = S.gateMode === "join";
  const rules = S.config?.houseRules || [];
  const seg = (id, label) => `<button type="button" class="${S.gateMode === id ? "on" : ""}" data-act="gateMode" data-id="${id}">${label}</button>`;
  $root.innerHTML = `<div class="wrap">
    <div class="hero"><h1>GT<span>SIDEQUESTS</span></h1>
      <p class="sub">Fun little sidequests to do at GT Abuja</p></div>
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
    ${S.linked || S.regError.includes("Start over") ? `<button class="btn ghost small" style="margin-top:12px" data-act="logout">Start over</button>` : ""}
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

function nextStep(m, prog) {
  const p = S.config?.picking || {};
  const needG = (p.groupQuestsPerPlayer ?? 2) - m.coreGroup.length;
  const needP = (p.personalQuestsPerPlayer ?? 1) - m.corePersonal.length;
  const card = (icon, title, text, btn) => `<div class="card next"><div class="title">${icon} ${title}</div><div class="blurb">${text}</div>${btn || ""}</div>`;
  if (needG > 0 || needP > 0) {
    const bits = [];
    if (needG > 0) bits.push(`${needG} group quest${needG > 1 ? "s" : ""}`);
    if (needP > 0) bits.push(`${needP} solo quest`);
    return S.config?.pickingOpen
      ? card("🗺️", "Pick your quests", `You still need ${bits.join(" and ")}.`, `<button class="btn primary" data-act="tab" data-id="board">Go to the Board</button>`)
      : card("🔒", "Picking is locked", `You still need ${bits.join(" and ")}. Message ${HOST_NAME} to sort it out.`);
  }
  const core = [...m.coreGroup, ...m.corePersonal];
  const ready = core.find((q) => questState(q) === "ready");
  if (ready) return card("⚡", `Ready: ${esc(ready.title)}`, esc(ready.doneWhen ? `Done when: ${ready.doneWhen}` : ready.blurb), `<button class="btn primary" data-act="open" data-id="${ready.id}">Open quest</button>`);
  const forming = core.find((q) => questState(q) === "forming");
  if (forming) {
    const n = forming.min - forming.members.length;
    return card("⏳", `Waiting on ${esc(forming.title)}`, `It needs ${n} more ${n > 1 ? "people" : "person"} to start. Give it a shout in the Everyone chat.`, `<button class="btn" data-act="chat" data-id="${GROUP_CHAT}">📣 Open the Everyone chat</button>`);
  }
  return card("🏆", "Core quests cleared!", "Bonus quests are unlocked. Grab one on the Board, or suggest your own with ＋.", `<button class="btn primary" data-act="goBonus">See bonus quests</button>`);
}

function viewMine() {
  const m = myQuests(S.quests, S.uid);
  const prog = coreProgress(S.quests, S.uid, S.config);
  const core = [...m.coreGroup, ...m.corePersonal];
  const pips = Array.from({ length: prog.needed }, (_, i) =>
    `<div class="pip ${i < prog.done ? "done" : i < prog.picked ? "picked" : ""}"></div>`).join("");
  return `
    <h1>Hey ${esc(S.me.name)}</h1>
    <p class="sub">${prog.done} of ${prog.needed} core quests done</p>
    <div class="progress">${pips}</div>
    ${nextStep(m, prog)}
    ${bringCard()}
    ${daresSection()}
    ${core.length ? `<h2>Core quests</h2>${core.map(questCard).join("")}` : ""}
    ${m.bonus.length ? `<h2>Bonus quests</h2>${m.bonus.map(questCard).join("")}` : ""}`;
}

function viewBoard() {
  const prog = coreProgress(S.quests, S.uid, S.config);
  const seg = (id, label) => `<button class="${S.board === id ? "on" : ""}" data-act="board" data-id="${id}">${label}</button>`;
  let list = S.quests.filter((q) => q.active);
  if (S.board === "group") list = list.filter((q) => q.pool === "core" && q.type === "group");
  if (S.board === "personal") list = list.filter((q) => q.pool === "core" && q.type === "personal");
  if (S.board === "bonus") list = list.filter((q) => q.pool === "bonus");
  const v = { ...S.view, size: S.board === "personal" ? "any" : S.view.size };
  list = filterSort(list, v, S.uid);
  const locked = !S.config?.pickingOpen;
  const intro = {
    group: `Pick 2. Names show who's in. ${hint("noRepeat")}`,
    personal: "Pick 1. First come, first served.",
    bonus: prog.allDone ? `Extra quests for overachievers. ${hint("bonus")}` : `Unlocks after your core quests. ${hint("bonus")}`,
  }[S.board];
  const lockTxt = locked && S.board !== "bonus" ? "🔒 Picking is locked. " : "";
  return `
    <h1>Quest board</h1>
    <div class="seg">${seg("group", `Group${locked ? " 🔒" : ""}`)}${seg("personal", `Solo${locked ? " 🔒" : ""}`)}${seg("bonus", prog.allDone ? "Bonus" : "Bonus 🔒")}</div>
    <div class="boardbar"><p class="sub">${lockTxt}${intro}</p>${viewToggle(v)}</div>
    ${viewPanel(v)}
    ${list.map(questCard).join("") || `<div class="empty-state">${activeFilterCount(v) ? "No quests match these filters." : "Nothing here yet."}</div>`}`;
}

function viewToggle(v) {
  const n = activeFilterCount(v);
  return `<button class="vtoggle ${n || v.sort !== "smart" || S.viewOpen ? "on" : ""}" data-act="vToggle" aria-label="Sort and filter">⚙️${n ? ` ${n}` : ""}</button>`;
}
function viewPanel(v) {
  const n = activeFilterCount(v);
  const chip = (act, val, label, on) => `<button class="${on ? "on" : ""}" data-act="${act}" data-v="${val}">${label}</button>`;
  let panel = "";
  if (S.viewOpen) {
    panel = `<div class="vpanel">
      <div class="vlabel">Sort</div>
      <div class="chipset">${chip("vSort", "smart", "Smart", v.sort === "smart")}${chip("vSort", "az", "A–Z", v.sort === "az")}${chip("vSort", "level", "Difficulty", v.sort === "level")}</div>
      <div class="vlabel">Difficulty</div>
      <div class="chipset">${["easy", "medium", "hard"].map((l) => chip("vLevel", l, l[0].toUpperCase() + l.slice(1), v.levels.includes(l))).join("")}</div>
      <div class="vlabel">Show ${hint("space")}</div>
      <div class="chipset">${chip("vSpace", "1", "Has space only", v.space)}</div>
      ${S.board !== "personal" ? `<div class="vlabel">Team size</div>
      <div class="chipset">${["any", "2", "3", "4+"].map((z) => chip("vSize", z, z === "any" ? "Any" : z, v.size === z)).join("")}</div>` : ""}
      ${n || v.sort !== "smart" ? `<button class="btn ghost small" data-act="vReset">Reset</button>` : ""}
    </div>`;
  }
  return panel;
}

function viewRanks(scores) {
  const rows = [...S.players.entries()]
    .map(([uid, p]) => ({ uid, name: p.name, score: scores.get(uid) || 0, prog: coreProgress(S.quests, uid, S.config) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const feed = S.quests.filter((q) => q.status === "done")
    .sort((a, b) => (b.completedAt?.seconds || 0) - (a.completedAt?.seconds || 0)).slice(0, 25);
  return `
    <h1>Leaderboard</h1>
    <button class="linkbtn" data-act="points">🏆 How points work</button>
    <h2>Players</h2>
    <div class="list">${rows.map((r, i) => `<div class="rank">
      <span class="n">${i + 1}</span>
      <span class="who">${esc(r.name)}${r.uid === S.uid ? " (you)" : ""}<small>${r.prog.done}/${r.prog.needed} core done</small></span>
      ${r.uid !== S.uid ? `<button class="iconbtn" data-act="dm" data-uid="${r.uid}" aria-label="Message ${esc(r.name)}">✉️</button>` : ""}
      <span class="pts">${r.score}</span></div>`).join("")}</div>
    <h2>Recently completed</h2>
    ${feed.length ? `<div class="list">${feed.map((q) => `<div class="feed">
      <b>${q.members.map((m) => esc(nameOf(m))).join(" & ")}</b> completed <b>${esc(q.title)}</b>
      ${q.note ? `<q>${esc(q.note)}</q>` : ""}</div>`).join("")}</div>` : `<div class="empty-state">Nothing completed yet. Be first.</div>`}`;
}

/* ---------- overlay (quest sheet + inbox) ---------- */
function renderOverlay() { preserve(renderOverlayNow); }
function renderOverlayNow() { keepScroll($overlay, renderOverlayInner); }
function renderOverlayInner() {
  if (!S.sheet || !S.me) { $overlay.innerHTML = ""; return; }
  if (S.sheet.kind === "chat") {
    const id = S.sheet.id;
    const isQuest = id.startsWith("q_");
    const q = isQuest ? qById(id.slice(2)) : null;
    const sub = id === GROUP_CHAT ? "Everyone" : isQuest ? (q ? q.members.map(nameOf).join(", ") : "") : "Private chat";
    $overlay.innerHTML = `<div class="scrim" data-act="close"></div>
      <div class="sheet chatsheet" role="dialog">
        <div class="chathead wrap"><div class="grow"><b>${esc(chatTitle(id))}</b><small>${esc(sub)} · ${HOST_NAME} can read this ⚠️</small></div>
          <button class="iconbtn" data-act="close" aria-label="Close">✕</button></div>
        <div class="msgs"><div class="wrap">${messagesHtml(S.msgs, S.uid, nameOf)}</div></div>
        <form class="composer wrap" data-act="sendMsg">
          <input class="field" id="chatInput" maxlength="500" autocomplete="off" placeholder="Message">
          <button class="btn primary small">Send</button>
        </form>
      </div>`;
    return;
  }
  if (S.sheet.kind === "bring") {
    // Rendered only on demand so typing isn't interrupted by live updates.
    if ($overlay.querySelector(".bringsheet") && !S.sheet.redraw) return;
    S.sheet.redraw = false;
  }
  let inner = "";
  if (S.sheet.kind === "bring") inner = bringSheet();
  else if (S.sheet.kind === "suggest") inner = suggestSheet();
  else if (S.sheet.kind === "quest") {
    const q = qById(S.sheet.id);
    if (!q) { S.sheet = null; $overlay.innerHTML = ""; return; }
    inner = questSheet(q);
  } else if (S.sheet.kind === "pickPlayer") {
    const others = [...S.players.entries()].filter(([u]) => u !== S.uid).sort((a, b) => a[1].name.localeCompare(b[1].name));
    inner = `<h3>Message someone</h3><div class="caution">⚠️ Chats can be read by ${HOST_NAME}. Be warned!</div>
      <div class="list">${others.map(([u, p]) => `<button class="hrow chatrow" data-act="dm" data-uid="${u}"><div class="grow"><b>${esc(p.name)}</b></div>✉️</button>`).join("") || `<div class="empty-state">Nobody else yet.</div>`}</div>`;
  } else if (S.sheet.kind === "menu") {
    const item = (act, label, sub = "") => `<button class="hrow chatrow" data-act="${act}"><div class="grow"><b>${label}</b>${sub ? `<small>${sub}</small>` : ""}</div>›</button>`;
    const req = S.myRequest?.items || [];
    const bringSub = !S.config?.requestDeadline ? "" : requestsOpen()
      ? (req.length ? `${req.length} item${req.length > 1 ? "s" : ""} · edit until ${esc(fmtTime(S.config.requestDeadline))}` : `Open until ${esc(fmtTime(S.config.requestDeadline))}`)
      : (req.length ? "Requests closed · view your list" : "Requests closed");
    inner = `<h3>Menu</h3><p class="sub">Logged in as <b>${esc(S.me.name)}</b></p>
      <div class="list">
        ${item("guide", "📖 How to play")}
        ${item("points", "🏆 How points work")}
        ${item("rules", "📜 House rules")}
        ${S.config?.requestDeadline ? item("bring", "🧃 My bring list", bringSub) : ""}
        ${item("logout", "↩ Log out", "Switch player on this phone")}
      </div>`;
  } else if (S.sheet.kind === "guide") {
    const i = S.sheet.step, [icon, title, text] = GUIDE[i], last = i === GUIDE.length - 1;
    inner = `<div class="guide"><div class="gicon">${icon}</div><h3>${title}</h3><p class="sub">${esc(text)}</p>
      <div class="dots">${GUIDE.map((_, j) => `<i class="${j === i ? "on" : ""}"></i>`).join("")}</div>
      <div class="row">${i ? `<button class="btn" data-act="guideStep" data-d="-1">Back</button>` : ""}
        <button class="btn primary" data-act="${last ? "guideDone" : "guideStep"}" data-d="1">${last ? "Let's go" : "Next"}</button></div></div>`;
  } else if (S.sheet.kind === "points") {
    const pts = { ...DEFAULT_POINTS, ...(S.config?.points || {}) };
    const row = (a, b) => `<div class="hrow"><div class="grow">${a}</div><b>${b}</b></div>`;
    inner = `<h3>How points work</h3>
      <div class="list">
        ${row("Complete an easy quest", `${pts.easy}`)}${row("Complete a medium quest", `${pts.medium}`)}${row("Complete a hard quest", `${pts.hard}`)}
        ${row("Pull off your secret twist", `+${pts.twistBonus}`)}
        ${row(`Complete a dare (first ${DARE_CAP} count)`, `+${pts.dare}`)}
        ${row("Someone completes your suggestion or dare", `+${pts.suggestBonus}`)}
        ${row(`${HOST_NAME} completes the sidequest you sent`, `+${pts.hostQuestReward}`)}
      </div>
      <p class="sub" style="font-size:14px">Everyone in a team gets the full points. Core and bonus quests score the same. It's all on trust, and ${HOST_NAME} can adjust points if needed.</p>`;
  } else if (S.sheet.kind === "rules") {
    inner = `<h3>House rules</h3><ul class="rules">${(S.config?.houseRules || []).map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`;
  } else if (S.sheet.kind === "inbox") {
    inner = `<h3>Give ${HOST_NAME} a sidequest</h3>
      <p class="sub">Anything fun and harmless. If ${HOST_NAME} completes it, you get ${S.config?.points?.hostQuestReward ?? 10} points.</p>
      <textarea class="field" id="inboxText" maxlength="500" placeholder="e.g. Start a conga line during the next song"></textarea>
      <label class="check"><input type="checkbox" id="anon"> Send anonymously (no points)</label>
      <button class="btn pink" data-act="sendInbox" ${S.busy ? "disabled" : ""}>Send it</button>`;
  }
  $overlay.innerHTML = `<div class="scrim" data-act="close"></div>
    <div class="sheet ${S.sheet.kind === "bring" ? "bringsheet" : ""}" role="dialog"><div class="grab"></div>
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
      twist = `<div class="box secret"><div class="label">🤫 Secret twist ${hint("twist")}</div>Unlocks once your team has ${q.min} people.</div>`;
    } else {
      const sec = loadSecret(q);
      const ticked = (q.twistDone || []).includes(S.uid);
      twist = `<div class="box secret"><div class="label">🤫 Secret twist · +${S.config?.points?.twistBonus ?? 10} pts ${hint("twist")}</div>
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
    action = `<div class="note">Waiting for ${q.min - q.members.length} more ${q.min - q.members.length > 1 ? "people" : "person"} to join. Hype it in the Everyone chat.</div>
      <button class="btn small" data-act="chat" data-id="${GROUP_CHAT}">📣 Open the Everyone chat</button>`;
  } else {
    action = `<textarea class="field" id="note" maxlength="280" placeholder="What happened? (optional, shows on the leaderboard)"></textarea>
      <button class="btn primary" data-act="complete" ${S.busy ? "disabled" : ""}>Mark as complete</button>`;
  }
  const chatBtn = mine && q.type === "group"
    ? `<button class="btn" data-act="chat" data-id="${questChatId(q.id)}">💬 Team chat${isUnread(questChatId(q.id), S.questChats.get(questChatId(q.id))) ? " · new" : ""}</button>` : "";
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
    <div class="box win"><div class="label">Done when ${hint("doneWhen")}</div>${esc(q.doneWhen)}</div>
    ${(q.tips || []).length ? `<div class="box tips"><div class="label">💡 Tips</div><ul>${q.tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>` : ""}
    ${twist}
    ${action}
    ${chatBtn}
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
  try { await fn(); }
  catch (e) {
    console.error(e);
    if (!S.me || !S.linked) S.regError = friendly(e); else toast(friendly(e));
  }
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
    const user = await ensureSession();
    if (!user.isAnonymous) { S.regError = "This phone is half signed in. Tap Start over below, then try again."; S.linked = true; return; }
    const nref = doc(db, "names", f.lower);
    if ((await withRetry(() => getDoc(nref))).exists()) { S.regError = `"${f.name}" is taken. If that's you, tap Log in.`; return; }
    const key = newKey();
    await withRetry(() => linkWithCredential(user, EmailAuthProvider.credential(emailFor(key), pwFor(f.pin))));
    S.linked = true;
    await withRetry(() => runTransaction(db, async (tx) => {
      if ((await tx.get(nref)).exists()) throw new Error(`"${f.name}" was just taken. Tap Start over and pick another name.`);
      tx.set(doc(db, "players", user.uid), { name: f.name, nameLower: f.lower, createdAt: serverTimestamp(), adjust: 0 });
      tx.set(nref, { uid: user.uid, key });
    }));
  });
}

async function login() {
  const f = readForm(); if (!f) return;
  await busy(async () => {
    await ensureSession();
    const ns = await withRetry(() => getDoc(doc(db, "names", f.lower)));
    if (!ns.exists()) { S.regError = `No player called "${f.name}". Check the spelling, or tap I'm new.`; return; }
    if (!ns.data().key) { S.regError = `${f.name} hasn't set a PIN yet. Open the app on your original phone first, or ask ${HOST_NAME}.`; return; }
    try { await withRetry(() => signInWithEmailAndPassword(auth, emailFor(ns.data().key), pwFor(f.pin))); }
    catch (e) { S.regError = friendly(e); }
  });
}

async function setPin() {
  const f = readForm(); if (!f) return;
  await busy(async () => {
    const key = newKey();
    await withRetry(() => linkWithCredential(auth.currentUser, EmailAuthProvider.credential(emailFor(key), pwFor(f.pin))));
    await withRetry(() => updateDoc(doc(db, "names", S.me.nameLower), { key }));
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
    toast(`Sent to ${HOST_NAME} 📨`);
  });
}

/* ---------- bring list ---------- */
// Shown on My quests only until the player has had a first go (saved a list or said no thanks).
// After that it lives in the ☰ Menu.
function bringCard() {
  if (!S.config?.requestDeadline || !requestsOpen() || S.myRequest !== null) return "";
  return `<div class="card">
    <div class="title">🧃 Need anything brought?</div>
    <div class="blurb">${HOST_NAME} can bring water, gum, slippers, painkillers, drinks and more. Ask before ${esc(fmtTime(S.config.requestDeadline))}.</div>
    <div class="row" style="margin-top:12px"><button class="btn primary small" data-act="bring">Make a request</button><button class="btn small" data-act="bringNo">No thanks</button></div>
  </div>`;
}
function openBring() {
  S.sheet = { kind: "bring", items: JSON.parse(JSON.stringify(S.myRequest?.items || [])), redraw: true };
  renderOverlay();
}
function bringSheet() {
  const open = requestsOpen();
  const items = S.sheet.items;
  if (!open) {
    return `<h3>Your bring list</h3><p class="sub">Requests are closed. Here's what you asked for:</p>
      ${items.length ? `<div class="list">${items.map((i) => `<div class="shop"><div class="grow"><b>${i.qty}× ${esc(i.item)}</b>${i.note ? `<small>${esc(i.note)}</small>` : ""}</div></div>`).join("")}</div>` : `<div class="empty-state">Nothing requested.</div>`}`;
  }
  return `<h3>What should ${HOST_NAME} bring for you?</h3>
    <p class="sub">Open until ${esc(fmtTime(S.config.requestDeadline))}. Only you and ${HOST_NAME} see this.</p>
    <div class="quick">
      ${PRESETS.map(([icon, name]) => `<button data-act="reqAdd" data-item="${name}">${icon} ${name}</button>`).join("")}
      <button data-act="reqAdd" data-kind="drink">🥤 A drink</button>
      <button data-act="reqAdd" data-kind="other">＋ Something else</button>
    </div>
    ${items.length ? items.map((it, i) => `<div class="reqrow">
      <div class="top">
        <input class="field" id="req-item-${i}" data-req="${i}" data-f="item" maxlength="40" value="${esc(it.item)}"
          placeholder="${it.kind === "drink" ? "Which drink? e.g. Coke" : "What do you need?"}">
        <div class="stepper"><button data-act="reqQty" data-i="${i}" data-d="-1">−</button><span>${it.qty}</span><button data-act="reqQty" data-i="${i}" data-d="1">+</button></div>
        <button class="iconbtn" data-act="reqDel" data-i="${i}" aria-label="Remove">✕</button>
      </div>
      <input class="field note-in" id="req-note-${i}" data-req="${i}" data-f="note" maxlength="80" value="${esc(it.note || "")}" placeholder="Note (optional), e.g. size 43">
    </div>`).join("") : `<div class="empty-state">Tap an item above to add it.</div>`}
    <button class="btn primary" data-act="reqSave" ${S.busy ? "disabled" : ""}>Save my list</button>`;
}
function bringRedraw() { S.sheet.redraw = true; renderOverlay(); }
async function saveBring() {
  const items = S.sheet.items
    .map((i) => ({ item: i.item.trim().slice(0, 40), qty: Math.min(20, Math.max(1, i.qty | 0)), note: (i.note || "").trim().slice(0, 80), kind: i.kind || "item" }))
    .filter((i) => i.item);
  await busy(async () => {
    await setDoc(doc(db, "requests", S.uid), { items, updatedAt: serverTimestamp() });
    S.sheet = null;
    toast(items.length ? "List saved 🧃" : "List cleared");
  });
}

/* ---------- suggestions + dares ---------- */
function openDaresForMe() { return S.dares.filter((d) => d.to === S.uid && d.status === "open"); }
function dareTextOf(id) {
  if (!(id in S.dareText)) {
    S.dareText[id] = null;
    getDoc(doc(db, "dareText", id)).then((s) => { S.dareText[id] = s.exists() ? s.data() : { title: "(hidden)", details: "" }; render(); }).catch(() => {});
  }
  return S.dareText[id];
}
function daresSection() {
  const forMe = S.dares.filter((d) => d.to === S.uid);
  const sent = S.dares.filter((d) => d.from === S.uid);
  if (!forMe.length && !sent.length) return "";
  const pts = S.config?.points?.dare ?? 10;
  const card = (d) => {
    const t = dareTextOf(d.id);
    return `<div class="card dare ${d.status !== "open" ? "closed" : ""}">
      <div class="from">🎲 Dare from ${esc(nameOf(d.from))} · ${pts} pts</div>
      <div class="title">${esc(t?.title || "Loading…")}</div>
      ${t?.details ? `<div class="blurb">${esc(t.details)}</div>` : ""}
      ${d.status === "open" ? `<div class="row" style="margin-top:12px">
        <button class="btn primary small" data-act="dareDone" data-id="${d.id}">✓ Done</button>
        <button class="btn small" data-act="dareSkip" data-id="${d.id}">Skip</button></div>`
        : `<div class="foot"><span class="state ${d.status === "done" ? "done" : ""}">${d.status === "done" ? "Completed" : "Skipped"}</span>
           <button class="btn ghost small" data-act="dareReopen" data-id="${d.id}">Undo</button></div>`}
    </div>`;
  };
  return `${forMe.length ? `<h2>Dares for you</h2><p class="sub" style="margin:-4px 0 10px;font-size:13px">Skipping is always fine. No penalty. ${hint("dares")}</p>${forMe.map(card).join("")}` : ""}
    ${sent.length ? `<h2>Dares you sent</h2><div class="list">${sent.map((d) => `<div class="hrow"><div class="grow"><b>${esc(dareTextOf(d.id)?.title || "…")}</b><small>to ${esc(nameOf(d.to))} · ${d.status}</small></div></div>`).join("")}</div>` : ""}`;
}
async function setDare(id, status) {
  try { await updateDoc(doc(db, "dares", id), { status, completedAt: status === "done" ? serverTimestamp() : null }); }
  catch (e) { toast(friendly(e)); }
}

function suggestSheet() {
  const t = S.sheet.target || "anyone";
  const seg = (id, label) => `<button type="button" class="${t === id ? "on" : ""}" data-act="sgTarget" data-id="${id}">${label}</button>`;
  const others = [...S.players.entries()].filter(([u]) => u !== S.uid).sort((a, b) => a[1].name.localeCompare(b[1].name));
  const pts = { ...{ easy: 10, dare: 10, suggestBonus: 5, hostQuestReward: 10 }, ...(S.config?.points || {}) };
  const sizes = t === "team" ? [2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6];
  const hint = {
    anyone: `Goes on the bonus board for anyone to take. They get ${pts.easy} pts, you get +${pts.suggestBonus} when it's done.`,
    team: `Goes on the bonus board with you already in. Others join to fill it.`,
    player: `Only they (and ${HOST_NAME}) see it. They get ${pts.dare} pts if they do it, you get +${pts.suggestBonus} (first ${DARE_CAP} dares per person count). They can skip it.`,
    admin: `For ${HOST_NAME}. If ${HOST_NAME} does it, you get ${pts.hostQuestReward} pts.`,
  }[t];
  return `<h3>Suggest a sidequest</h3>
    <div class="seg four">${seg("anyone", "Anyone")}${seg("team", "Me + others")}${seg("player", "A player")}${seg("admin", HOST_NAME)}</div>
    <p class="sub" style="font-size:14px">${hint}</p>
    ${t === "player" ? `<select class="field" id="sgTo"><option value="">Who's it for?</option>${others.map(([u, p]) => `<option value="${u}">${esc(p.name)}</option>`).join("")}</select>` : ""}
    <input class="field" id="sgTitle" maxlength="40" placeholder="Quest name, e.g. Human Beatbox">
    <textarea class="field" id="sgDetails" maxlength="300" placeholder="What do they have to do? What counts as done?"></textarea>
    ${t === "anyone" || t === "team" ? `<select class="field" id="sgSize">${sizes.map((n) => `<option value="${n}">${n === 1 ? "Solo (1 player)" : `${n} players`}</option>`).join("")}</select>` : ""}
    ${t === "admin" ? `<label class="check"><input type="checkbox" id="anon"> Send anonymously (no points)</label>` : ""}
    ${t !== "admin" ? `<div class="caution">⚠️ This goes live straight away. Keep it kind, safe and consensual: no pressuring strangers, no touching without a yes.</div>` : ""}
    <button class="btn pink" data-act="sgSend" ${S.busy ? "disabled" : ""}>${t === "admin" ? `Send to ${HOST_NAME}` : "Publish it"}</button>`;
}

async function sendSuggestion() {
  const t = S.sheet.target || "anyone";
  const title = document.getElementById("sgTitle").value.trim();
  const details = document.getElementById("sgDetails").value.trim();
  if (title.length < 2) return toast("Give it a name.");
  await busy(async () => {
    if (t === "admin") {
      const anon = document.getElementById("anon").checked;
      await addDoc(collection(db, "inbox"), {
        fromUid: anon ? null : S.uid, fromName: anon ? null : S.me.name,
        text: (details ? `${title}: ${details}` : title).slice(0, 500), createdAt: serverTimestamp(), status: "new",
      });
      toast(`Sent to ${HOST_NAME} 📨`);
    } else if (t === "player") {
      const to = document.getElementById("sgTo").value;
      if (!to) throw new Error("Pick who it's for.");
      const id = "d" + newKey();
      const b = writeBatch(db);
      b.set(doc(db, "dareText", id), { title, details });
      b.set(doc(db, "dares", id), { from: S.uid, to, status: "open", createdAt: serverTimestamp(), completedAt: null });
      await b.commit();
      toast(`Dare sent to ${nameOf(to)} 🎲`);
    } else {
      const n = Number(document.getElementById("sgSize").value) || 1;
      await setDoc(doc(db, "quests", "s-" + newKey()), {
        title, blurb: details, type: n === 1 ? "personal" : "group", pool: "bonus", level: "easy", category: "suggested",
        min: n, max: n, instructions: [], doneWhen: "You all agree it happened. Be honest!",
        twistCount: 0, needsHostSetup: false, order: 10000 + S.quests.length, active: true,
        members: t === "team" ? [S.uid] : [], twistDone: [], status: "open", note: "", completedBy: null, completedAt: null,
        suggestedBy: S.uid,
      });
      toast("Published to the bonus board 💡");
    }
    S.sheet = null;
  });
}

/* ---------- usage stats (host-only) ---------- */
// One "session" doc per visit: who, which device, how long the app was on screen, which quests were opened.
// A new visit starts on page load, on a new login, or after 30+ minutes away.
const A = { id: null, uid: null, beatAt: 0, hiddenAt: 0 };
function deviceId() {
  try {
    let d = localStorage.getItem("gtsq:device");
    if (!d) { d = newKey(); localStorage.setItem("gtsq:device", d); }
    return d;
  } catch { return "unknown"; }
}
function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Other";
  const app = /WhatsApp/.test(ua) ? "WhatsApp" : /Instagram/.test(ua) ? "Instagram" : /FBAN|FBAV/.test(ua) ? "Facebook" : /CriOS|Chrome/.test(ua) ? "Chrome" : /FxiOS|Firefox/.test(ua) ? "Firefox" : /Safari/.test(ua) ? "Safari" : "Browser";
  return `${os} · ${app}`;
}
function startSession() {
  if (!S.uid) return;
  A.id = "s" + newKey(); A.uid = S.uid; A.beatAt = Date.now();
  setDoc(doc(db, "sessions", A.id), {
    uid: S.uid, device: deviceId(), deviceLabel: deviceLabel(),
    startedAt: serverTimestamp(), lastSeenAt: serverTimestamp(), activeSec: 0, questOpens: {}, views: {},
  }).catch(() => {});
}
function beat() {
  if (!A.id || A.uid !== S.uid) return;
  const secs = Math.min(90, Math.round((Date.now() - A.beatAt) / 1000));
  A.beatAt = Date.now();
  if (secs > 0) updateDoc(doc(db, "sessions", A.id), { lastSeenAt: serverTimestamp(), activeSec: increment(secs) }).catch(() => {});
}
function track(field, key) {
  if (!A.id || A.uid !== S.uid || !key) return;
  updateDoc(doc(db, "sessions", A.id), { [`${field}.${key}`]: increment(1), lastSeenAt: serverTimestamp() }).catch(() => {});
}
setInterval(() => { if (document.visibilityState === "visible") beat(); }, 60000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { beat(); A.hiddenAt = Date.now(); }
  else {
    if (A.hiddenAt && Date.now() - A.hiddenAt > 30 * 60000) startSession();
    A.beatAt = Date.now();
  }
});

function markGuided() { try { localStorage.setItem(`gtsq:guided:${S.uid}`, "1"); } catch {} }

/* ---------- events ---------- */
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const act = t.dataset.act;
  const qid = S.sheet?.id;
  if (act === "tab") { if (S.sheet?.kind === "chat") closeChat(); S.tab = t.dataset.id; track("views", t.dataset.id); S.sheet = null; render(); window.scrollTo(0, 0); }
  else if (act === "board") { S.board = t.dataset.id; render(); }
  else if (act === "vToggle") { S.viewOpen = !S.viewOpen; render(); }
  else if (act === "vSort") { S.view.sort = t.dataset.v; render(); }
  else if (act === "vLevel") { const l = t.dataset.v; S.view.levels = S.view.levels.includes(l) ? S.view.levels.filter((x) => x !== l) : [...S.view.levels, l]; render(); }
  else if (act === "vSpace") { S.view.space = !S.view.space; render(); }
  else if (act === "vSize") { S.view.size = t.dataset.v; render(); }
  else if (act === "vReset") { S.view = { ...DEFAULT_VIEW }; render(); }
  else if (act === "open") { S.sheet = { kind: "quest", id: t.dataset.id }; track("questOpens", t.dataset.id); renderOverlay(); }
  else if (act === "close") {
    if (S.sheet?.kind === "guide") markGuided();
    if (S.sheet?.kind === "chat") { closeChat(); S.sheet = null; render(); } else { S.sheet = null; renderOverlay(); }
  }
  else if (act === "menu") { S.sheet = { kind: "menu" }; renderOverlay(); }
  else if (act === "guide") { S.sheet = { kind: "guide", step: 0 }; renderOverlay(); }
  else if (act === "guideStep") { S.sheet.step = Math.max(0, Math.min(GUIDE.length - 1, S.sheet.step + Number(t.dataset.d))); renderOverlay(); }
  else if (act === "guideDone") { markGuided(); S.sheet = null; render(); }
  else if (act === "points") { S.sheet = { kind: "points" }; renderOverlay(); }
  else if (act === "hint") { e.stopPropagation(); toast(HINTS[t.dataset.k] || "", 6000); }
  else if (act === "goBonus") { S.tab = "board"; S.board = "bonus"; S.sheet = null; render(); window.scrollTo(0, 0); }
  else if (act === "bringNo") setDoc(doc(db, "requests", S.uid), { items: [], updatedAt: serverTimestamp() }).then(() => toast("No problem. You can still ask from ☰ Menu.")).catch((er) => toast(friendly(er)));
  else if (act === "inbox") { S.sheet = { kind: "inbox" }; renderOverlay(); }
  else if (act === "rules") { S.sheet = { kind: "rules" }; renderOverlay(); }
  else if (act === "suggest") { S.sheet = { kind: "suggest", target: "anyone" }; renderOverlay(); }
  else if (act === "sgTarget") { S.sheet.target = t.dataset.id; renderOverlay(); }
  else if (act === "sgSend") sendSuggestion();
  else if (act === "dareDone") setDare(t.dataset.id, "done");
  else if (act === "dareSkip") setDare(t.dataset.id, "skipped");
  else if (act === "dareReopen") setDare(t.dataset.id, "open");
  else if (act === "bring") openBring();
  else if (act === "reqAdd") {
    const items = S.sheet.items;
    const name = t.dataset.item;
    const existing = name && items.find((i) => i.item.toLowerCase() === name.toLowerCase());
    if (existing) existing.qty = Math.min(20, existing.qty + 1);
    else items.push({ item: name || "", qty: 1, note: "", kind: t.dataset.kind || "item" });
    bringRedraw();
    if (!name) setTimeout(() => document.getElementById(`req-item-${items.length - 1}`)?.focus(), 30);
  }
  else if (act === "reqQty") { const it = S.sheet.items[t.dataset.i]; it.qty = Math.min(20, Math.max(1, it.qty + Number(t.dataset.d))); bringRedraw(); }
  else if (act === "reqDel") { S.sheet.items.splice(Number(t.dataset.i), 1); bringRedraw(); }
  else if (act === "reqSave") saveBring();
  else if (act === "chat") openChat(t.dataset.id);
  else if (act === "dm") openChat(dmChatId(S.uid, t.dataset.uid));
  else if (act === "pickPlayer") { S.sheet = { kind: "pickPlayer" }; renderOverlay(); }
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
document.addEventListener("input", (e) => {
  const i = e.target.dataset.req;
  if (i !== undefined && S.sheet?.kind === "bring") S.sheet.items[i][e.target.dataset.f] = e.target.value;
});
document.addEventListener("change", (e) => {
  if (e.target.dataset.act === "twist") toggleTwist(S.sheet.id, e.target.checked);
});
document.addEventListener("submit", (e) => {
  const act = e.target.dataset.act;
  if (["register", "login", "setPin", "sendMsg"].includes(act)) e.preventDefault();
  if (act === "sendMsg") sendMsg();
  if (act === "register") register();
  if (act === "login") login();
  if (act === "setPin") setPin();
});
