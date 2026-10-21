import { BrowserMcpClient } from "./mcp-browser.js";

const $ = (id) => document.getElementById(id);
const els = {
  engineBadge: $("engineBadge"), protoBadge: $("protoBadge"), clock: $("clock"), speaker: $("speaker"),
  convo: $("convo"), emptyHint: $("emptyHint"), micBtn: $("micBtn"), askForm: $("askForm"), askInput: $("askInput"),
  sendBtn: $("sendBtn"), chips: $("chips"), tts: $("ttsToggle"), newConvo: $("newConvoBtn"),
  traceList: $("traceList"), feed: $("feed"), refreshFeed: $("refreshFeed"),
  toolSelect: $("toolSelect"), toolDesc: $("toolDesc"), toolArgs: $("toolArgs"), callTool: $("callTool"),
  toolMeta: $("toolMeta"), toolResult: $("toolResult"), inspectorWire: $("inspectorWire"),
  resetDemo: $("resetDemo"), resetMsg: $("resetMsg"), specVersion: $("specVersion"),
};

const SUGGESTIONS = [
  "Did Mom take her pills today?",
  "I just gave Dad his amlodipine",
  "Mom took her metformin",
  "When will we run out of anything?",
  "Reorder Mom's metformin",
  "Yes, go ahead",
  "Note that Dad felt dizzy after lunch",
  "Give me the handoff for this week",
];

const state = {
  config: null,
  caregiverId: null,
  sessionId: newId(),
  tokens: new Map(), // caregiverId -> { token, exp }
  busy: false,
  tools: [],
  mcp: null,
  inspectorWire: [],
  theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
};

function newId() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
}

// ---------------- auth: short-lived session tokens ----------------
async function getToken(caregiverId = state.caregiverId) {
  const cached = state.tokens.get(caregiverId);
  if (cached && cached.exp - Date.now() > 60_000) return cached.token;
  const res = await fetch("/api/demo/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ caregiverId }) });
  if (!res.ok) throw new Error("Couldn't get a session token (is demo mode on?)");
  const body = await res.json();
  state.tokens.set(caregiverId, { token: body.token, exp: Date.parse(body.expiresAt) });
  return body.token;
}

function currentActor() {
  return state.config.caregivers.find((c) => c.id === state.caregiverId);
}

// ---------------- conversation ----------------
function scrollConvo() {
  els.convo.scrollTop = els.convo.scrollHeight;
}

function addBubble(role, text, extra) {
  els.emptyHint?.remove();
  const who = role === "user" ? currentActor()?.name ?? "You" : "Alexa";
  const b = el("div", { class: `bubble ${role}` }, el("span", { class: "who" }, who), text);
  if (extra) b.append(extra);
  els.convo.append(b);
  scrollConvo();
  return b;
}

function speak(text) {
  if (!els.tts.checked || !("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.02;
  speechSynthesis.speak(u);
}

function setBusy(busy) {
  state.busy = busy;
  els.sendBtn.disabled = busy;
  els.micBtn.classList.toggle("busy", busy);
}

async function sendTurn(text) {
  text = text.trim();
  if (!text || state.busy) return;
  setBusy(true);
  addBubble("user", text);
  const thinking = addBubble("assistant thinking", "…");
  try {
    const res = await fetch("/api/agent/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getToken()}` },
      body: JSON.stringify({ text, sessionId: state.sessionId }),
    });
    const body = await res.json().catch(() => ({}));
    thinking.remove();
    if (!res.ok) {
      addBubble("assistant error", body.message || `Request failed (${res.status}).`);
      return;
    }
    const note = body.engineNote ? el("div", { class: "engine-note" }, body.engineNote) : null;
    addBubble("assistant", body.reply, note);
    for (const card of body.cards || []) mountCard(card);
    renderTurnTrace(text, body);
    speak(body.reply);
    refreshFeed();
  } catch (err) {
    thinking.remove();
    addBubble("assistant error", `Couldn't reach Tend: ${err.message}`);
  } finally {
    setBusy(false);
  }
}

// ---------------- MCP Apps host ----------------
// Renders a ui:// resource through the sandbox proxy and implements the host side
// of io.modelcontextprotocol/ui: ui/initialize, tool-input/tool-result, size-changed
// and proxied tools/call from the view.
function mountCard(card) {
  const frame = el("iframe", { sandbox: "allow-scripts", src: "sandbox-proxy.html", title: `${card.toolName} card`, loading: "eager" });
  const wrap = el("div", { class: "card" }, frame);
  els.convo.append(wrap);
  scrollConvo();
  const post = (msg) => frame.contentWindow?.postMessage(msg, "*");
  const actorAtMount = state.caregiverId;

  const onMessage = async (event) => {
    if (event.source !== frame.contentWindow) return;
    const msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    switch (msg.method) {
      case "ui/notifications/sandbox-proxy-ready":
        post({ jsonrpc: "2.0", method: "ui/notifications/sandbox-resource-ready", params: { html: card.html } });
        return;
      case "ui/initialize":
        post({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: "2026-01-26",
            hostInfo: { name: "tend-alexa-plus-simulator", version: "0.1.0" },
            hostCapabilities: { serverTools: {}, sandbox: { csp: { connectDomains: [], resourceDomains: [] } } },
            hostContext: { theme: "light", displayMode: "inline", availableDisplayModes: ["inline"], toolInfo: { tool: { name: card.toolName } } },
          },
        });
        return;
      case "ui/notifications/initialized":
        post({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: card.toolInput } });
        post({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: card.toolResult });
        return;
      case "ui/notifications/size-changed":
        if (msg.params?.height) frame.style.height = `${Math.min(Math.max(msg.params.height, 60), 900)}px`;
        return;
      case "tools/call": {
        // Only proxy tools the view is allowed to use, as the caregiver who saw the card.
        const allowed = new Set(["log_dose", "get_care_status", "forecast_refills", "get_handoff_report"]);
        if (!allowed.has(msg.params?.name)) {
          post({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Tool not available to this view" } });
          return;
        }
        try {
          const client = clientFor(actorAtMount);
          const result = await client.callTool(msg.params.name, msg.params.arguments);
          post({ jsonrpc: "2.0", id: msg.id, result });
          refreshFeed();
        } catch (err) {
          post({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: err.message } });
        }
        return;
      }
      default:
        if (msg.id !== undefined && msg.method) post({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
  };
  window.addEventListener("message", onMessage);
}

// ---------------- trace panel ----------------
function summarizeWire(entry) {
  const m = entry.message;
  if (typeof m === "string") return m;
  if (m?.method) return `${m.method}${m.id !== undefined ? ` #${m.id}` : ""}`;
  if (m?.result !== undefined) return `result #${m.id}`;
  if (m?.error) return `error #${m.id}: ${m.error.message}`;
  return "message";
}

function renderTurnTrace(text, body) {
  if (els.traceList.querySelector("p.muted")) els.traceList.replaceChildren();
  const engine = body.engine === "bedrock" ? `Amazon Bedrock · ${state.config.model}` : "offline router";
  const tools = body.tools.map((t) =>
    el("div", { class: `tool${t.blockedByHost ? " blocked" : t.isError ? " error" : ""}` },
      el("div", {}, el("span", { class: "tool-name" }, t.name), " ", el("span", { class: "muted small" }, `${t.ms} ms${t.blockedByHost ? " · blocked by host policy" : t.isError ? " · error" : ""}`)),
      el("div", { class: "tool-args" }, JSON.stringify(t.arguments)),
      el("div", { class: "tool-speech" }, t.speech)));
  const wire = el("details", {},
    el("summary", {}, `Raw JSON-RPC over Streamable HTTP (${body.wire.length} messages, protocol ${body.protocolVersion ?? "?"})`),
    ...body.wire.map((w) => el("div", { class: "wire-item" },
      el("div", { class: "wire-dir" }, `${w.direction}${w.httpStatus ? ` · HTTP ${w.httpStatus}` : ""} · ${summarizeWire(w)}`),
      el("pre", { class: "code" }, typeof w.message === "string" ? w.message : JSON.stringify(w.message, null, 2)))));
  const usage = body.usage ? ` · ${body.usage.modelCalls} model calls, ${body.usage.inputTokens + body.usage.outputTokens} tokens` : "";
  const turn = el("article", { class: "turn" },
    el("div", { class: "turn-head" }, el("strong", {}, `"${text}"`), el("span", { class: "muted" }, `${engine} · ${body.tools.length} tool call${body.tools.length === 1 ? "" : "s"} · ${body.ms} ms${usage}`)),
    tools.length ? tools : el("p", { class: "muted small" }, "No tool calls."),
    wire);
  els.traceList.prepend(turn);
}

// ---------------- browser MCP client (feed + inspector) ----------------
const clients = new Map();
function clientFor(caregiverId) {
  let c = clients.get(caregiverId);
  if (!c) {
    c = new BrowserMcpClient("/mcp", () => getToken(caregiverId), (w) => {
      state.inspectorWire.push(w);
      if (state.inspectorWire.length > 40) state.inspectorWire.shift();
    });
    clients.set(caregiverId, c);
  }
  return c;
}

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: state.config.timezone });
}

async function refreshFeed() {
  try {
    const res = await clientFor(state.caregiverId).callTool("get_recent_activity", { limit: 15 });
    const items = res?.structuredContent?.items ?? [];
    els.feed.replaceChildren(...items.map((i) => el("li", {}, el("time", { datetime: i.at }, fmtTime(i.at)), el("span", { class: `k-${i.kind}` }, i.message))));
    if (!items.length) els.feed.replaceChildren(el("li", {}, el("span", { class: "muted" }, "No activity yet.")));
  } catch (err) {
    els.feed.replaceChildren(el("li", {}, el("span", { class: "muted" }, `Couldn't load feed: ${err.message}`)));
  }
}

function exampleArgs(schema) {
  const out = {};
  for (const key of schema?.required ?? []) {
    const p = schema.properties?.[key] ?? {};
    if (p.type === "number" || p.type === "integer") out[key] = 1;
    else if (p.type === "array") out[key] = ["08:00"];
    else if (p.type === "boolean") out[key] = false;
    else out[key] = "";
  }
  return out;
}

async function loadInspectorTools() {
  try {
    const res = await clientFor(state.caregiverId).listTools();
    state.tools = res?.tools ?? [];
    els.toolSelect.replaceChildren(...state.tools.map((t) => el("option", { value: t.name }, t.name + (t._meta?.ui ? "  [MCP App]" : ""))));
    onToolSelected();
  } catch (err) {
    els.toolDesc.textContent = `Couldn't list tools: ${err.message}`;
  }
}

function onToolSelected() {
  const t = state.tools.find((x) => x.name === els.toolSelect.value);
  if (!t) return;
  const ann = t.annotations ? Object.entries(t.annotations).filter(([, v]) => v === true).map(([k]) => k).join(", ") : "";
  els.toolDesc.textContent = t.description ?? "";
  els.toolMeta.textContent = ann ? `hints: ${ann}` : "";
  els.toolArgs.value = JSON.stringify(exampleArgs(t.inputSchema), null, 2);
}

async function callSelectedTool() {
  let args;
  try {
    args = JSON.parse(els.toolArgs.value || "{}");
  } catch {
    els.toolResult.textContent = "Arguments must be valid JSON.";
    return;
  }
  state.inspectorWire = [];
  els.toolResult.textContent = "Calling…";
  try {
    const result = await clientFor(state.caregiverId).callTool(els.toolSelect.value, args);
    els.toolResult.textContent = JSON.stringify(result, null, 2);
    refreshFeed();
  } catch (err) {
    els.toolResult.textContent = `JSON-RPC error ${err.code ?? ""}: ${err.message}`;
  }
  els.inspectorWire.textContent = state.inspectorWire
    .map((w) => `// ${w.direction}${w.httpStatus ? ` (HTTP ${w.httpStatus})` : ""}\n${typeof w.message === "string" ? w.message : JSON.stringify(w.message, null, 2)}`)
    .join("\n\n");
}

// ---------------- voice input ----------------
function setupMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    els.micBtn.disabled = true;
    els.micBtn.title = "Voice input needs Chrome or Edge. Type instead.";
    return;
  }
  const rec = new SR();
  rec.lang = "en-US";
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  let listening = false;
  let finalText = "";
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    els.askInput.value = finalText || interim;
  };
  rec.onend = () => {
    listening = false;
    els.micBtn.classList.remove("listening");
    const text = finalText.trim();
    finalText = "";
    if (text) {
      els.askInput.value = "";
      sendTurn(text);
    }
  };
  rec.onerror = (e) => {
    els.askInput.placeholder = e.error === "not-allowed" ? "Microphone blocked. Type instead." : "Didn't catch that. Try again.";
  };
  els.micBtn.addEventListener("click", () => {
    if (state.busy) return;
    if (listening) return rec.stop();
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    finalText = "";
    listening = true;
    els.micBtn.classList.add("listening");
    rec.start();
  });
}

// ---------------- wiring ----------------
function setupTabs() {
  document.querySelectorAll(".tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b === btn)));
      document.querySelectorAll(".tabpanel").forEach((p) => (p.hidden = p.id !== `tab-${btn.dataset.tab}`));
      if (btn.dataset.tab === "feed") refreshFeed();
      if (btn.dataset.tab === "inspector") loadInspectorTools();
    });
  });
}

function tickClock() {
  if (!state.config) return;
  els.clock.textContent = new Date().toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: state.config.timezone });
}

async function init() {
  setupTabs();
  setupMic();
  els.chips.replaceChildren(...SUGGESTIONS.map((s) => el("button", { type: "button", class: "chip", onclick: () => sendTurn(s) }, s)));
  els.askForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const t = els.askInput.value;
    els.askInput.value = "";
    sendTurn(t);
  });
  els.newConvo.addEventListener("click", async () => {
    await fetch("/api/agent/reset", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getToken()}` }, body: JSON.stringify({ sessionId: state.sessionId }) }).catch(() => {});
    state.sessionId = newId();
    els.convo.replaceChildren();
  });
  els.refreshFeed.addEventListener("click", refreshFeed);
  els.toolSelect.addEventListener("change", onToolSelected);
  els.callTool.addEventListener("click", callSelectedTool);
  els.resetDemo.addEventListener("click", async () => {
    const res = await fetch("/api/demo/reset", { method: "POST", headers: { Authorization: `Bearer ${await getToken()}` } });
    els.resetMsg.textContent = res.ok ? "Demo data reset." : "Reset failed (view-only users can't reset).";
    refreshFeed();
  });

  const res = await fetch("/api/config");
  state.config = await res.json();
  els.specVersion.textContent = state.config.server.mcpProtocolVersion;
  els.protoBadge.textContent = `MCP ${state.config.server.mcpProtocolVersion} · Streamable HTTP`;
  if (state.config.engine === "bedrock") {
    els.engineBadge.textContent = `Amazon Bedrock · ${state.config.model}`;
  } else {
    els.engineBadge.textContent = "Offline router (no LLM)";
    els.engineBadge.classList.add("warn");
    els.engineBadge.title = "AWS credentials not configured. Set them to use Amazon Bedrock.";
  }
  els.speaker.replaceChildren(...state.config.caregivers.map((c) => el("option", { value: c.id }, `${c.name}${c.role === "viewer" ? " (view-only)" : ""}`)));
  state.caregiverId = state.config.caregivers[0]?.id;
  els.speaker.addEventListener("change", () => {
    state.caregiverId = els.speaker.value;
    state.sessionId = newId();
    addBubble("assistant", `Now speaking as ${currentActor().name}.`);
    refreshFeed();
    if (!$("tab-inspector").hidden) loadInspectorTools();
  });
  tickClock();
  setInterval(tickClock, 15_000);
  refreshFeed();
}

init().catch((err) => {
  els.engineBadge.textContent = "offline";
  addBubble("assistant error", `Failed to start: ${err.message}`);
});
