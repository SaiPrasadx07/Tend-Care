// Data layer. The caregiver UI reads and writes exclusively through Tend's MCP
// tools (the same ones Alexa+ uses), as the selected caregiver, so every
// permission and safety rule is enforced by the server, not the UI.
import { BrowserMcpClient } from "../mcp-browser.js";

const listeners = new Set();
const tokens = new Map();
const clients = new Map();

export const state = {
  config: null,
  actorId: null,
  data: null, // { recipients, status, forecast, handoff, activity }
  handoffDays: 7,
  loading: false,
  error: null,
  fetchedAt: null,
  wire: [], // every JSON-RPC message seen by this page (dashboard, inspector, cards, assistant)
  turns: [], // assistant turn traces
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(reason) {
  for (const fn of listeners) fn(reason);
}

export function actor() {
  return state.config?.caregivers.find((c) => c.id === state.actorId);
}
export function canWrite() {
  return actor()?.role === "caregiver";
}

let wireSeq = 0;
export function recordWire(entry) {
  state.wire.push({ seq: ++wireSeq, at: new Date().toISOString(), ...entry });
  if (state.wire.length > 600) state.wire.splice(0, state.wire.length - 600);
}

export async function loadConfig() {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error(`Config failed (${res.status})`);
  state.config = await res.json();
  return state.config;
}

export async function getToken(actorId = state.actorId) {
  const cached = tokens.get(actorId);
  if (cached && cached.exp - Date.now() > 60_000) return cached.token;
  const res = await fetch("/api/demo/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ caregiverId: actorId }) });
  if (!res.ok) throw new Error("Couldn't start a session for this caregiver (demo mode must be on).");
  const body = await res.json();
  tokens.set(actorId, { token: body.token, exp: Date.parse(body.expiresAt) });
  return body.token;
}

export function client(actorId = state.actorId) {
  let c = clients.get(actorId);
  if (!c) {
    c = new BrowserMcpClient("/mcp", () => getToken(actorId), recordWire);
    clients.set(actorId, c);
  }
  return c;
}

export class ToolError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** Call a Tend tool and return structuredContent; tool-level errors become ToolError with a clean message. */
export async function tool(name, args = {}, source = "dashboard") {
  const res = await client().callTool(name, args, source);
  if (res?.isError) {
    const text = res.content?.find((c) => c.type === "text")?.text ?? "Something went wrong.";
    const m = /^([A-Z_]+):\s*(.*)$/s.exec(text);
    throw new ToolError(m ? m[2] : text.replace(/^MCP error -?\d+:\s*/, ""), m ? m[1] : "ERROR");
  }
  return { data: res.structuredContent ?? {}, speech: res.content?.find((c) => c.type === "text")?.text ?? "" };
}

export async function refresh(reason = "refresh") {
  if (!state.actorId) return;
  state.loading = true;
  emit("loading");
  try {
    const [recipients, status, forecast, handoff, activity] = await Promise.all([
      tool("list_care_recipients"),
      tool("get_care_status"),
      tool("forecast_refills", { within_days: 7 }),
      tool("get_handoff_report", { days: state.handoffDays }),
      tool("get_recent_activity", { limit: 40 }),
    ]);
    const prev = state.data;
    state.data = {
      recipients: recipients.data.people,
      status: status.data,
      forecast: forecast.data.items,
      handoff: handoff.data,
      handoffSpeech: handoff.speech,
      activity: activity.data.items,
    };
    state.previous = prev;
    state.error = null;
    state.fetchedAt = new Date();
  } catch (err) {
    state.error = err.message;
  } finally {
    state.loading = false;
    emit(reason);
  }
}

export async function setHandoffDays(days) {
  state.handoffDays = days;
  const handoff = await tool("get_handoff_report", { days });
  state.data = { ...state.data, handoff: handoff.data, handoffSpeech: handoff.speech };
  emit("handoff");
}

export function setActor(id) {
  state.actorId = id;
  try { localStorage.setItem("tend.actor", id); } catch { /* storage unavailable */ }
  state.data = null;
  emit("actor");
  return refresh("actor");
}

// ---------- assistant ----------
export async function agentTurn(text, sessionId) {
  const res = await fetch("/api/agent/turn", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getToken()}` },
    body: JSON.stringify({ text, sessionId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `Request failed (${res.status})`);
  for (const w of body.wire ?? []) recordWire({ ...w, source: "assistant" });
  state.turns.unshift({ text, at: new Date().toISOString(), actor: actor()?.name, ...body });
  if (state.turns.length > 50) state.turns.pop();
  return body;
}

export async function resetAgent(sessionId) {
  await fetch("/api/agent/reset", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getToken()}` }, body: JSON.stringify({ sessionId }) }).catch(() => {});
}

export async function resetDemo() {
  const res = await fetch("/api/demo/reset", { method: "POST", headers: { Authorization: `Bearer ${await getToken()}` } });
  if (!res.ok) throw new Error("Only caregivers can reset demo data.");
}
