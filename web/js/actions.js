// Caregiver actions. Each one is a real MCP tool call as the current caregiver;
// dialogs show what the server returned (the double-dose guard, refill summaries)
// rather than anything the UI invents.
import { tool, refresh, ToolError, actor } from "./api.js";
import { h, icon, openSheet, toast, fmtTime, hhmmLabel } from "./ui.js";

async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    toast(err instanceof ToolError ? err.message : `Couldn't reach Tend: ${err.message}`, "error");
    return undefined;
  }
}

export async function markDose(slot, personName, status = "taken") {
  return guarded(async () => {
    const args = { medication: slot.medicationId, person: personName, slot_time: slot.time, status };
    const { data } = await tool("log_dose", args);
    if (data.outcome === "needs_confirmation") {
      const confirmed = await openSheet((close) => [
        h("p", { class: "eyebrow" }, "Double-dose guard"),
        h("h2", { class: "display" }, "This dose was already given"),
        h("div", { class: "callout warn" }, h("strong", {}, `${data.personName}'s ${data.slotLabel} ${data.medication}`),
          ` was logged as given at ${fmtTime(data.previous.recordedAt)} by ${data.previous.loggedBy}. Nothing has been saved.`),
        h("p", {}, `Check with ${data.previous.loggedBy} first. Only record a second dose if one was really given; it will be flagged for the whole care circle.`),
        h("div", { class: "form-actions" },
          h("button", { class: "btn btn-secondary", onclick: () => close(false), autofocus: true }, "Keep it as one dose"),
          h("button", { class: "btn btn-danger", onclick: () => close(true) }, "Record an extra dose")),
      ]);
      if (!confirmed) return;
      const forced = await tool("log_dose", { ...args, confirm_duplicate: true });
      toast(forced.data.message, "error");
    } else {
      toast(data.message);
    }
    await refresh("action");
  });
}

export async function requestRefill(item) {
  return guarded(async () => {
    const { data: pending } = await tool("request_refill", { medication: item.medicationId, person: item.personName });
    const decision = await openSheet((close) => [
      h("p", { class: "eyebrow" }, "Step 1 of 2 · Review"),
      h("h2", { class: "display" }, "Request a refill?"),
      h("p", {}, pending.summary),
      h("div", { class: "callout info" }, icon("shield", "sm"), " Nothing is sent until you confirm. This request expires in 15 minutes."),
      h("div", { class: "form-actions" },
        h("button", { class: "btn btn-secondary", onclick: () => close("cancel") }, "Not now"),
        h("button", { class: "btn btn-primary", onclick: () => close("confirm"), autofocus: true }, "Confirm request")),
    ]);
    if (decision !== "confirm") {
      await tool("cancel_action", { action_id: pending.actionId });
      toast("Refill request cancelled. Nothing was requested.");
      await refresh("action");
      return;
    }
    const { data: done } = await tool("confirm_action", { action_id: pending.actionId });
    await refresh("action");
    await showDraft(done.message, done.pharmacyMessage);
  });
}

export async function reviewPending(action) {
  return guarded(async () => {
    const decision = await openSheet((close) => [
      h("p", { class: "eyebrow" }, `Awaiting confirmation · started by ${action.createdBy}`),
      h("h2", { class: "display" }, "Confirm this request?"),
      h("p", {}, action.summary),
      h("div", { class: "form-actions" },
        h("button", { class: "btn btn-secondary", onclick: () => close("cancel") }, "Cancel request"),
        h("button", { class: "btn btn-primary", onclick: () => close("confirm") }, "Confirm")),
    ]);
    if (!decision) return;
    const { data } = await tool(decision === "confirm" ? "confirm_action" : "cancel_action", { action_id: action.actionId });
    await refresh("action");
    if (decision === "confirm") await showDraft(data.message, data.pharmacyMessage);
    else toast(data.message);
  });
}

function showDraft(message, draft) {
  return openSheet((close) => [
    h("p", { class: "eyebrow" }, "Step 2 of 2 · Recorded"),
    h("h2", { class: "display" }, "Refill requested"),
    h("p", {}, message),
    draft ? h("p", { class: "small muted" }, "Draft message for the pharmacy (Tend doesn't send it; copy it into a call, text or portal):") : null,
    draft ? h("div", { class: "draft" }, draft) : null,
    h("div", { class: "form-actions" },
      draft ? h("button", {
        class: "btn btn-secondary", onclick: async (e) => {
          try {
            await navigator.clipboard.writeText(draft);
            e.currentTarget.textContent = "Copied";
          } catch { toast("Clipboard isn't available here. Select the text instead.", "error"); }
        },
      }, icon("copy", "sm"), "Copy message") : null,
      h("button", { class: "btn btn-primary", onclick: () => close() }, "Done")),
  ]);
}

export async function recordPickup(item) {
  const qty = await openSheet((close) => {
    const input = h("input", { type: "number", min: 1, max: 1000, value: 30, required: true, inputmode: "numeric" });
    const err = h("div", { class: "form-error", role: "alert" });
    return [
      h("p", { class: "eyebrow" }, "Supply"),
      h("h2", { class: "display" }, `Picked up ${item.medication}`),
      h("p", {}, `For ${item.personName}. This adds to the ${item.quantityOnHand} on hand${item.openRefillRequest ? " and closes the open refill request" : ""}.`),
      h("form", {
        onsubmit: (e) => {
          e.preventDefault();
          const n = Number(input.value);
          if (!Number.isInteger(n) || n < 1 || n > 1000) { err.textContent = "Enter a whole number from 1 to 1000."; return; }
          close(n);
        },
      },
        h("label", { class: "field" }, "Quantity picked up", input),
        err,
        h("div", { class: "form-actions" },
          h("button", { type: "button", class: "btn btn-secondary", onclick: () => close() }, "Cancel"),
          h("button", { type: "submit", class: "btn btn-primary" }, "Add to supply"))),
    ];
  });
  if (!qty) return;
  return guarded(async () => {
    const { data } = await tool("record_refill_pickup", { medication: item.medicationId, person: item.personName, quantity: qty });
    toast(data.message);
    await refresh("action");
  });
}

export async function addNote(personName) {
  const values = await openSheet((close) => {
    const text = h("textarea", { maxlength: 1000, required: true, placeholder: "e.g. Felt dizzy after standing up quickly" });
    const cat = h("select", {}, ["observation", "symptom", "appointment", "general"].map((c) => h("option", { value: c }, c[0].toUpperCase() + c.slice(1))));
    return [
      h("p", { class: "eyebrow" }, `Care note · ${personName}`),
      h("h2", { class: "display" }, "What should the care circle know?"),
      h("p", { class: "small muted" }, "Notes appear in the handoff report. Tend records them; it doesn't interpret symptoms."),
      h("form", {
        onsubmit: (e) => {
          e.preventDefault();
          if (text.value.trim()) close({ text: text.value.trim(), category: cat.value });
        },
      },
        h("div", { class: "stack" }, h("label", { class: "field" }, "Note", text), h("label", { class: "field" }, "Type", cat)),
        h("div", { class: "form-actions" },
          h("button", { type: "button", class: "btn btn-secondary", onclick: () => close() }, "Cancel"),
          h("button", { type: "submit", class: "btn btn-primary" }, "Save note"))),
    ];
  });
  if (!values) return;
  return guarded(async () => {
    const { data } = await tool("add_care_note", { person: personName, ...values });
    toast(data.message);
    await refresh("action");
  });
}

export async function addMedication(personName) {
  const values = await openSheet((close) => {
    const f = {
      name: h("input", { required: true, maxlength: 80, placeholder: "e.g. Vitamin D" }),
      strength: h("input", { maxlength: 40, placeholder: "e.g. 1000 IU" }),
      times: h("input", { required: true, placeholder: "08:00, 20:00", pattern: "^\\s*([01]\\d|2[0-3]):[0-5]\\d(\\s*,\\s*([01]\\d|2[0-3]):[0-5]\\d)*\\s*$" }),
      dose: h("input", { type: "number", min: 0.25, max: 20, step: 0.25, value: 1 }),
      qty: h("input", { type: "number", min: 0, max: 10000, value: 30, required: true }),
      refills: h("input", { type: "number", min: 0, max: 99, value: 0 }),
      instructions: h("input", { maxlength: 200, placeholder: "e.g. with food" }),
      pharmacy: h("input", { maxlength: 80 }),
    };
    const err = h("div", { class: "form-error", role: "alert" });
    return [
      h("p", { class: "eyebrow" }, `New medication · ${personName}`),
      h("h2", { class: "display" }, "Add a medication"),
      h("form", {
        onsubmit: (e) => {
          e.preventDefault();
          const times = f.times.value.split(",").map((t) => t.trim()).filter(Boolean);
          if (!times.every((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t))) { err.textContent = "Times must be 24-hour HH:MM, separated by commas."; return; }
          close({
            person: personName, name: f.name.value.trim(), strength: f.strength.value.trim() || undefined, times,
            dose_units: Number(f.dose.value) || 1, quantity_on_hand: Number(f.qty.value), refills_remaining: Number(f.refills.value) || 0,
            instructions: f.instructions.value.trim() || undefined, pharmacy: f.pharmacy.value.trim() || undefined,
          });
        },
      },
        h("div", { class: "form-row" }, h("label", { class: "field" }, "Name", f.name), h("label", { class: "field" }, "Strength", f.strength)),
        h("div", { class: "form-row", style: "margin-top:12px" }, h("label", { class: "field" }, "Times (24h)", f.times), h("label", { class: "field" }, "Units per dose", f.dose)),
        h("div", { class: "form-row", style: "margin-top:12px" }, h("label", { class: "field" }, "On hand", f.qty), h("label", { class: "field" }, "Refills left", f.refills)),
        h("div", { class: "form-row", style: "margin-top:12px" }, h("label", { class: "field" }, "Instructions", f.instructions), h("label", { class: "field" }, "Pharmacy", f.pharmacy)),
        err,
        h("div", { class: "form-actions" },
          h("button", { type: "button", class: "btn btn-secondary", onclick: () => close() }, "Cancel"),
          h("button", { type: "submit", class: "btn btn-primary" }, "Add medication"))),
    ];
  });
  if (!values) return;
  return guarded(async () => {
    const { speech } = await tool("add_medication", values);
    toast(speech);
    await refresh("action");
  });
}

export function viewOnlyReason() {
  return `${actor()?.name ?? "This caregiver"} has view-only access.`;
}

export function doseLabel(slot) {
  return `${hhmmLabel(slot.time)} ${slot.medication}`;
}
