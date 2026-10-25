// Pure game logic shared by the player app and the host dashboard.

export const DEFAULT_POINTS = { easy: 10, medium: 20, hard: 30, twistBonus: 10, hostQuestReward: 10 };

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

export function computeScores(quests, players, config) {
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
