// Output schemas for every Tend tool. The MCP SDK validates each tool's
// structuredContent against these before it leaves the server, so the
// contract advertised in tools/list is the contract actually delivered.
import { z } from "zod";

export const medicationView = z.object({
  id: z.string(),
  personId: z.string(),
  personName: z.string(),
  name: z.string(),
  strength: z.string(),
  label: z.string(),
  doseUnits: z.number(),
  unitLabel: z.string(),
  times: z.array(z.string()),
  instructions: z.string(),
  quantityOnHand: z.number(),
  refillsRemaining: z.number(),
  pharmacy: z.string(),
});

export const forecastItem = z.object({
  medicationId: z.string(),
  personName: z.string(),
  medication: z.string(),
  unitsPerDay: z.number(),
  quantityOnHand: z.number(),
  daysLeft: z.number(),
  runoutDate: z.string(),
  refillsRemaining: z.number(),
  openRefillRequest: z.boolean(),
  urgency: z.enum(["critical", "soon", "ok"]),
  advice: z.string(),
});

export const pendingActionView = z.object({
  actionId: z.string(),
  type: z.string(),
  summary: z.string(),
  createdBy: z.string(),
  expiresAt: z.string(),
  medicationId: z.string().nullable(),
});

const slotState = z.enum(["taken", "skipped", "missed", "due", "upcoming"]);

export const recipientsOutput = {
  people: z.array(
    z.object({
      personId: z.string(),
      name: z.string(),
      aliases: z.array(z.string()),
      medications: z.array(medicationView),
    }),
  ),
};

export const statusOutput = {
  date: z.string(),
  timezone: z.string(),
  generatedAt: z.string(),
  localTime: z.string(),
  people: z.array(
    z.object({
      personId: z.string(),
      name: z.string(),
      slots: z.array(
        z.object({
          medicationId: z.string(),
          medication: z.string(),
          time: z.string(),
          timeLabel: z.string(),
          state: slotState,
          dose: z.string(),
          instructions: z.string(),
          recordedAt: z.string().nullable(),
          loggedBy: z.string().nullable(),
        }),
      ),
      counts: z.object({ taken: z.number(), skipped: z.number(), missed: z.number(), due: z.number(), upcoming: z.number() }),
    }),
  ),
  supplyAlerts: z.array(forecastItem),
  pendingActions: z.array(pendingActionView),
};

export const logDoseOutput = {
  outcome: z.enum(["logged", "needs_confirmation"]),
  personName: z.string(),
  medication: z.string(),
  status: z.enum(["taken", "skipped"]),
  slotDate: z.string(),
  slotTime: z.string(),
  slotLabel: z.string(),
  message: z.string(),
  previous: z.object({ status: z.string(), recordedAt: z.string(), loggedBy: z.string() }).nullable(),
  quantityOnHand: z.number(),
  supplyWarning: z.string().nullable(),
};

export const forecastOutput = {
  withinDays: z.number(),
  items: z.array(forecastItem),
};

export const pendingOutput = {
  ...pendingActionView.shape,
  requiresConfirmation: z.literal(true),
};

export const confirmOutput = {
  actionId: z.string(),
  type: z.string(),
  message: z.string(),
  pharmacyMessage: z.string().nullable(),
};

export const cancelOutput = {
  actionId: z.string(),
  message: z.string(),
};

export const pickupOutput = {
  message: z.string(),
  quantityOnHand: z.number(),
  refillsRemaining: z.number(),
};

export const noteOutput = {
  message: z.string(),
  noteId: z.string(),
};

export const addMedicationOutput = {
  medication: medicationView,
};

export const handoffOutput = {
  fromDate: z.string(),
  toDate: z.string(),
  days: z.number(),
  generatedAt: z.string(),
  people: z.array(
    z.object({
      personId: z.string(),
      name: z.string(),
      overallAdherencePct: z.number().nullable(),
      adherence: z.array(
        z.object({
          medication: z.string(),
          scheduled: z.number(),
          taken: z.number(),
          skipped: z.number(),
          missed: z.number(),
          adherencePct: z.number().nullable(),
          medicationId: z.string(),
          times: z.array(z.string()),
          daily: z.array(
            z.object({
              date: z.string(),
              slots: z.array(z.object({ time: z.string(), state: z.enum(["taken", "skipped", "missed", "due", "upcoming", "untracked"]) })),
            }),
          ),
        }),
      ),
      missedDoses: z.array(z.object({ medication: z.string(), date: z.string(), time: z.string() })),
      notes: z.array(z.object({ at: z.string(), category: z.string(), text: z.string(), loggedBy: z.string() })),
    }),
  ),
  supplyAlerts: z.array(forecastItem),
  openRefillRequests: z.array(z.object({ medication: z.string(), personName: z.string(), requestedBy: z.string(), requestedAt: z.string() })),
  recentActivity: z.array(z.object({ at: z.string(), actor: z.string(), message: z.string() })),
};
