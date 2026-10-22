// The Alexa+ companion: a simulated Alexa+ surface whose host agent talks to
// Tend over MCP. Replies can carry MCP Apps cards, rendered here through the
// spec's sandbox proxy, and every turn refreshes the caregiver dashboard.
import { state, agentTurn, resetAgent, refresh, client, actor, canWrite } from "./api.js";
import { h, icon, toast } from "./ui.js";

let els;
let busy = false;
let sessionId = newId();

function newId() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function newSession() {
  void resetAgent(sessionId);
  sessionId = newId();
  if (els) els.transcript.replaceChildren(emptyState());
}

function emptyState() {
  return h("div", { class: "rail-empty" },
    h("div", { class: "display" }, "“Alexa, did Mom take her pills?”"),
    h("p", {}, "Ask out loud or type. Alexa answers from Tend's shared care record and can log doses, track supply and request refills, always as you."));
}

function suggestions() {
  const d = state.data;
  const out = [];
  const alias = (name) => d?.recipients.find((r) => r.name === name)?.aliases[0] ?? name;
  if (d) {
    const pending = d.status.pendingActions[0];
    if (pending) out.push("Yes, go ahead");
    const open = d.status.people.flatMap((p) => p.slots.filter((s) => s.state === "due" || s.state === "missed").map((s) => ({ p: p.name, s })))[0];
    if (open && canWrite()) out.push(`I just gave ${alias(open.p)} ${alias(open.p) === "Mom" ? "her" : alias(open.p) === "Dad" ? "his" : "the"} ${open.s.medication.split(" ")[0].toLowerCase()}`);
    out.push(`Did ${alias(d.recipients[0]?.name)} take ${alias(d.recipients[0]?.name) === "Dad" ? "his" : "her"} pills today?`);
    const crit = d.forecast.find((f) => f.urgency !== "ok" && !f.openRefillRequest);
    if (crit && canWrite()) out.push(`Reorder ${alias(crit.personName)}'s ${crit.medication.split(" ")[0].toLowerCase()}`);
  }
  out.push("When will we run out of anything?", "Give me the handoff for this week");
  if (canWrite()) out.push("Note that Dad felt dizzy after lunch");
  return [...new Set(out)].slice(0, 4);
}

export function renderSuggestions() {
  if (!els) return;
  els.suggestions.replaceChildren(...suggestions().map((t) => h("button", { class: "suggestion", type: "button", onclick: () => send(t) }, t)));
}

function addUser(text) {
  els.transcript.querySelector(".rail-empty")?.remove();
  els.transcript.append(h("div", { class: "turn-u" }, h("div", { class: "speaker" }, actor()?.name ?? "You"), h("p", {}, text)));
}

function addAssistant(text, cls = "") {
  const el = h("div", { class: `turn-a ${cls}` }, h("div", { class: "speaker" }, "Alexa"), h("p", {}, text));
  els.transcript.append(el);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  return el;
}

function speak(text) {
  if (!els.tts.checked || !("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.02;
  speechSynthesis.speak(u);
}

export async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  busy = true;
  els.mic.classList.add("busy");
  els.sendBtn.disabled = true;
  addUser(text);
  const thinking = addAssistant("Checking Tend…", "thinking");
  try {
    const turn = await agentTurn(text, sessionId);
    thinking.remove();
    const el = addAssistant(turn.reply);
    if (turn.engineNote) el.append(h("div", { class: "engine-note" }, turn.engineNote));
    const meta = h("div", { class: "turn-meta" },
      turn.tools.map((t) => h("span", { class: `tool-pill ${t.blockedByHost ? "blocked" : ""}`, title: t.blockedByHost ?? "" }, t.name)),
      h("span", {}, `${turn.ms} ms`),
      h("a", { href: "#/developer", onclick: () => { sessionStorage.setItem("tend.devtab", "turns"); } }, "Trace"));
    el.append(meta);
    for (const card of turn.cards ?? []) mountCard(el, card);
    speak(turn.reply);
    await refresh("assistant");
  } catch (err) {
    thinking.remove();
    addAssistant(err.message, "error");
  } finally {
    busy = false;
    els.mic.classList.remove("busy");
    els.sendBtn.disabled = false;
    els.transcript.scrollTop = els.transcript.scrollHeight;
  }
}

// ---------- MCP Apps host (io.modelcontextprotocol/ui, 2026-01-26) ----------
const VIEW_TOOLS = new Set(["log_dose", "get_care_status", "forecast_refills", "get_handoff_report"]);

function mountCard(parent, card) {
  const frame = h("iframe", { sandbox: "allow-scripts", src: "sandbox-proxy.html", title: `${card.toolName} card` });
  parent.append(h("div", { class: "app-card" }, frame));
  const actorAtMount = state.actorId;
  const writer = state.config.caregivers.find((c) => c.id === actorAtMount)?.role === "caregiver";
  const post = (msg) => frame.contentWindow?.postMessage(msg, "*");
  const onMessage = async (event) => {
    if (!frame.isConnected) { window.removeEventListener("message", onMessage); return; }
    if (event.source !== frame.contentWindow) return;
    const msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    switch (msg.method) {
      case "ui/notifications/sandbox-proxy-ready":
        post({ jsonrpc: "2.0", method: "ui/notifications/sandbox-resource-ready", params: { html: card.html } });
        return;
      case "ui/initialize":
        post({
          jsonrpc: "2.0", id: msg.id, result: {
            protocolVersion: "2026-01-26",
            hostInfo: { name: "tend-alexa-plus-simulator", version: "0.2.0" },
            // Only caregivers get in-card actions; view-only users see a read-only card.
            hostCapabilities: { ...(writer ? { serverTools: {} } : {}), sandbox: { csp: { connectDomains: [], resourceDomains: [] } } },
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
      case "tools/call":
        if (!VIEW_TOOLS.has(msg.params?.name)) {
          post({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Tool not available to this view" } });
          return;
        }
        try {
          const result = await client(actorAtMount).callTool(msg.params.name, msg.params.arguments, "card");
          post({ jsonrpc: "2.0", id: msg.id, result });
          if (msg.params.name === "log_dose") await refresh("card");
        } catch (err) {
          post({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: err.message } });
        }
        return;
      default:
        if (msg.id !== undefined && msg.method) post({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
  };
  window.addEventListener("message", onMessage);
}

// ---------- voice ----------
function setupMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    els.mic.disabled = true;
    els.mic.title = "Voice input needs Chrome or Edge. Type instead.";
    return;
  }
  const rec = new SR();
  rec.lang = "en-US";
  rec.interimResults = true;
  let listening = false;
  let finalText = "";
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    els.input.value = finalText || interim;
  };
  rec.onend = () => {
    listening = false;
    els.mic.classList.remove("listening");
    els.mic.setAttribute("aria-pressed", "false");
    const text = finalText.trim();
    finalText = "";
    if (text) { els.input.value = ""; send(text); }
  };
  rec.onerror = (e) => {
    if (e.error === "not-allowed") toast("Microphone access is blocked. Type instead.", "error");
  };
  els.mic.addEventListener("click", () => {
    if (busy) return;
    if (listening) { rec.stop(); return; }
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    finalText = "";
    listening = true;
    els.mic.classList.add("listening");
    els.mic.setAttribute("aria-pressed", "true");
    rec.start();
  });
}

export function mountAssistant(rail, { onClose }) {
  const input = h("input", { maxlength: 500, placeholder: "Ask Alexa about the family's care…", "aria-label": "Message Alexa" });
  const sendBtn = h("button", { class: "send", type: "submit", "aria-label": "Send" }, icon("send"));
  const mic = h("button", { class: "mic", type: "button", "aria-label": "Talk to Alexa", "aria-pressed": "false" }, icon("mic", "lg"));
  const tts = h("input", { type: "checkbox", checked: true });
  const transcript = h("div", { class: "transcript", "aria-live": "polite" }, emptyState());
  const suggestionsEl = h("div", { class: "suggestions", "aria-label": "Suggested requests" });
  const engineSub = h("div", { class: "sub" });
  els = { input, sendBtn, mic, tts, transcript, suggestions: suggestionsEl, engineSub };
  rail.replaceChildren(
    h("div", { class: "rail-head" },
      h("div", {}, h("div", { class: "title" }, "Alexa+"), engineSub),
      h("button", { class: "icon-btn", type: "button", "aria-label": "Hide Alexa panel", title: "Hide", onclick: onClose }, icon("close", "sm"))),
    transcript,
    suggestionsEl,
    h("div", { class: "composer" }, mic, h("form", { onsubmit: (e) => { e.preventDefault(); const t = input.value; input.value = ""; send(t); } }, input, sendBtn)),
    h("div", { class: "rail-foot" }, h("label", {}, tts, "Speak replies"), h("button", { type: "button", onclick: newSession }, "New conversation")));
  setupMic();
  updateEngine();
  renderSuggestions();
}

export function updateEngine() {
  if (!els) return;
  const cfg = state.config;
  els.engineSub.textContent = cfg.engine === "bedrock"
    ? `Tend add-on · Amazon Bedrock${cfg.guardrail ? " + Guardrails" : ""} · simulated device`
    : "Tend add-on · offline router (no LLM) · simulated device";
}

export function focusInput() {
  els?.input.focus();
}
