// Tend's MCP surface. One McpServer is built per request for the
// authenticated caregiver (stateless Streamable HTTP), so the tool list
// itself reflects their role: view-only members never see write tools.
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CareError } from "../domain/care.ts";
import type { Actor, CareService, ForecastItem, HandoffReport, StatusResult } from "../domain/care.ts";
import { formatDateLong, formatTime12 } from "../domain/time.ts";
import * as out from "./schemas.ts";

export const SERVER_NAME = "tend-care";
export const SERVER_VERSION = "0.1.0";
export const CARE_BOARD_URI = "ui://tend/care-board";
export const MCP_APP_MIME = "text/html;profile=mcp-app";

const careBoardHtml = readFileSync(new URL("./ui/care-board.html", import.meta.url), "utf8");

const INSTRUCTIONS = `Tend keeps a shared, persistent medication and care log for a family's care circle (for example siblings looking after a parent).
Voice-first: keep spoken replies to one to three short sentences and use the "speech" text returned by each tool.
Rules:
- Never give medical advice (dosing changes, interactions, diagnoses). Suggest the pharmacist or doctor instead.
- log_dose may return outcome "needs_confirmation" when the dose was already logged by someone else. Relay the warning; only retry with confirm_duplicate=true if the user explicitly says an extra dose was really given.
- request_refill only creates a pending action. Read its summary to the user and call confirm_action ONLY after the user clearly says yes in their next turn. Otherwise call cancel_action.
- If a person or medication is ambiguous, ask a short clarifying question instead of guessing.`;

type ToolOk = CallToolResult & { structuredContent: Record<string, unknown> };

function ok(speech: string, data: Record<string, unknown>): ToolOk {
  return {
    content: [
      { type: "text", text: speech },
      { type: "text", text: JSON.stringify(data) },
    ],
    structuredContent: data,
  };
}

function fail(err: unknown): CallToolResult {
  if (err instanceof CareError) {
    return { isError: true, content: [{ type: "text", text: `${err.code}: ${err.message}` }] };
  }
  // Never leak internals (stack traces, SQL) to the model or client.
  console.error("[tend] unexpected tool error", err);
  return { isError: true, content: [{ type: "text", text: "INTERNAL: Something went wrong on the Tend server. Please try again." }] };
}

function guarded<A>(fn: (args: A) => ToolOk): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return fn(args);
    } catch (err) {
      return fail(err);
    }
  };
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function speakStatus(s: StatusResult): string {
  if (s.people.length === 0) return "No one is set up in Tend yet.";
  const parts: string[] = [];
  for (const p of s.people) {
    if (p.slots.length === 0) {
      parts.push(`${p.name} has nothing scheduled.`);
      continue;
    }
    const by = (state: string) => p.slots.filter((x) => x.state === state).map((x) => `${x.timeLabel} ${x.medication}`);
    const taken = by("taken");
    const missed = by("missed");
    const due = by("due");
    const upcoming = by("upcoming");
    const bits: string[] = [];
    if (missed.length) bits.push(`missed ${list(missed)}`);
    if (due.length) bits.push(`${list(due)} ${due.length === 1 ? "is" : "are"} due now`);
    if (taken.length) bits.push(`${taken.length} of ${p.slots.length} doses are logged`);
    if (upcoming.length) bits.push(`next is ${upcoming[0]}`);
    parts.push(`${p.name}: ${bits.join("; ")}.`);
  }
  const critical = s.supplyAlerts.filter((a) => a.urgency === "critical");
  if (critical.length) parts.push(`Running low: ${list(critical.map((c) => `${c.personName}'s ${c.medication}, ${c.daysLeft} days left`))}.`);
  return parts.join(" ");
}

export function speakForecast(items: ForecastItem[], within: number): string {
  const low = items.filter((i) => i.urgency !== "ok");
  if (low.length === 0) return `Everyone has more than ${within} days of every medication.`;
  return low
    .map((i) => `${i.personName}'s ${i.medication} runs out in ${i.daysLeft} day${i.daysLeft === 1 ? "" : "s"}, around ${formatDateLong(i.runoutDate)}. ${i.advice}`)
    .join(" ");
}

export function speakHandoff(r: HandoffReport): string {
  const parts: string[] = [`Here's the last ${r.days} day${r.days === 1 ? "" : "s"}.`];
  for (const p of r.people) {
    const pct = p.overallAdherencePct === null ? "no doses due yet" : `${p.overallAdherencePct}% of doses taken`;
    let line = `${p.name}: ${pct}`;
    if (p.missedDoses.length) {
      const counts = new Map<string, number>();
      for (const m of p.missedDoses) counts.set(m.medication, (counts.get(m.medication) ?? 0) + 1);
      line += `, missed ${list([...counts].map(([med, n]) => `${med} ${n === 1 ? "once" : `${n} times`}`))}`;
    }
    line += ".";
    if (p.notes.length) line += ` Latest note: ${p.notes[p.notes.length - 1]!.text.replace(/[.!?\s]+$/, "")}.`;
    parts.push(line);
  }
  if (r.supplyAlerts.length) parts.push(`Low supply: ${list(r.supplyAlerts.map((a) => `${a.personName}'s ${a.medication} (${a.daysLeft} days)`))}.`);
  if (r.openRefillRequests.length) parts.push(`${r.openRefillRequests.length} refill request${r.openRefillRequests.length === 1 ? " is" : "s are"} open.`);
  return parts.join(" ");
}

const personArg = z.string().min(1).max(80).optional().describe('Who the care is for: a name or alias such as "Mom" or "Lakshmi". Optional when only one person is tracked or the medication name is unique.');
const medArg = z.string().min(1).max(80).describe('Medication name as the user said it, e.g. "metformin".');

export function buildMcpServer(care: CareService, actor: Actor): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: "Tend: Care Circle" },
    { instructions: INSTRUCTIONS, capabilities: { tools: {}, resources: {} } },
  );
  const canWrite = actor.role === "caregiver";
  const uiMeta = { ui: { resourceUri: CARE_BOARD_URI } };

  // ---- MCP Apps view (renders status / forecast / handoff results as an interactive card) ----
  server.registerResource(
    "care-board",
    CARE_BOARD_URI,
    { title: "Tend care board", description: "Interactive card for Tend status, refill and handoff results.", mimeType: MCP_APP_MIME },
    async () => ({
      contents: [
        {
          uri: CARE_BOARD_URI,
          mimeType: MCP_APP_MIME,
          text: careBoardHtml,
          _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
        },
      ],
    }),
  );

  // ---- read tools ----
  server.registerTool(
    "list_care_recipients",
    {
      title: "List care recipients",
      description: "List the people in this care circle and their active medications, schedules and supply. Use it to resolve names like 'Mom' before acting.",
      inputSchema: {},
      outputSchema: out.recipientsOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(() => {
      const people = care.listRecipients();
      const speech = people.length
        ? people.map((p) => `${p.name} takes ${list(p.medications.map((m) => m.label)) || "nothing yet"}.`).join(" ")
        : "No one is set up yet.";
      return ok(speech, { people });
    }),
  );

  server.registerTool(
    "get_care_status",
    {
      title: "Today's care status",
      description: "What's been taken, missed, due now and coming up for a day (default today), plus low-supply alerts and pending confirmations. Answers 'Did Mom take her pills?'",
      inputSchema: {
        person: personArg,
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Local date YYYY-MM-DD; defaults to today in the household timezone."),
      },
      outputSchema: out.statusOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: uiMeta,
    },
    guarded((args: { person?: string; date?: string }) => {
      const s = care.getStatus(args);
      return ok(speakStatus(s), { ...s });
    }),
  );

  server.registerTool(
    "forecast_refills",
    {
      title: "Forecast refills",
      description: "Compute when each medication runs out from stock on hand and the dose schedule, and what to do about it.",
      inputSchema: {
        person: personArg,
        within_days: z.number().int().min(1).max(60).optional().describe("Flag medications running out within this many days (default 7)."),
      },
      outputSchema: out.forecastOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: uiMeta,
    },
    guarded((args: { person?: string; within_days?: number }) => {
      const within = args.within_days ?? 7;
      const items = care.forecastRefills({ person: args.person, withinDays: within });
      return ok(speakForecast(items, within), { withinDays: within, items });
    }),
  );

  server.registerTool(
    "get_handoff_report",
    {
      title: "Caregiver handoff report",
      description: "Summarize adherence, missed doses, observations, supply alerts and open refills over recent days, for handing care over to another family member or a doctor visit.",
      inputSchema: {
        person: personArg,
        days: z.number().int().min(1).max(31).optional().describe("How many days to cover (default 7)."),
      },
      outputSchema: out.handoffOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: uiMeta,
    },
    guarded((args: { person?: string; days?: number }) => {
      const r = care.handoffReport(args);
      return ok(speakHandoff(r), { ...r });
    }),
  );

  server.registerTool(
    "get_recent_activity",
    {
      title: "Recent care-circle activity",
      description: "Who did what recently across the care circle (doses logged, notes, refill requests).",
      inputSchema: { limit: z.number().int().min(1).max(50).optional() },
      outputSchema: { items: z.array(z.object({ at: z.string(), actor: z.string(), kind: z.string(), message: z.string() })) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded((args: { limit?: number }) => {
      const items = care.recentActivity(args.limit ?? 10);
      const speech = items.length ? items.slice(0, 3).map((i) => i.message).join(" ") : "No activity yet.";
      return ok(speech, { items });
    }),
  );

  if (!canWrite) return server;

  // ---- write tools (caregivers only) ----
  server.registerTool(
    "log_dose",
    {
      title: "Log a dose",
      description: "Record that a scheduled dose was taken (default) or skipped. The dose is matched to the nearest scheduled time. If that dose was already logged as taken, nothing is saved and outcome is 'needs_confirmation' (double-dose guard).",
      inputSchema: {
        medication: medArg,
        person: personArg,
        status: z.enum(["taken", "skipped"]).optional().describe("Default 'taken'."),
        slot_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe("Scheduled slot HH:MM if the user named one, e.g. 'her 8 PM dose' -> 20:00."),
        taken_at: z.iso.datetime({ offset: true }).optional().describe("ISO time the dose was actually taken, if not just now. Max 36 hours ago."),
        confirm_duplicate: z.boolean().optional().describe("Only true if the user explicitly confirms a second dose for the same slot was really given."),
        note: z.string().max(300).optional(),
      },
      outputSchema: out.logDoseOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded((a: { medication: string; person?: string; status?: "taken" | "skipped"; slot_time?: string; taken_at?: string; confirm_duplicate?: boolean; note?: string }) => {
      const r = care.logDose(
        { medication: a.medication, person: a.person, status: a.status, slotTime: a.slot_time, at: a.taken_at, confirmDuplicate: a.confirm_duplicate, note: a.note },
        actor,
      );
      return ok(r.message, { ...r });
    }),
  );

  server.registerTool(
    "request_refill",
    {
      title: "Request a refill (step 1 of 2)",
      description: "Prepare a refill request. This does NOT send anything: it returns a pending action with a summary that must be read to the user. Call confirm_action only after the user explicitly agrees.",
      inputSchema: { medication: medArg, person: personArg },
      outputSchema: out.pendingOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    guarded((a: { medication: string; person?: string }) => {
      const p = care.requestRefill(a, actor);
      return ok(`${p.summary} Should I go ahead?`, { ...p, requiresConfirmation: true as const });
    }),
  );

  server.registerTool(
    "confirm_action",
    {
      title: "Confirm a pending action (step 2 of 2)",
      description: "Execute a pending action created by request_refill. Only call this after the user has explicitly said yes to the summary. Pending actions expire after 15 minutes and can be confirmed once.",
      inputSchema: { action_id: z.uuid().describe("actionId returned by request_refill.") },
      outputSchema: out.confirmOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    guarded((a: { action_id: string }) => {
      const r = care.confirmAction({ actionId: a.action_id }, actor);
      return ok(r.message, { ...r });
    }),
  );

  server.registerTool(
    "cancel_action",
    {
      title: "Cancel a pending action",
      description: "Cancel a pending action when the user declines.",
      inputSchema: { action_id: z.uuid() },
      outputSchema: out.cancelOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded((a: { action_id: string }) => {
      const r = care.cancelAction({ actionId: a.action_id }, actor);
      return ok(r.message, { ...r });
    }),
  );

  server.registerTool(
    "record_refill_pickup",
    {
      title: "Record a refill pickup",
      description: "Add picked-up stock for a medication and close any open refill request.",
      inputSchema: { medication: medArg, person: personArg, quantity: z.number().int().min(1).max(1000).describe("Units picked up, e.g. 30 tablets.") },
      outputSchema: out.pickupOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded((a: { medication: string; person?: string; quantity: number }) => {
      const r = care.recordRefillPickup(a, actor);
      return ok(r.message, { ...r });
    }),
  );

  server.registerTool(
    "add_care_note",
    {
      title: "Add a care note",
      description: "Record an observation (e.g. 'Dad felt dizzy after lunch'), an appointment, or general info. Notes appear in the handoff report. Do not interpret symptoms.",
      inputSchema: {
        person: personArg,
        text: z.string().min(1).max(1000),
        category: z.enum(["observation", "symptom", "appointment", "general"]).optional(),
      },
      outputSchema: out.noteOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded((a: { person?: string; text: string; category?: string }) => {
      const r = care.addNote(a, actor);
      return ok(r.message, { ...r });
    }),
  );

  server.registerTool(
    "add_medication",
    {
      title: "Add a medication",
      description: "Add a medication with its daily schedule and current supply for a person in the care circle.",
      inputSchema: {
        person: z.string().min(1).max(80),
        name: z.string().min(1).max(80),
        strength: z.string().max(40).optional().describe('e.g. "500 mg"'),
        dose_units: z.number().positive().max(20).optional().describe("Units per dose, default 1."),
        unit_label: z.string().max(20).optional().describe('e.g. "tablet", "capsule"; default "tablet".'),
        times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).min(1).max(8).describe("Daily times in 24h HH:MM."),
        instructions: z.string().max(200).optional().describe('e.g. "with food"'),
        quantity_on_hand: z.number().min(0).max(10000),
        refills_remaining: z.number().int().min(0).max(99).optional(),
        pharmacy: z.string().max(80).optional(),
      },
      outputSchema: out.addMedicationOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded((a: { person: string; name: string; strength?: string; dose_units?: number; unit_label?: string; times: string[]; instructions?: string; quantity_on_hand: number; refills_remaining?: number; pharmacy?: string }) => {
      const m = care.addMedication(
        {
          person: a.person, name: a.name, strength: a.strength, doseUnits: a.dose_units, unitLabel: a.unit_label, times: a.times,
          instructions: a.instructions, quantityOnHand: a.quantity_on_hand, refillsRemaining: a.refills_remaining, pharmacy: a.pharmacy,
        },
        actor,
      );
      return ok(`Added ${m.label} for ${m.personName} at ${list(m.times.map(formatTime12))}.`, { medication: m });
    }),
  );

  server.registerTool(
    "add_care_recipient",
    {
      title: "Add a care recipient",
      description: "Add a person the care circle looks after, with optional aliases such as 'Mom'.",
      inputSchema: { name: z.string().min(1).max(80), aliases: z.array(z.string().min(1).max(40)).max(5).optional() },
      outputSchema: { personId: z.string(), name: z.string(), aliases: z.array(z.string()) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded((a: { name: string; aliases?: string[] }) => {
      const p = care.addPerson(a, actor);
      return ok(`Added ${p.name} to the care circle.`, { personId: p.id, name: p.name, aliases: p.aliases.split(",").filter(Boolean) });
    }),
  );

  return server;
}
