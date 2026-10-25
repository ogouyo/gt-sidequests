// Shared chat helpers for the player app and host dashboard.
// Chat ids: "q_<questId>" for a quest's team chat, "d_<uidA>_<uidB>" (sorted) for private messages.
import { esc } from "./game.js";

export const questChatId = (questId) => `q_${questId}`;
export const dmChatId = (a, b) => `d_${[a, b].sort().join("_")}`;
export const GROUP_CHAT = "all";
export const ms = (t) => (t?.toMillis ? t.toMillis() : (t?.seconds || 0) * 1000);

const time = (t) => {
  const m = ms(t);
  return m ? new Date(m).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "sending…";
};

// msgs: [{ from, text, at }]. me: viewer uid (null for host: nobody is "me").
export function messagesHtml(msgs, me, nameOf) {
  if (!msgs.length) return `<div class="empty-state">No messages yet. Say hi 👋</div>`;
  let prev = null;
  return msgs.map((m) => {
    const mine = m.from === me;
    const admin = m.from === "admin";
    const showName = !mine && m.from !== prev;
    prev = m.from;
    return `<div class="bubble ${mine ? "mine" : ""} ${admin ? "admin" : ""}">
      ${showName ? `<div class="who">${admin ? "📣 Admin" : esc(nameOf(m.from))}</div>` : ""}
      <div>${esc(m.text)}</div><div class="t">${time(m.at)}</div></div>`;
  }).join("");
}

// Re-render helper that keeps the message list pinned to the bottom unless the reader scrolled up.
export function keepScroll(container, fn) {
  const box = container.querySelector(".msgs");
  const atBottom = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const top = box?.scrollTop;
  fn();
  const nb = container.querySelector(".msgs");
  if (nb) nb.scrollTop = atBottom ? nb.scrollHeight : top;
}
