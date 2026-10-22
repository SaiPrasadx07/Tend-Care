import { state, canWrite } from "../api.js";
import { h, icon, fmtDateShort, fmtDay, plural } from "../ui.js";
import { runwayBar } from "../charts.js";
import { requestRefill, recordPickup, reviewPending, viewOnlyReason } from "../actions.js";

const STEPS = ["Needed", "Confirm", "Requested", "Picked up"];

/** Where each medication is in the refill lifecycle, derived only from backend state. */
export function refillStage(f, pending, open) {
  if (pending) return { key: "awaiting", step: 1, label: "Awaiting confirmation", detail: `Prepared by ${pending.createdBy}. Nothing is requested until someone confirms.` };
  if (f.openRefillRequest) return { key: "requested", step: 2, label: "Refill requested", detail: open ? `Requested by ${open.requestedBy}, ${fmtDay(open.requestedAt)}. Record the pickup when it's collected.` : "Record the pickup when it's collected." };
  if (f.urgency !== "ok" && f.refillsRemaining === 0) return { key: "prescriber", step: 0, label: "Prescriber follow-up", detail: "No refills left on this prescription. The prescriber needs to authorize a new one." };
  if (f.urgency !== "ok") return { key: "needed", step: 0, label: f.urgency === "critical" ? "Refill needed now" : "Refill soon", detail: `${plural(f.refillsRemaining, "refill")} left on the prescription.` };
  return { key: "stocked", step: -1, label: "Stocked", detail: "No action needed." };
}

function stepper(step) {
  if (step < 0) return null;
  return h("ol", { class: "stepper", "aria-label": `Refill progress: ${STEPS[step]}` },
    STEPS.map((s, i) => h("li", { class: i < step ? "done" : i === step ? "current" : "", "aria-current": i === step ? "step" : null }, h("span", { class: "dot" }), s)));
}

function row(f, pending, open) {
  const stage = refillStage(f, pending, open);
  let action = null;
  if (!canWrite()) action = h("span", { class: "tiny muted" }, "View only");
  else if (stage.key === "awaiting") action = h("button", { class: "btn btn-primary btn-sm", onclick: () => reviewPending(pending) }, icon("shield", "sm"), "Review & confirm");
  else if (stage.key === "requested") action = h("button", { class: "btn btn-primary btn-sm", onclick: () => recordPickup(f) }, icon("box", "sm"), "Record pickup");
  else if (stage.key === "needed") action = h("button", { class: `btn ${f.urgency === "critical" ? "btn-primary" : "btn-secondary"} btn-sm`, onclick: () => requestRefill(f) }, icon("refill", "sm"), "Request refill");
  else if (stage.key === "prescriber") action = h("button", { class: "btn btn-secondary btn-sm", onclick: () => requestRefill(f), title: "Tend will record the request and flag that a new prescription is needed" }, icon("refill", "sm"), "Request & flag");
  else action = h("button", { class: "btn btn-ghost btn-sm", onclick: () => recordPickup(f) }, "Record pickup");
  return h("article", { class: `supply-row stage-${stage.key}` },
    h("div", { class: "supply-name" },
      h("b", {}, f.medication),
      h("span", {}, `${f.personName} · ${f.quantityOnHand} on hand · ${f.unitsPerDay} a day`)),
    h("div", { class: "supply-runway" },
      runwayBar(f),
      h("div", { class: "runway-meta" },
        h("span", {}, h("b", { class: "num" }, plural(f.daysLeft, "day")), " left"),
        h("span", {}, `runs out ${fmtDateShort(f.runoutDate)}`))),
    h("div", { class: "supply-stage" },
      h("span", { class: `stage-label ${stage.key}` }, stage.label),
      h("p", {}, stage.detail),
      stepper(stage.step)),
    h("div", { class: "supply-action" }, action));
}

export function renderSupply() {
  const { forecast, status, handoff } = state.data;
  const pendingByMed = new Map(status.pendingActions.filter((a) => a.medicationId).map((a) => [a.medicationId, a]));
  const openByKey = new Map(handoff.openRefillRequests.map((o) => [`${o.personName}|${o.medication}`, o]));
  const needs = forecast.filter((f) => f.urgency !== "ok" || pendingByMed.has(f.medicationId) || f.openRefillRequest);
  const stocked = forecast.filter((f) => !needs.includes(f));
  const rows = (list) => list.map((f) => row(f, pendingByMed.get(f.medicationId), openByKey.get(`${f.personName}|${f.medication}`)));
  return h("div", { class: "view" },
    h("header", { class: "hero" },
      h("div", {}, h("p", { class: "eyebrow" }, "Supply"), h("h1", { class: "display display-xl" }, "Refills & runway"),
        h("p", { class: "lede" }, needs.length
          ? `${plural(needs.length, "medication")} ${needs.length === 1 ? "is" : "are"} in the refill process or running low. Each runway is computed from stock on hand and the dose schedule, and nothing is requested without a confirmation.`
          : "Every medication has more than a week of supply."))),
    !canWrite() ? h("p", { class: "tiny muted" }, viewOnlyReason()) : null,
    needs.length ? h("section", { class: "card" },
      h("div", { class: "section-head" },
        h("div", {}, h("h2", { class: "section-title" }, "In progress & running low"), h("p", { class: "small muted" }, "Runway on a 30-day scale; the dashed line is the 7-day refill point."))),
      h("div", { class: "supply-list" }, rows(needs))) : null,
    stocked.length ? h("section", { class: "card" },
      h("div", { class: "section-head" }, h("h2", { class: "section-title" }, "Stocked"), h("p", { class: "small muted" }, "More than a week left")),
      h("div", { class: "supply-list" }, rows(stocked))) : null);
}
