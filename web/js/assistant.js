// The Alexa+ companion: a simulated Alexa+ surface whose host agent talks to
// Tend over MCP. The orb reflects only real events (microphone, request in
// flight, speech playing). Replies can carry MCP Apps cards, rendered through
// the spec's sandbox proxy, and every turn refreshes the caregiver dashboard.
import { state, agentTurn, resetAgent, refresh, client, actor, canWrite } from "./api.js";
import { h, icon, toast } from "./ui.js";
import { createOrb } from "./orb.js";

let els;
let orb;
let busy = false;
let lastText = "";
let sessionId = newId();
let speaking = false;
/** Other orbs on the page (the empty-state orb, the "Ask Alexa+" button) mirror the assistant's real state. */
const mirrors = new Set();
let emptyOrb = null;

// What a caregiver needs to know about each tool, in their language.
const ACTIVITY = {
  get_care_status: "Checked today's doses",
  forecast_refills: "Checked supply",
  get_handoff_report: "Read the handoff report",
  get_recent_activity: "Checked recent activity",
  log_dose: "Updated the dose record",
  request_refill: "Prepared a refill request",
  confirm_action: "Confirmed the request",
  cancel_action: "Cancelled the request",
  record_refill_pickup: "Updated supply",
  add_care_note: "Saved a note",
  add_medication: "Added a medication",
};

function newId() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function newSession() {
  stopSpeaking();
  void resetAgent(sessionId);
  sessionId = newId();
  if (els) {
    els.transcript.replaceChildren(emptyState());
    renderSuggestions();
  }
}

function engineLabel() {
  const cfg = state.config;
  return cfg.engine === "bedrock" ? `Amazon Bedrock${cfg.guardrail ? " + Guardrails" : ""}` : "offline router, no LLM";
}

export function mirrorOrb(o) {
  mirrors.add(o);
  if (orb) o.set(orb.state === "success" ? "idle" : orb.state);
}

function setOrb(next) {
  orb.set(next);
  for (const m of mirrors) m.set(next);
  if (emptyOrb?.el.isConnected) emptyOrb.set(next);
  els.orbBtn.dataset.state = next;
  const text = {
    idle: `Ready · ${engineLabel()}`,
    listening: "Listening…",
    thinking: "Checking the care record…",
    speaking: "Speaking…",
    success: `Ready · ${engineLabel()}`,
    error: "Couldn't complete that",
    unavailable: "Unavailable",
  }[next];
  els.status.textContent = text;
  els.status.dataset.state = next;
  els.stop.hidden = next !== "speaking";
}

/** Transient acknowledgement (success/error) that returns to rest unless something else took over. */
function flashOrb(next, ms = 1400) {
  setOrb(next);
  setTimeout(() => { if (orb.state === next) setOrb("idle"); }, ms);
}

function emptyState() {
  emptyOrb = createOrb(96);
  if (orb) emptyOrb.set(orb.state);
  return h("div", { class: "rail-empty" },
    emptyOrb.el,
    h("div", { class: "display" }, "How can I help with today's care?"),
    h("p", {}, "Ask out loud or type. Answers come from Tend's shared care record, and anything I change is saved as you."));
}

function suggestions() {
  const d = state.data;
  const out = [];
  const alias = (name) => d?.recipients.find((r) => r.name === name)?.aliases[0] ?? name;
  const poss = (name) => ({ Mom: "her", Dad: "his" }[alias(name)] ?? "their");
  if (d) {
    if (d.status.pendingActions[0] && canWrite()) out.push("Yes, go ahead");
    const open = d.status.people.flatMap((p) => p.slots.filter((s) => s.state === "due" || s.state === "missed").map((s) => ({ p: p.name, s })))[0];
    if (open && canWrite()) out.push(`I just gave ${alias(open.p)} ${poss(open.p)} ${open.s.medication.split(" ")[0].toLowerCase()}`);
    const first = d.recipients[0]?.name;
    if (first) out.push(`What does ${alias(first)} need to take today?`);
    const crit = d.forecast.find((f) => f.urgency !== "ok" && !f.openRefillRequest && f.refillsRemaining > 0);
    if (crit && canWrite()) out.push(`Reorder ${alias(crit.personName)}'s ${crit.medication.split(" ")[0].toLowerCase()}`);
  }
  out.push("Is anything running low?", "Give me this week's handoff");
  const started = els?.transcript.querySelector(".turn-u");
  return [...new Set(out)].slice(0, started ? 3 : 4);
}

export function renderSuggestions() {
  if (!els) return;
  els.suggestions.replaceChildren(...suggestions().map((t) => h("button", { class: "suggestion", type: "button", onclick: () => send(t) }, t)));
}

function addUser(text) {
  els.transcript.querySelector(".rail-empty")?.remove();
  els.transcript.append(h("div", { class: "turn-u msg-in" }, h("div", { class: "speaker" }, actor()?.name ?? "You"), h("p", {}, text)));
  scrollDown();
}

function addAssistant(text, cls = "") {
  const el = h("div", { class: `turn-a msg-in ${cls}` }, h("div", { class: "speaker" }, "Alexa"), h("p", {}, text));
  els.transcript.append(el);
  scrollDown();
  return el;
}

function scrollDown() {
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

// ---------- speech ----------
function stopSpeaking() {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  if (speaking) {
    speaking = false;
    if (orb) setOrb("idle");
  }
}

function speak(text) {
  if (!els.tts.checked || !("speechSynthesis" in window) || !text) return false;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.98;
  u.pitch = 1;
  const voice = speechSynthesis.getVoices().find((v) => /en[-_](US|GB|IN)/i.test(v.lang) && /natural|neural|online/i.test(v.name))
    ?? speechSynthesis.getVoices().find((v) => /^en/i.test(v.lang));
  if (voice) u.voice = voice;
  u.onstart = () => { speaking = true; setOrb("speaking"); };
  u.onboundary = () => { orb.pulse(); if (emptyOrb?.el.isConnected) emptyOrb.pulse(); };
  u.onend = () => { if (speaking) { speaking = false; setOrb("idle"); } };
  u.onerror = () => { speaking = false; setOrb("idle"); };
  speechSynthesis.speak(u);
  return true;
}

// ---------- a turn ----------
export async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  stopSpeaking();
  busy = true;
  lastText = text;
  els.sendBtn.disabled = true;
  addUser(text);
  setOrb("thinking");
  const pending = h("div", { class: "turn-a thinking msg-in", "aria-hidden": "true" }, h("div", { class: "speaker" }, "Alexa"), h("p", {}, "Checking the care record…"));
  els.transcript.append(pending);
  scrollDown();
  try {
    const turn = await agentTurn(text, sessionId);
    pending.remove();
    const el = addAssistant(turn.reply);
    if (turn.engineNote) el.append(h("div", { class: "engine-note" }, turn.engineNote));
    const did = [...new Set(turn.tools.filter((t) => ACTIVITY[t.name] && !t.isError).map((t) => ACTIVITY[t.name]))];
    const blocked = turn.tools.some((t) => t.blockedByHost);
    el.append(h("div", { class: "turn-meta" },
      did.map((d) => h("span", { class: "did" }, icon("check", "sm"), d)),
      blocked ? h("span", { class: "did warn" }, icon("shield", "sm"), "Waited for your confirmation") : null,
      h("a", { href: "#/developer", onclick: () => { try { sessionStorage.setItem("tend.devtab", "turns"); } catch { /* ignore */ } } }, "Trace")));
    for (const card of turn.cards ?? []) mountCard(el, card);
    const wrote = turn.tools.some((t) => !t.isError && ["log_dose", "confirm_action", "add_care_note", "record_refill_pickup", "add_medication"].includes(t.name));
    // Settle the orb first; it switches to "speaking" only if the utterance really starts.
    if (wrote) flashOrb("success");
    else setOrb("idle");
    speak(turn.speech ?? turn.reply);
    scrollDown();
    await refresh("assistant");
  } catch (err) {
    pending.remove();
    const el = addAssistant(`I couldn't complete that. ${err.message}`, "error");
    el.append(h("div", { class: "turn-meta" }, h("button", { class: "retry", type: "button", onclick: () => send(lastText) }, icon("refresh", "sm"), "Try again")));
    flashOrb("error", 2600);
  } finally {
    busy = false;
    els.sendBtn.disabled = false;
    renderSuggestions();
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
            hostInfo: { name: "tend-alexa-plus-simulator", version: "0.3.0" },
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

// ---------- voice input ----------
// Live microphone level for the listening orb. It runs only while speech
// recognition is actually listening, and only when microphone permission is
// already granted, so it never causes a second prompt. Without it the orb
// falls back to its CSS listening animation.
let meter = null;
let meterWanted = false;
const allOrbs = () => [orb, ...mirrors, ...(emptyOrb?.el.isConnected ? [emptyOrb] : [])];

async function startMeter() {
  meterWanted = true;
  if (meter || matchMedia("(prefers-reduced-motion: reduce)").matches || !navigator.mediaDevices?.getUserMedia) return;
  try {
    const perm = await navigator.permissions?.query({ name: "microphone" });
    if (perm?.state !== "granted" || !meterWanted) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!meterWanted) { stream.getTracks().forEach((t) => t.stop()); return; }
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    const m = { stream, ctx, raf: 0, level: 0 };
    meter = m;
    const tick = () => {
      if (meter !== m) return;
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      // Fast attack, slow release, so the ring follows speech without flicker.
      m.level = Math.max(Math.min(1, Math.sqrt(sum / buf.length) * 5), m.level * 0.86);
      for (const o of allOrbs()) if (o.state === "listening") o.level(m.level);
      m.raf = requestAnimationFrame(tick);
    };
    tick();
  } catch { /* no meter: the CSS listening animation is used instead */ }
}

function stopMeter() {
  meterWanted = false;
  if (!meter) return;
  cancelAnimationFrame(meter.raf);
  meter.stream.getTracks().forEach((t) => t.stop());
  meter.ctx.close().catch(() => {});
  meter = null;
  for (const o of allOrbs()) { o.level(null); o.voice(false); }
}

function setupMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    els.orbBtn.setAttribute("aria-disabled", "true");
    els.orbBtn.title = "Voice input needs Chrome or Edge. Type your question instead.";
    els.orbBtn.addEventListener("click", () => {
      if (speaking) { stopSpeaking(); return; }
      els.input.focus();
      toast("Voice input isn't available in this browser. Type instead.");
    });
    return;
  }
  const rec = new SR();
  rec.lang = "en-US";
  rec.interimResults = true;
  let listening = false;
  let finalText = "";
  rec.onstart = () => { listening = true; setOrb("listening"); els.orbBtn.setAttribute("aria-pressed", "true"); startMeter(); };
  rec.onspeechstart = () => { for (const o of allOrbs()) o.voice(true); };
  rec.onspeechend = () => { for (const o of allOrbs()) o.voice(false); };
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
    stopMeter();
    els.orbBtn.setAttribute("aria-pressed", "false");
    const text = finalText.trim();
    finalText = "";
    if (text) { els.input.value = ""; send(text); } else if (!busy) setOrb("idle");
  };
  rec.onerror = (e) => {
    listening = false;
    stopMeter();
    setOrb("idle");
    if (e.error === "not-allowed" || e.error === "service-not-allowed") toast("Microphone access is blocked. Type instead.", "error");
    else if (e.error === "no-speech") toast("I didn't hear anything. Tap the orb and try again.");
  };
  els.orbBtn.addEventListener("click", () => {
    if (busy) return;
    if (speaking) { stopSpeaking(); return; }
    if (listening) { rec.stop(); return; }
    finalText = "";
    try { rec.start(); } catch { /* already starting */ }
  });
}

export function mountAssistant(rail, { onClose }) {
  orb = createOrb(54);
  const input = h("input", { maxlength: 500, placeholder: "Ask about today's care…", "aria-label": "Message Alexa" });
  const sendBtn = h("button", { class: "send", type: "submit", "aria-label": "Send" }, icon("send"));
  const orbBtn = h("button", { class: "orb-btn", type: "button", "aria-label": "Talk to Alexa (tap again to stop)", "aria-pressed": "false" }, orb.el, icon("mic", "orb-mic"));
  const tts = h("input", { type: "checkbox", checked: true });
  tts.addEventListener("change", () => { if (!tts.checked) stopSpeaking(); });
  const transcript = h("div", { class: "transcript", "aria-live": "polite", "aria-relevant": "additions" }, emptyState());
  const suggestionsEl = h("div", { class: "suggestions", "aria-label": "Suggested requests" });
  const status = h("div", { class: "rail-status", role: "status" });
  const stop = h("button", { class: "rail-stop", type: "button", hidden: true, onclick: stopSpeaking }, icon("close", "sm"), "Stop speaking");
  els = { input, sendBtn, orbBtn, tts, transcript, suggestions: suggestionsEl, status, stop };
  rail.replaceChildren(
    h("div", { class: "rail-head" },
      h("div", {}, h("div", { class: "title" }, "Alexa+ ", h("span", { class: "title-sub" }, "· Tend add-on")), status),
      stop,
      h("button", { class: "icon-btn", type: "button", "aria-label": "Hide Alexa panel", title: "Hide", onclick: onClose }, icon("close", "sm"))),
    transcript,
    suggestionsEl,
    h("div", { class: "composer" }, orbBtn, h("form", { onsubmit: (e) => { e.preventDefault(); const t = input.value; input.value = ""; send(t); } }, input, sendBtn)),
    h("div", { class: "rail-foot" },
      h("label", {}, tts, "Speak replies"),
      h("span", { class: "rail-sim" }, "Simulated device"),
      h("button", { type: "button", onclick: newSession }, "New conversation")));
  setOrb("idle");
  setupMic();
  renderSuggestions();
}

export function updateEngine() {
  if (orb && els && (orb.state === "idle" || orb.state === "success")) setOrb("idle");
}

export function setAvailability(ok) {
  if (!orb) return;
  if (!ok) setOrb("unavailable");
  else if (orb.state === "unavailable") setOrb("idle");
}

export function focusInput() {
  els?.input.focus();
}
