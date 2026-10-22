import { state, canWrite } from "../api.js";
import { h, icon, urgencyChip, fmtDateShort, fmtDay, plural } from "../ui.js";
import { runwayBar } from "../charts.js";
import { requestRefill, recordPickup, reviewPending, viewOnlyReason } from "../actions.js";

function row(f) {
  let action;
  if (!canWrite()) action = h("span", { class: "tiny muted" }, "View only");
  else if (f.openRefillRequest) action = h("button", { class: "btn btn-secondary btn-sm", onclick: () => recordPickup(f) }, icon("box", "sm"), "Record pickup");
  else if (f.urgency === "ok") action = h("button", { class: "btn btn-ghost btn-sm", onclick: () => recordPickup(f) }, "Record pickup");
  else action = [
    h("button", { class: `btn ${f.urgency === "critical" ? "btn-primary" : "btn-secondary"} btn-sm`, onclick: () => requestRefill(f) }, icon("refill", "sm"), "Request refill"),
    h("button", { class: "btn btn-ghost btn-sm", onclick: () => recordPickup(f) }, "Pickup"),
  ];
  return h("div", { class: "runway-row with-actions" },
    h("div", { class: "runway-name" }, h("b", {}, f.medication), h("span", {}, `${f.personName} · ${f.quantityOnHand} on hand · ${f.unitsPerDay}/day`), h("div", { style: "margin-top:6px" }, urgencyChip(f.urgency))),
    h("div", {},
      runwayBar(f),
      h("div", { class: "runway-meta" },
        h("span", {}, h("b", { class: "num" }, plural(f.daysLeft, "day")), " left · runs out ", fmtDateShort(f.runoutDate)),
        h("span", {}, `${plural(f.refillsRemaining, "refill")} left${f.openRefillRequest ? " · requested" : ""}`))),
    h("div", { class: "runway-actions" }, action));
}

export function renderSupply() {
  const { forecast, status, handoff } = state.data;
  const needs = forecast.filter((f) => f.urgency !== "ok");
  const noRefills = forecast.filter((f) => f.refillsRemaining === 0);
  return h("div", { class: "view" },
    h("header", { class: "hero" },
      h("div", {}, h("p", { class: "eyebrow" }, "Supply"), h("h1", { class: "display display-xl" }, "Refills & runway"),
        h("p", { class: "lede" }, needs.length
          ? `${plural(needs.length, "medication")} ${needs.length === 1 ? "needs" : "need"} attention this week. Tend computes each runway from stock on hand and the dose schedule; refills are requested in two steps and never sent without your confirmation.`
          : "Every medication has more than a week of supply."))),
    status.pendingActions.length ? h("section", { class: "card" },
      h("div", { class: "section-head" }, h("h2", { class: "section-title" }, "Waiting for confirmation")),
      status.pendingActions.map((a) => h("div", { class: "runway-row" },
        h("div", { class: "runway-name" }, h("b", {}, "Refill request"), h("span", {}, `Started by ${a.createdBy}`)),
        h("div", { class: "small" }, a.summary),
        h("div", { class: "runway-actions" }, canWrite() ? h("button", { class: "btn btn-primary btn-sm", onclick: () => reviewPending(a) }, "Review") : null)))) : null,
    h("section", { class: "card" },
      h("div", { class: "section-head" },
        h("div", {}, h("h2", { class: "section-title" }, "Runway"), h("p", { class: "small muted" }, "Days left on a 30-day scale. The dashed line marks the 7-day refill point."))),
      h("div", { class: "runway" }, forecast.map(row)),
      !canWrite() ? h("p", { class: "tiny muted" }, viewOnlyReason()) : null),
    h("div", { class: "grid-2" },
      h("section", { class: "card" },
        h("h2", { class: "section-title" }, "Open refill requests"),
        handoff.openRefillRequests.length
          ? h("ul", { class: "feed", style: "margin-top:10px" }, handoff.openRefillRequests.map((r) => h("li", { class: "feed-item" }, h("span", { class: "monogram xs" }, icon("refill", "sm")), h("div", {}, h("b", { class: "small" }, `${r.personName} · ${r.medication}`), h("p", {}, `Requested by ${r.requestedBy}, ${fmtDay(r.requestedAt)}`)), h("span", {}))))
          : h("p", { class: "muted small" }, "None open. Confirmed requests appear here until the pickup is recorded.")),
      h("section", { class: "card" },
        h("h2", { class: "section-title" }, "Prescriptions out of refills"),
        noRefills.length
          ? h("ul", { class: "feed", style: "margin-top:10px" }, noRefills.map((f) => h("li", { class: "feed-item" }, h("span", { class: "monogram xs" }, "!"), h("div", {}, h("b", { class: "small" }, `${f.personName} · ${f.medication}`), h("p", {}, "The prescriber needs to authorize a new prescription before the next refill.")), h("span", {}))))
          : h("p", { class: "muted small" }, "Every prescription has refills remaining."))));
}
