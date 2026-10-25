import {
  makeApp, HOST_EMAIL, onAuthStateChanged, signInWithPopup, signInWithRedirect, signInWithCredential, signOut, GoogleAuthProvider,
  doc, collection, onSnapshot, getDoc, getDocs, writeBatch, updateDoc, setDoc, deleteDoc, increment, serverTimestamp,
  query, orderBy, limitToLast,
} from "./firebase.js";
import { ms, messagesHtml, keepScroll, GROUP_CHAT } from "./chat.js";
import { esc, sizeLabel, questState, slotText, myQuests, coreProgress, computeScores, slotMath } from "./game.js";

const { auth, db } = makeApp("host", { offline: false });

const S = {
  user: undefined, config: null, quests: [], players: new Map(), claims: [], inbox: [],
  tab: "overview", qfilter: "group", sheet: null, busy: false, listening: false,
  chats: [], msgs: [], requests: [], dares: [], dareText: {}, shopping: {}, defaulted: false,
};
// Default bring-list deadline: Thursday 29 October 2026, 11:59pm Lagos time.
const DEFAULT_DEADLINE = new Date("2026-10-29T23:59:00+01:00");
const $root = document.getElementById("root");
const $overlay = document.getElementById("overlay");
const $toast = document.getElementById("toast");
const nameOf = (uid) => (uid === "admin" ? "Admin" : S.players.get(uid)?.name || "(unknown)");
const qById = (id) => S.quests.find((q) => q.id === id);
let tt;
const toast = (m) => { $toast.innerHTML = `<div class="toast">${esc(m)}</div>`; clearTimeout(tt); tt = setTimeout(() => ($toast.innerHTML = ""), 3000); };
const isHost = (u) => u && u.email === HOST_EMAIL;
const playerLink = () => new URL("./", location.href).href;

/* ---------- auth ---------- */
onAuthStateChanged(auth, (u) => {
  S.user = u;
  if (isHost(u) && !S.listening) listen();
  render();
});

async function login() {
  const provider = new GoogleAuthProvider();
  try { await signInWithPopup(auth, provider); }
  catch (e) {
    if (String(e.code).includes("popup")) await signInWithRedirect(auth, provider);
    else toast(e.message);
  }
}
// Test hook: only works against the local emulator.
if (new URLSearchParams(location.search).has("emu")) {
  window.__hostTestLogin = () => signInWithCredential(auth, GoogleAuthProvider.credential(
    JSON.stringify({ sub: "host-test", email: HOST_EMAIL, email_verified: true })));
}

function listen() {
  S.listening = true;
  onSnapshot(doc(db, "config", "game"), (s) => {
    S.config = s.exists() ? s.data() : null;
    if (S.config && !S.config.requestDeadline && !S.defaulted) {
      S.defaulted = true;
      setDoc(doc(db, "config", "game"), { requestDeadline: DEFAULT_DEADLINE }, { merge: true });
    }
    render();
  });
  onSnapshot(doc(db, "config", "shopping"), (s) => { S.shopping = s.exists() ? s.data().checked || {} : {}; render(); });
  onSnapshot(collection(db, "requests"), (snap) => { S.requests = snap.docs.map((d) => ({ uid: d.id, ...d.data() })); render(); });
  onSnapshot(collection(db, "dares"), (snap) => { S.dares = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => ms(b.createdAt) - ms(a.createdAt)); render(); });
  onSnapshot(collection(db, "dareText"), (snap) => { S.dareText = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()])); render(); });
  onSnapshot(collection(db, "quests"), (snap) => {
    S.quests = snap.docs.map((d) => ({ id: d.id, members: [], twistDone: [], ...d.data() })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    render();
  });
  onSnapshot(collection(db, "players"), (snap) => { S.players = new Map(snap.docs.map((d) => [d.id, d.data()])); render(); });
  onSnapshot(collection(db, "claims"), (snap) => { S.claims = snap.docs.map((d) => ({ id: d.id, ...d.data() })); render(); });
  onSnapshot(collection(db, "chats"), (snap) => {
    S.chats = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => ms(b.lastAt) - ms(a.lastAt));
    render();
  });
  onSnapshot(collection(db, "inbox"), (snap) => {
    S.inbox = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    render();
  });
}

/* ---------- render ---------- */
function render() {
  if (S.user === undefined) return;
  if (!S.user) {
    $root.innerHTML = `<div class="wrap center"><div>
      <h1>Host dashboard</h1><p class="sub">Sign in with the host Google account.</p>
      <button class="btn primary" style="margin-top:20px" data-act="login">Sign in with Google</button></div></div>`;
    return;
  }
  if (!isHost(S.user)) {
    $root.innerHTML = `<div class="wrap center"><div>
      <h1>Not the host</h1><p class="sub">${esc(S.user.email || "This account")} can't manage the game.</p>
      <button class="btn" style="margin-top:20px" data-act="logout">Sign out</button></div></div>`;
    return;
  }
  const newInbox = S.inbox.filter((i) => i.status === "new").length;
  const t = (id, label) => `<button class="${S.tab === id ? "on" : ""}" data-act="tab" data-id="${id}">${label}</button>`;
  let body = "";
  if (!S.config && !S.quests.length) body = viewSetup();
  else if (S.tab === "overview") body = viewOverview();
  else if (S.tab === "quests") body = viewQuests();
  else if (S.tab === "players") body = viewPlayers();
  else if (S.tab === "inbox") body = viewInbox();
  else if (S.tab === "chats") body = viewChats();
  else if (S.tab === "bring") body = viewBring();
  // Keep the edit form's typed values when live data re-renders.
  const keep = {};
  $overlay.querySelectorAll("[name]").forEach((el) => (keep[el.name] = el.value));
  const drafts = {};
  for (const id of ["rulesText", "deadline", "hostMsg"]) {
    const el = document.getElementById(id);
    if (el && (el.dataset.dirty || id === "hostMsg")) drafts[id] = { v: el.value, f: document.activeElement === el };
  }
  $root.innerHTML = `
    <header class="topbar"><div class="wrap">
      <div class="logo">GT <span>HOST</span></div>
      <button class="btn small ghost" data-act="logout">Sign out</button>
    </div></header>
    <main><div class="wrap">
      <div class="seg">${t("overview", "Overview")}${t("quests", "Quests")}${t("players", `Players (${S.players.size})`)}${t("chats", "Chats")}${t("bring", "Bring list")}${t("inbox", `Inbox${newInbox ? ` (${newInbox})` : ""}`)}</div>
      ${body}
    </div></main>`;
  renderOverlay();
  $overlay.querySelectorAll("[name]").forEach((el) => { if (el.name in keep) el.value = keep[el.name]; });
  for (const [id, d] of Object.entries(drafts)) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.value = d.v; if (id !== "hostMsg") el.dataset.dirty = "1";
    if (d.f) el.focus();
  }
}

function viewSetup() {
  return `<div class="card"><div class="title">Welcome! Let's load the quests.</div>
    <p class="blurb">Pick your <b>quests.json</b> file. This creates the quest board, house rules and points settings. Keep that file private, not on GitHub.</p>
    <button class="btn primary" style="margin-top:14px" data-act="import">Import quests.json</button></div>`;
}

function viewOverview() {
  const m = slotMath(S.quests, S.players.size, S.config);
  const gOk = m.groupMin <= m.groupNeeded && m.groupNeeded <= m.groupMax;
  const sOk = m.personal >= m.personalNeeded;
  const setup = S.quests.filter((q) => q.needsHostSetup);
  const fullyPicked = [...S.players.keys()].filter((u) => coreProgress(S.quests, u, S.config).picked >= coreProgress(S.quests, u, S.config).needed).length;
  const stranded = S.quests.filter((q) => q.active && q.type === "group" && q.members.length > 0 && q.members.length < q.min);
  const sw = (key, on, label, hint) => `<div class="hrow"><div class="grow">${label}<small>${hint}</small></div>
    <label class="switch"><input type="checkbox" data-act="cfg" data-key="${key}" ${on ? "checked" : ""}><span></span></label></div>`;
  return `
    <h2>Share with players</h2>
    <div class="linkbox"><input class="field" readonly value="${esc(playerLink())}" id="plink"><button class="btn small primary" data-act="copy">Copy</button></div>
    <p class="sub" style="font-size:13px">One link for everyone. Each person picks a name on first open.</p>

    <h2>Game switches</h2>
    <div class="list">
      ${sw("pickingOpen", S.config?.pickingOpen, "Picking open", "Players can join and leave core quests. Lock it when the rave starts.")}
      ${sw("noRepeatTeammates", S.config?.picking?.noRepeatTeammates !== false, "No repeat teammates", "A player's two group quests can't share a teammate.")}
    </div>

    <h2>Balance for ${S.players.size} player${S.players.size === 1 ? "" : "s"}</h2>
    <div class="stats">
      <div class="stat"><div class="big ${gOk ? "ok" : "warn"}">${m.groupMin}–${m.groupMax}</div><small>group slots active · need ${m.groupNeeded}</small></div>
      <div class="stat"><div class="big ${sOk ? "ok" : "warn"}">${m.personal}</div><small>solo quests active · need ${m.personalNeeded}</small></div>
      <div class="stat"><div class="big">${fullyPicked}/${S.players.size}</div><small>players with all picks</small></div>
      <div class="stat"><div class="big ${stranded.length ? "warn" : "ok"}">${stranded.length}</div><small>group quests short of people</small></div>
    </div>
    ${!gOk ? `<div class="note">${m.groupNeeded < m.groupMin ? "Too many group slots: some quests won't fill. Switch off a quest or two in the Quests tab." : "Not enough group slots: switch on more group quests (bonus ones can be moved to core in Edit)."}</div>` : ""}
    ${stranded.length ? `<div class="note">Short of people: ${stranded.map((q) => `${esc(q.title)} (${q.members.length}/${q.min})`).join(", ")}</div>` : ""}

    ${setup.length ? `<h2>Needs your input</h2>${setup.map((q) => `<div class="hrow card"><div class="grow">${esc(q.title)}<small>Fill in the [HOST] placeholders in its twists.</small></div><button class="btn small" data-act="edit" data-id="${q.id}">Edit</button></div>`).join("")}` : ""}

    ${S.claims.length ? `<h2>New-phone requests</h2><div class="list">${S.claims.map((c) => `<div class="hrow"><div class="grow"><b>${esc(c.name)}</b><small>says they're on a new phone</small></div>
      <button class="btn small primary" data-act="approve" data-id="${c.id}">Approve</button><button class="btn small danger" data-act="deny" data-id="${c.id}">Deny</button></div>`).join("")}</div>` : ""}

    <h2>House rules</h2>
    <textarea class="field" id="rulesText" style="min-height:200px">${esc((S.config?.houseRules || []).join("\n"))}</textarea>
    <p class="sub" style="font-size:13px;margin-bottom:8px">One rule per line. Players see these on their welcome screen.</p>
    <button class="btn primary" data-act="saveRules">Save house rules</button>

    <h2>Data</h2>
    <div class="row"><button class="btn" data-act="import">Re-import quests.json</button></div>
    <div class="row" style="margin-top:8px"><button class="btn danger" data-act="resetProgress">Reset all progress</button><button class="btn danger" data-act="resetAll">Remove all players</button></div>
    <p class="sub" style="font-size:13px">Use the reset buttons after testing, before you share the link.</p>`;
}

function viewQuests() {
  const f = S.qfilter;
  const seg = (id, l) => `<button class="${f === id ? "on" : ""}" data-act="qfilter" data-id="${id}">${l}</button>`;
  let list = S.quests;
  if (f === "group") list = list.filter((q) => q.pool === "core" && q.type === "group");
  if (f === "personal") list = list.filter((q) => q.pool === "core" && q.type === "personal");
  if (f === "bonus") list = list.filter((q) => q.pool === "bonus");
  const options = [...S.players.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  return `
    <div class="seg">${seg("group", "Core group")}${seg("personal", "Core solo")}${seg("bonus", "Bonus")}</div>
    <button class="btn small" data-act="newQuest" style="margin-bottom:12px">＋ New quest</button>
    ${list.map((q) => {
      const st = questState(q);
      const addable = options.filter(([u]) => !q.members.includes(u));
      return `<div class="card ${q.active ? "" : "done"}">
        <div class="hrow" style="padding:0">
          <label class="switch" title="Active"><input type="checkbox" data-act="active" data-id="${q.id}" ${q.active ? "checked" : ""}><span></span></label>
          <div class="grow"><b>${esc(q.title)}</b><small>${q.level} · ${q.type === "personal" ? "solo" : sizeLabel(q) + " players"} · <span class="state ${st}">${esc(slotText(q))}</span>${q.needsHostSetup ? " · ⚠️ needs setup" : ""}</small></div>
          <button class="btn small" data-act="edit" data-id="${q.id}">Edit</button>
          <button class="btn small ${st === "done" ? "" : "primary"}" data-act="${st === "done" ? "reopen" : "markDone"}" data-id="${q.id}" ${q.members.length ? "" : "disabled"}>${st === "done" ? "Reopen" : "Done"}</button>
        </div>
        <div class="chips" style="margin-top:10px">
          ${q.members.map((u) => `<span class="chip">${esc(nameOf(u))}${(q.twistDone || []).includes(u) ? " ⭐" : ""}<button data-act="kick" data-id="${q.id}" data-uid="${u}" aria-label="Remove">×</button></span>`).join("")}
          ${q.members.length < q.max && addable.length ? `<select class="chip" data-act="addPlayer" data-id="${q.id}"><option value="">＋ add player</option>${addable.map(([u, p]) => `<option value="${u}">${esc(p.name)}</option>`).join("")}</select>` : ""}
        </div>
        ${q.note ? `<div class="note">“${esc(q.note)}”</div>` : ""}
      </div>`;
    }).join("") || `<div class="empty-state">No quests here.</div>`}`;
}

function viewPlayers() {
  const scores = computeScores(S.quests, S.players, S.config, S.dares);
  const rows = [...S.players.entries()].sort((a, b) => (scores.get(b[0]) || 0) - (scores.get(a[0]) || 0));
  if (!rows.length) return `<div class="empty-state">No players yet. Share the link from the Overview tab.</div>`;
  return `<div class="list">${rows.map(([uid, p]) => {
    const m = myQuests(S.quests, uid);
    const pr = coreProgress(S.quests, uid, S.config);
    return `<div class="hrow"><div class="grow"><b>${esc(p.name)}</b>
      <small>Picks: ${m.coreGroup.length} group, ${m.corePersonal.length} solo, ${m.bonus.length} bonus · ${pr.done}/${pr.needed} core done${p.adjust ? ` · adjust ${p.adjust > 0 ? "+" : ""}${p.adjust}` : ""}</small>
      <small>${m.all.map((q) => esc(q.title)).join(", ") || "No quests yet"}</small></div>
      <span class="pill">${scores.get(uid) || 0} pts</span>
      <button class="btn small" data-act="adj" data-uid="${uid}" data-n="-10">−10</button>
      <button class="btn small" data-act="adj" data-uid="${uid}" data-n="10">+10</button>
      <button class="btn small danger" data-act="removePlayer" data-uid="${uid}">Remove</button></div>`;
  }).join("")}</div>`;
}

function viewInbox() {
  const reward = S.config?.points?.hostQuestReward ?? 10;
  const made = S.quests.filter((q) => q.suggestedBy);
  const extra = `
    <h2>Player-made quests (${made.length})</h2>
    ${made.length ? `<div class="list">${made.map((q) => `<div class="hrow"><div class="grow"><b>${esc(q.title)}</b>
      <small>by ${esc(nameOf(q.suggestedBy))} · ${q.type === "personal" ? "solo" : q.max + " players"} · ${esc(slotText(q))}</small>${q.blurb ? `<small>${esc(q.blurb)}</small>` : ""}</div>
      <button class="btn small" data-act="edit" data-id="${q.id}">Edit</button><button class="btn small danger" data-act="delSuggested" data-id="${q.id}">Remove</button></div>`).join("")}</div>`
      : `<div class="empty-state">None yet.</div>`}
    <h2>Dares between players (${S.dares.length})</h2>
    ${S.dares.length ? `<div class="list">${S.dares.map((d) => `<div class="hrow"><div class="grow"><b>${esc(S.dareText[d.id]?.title || "…")}</b>
      <small>${esc(nameOf(d.from))} → ${esc(nameOf(d.to))} · ${d.status}</small>${S.dareText[d.id]?.details ? `<small>${esc(S.dareText[d.id].details)}</small>` : ""}</div>
      <button class="btn small danger" data-act="delDare" data-id="${d.id}">Remove</button></div>`).join("")}</div>`
      : `<div class="empty-state">None yet.</div>`}`;
  if (!S.inbox.length) return `<h2>Sidequests for you</h2><div class="empty-state">None yet.</div>${extra}`;
  return `<h2>Sidequests for you</h2>` + S.inbox.map((i) => `<div class="card ${i.status !== "new" ? "done" : ""}">
    <div class="meta"><span class="badge">${i.fromName ? esc(i.fromName) : "Anonymous"}</span>${i.status !== "new" ? `<span class="badge">${i.status}</span>` : ""}</div>
    <div class="title">${esc(i.text)}</div>
    ${i.status === "new" ? `<div class="row" style="margin-top:10px">
      <button class="btn small primary" data-act="inboxDone" data-id="${i.id}">I did it${i.fromUid ? ` (+${reward} to ${esc(i.fromName)})` : ""}</button>
      <button class="btn small" data-act="inboxDismiss" data-id="${i.id}">Dismiss</button></div>` : ""}
  </div>`).join("") + extra;
}

async function hostSend() {
  const el = document.getElementById("hostMsg");
  const text = el.value.trim().slice(0, 500);
  if (!text) return;
  el.value = "";
  const b = writeBatch(db);
  b.set(doc(collection(db, "chats", GROUP_CHAT, "messages")), { from: "admin", text, at: serverTimestamp() });
  b.set(doc(db, "chats", GROUP_CHAT), { lastAt: serverTimestamp(), lastFrom: "admin", lastText: text.slice(0, 80) });
  await b.commit();
}

/* ---------- bring list ---------- */
const toLocalInput = (d) => { const z = new Date(d - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 16); };
function viewBring() {
  const dl = S.config?.requestDeadline ? new Date(ms(S.config.requestDeadline)) : DEFAULT_DEADLINE;
  const open = Date.now() < dl.getTime();
  const groups = new Map();
  for (const r of S.requests) for (const it of r.items || []) {
    const key = (it.kind === "drink" ? "drink:" : "") + it.item.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, { key, label: (it.kind === "drink" ? "🥤 " : "") + it.item.trim(), total: 0, people: [] });
    const g = groups.get(key);
    g.total += it.qty; g.people.push(`${nameOf(r.uid)} ${it.qty}${it.note ? ` (${it.note})` : ""}`);
  }
  const list = [...groups.values()].sort((a, b) => b.total - a.total);
  const people = S.requests.filter((r) => (r.items || []).length);
  return `
    <h2>Deadline</h2>
    <div class="linkbox"><input class="field" type="datetime-local" id="deadline" value="${toLocalInput(dl)}"><button class="btn small primary" data-act="saveDeadline">Save</button></div>
    <p class="sub" style="font-size:13px">${open ? "🟢 Open." : "🔴 Closed."} Players can add or change requests until then. Set a later time to reopen.</p>
    <h2>Shopping list · ${people.length} of ${S.players.size} players asked</h2>
    ${list.length ? `<div class="list">${list.map((g) => `<label class="shop ${S.shopping[g.key] ? "got" : ""}">
      <input type="checkbox" data-act="shopTick" data-key="${esc(g.key)}" ${S.shopping[g.key] ? "checked" : ""}>
      <div class="grow"><b>${g.total}× ${esc(g.label)}</b><small>${esc(g.people.join(" · "))}</small></div></label>`).join("")}</div>`
      : `<div class="empty-state">No requests yet.</div>`}
    ${people.length ? `<h2>By person</h2><div class="list">${people.map((r) => `<div class="hrow"><div class="grow"><b>${esc(nameOf(r.uid))}</b>
      <small>${esc(r.items.map((i) => `${i.qty}× ${i.item}${i.note ? ` (${i.note})` : ""}`).join(", "))}</small></div></div>`).join("")}</div>` : ""}`;
}

/* ---------- edit sheet ---------- */
function chatTitle(id) {
  if (id === GROUP_CHAT) return "📣 Everyone";
  if (id.startsWith("q_")) return `💬 ${S.quests.find((q) => q.id === id.slice(2))?.title || "Quest chat"}`;
  return `✉️ ${id.slice(2).split("_").map(nameOf).join(" ↔ ")}`;
}

function viewChats() {
  const hasGroup = S.chats.some((c) => c.id === GROUP_CHAT);
  const groupBtn = hasGroup ? "" : `<button class="btn primary" data-act="openChat" data-id="${GROUP_CHAT}" style="margin-bottom:12px">📣 Post in the Everyone chat</button>`;
  if (!S.chats.length) return `${groupBtn}<div class="empty-state">No chats yet. Team chats and private messages will show up here.</div>`;
  return `${groupBtn}<button class="btn small" data-act="exportChats" style="margin-bottom:12px">⬇ Download all chats (.txt)</button>
    <div class="list">${S.chats.map((c) => `<button class="hrow chatrow" data-act="openChat" data-id="${c.id}">
      <div class="grow"><b>${esc(chatTitle(c.id))}</b><small>${esc(nameOf(c.lastFrom))}: ${esc(c.lastText || "")}</small></div>
      <small style="color:var(--muted)">${c.lastAt ? new Date(ms(c.lastAt)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</small></button>`).join("")}</div>`;
}

let msgUnsub = null;
function openChat(id) {
  if (msgUnsub) msgUnsub();
  S.msgs = []; S.sheet = { kind: "chat", id };
  msgUnsub = onSnapshot(query(collection(db, "chats", id, "messages"), orderBy("at"), limitToLast(1000)), (snap) => {
    S.msgs = snap.docs.map((d) => d.data({ serverTimestamps: "estimate" }));
    renderOverlay();
  });
  renderOverlay();
}

async function exportChats() {
  const lines = [];
  for (const c of S.chats) {
    const snap = await getDocs(query(collection(db, "chats", c.id, "messages"), orderBy("at")));
    lines.push(`=== ${chatTitle(c.id).replace(/^\S+ /, "")} ===`);
    snap.forEach((d) => { const m = d.data(); lines.push(`[${new Date(ms(m.at)).toLocaleString()}] ${nameOf(m.from)}: ${m.text}`); });
    lines.push("");
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/plain" }));
  a.download = "gt-sidequests-chats.txt";
  a.click();
}

function renderOverlay() {
  const el = $overlay.querySelector("#hostMsg");
  const v = el?.value, f = document.activeElement === el;
  keepScroll($overlay, renderOverlayInner);
  const ne = $overlay.querySelector("#hostMsg");
  if (ne && v !== undefined) { ne.value = v; if (f) ne.focus(); }
}
function renderOverlayInner() {
  if (!S.sheet) { $overlay.innerHTML = ""; return; }
  if (S.sheet.kind === "chat") {
    $overlay.innerHTML = `<div class="scrim" data-act="close"></div>
      <div class="sheet chatsheet"><div class="chathead wrap"><div class="grow"><b>${esc(chatTitle(S.sheet.id))}</b><small>${S.sheet.id === GROUP_CHAT ? "You post as 📣 Admin" : "Read-only"} · ${S.msgs.length} messages</small></div>
        <button class="iconbtn" data-act="close">✕</button></div>
        <div class="msgs"><div class="wrap">${messagesHtml(S.msgs, "admin", nameOf)}</div></div>
        ${S.sheet.id === GROUP_CHAT ? `<form class="composer wrap" data-act="hostSend"><input class="field" id="hostMsg" name="hostMsg" maxlength="500" autocomplete="off" placeholder="Announcement to everyone"><button class="btn primary small">Send</button></form>` : ""}</div>`;
    return;
  }
  const q = S.sheet.q;
  const sel = (name, opts, v) => `<select class="field" name="${name}">${opts.map((o) => `<option ${o === v ? "selected" : ""}>${o}</option>`).join("")}</select>`;
  $overlay.innerHTML = `<div class="scrim" data-act="close"></div>
    <div class="sheet"><div class="grab"></div><button class="iconbtn closex" data-act="close">✕</button><div class="wrap">
      <h3>${S.sheet.isNew ? "New quest" : "Edit quest"}</h3>
      <input class="field" name="title" placeholder="Title" value="${esc(q.title)}">
      <input class="field" name="blurb" placeholder="One-line pitch" value="${esc(q.blurb)}">
      <div class="grid2">${sel("type", ["group", "personal"], q.type)}${sel("pool", ["core", "bonus"], q.pool)}</div>
      <div class="grid2">${sel("level", ["easy", "medium", "hard"], q.level)}<input class="field" name="category" placeholder="Category" value="${esc(q.category)}"></div>
      <div class="grid2"><input class="field" name="min" type="number" min="1" max="12" value="${q.min}" placeholder="Min players"><input class="field" name="max" type="number" min="1" max="12" value="${q.max}" placeholder="Max players"></div>
      <div class="label sub">How to play (one step per line)</div>
      <textarea class="field" name="instructions">${esc((q.instructions || []).join("\n"))}</textarea>
      <input class="field" name="doneWhen" placeholder="Done when…" value="${esc(q.doneWhen)}">
      <div class="label sub">Secret twists, one per line. Line 1 goes to the first person who joins, line 2 to the second, and so on. A single line is shared by the whole team.</div>
      <textarea class="field" name="twists" placeholder="${S.sheet.loading ? "Loading…" : "Optional"}">${esc((S.sheet.twists || []).join("\n"))}</textarea>
      <button class="btn primary" data-act="saveQuest">Save</button>
      ${S.sheet.isNew ? "" : `<button class="btn ghost small danger" data-act="deleteQuest">Delete quest</button>`}
    </div></div>`;
}

async function openEdit(id) {
  const q = qById(id);
  S.sheet = { q, isNew: false, twists: [], loading: true };
  renderOverlay();
  const snaps = await Promise.all(Array.from({ length: q.twistCount || 0 }, (_, i) => getDoc(doc(db, "questSecrets", id, "slots", String(i)))));
  S.sheet.twists = snaps.map((s) => (s.exists() ? s.data().text : ""));
  S.sheet.loading = false;
  renderOverlay();
}

async function saveQuest() {
  const v = Object.fromEntries([...$overlay.querySelectorAll("[name]")].map((el) => [el.name, el.value]));
  const twists = v.twists.split("\n").map((s) => s.trim()).filter(Boolean);
  let min = Math.max(1, parseInt(v.min) || 1), max = Math.max(min, parseInt(v.max) || min);
  if (v.type === "personal") { min = 1; max = 1; }
  if (!v.title.trim()) return toast("Give it a title.");
  const content = {
    title: v.title.trim(), blurb: v.blurb.trim(), type: v.type, pool: v.pool, level: v.level, category: v.category.trim(),
    min, max, instructions: v.instructions.split("\n").map((s) => s.trim()).filter(Boolean), doneWhen: v.doneWhen.trim(),
    twistCount: twists.length, needsHostSetup: twists.some((t) => t.includes("[HOST")),
  };
  const old = S.sheet.q;
  const id = S.sheet.isNew ? slug(content.title) : old.id;
  const b = writeBatch(db);
  if (S.sheet.isNew) b.set(doc(db, "quests", id), { ...blankState(), ...content, active: true, order: S.quests.length });
  else b.update(doc(db, "quests", id), content);
  writeSlots(b, id, twists, old.twistCount || 0);
  await b.commit();
  S.sheet = null; renderOverlay(); toast("Saved");
}

const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) + "-" + Math.random().toString(36).slice(2, 6);
const blankState = () => ({ members: [], twistDone: [], status: "open", note: "", completedBy: null, completedAt: null });
function writeSlots(b, id, twists, oldCount) {
  twists.forEach((text, i) => b.set(doc(db, "questSecrets", id, "slots", String(i)), { text }));
  for (let i = twists.length; i < Math.max(oldCount, 8); i++) b.delete(doc(db, "questSecrets", id, "slots", String(i)));
}

/* ---------- actions ---------- */
async function importFile(file) {
  const data = JSON.parse(await file.text());
  if (!Array.isArray(data.quests)) throw new Error("That file has no quests list.");
  if (S.quests.length && !confirm("Re-importing overwrites quest text and twists (including your edits). Who joined what is kept. Continue?")) return;
  const b = writeBatch(db);
  b.set(doc(db, "config", "game"), {
    points: data.points || {}, picking: { ...(data.picking || {}), ...(typeof S.config?.picking?.noRepeatTeammates === "boolean" ? { noRepeatTeammates: S.config.picking.noRepeatTeammates } : {}) },
    houseRules: data.houseRules || [], pickingOpen: S.config?.pickingOpen ?? true,
  }, { merge: true });
  data.quests.forEach((q, i) => {
    const twists = q.twists || [];
    const content = {
      title: q.title, blurb: q.blurb || "", type: q.type, pool: q.pool, level: q.level, category: q.category || "",
      min: q.min, max: q.max, instructions: q.instructions || [], doneWhen: q.doneWhen || "",
      twistCount: twists.length, needsHostSetup: twists.some((t) => t.includes("[HOST")), order: i,
    };
    const existing = qById(q.id);
    if (existing) b.update(doc(db, "quests", q.id), content);
    else b.set(doc(db, "quests", q.id), { ...blankState(), ...content, active: true });
    writeSlots(b, q.id, twists, existing?.twistCount || 0);
  });
  await b.commit();
  toast(`Imported ${data.quests.length} quests`);
}

async function approve(claimId) {
  const c = S.claims.find((x) => x.id === claimId);
  const nameDoc = await getDoc(doc(db, "names", c.nameLower));
  const oldUid = nameDoc.exists() ? nameDoc.data().uid : null;
  const old = oldUid ? S.players.get(oldUid) : null;
  const b = writeBatch(db);
  b.set(doc(db, "players", claimId), old || { name: c.name, nameLower: c.nameLower, adjust: 0, createdAt: new Date() });
  if (oldUid && oldUid !== claimId) {
    b.delete(doc(db, "players", oldUid));
    for (const q of S.quests) {
      if (!q.members.includes(oldUid) && q.completedBy !== oldUid) continue;
      b.update(doc(db, "quests", q.id), {
        members: q.members.map((u) => (u === oldUid ? claimId : u)),
        twistDone: (q.twistDone || []).map((u) => (u === oldUid ? claimId : u)),
        completedBy: q.completedBy === oldUid ? claimId : q.completedBy ?? null,
      });
    }
  }
  b.set(doc(db, "names", c.nameLower), { uid: claimId });
  b.delete(doc(db, "claims", claimId));
  await b.commit();
  toast(`${c.name} is back in`);
}

async function removePlayer(uid) {
  const p = S.players.get(uid);
  if (!confirm(`Remove ${p.name}? They leave all their quests.`)) return;
  const b = writeBatch(db);
  for (const q of S.quests) {
    if (!q.members.includes(uid)) continue;
    b.update(doc(db, "quests", q.id), { members: q.members.filter((u) => u !== uid), twistDone: (q.twistDone || []).filter((u) => u !== uid) });
  }
  b.delete(doc(db, "players", uid));
  if (p.nameLower) b.delete(doc(db, "names", p.nameLower));
  await b.commit();
}

async function resetProgress() {
  if (!confirm("Clear every quest's members and completions? Players and quests stay.")) return;
  const b = writeBatch(db);
  S.quests.forEach((q) => b.update(doc(db, "quests", q.id), blankState()));
  S.players.forEach((_, uid) => b.update(doc(db, "players", uid), { adjust: 0 }));
  await b.commit(); toast("Progress reset");
}

async function resetAll() {
  if (!confirm("Remove ALL players, their names, the inbox, chats, bring requests, dares and player-made quests, and clear quest progress?")) return;
  const b = writeBatch(db);
  S.quests.forEach((q) => b.update(doc(db, "quests", q.id), blankState()));
  S.players.forEach((p, uid) => b.delete(doc(db, "players", uid)));
  (await getDocs(collection(db, "names"))).forEach((d) => b.delete(d.ref));
  S.claims.forEach((c) => b.delete(doc(db, "claims", c.id)));
  S.inbox.forEach((i) => b.delete(doc(db, "inbox", i.id)));
  await b.commit();
  // Chats, requests, dares, player-made quests: delete in chunks (a batch holds at most 500 writes).
  const refs = [];
  S.requests.forEach((r) => refs.push(doc(db, "requests", r.uid)));
  S.dares.forEach((d) => { refs.push(doc(db, "dares", d.id)); refs.push(doc(db, "dareText", d.id)); });
  S.quests.filter((q) => q.suggestedBy).forEach((q) => refs.push(doc(db, "quests", q.id)));
  refs.push(doc(db, "config", "shopping"));
  for (const c of S.chats) {
    (await getDocs(collection(db, "chats", c.id, "messages"))).forEach((d) => refs.push(d.ref));
    refs.push(doc(db, "chats", c.id));
  }
  for (let i = 0; i < refs.length; i += 400) {
    const cb = writeBatch(db); refs.slice(i, i + 400).forEach((r) => cb.delete(r)); await cb.commit();
  }
  toast("Everything cleared");
}

async function run(fn) {
  try { await fn(); } catch (e) { console.error(e); toast(e.message || "Something went wrong"); }
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-act]");
  if (!t || t.tagName === "SELECT" || (t.tagName === "INPUT" && t.type === "checkbox")) return;
  const { act, id, uid } = t.dataset;
  const q = id && qById(id);
  ({
    login, logout: () => signOut(auth),
    tab: () => { S.tab = id; render(); },
    qfilter: () => { S.qfilter = id; render(); },
    copy: () => navigator.clipboard.writeText(playerLink()).then(() => toast("Link copied")),
    import: () => document.getElementById("importFile").click(),
    edit: () => run(() => openEdit(id)),
    newQuest: () => { S.sheet = { isNew: true, twists: [], q: { title: "", blurb: "", type: "group", pool: "bonus", level: "easy", category: "", min: 2, max: 2, instructions: [], doneWhen: "" } }; renderOverlay(); },
    close: () => { if (msgUnsub) { msgUnsub(); msgUnsub = null; } S.sheet = null; renderOverlay(); },
    openChat: () => openChat(id),
    saveDeadline: () => run(async () => {
      const el = document.getElementById("deadline");
      if (!el.value) return toast("Pick a date and time.");
      delete el.dataset.dirty;
      await setDoc(doc(db, "config", "game"), { requestDeadline: new Date(el.value) }, { merge: true });
      toast("Deadline saved");
    }),
    delSuggested: () => run(async () => { if (confirm("Remove this player-made quest?")) await deleteDoc(doc(db, "quests", id)); }),
    delDare: () => run(async () => {
      if (!confirm("Remove this dare?")) return;
      const b = writeBatch(db); b.delete(doc(db, "dares", id)); b.delete(doc(db, "dareText", id)); await b.commit();
    }),
    exportChats: () => run(exportChats),
    saveQuest: () => run(saveQuest),
    deleteQuest: () => run(async () => {
      if (!confirm("Delete this quest for good?")) return;
      const b = writeBatch(db); b.delete(doc(db, "quests", S.sheet.q.id)); writeSlots(b, S.sheet.q.id, [], S.sheet.q.twistCount || 0);
      await b.commit(); S.sheet = null; renderOverlay();
    }),
    markDone: () => run(() => updateDoc(doc(db, "quests", id), { status: "done", completedBy: null, completedAt: new Date(), note: q.note || "Confirmed by Shalom" })),
    reopen: () => run(() => updateDoc(doc(db, "quests", id), { status: "open", completedAt: null })),
    kick: () => run(() => updateDoc(doc(db, "quests", id), { members: q.members.filter((u) => u !== uid), twistDone: (q.twistDone || []).filter((u) => u !== uid) })),
    adj: () => run(() => updateDoc(doc(db, "players", uid), { adjust: increment(Number(t.dataset.n)) })),
    removePlayer: () => run(() => removePlayer(uid)),
    approve: () => run(() => approve(id)),
    deny: () => run(() => deleteDoc(doc(db, "claims", id))),
    resetProgress: () => run(resetProgress),
    resetAll: () => run(resetAll),
    saveRules: () => run(async () => {
      const el = document.getElementById("rulesText");
      const rules = el.value.split("\n").map((r) => r.trim()).filter(Boolean);
      if (!rules.length) return toast("Add at least one rule.");
      delete el.dataset.dirty;
      await setDoc(doc(db, "config", "game"), { houseRules: rules }, { merge: true });
      toast("House rules saved");
    }),
    inboxDone: () => run(async () => {
      const i = S.inbox.find((x) => x.id === id);
      const b = writeBatch(db);
      b.update(doc(db, "inbox", id), { status: "done" });
      if (i.fromUid && S.players.has(i.fromUid)) b.update(doc(db, "players", i.fromUid), { adjust: increment(S.config?.points?.hostQuestReward ?? 10) });
      await b.commit();
    }),
    inboxDismiss: () => run(() => updateDoc(doc(db, "inbox", id), { status: "dismissed" })),
  })[act]?.();
});

document.addEventListener("input", (e) => { if (["rulesText", "deadline"].includes(e.target.id)) e.target.dataset.dirty = "1"; });
document.addEventListener("submit", (e) => {
  if (e.target.dataset.act === "hostSend") { e.preventDefault(); run(hostSend); }
});

document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.id === "importFile" && t.files[0]) { run(() => importFile(t.files[0])); t.value = ""; return; }
  const { act, id, key } = t.dataset;
  if (act === "shopTick") run(() => setDoc(doc(db, "config", "shopping"), { checked: { [t.dataset.key]: t.checked } }, { merge: true }));
  if (act === "active") run(() => updateDoc(doc(db, "quests", id), { active: t.checked }));
  if (act === "cfg" && key === "pickingOpen") run(() => setDoc(doc(db, "config", "game"), { pickingOpen: t.checked }, { merge: true }));
  if (act === "cfg" && key === "noRepeatTeammates") run(() => setDoc(doc(db, "config", "game"), { picking: { noRepeatTeammates: t.checked } }, { merge: true }));
  if (act === "addPlayer" && t.value) {
    const q = qById(id);
    run(() => updateDoc(doc(db, "quests", id), { members: [...q.members, t.value] }));
  }
});
