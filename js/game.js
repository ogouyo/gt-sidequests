// Pure game logic shared by the player app and the host dashboard.

// The name players see for the host.
export const HOST_NAME = "Ogouyo";

export const DEFAULT_POINTS = { easy: 10, medium: 20, hard: 30, twistBonus: 10, hostQuestReward: 10, dare: 10, suggestBonus: 5 };

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const sizeLabel = (q) => (q.min === q.max ? `${q.min}` : `${q.min}–${q.max}`);

// forming: not enough people yet. ready: can be played. done: completed.
export function questState(q) {
  if (q.status === "done") return "done";
  return q.members.length >= q.min ? "ready" : "forming";
}

export function slotText(q) {
  const n = q.members.length;
  if (q.status === "done") return "Completed";
  if (n < q.min) return `${n}/${q.min} joined · needs ${q.min - n} more`;
  if (n < q.max) return `${n}/${q.max} joined · ${q.max - n} spot${q.max - n > 1 ? "s" : ""} left`;
  return `${n}/${q.max} · full`;
}

export function myQuests(quests, uid) {
  const mine = quests.filter((q) => q.members.includes(uid));
  return {
    all: mine,
    coreGroup: mine.filter((q) => q.pool === "core" && q.type === "group"),
    corePersonal: mine.filter((q) => q.pool === "core" && q.type === "personal"),
    bonus: mine.filter((q) => q.pool === "bonus"),
  };
}

export function picking(config) {
  return { group: 2, personal: 1, noRepeatTeammates: true, ...(config?.picking || {}) };
}

export function coreProgress(quests, uid, config) {
  const p = picking(config);
  const m = myQuests(quests, uid);
  const core = [...m.coreGroup, ...m.corePersonal];
  const needed = (p.groupQuestsPerPlayer ?? p.group) + (p.personalQuestsPerPlayer ?? p.personal);
  const done = core.filter((q) => q.status === "done").length;
  return { picked: core.length, done, needed, allDone: done >= needed };
}

// Can `uid` join quest `q`? Returns { ok, reason }.
export function canJoin(q, uid, quests, config) {
  const p = picking(config);
  const maxGroup = p.groupQuestsPerPlayer ?? p.group;
  const maxPersonal = p.personalQuestsPerPlayer ?? p.personal;
  if (q.members.includes(uid)) return { ok: false, reason: "You're in this one." };
  if (!q.active) return { ok: false, reason: "This quest isn't active right now." };
  if (q.status === "done") return { ok: false, reason: "Already completed." };
  if (q.members.length >= q.max) return { ok: false, reason: "This quest is full." };
  const m = myQuests(quests, uid);
  if (q.pool === "core") {
    if (!config?.pickingOpen) return { ok: false, reason: "Picking is locked. Ask Shalom if you need a swap." };
    if (q.type === "group" && m.coreGroup.length >= maxGroup)
      return { ok: false, reason: `You already have ${maxGroup} group quests. Leave one to swap.` };
    if (q.type === "personal" && m.corePersonal.length >= maxPersonal)
      return { ok: false, reason: `You already have your solo quest. Leave it to swap.` };
    if (q.type === "group" && p.noRepeatTeammates) {
      const mates = new Set(m.coreGroup.flatMap((x) => x.members).filter((x) => x !== uid));
      const clash = q.members.find((x) => mates.has(x));
      if (clash) return { ok: false, reason: "clash:" + clash };
    }
  } else if (!coreProgress(quests, uid, config).allDone) {
    return { ok: false, reason: "Finish your core quests to unlock bonus quests." };
  }
  return { ok: true };
}

export function canLeave(q, uid, config) {
  if (!q.members.includes(uid) || q.status === "done") return false;
  return q.pool === "bonus" || !!config?.pickingOpen;
}

export function computeScores(quests, players, config, dares = []) {
  const pts = { ...DEFAULT_POINTS, ...(config?.points || {}) };
  const score = new Map();
  for (const [uid, p] of players) score.set(uid, Number(p.adjust || 0));
  for (const q of quests) {
    if (q.status !== "done") continue;
    for (const uid of q.members) {
      let s = pts[q.level] || 0;
      if ((q.twistDone || []).includes(uid)) s += pts.twistBonus;
      score.set(uid, (score.get(uid) || 0) + s);
    }
    // Whoever suggested a quest gets a small bonus when others complete it.
    if (q.suggestedBy && !q.members.includes(q.suggestedBy) && players.has(q.suggestedBy))
      score.set(q.suggestedBy, (score.get(q.suggestedBy) || 0) + pts.suggestBonus);
  }
  for (const d of countedDares(dares)) {
    if (d.counts && players.has(d.to)) score.set(d.to, (score.get(d.to) || 0) + pts.dare);
    if (d.senderCounts && players.has(d.from)) score.set(d.from, (score.get(d.from) || 0) + pts.suggestBonus);
  }
  return score;
}

// Host helper: how many slots the active core quests provide vs how many players need.
export function slotMath(quests, playerCount, config) {
  const p = picking(config);
  const g = quests.filter((q) => q.active && q.pool === "core" && q.type === "group");
  const s = quests.filter((q) => q.active && q.pool === "core" && q.type === "personal");
  return {
    groupMin: g.reduce((a, q) => a + q.min, 0),
    groupMax: g.reduce((a, q) => a + q.max, 0),
    groupNeeded: playerCount * (p.groupQuestsPerPlayer ?? p.group),
    personal: s.length,
    personalNeeded: playerCount * (p.personalQuestsPerPlayer ?? p.personal),
  };
}

// Sorting and filtering for quest lists (player Board + host Quests tab).
export const LEVEL_ORDER = { easy: 0, medium: 1, hard: 2 };
export const DEFAULT_VIEW = { sort: "smart", levels: [], space: false, size: "any" };
export function activeFilterCount(v) { return (v.levels.length ? 1 : 0) + (v.space ? 1 : 0) + (v.size !== "any" ? 1 : 0); }
export function filterSort(list, view, uid = null) {
  const { sort, levels, space, size } = { ...DEFAULT_VIEW, ...view };
  const out = list.filter((q) => {
    if (levels.length && !levels.includes(q.level)) return false;
    if (space && !(uid && q.members.includes(uid)) && (q.status === "done" || q.members.length >= q.max)) return false;
    if (size !== "any") {
      if (q.type !== "group") return false;
      if (size === "4+" ? q.max < 4 : !(q.min <= Number(size) && Number(size) <= q.max)) return false;
    }
    return true;
  });
  const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);
  const byTitle = (a, b) => a.title.localeCompare(b.title);
  // Smart: mine first, then quests closest to starting, then open ones, full/done last.
  const rank = (q) => {
    if (uid && q.members.includes(uid)) return -100;
    if (q.status === "done" || q.members.length >= q.max) return 100;
    if (q.members.length && q.members.length < q.min) return q.min - q.members.length;
    return 10;
  };
  if (sort === "az") out.sort(byTitle);
  else if (sort === "level") out.sort((a, b) => (LEVEL_ORDER[a.level] ?? 9) - (LEVEL_ORDER[b.level] ?? 9) || byTitle(a, b));
  else if (sort === "smart") out.sort((a, b) => rank(a) - rank(b) || byOrder(a, b));
  else out.sort(byOrder);
  return out;
}

// Only a player's first DARE_CAP completed dares earn points (and senders earn at most DARE_CAP bonuses).
export const DARE_CAP = 3;
const tms = (t) => (t?.toMillis ? t.toMillis() : (t?.seconds || 0) * 1000);
export function countedDares(dares) {
  const done = dares.filter((d) => d.status === "done").sort((a, b) => tms(a.completedAt) - tms(b.completedAt));
  const got = new Map(), gave = new Map();
  return done.map((d) => {
    const counts = (got.get(d.to) || 0) < DARE_CAP;
    if (counts) got.set(d.to, (got.get(d.to) || 0) + 1);
    const senderCounts = counts && (gave.get(d.from) || 0) < DARE_CAP;
    if (senderCounts) gave.set(d.from, (gave.get(d.from) || 0) + 1);
    return { ...d, counts, senderCounts };
  });
}
// A twist with a fill-me-in placeholder means the host still has setup to do.
export const needsSetup = (twists) => (twists || []).some((t) => /\[(HOST|Shalom|Ogouyo)/i.test(t));
