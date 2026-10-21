// Deterministic intent router used when Bedrock is not configured (and in
// tests). It is deliberately simple and labelled "offline" in the UI. It still
// goes through the real MCP client, so every action is a genuine tools/call.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { speechOf } from "./mcpClient.ts";

export interface OfflineSession {
  pendingActionId?: string;
  lastDuplicate?: { medication: string; person?: string; slot_time: string };
}

interface Recipient {
  name: string;
  aliases: string[];
  medications: { name: string; label: string }[];
}

export const AFFIRMATIVE = /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|confirm(ed)?|go ahead|do it|please do|that's right|correct)\b/i;
export const NEGATIVE = /^\s*(no|nope|cancel|don't|do not|stop|never ?mind|not now)\b/i;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const has = (text: string, word: string) => new RegExp(`\\b${escape(word.toLowerCase())}\\b`).test(text);

function findPerson(text: string, people: Recipient[]): string | undefined {
  for (const p of people) {
    for (const n of [p.name, ...p.aliases]) if (n && has(text, n)) return p.name;
  }
  return undefined;
}

function findMed(text: string, people: Recipient[], person?: string): string | undefined {
  const pool = people.filter((p) => !person || p.name === person).flatMap((p) => p.medications);
  const hit = pool.find((m) => has(text, m.name));
  return hit?.name;
}

export function parseSlotTime(text: string): string | undefined {
  const m = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i.exec(text) ?? /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(text);
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.toLowerCase().replace(/\./g, "");
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return undefined;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export async function runOffline(
  userText: string,
  session: OfflineSession,
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>,
): Promise<string> {
  const text = userText.toLowerCase().trim();
  const recipients = (await callTool("list_care_recipients", {})).structuredContent as { people: Recipient[] } | undefined;
  const people = recipients?.people ?? [];
  const person = findPerson(text, people);
  const med = findMed(text, people, person);
  const isQuestion = /^(did|has|have|what|when|is|are|how|who|which|can|do)\b/.test(text) || text.endsWith("?");

  // Follow-ups to a pending refill or a double-dose warning.
  if (session.pendingActionId && (AFFIRMATIVE.test(text) || NEGATIVE.test(text))) {
    const id = session.pendingActionId;
    session.pendingActionId = undefined;
    const r = await callTool(AFFIRMATIVE.test(text) ? "confirm_action" : "cancel_action", { action_id: id });
    const extra = r.structuredContent && typeof r.structuredContent.pharmacyMessage === "string" ? ` Here's the draft: ${r.structuredContent.pharmacyMessage}` : "";
    return speechOf(r) + extra;
  }
  if (session.lastDuplicate && AFFIRMATIVE.test(text) && /\b(extra|second|again|really|did)\b/.test(text)) {
    const d = session.lastDuplicate;
    session.lastDuplicate = undefined;
    return speechOf(await callTool("log_dose", { ...d, confirm_duplicate: true }));
  }
  session.lastDuplicate = undefined;

  if (/\b(refill|reorder|order more|request more)\b/.test(text) && med && !/\b(when|how long|run out|status)\b/.test(text)) {
    const r = await callTool("request_refill", { medication: med, ...(person ? { person } : {}) });
    if (!r.isError && typeof r.structuredContent?.actionId === "string") session.pendingActionId = r.structuredContent.actionId;
    return speechOf(r);
  }
  if (/\b(run(ning)? out|running low|supply|left in the bottle|days left|forecast|refills?)\b/.test(text)) {
    return speechOf(await callTool("forecast_refills", person ? { person } : {}));
  }
  const pickup = /\b(picked up|pick(ed)? up|got|collected)\b.*?\b(\d{1,4})\b/.exec(text);
  if (pickup && med) {
    return speechOf(await callTool("record_refill_pickup", { medication: med, quantity: Number(pickup[3]), ...(person ? { person } : {}) }));
  }
  if (/\b(handoff|hand off|hand over|summary|report|recap|catch me up|this week|past week|how has|how's .* been)\b/.test(text)) {
    return speechOf(await callTool("get_handoff_report", person ? { person } : {}));
  }
  if (/\b(note|noticed|felt|feeling|seems|seemed|complained|dizzy|tired|pain|nause|appointment)\b/.test(text) && !isQuestion) {
    const noteText = userText.replace(/^\s*(please\s+)?(add a |make a |take a )?note( that| for \w+)?[:,]?\s*/i, "").trim();
    const category = /\bappointment\b/.test(text) ? "appointment" : /\b(dizzy|pain|nause|tired|fever|cough|felt|feeling)\b/.test(text) ? "symptom" : "observation";
    return speechOf(await callTool("add_care_note", { text: noteText || userText, category, ...(person ? { person } : {}) }));
  }
  if (med && !isQuestion && /\b(skip|skipped|didn't take|did not take|refused|missed)\b/.test(text)) {
    const slot = parseSlotTime(text);
    return speechOf(await callTool("log_dose", { medication: med, status: "skipped", ...(person ? { person } : {}), ...(slot ? { slot_time: slot } : {}) }));
  }
  if (med && !isQuestion && /\b(took|taken|take|gave|given|had|swallowed|done with)\b/.test(text)) {
    const slot = parseSlotTime(text);
    const r = await callTool("log_dose", { medication: med, ...(person ? { person } : {}), ...(slot ? { slot_time: slot } : {}) });
    if (r.structuredContent?.outcome === "needs_confirmation") {
      session.lastDuplicate = { medication: med, ...(person ? { person } : {}), slot_time: String(r.structuredContent.slotTime) };
    }
    return speechOf(r);
  }
  if (/\b(who|activity|lately|recently)\b/.test(text) && !/\b(take|took|taken)\b/.test(text)) {
    return speechOf(await callTool("get_recent_activity", { limit: 5 }));
  }
  if (/\b(did|has|have|status|today|due|meds|medicine|medication|pills?|left to take|next)\b/.test(text)) {
    return speechOf(await callTool("get_care_status", person ? { person } : {}));
  }
  return "I can log a dose, tell you what's due today, forecast refills, request a refill, take a care note, or give you a handoff summary. What would you like?";
}
