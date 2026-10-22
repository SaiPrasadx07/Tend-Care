import { state, canWrite } from "../api.js";
import { h, icon, stateChip, monogram, fmtDateLong, fmtDateShort, fmtTime, hhmmLabel, localMinutes, localYmd, plural, listJoin, relTime } from "../ui.js";
import { dayTimeline, ring, adherenceGrid, stateLegend, runwayBar, slotDescription } from "../charts.js";
import { markDose, requestRefill, reviewPending, recordPickup, viewOnlyReason } from "../actions.js";

const slotKey = (slot) => `${slot.medicationId}@${slot.time}`;
const word = (n) => ["No", "One", "Two", "Three", "Four", "Five", "Six"][n] ?? String(n);

function summarySentence(status, forecast) {
  const all = status.people.flatMap((p) => p.slots.map((s) => ({ ...s, person: p.name })));
  const due = all.filter((s) => s.state === "due");
  const missed = all.filter((s) => s.state === "missed");
  const critical = forecast.filter((f) => f.urgency === "critical" && !f.openRefillRequest);
  const parts = [];
  if (due.length) parts.push(`${word(due.length)} ${due.length === 1 ? "dose is" : "doses are"} due now`);
  if (missed.length) parts.push(`${word(missed.length).toLowerCase()} ${missed.length === 1 ? "was" : "were"} missed`);
  if (critical.length) parts.push(`${critical[0].personName}'s ${critical[0].medication.split(" ")[0]} runs out in ${plural(critical[0].daysLeft, "day")}`);
  if (status.pendingActions.length) parts.push(`${plural(status.pendingActions.length, "request")} ${status.pendingActions.length === 1 ? "is" : "are"} waiting for confirmation`);
  if (parts.length) {
    const s = listJoin(parts);
    return s[0].toUpperCase() + s.slice(1) + ".";
  }
  const next = all.filter((s) => s.state === "upcoming").sort((a, b) => a.time.localeCompare(b.time))[0];
  return next ? `Everything is on track. Next up: ${hhmmLabel(next.time)} ${next.medication.split(" ")[0]} for ${next.person}.` : "Everything is on track. Nothing else is scheduled today.";
}

function actionButtons(slot, person, compact = false) {
  if (!canWrite()) return h("span", { class: "tiny muted", title: viewOnlyReason() }, "View only");
  const given = h("button", { class: `btn ${slot.state === "due" || slot.state === "missed" ? "btn-primary" : "btn-secondary"} btn-sm`, onclick: () => markDose(slot, person, "taken") }, icon("check", "sm"), compact ? "Given" : "Mark given");
  const skip = h("button", { class: "btn btn-ghost btn-sm", onclick: () => markDose(slot, person, "skipped") }, "Skip");
  if (slot.state === "taken") return null;
  if (slot.state === "skipped") return h("button", { class: "btn btn-ghost btn-sm", onclick: () => markDose(slot, person, "taken") }, "Mark given");
  return [given, skip];
}

function attention(status, forecast) {
  const cards = [];
  for (const p of status.people) {
    for (const slot of p.slots.filter((s) => s.state === "missed")) {
      cards.push(h("article", { class: "attn missed" },
        h("div", { class: "attn-kicker" }, icon("alert", "sm"), `Missed · ${hhmmLabel(slot.time)}`),
        h("div", { class: "attn-title" }, `${p.name}'s ${slot.medication}`),
        h("div", { class: "attn-body" }, `${slot.dose}${slot.instructions ? ` · ${slot.instructions}` : ""}. Not logged within 90 minutes.`),
        h("div", { class: "attn-actions" }, actionButtons(slot, p.name))));
    }
  }
  for (const p of status.people) {
    for (const slot of p.slots.filter((s) => s.state === "due")) {
      cards.push(h("article", { class: "attn due" },
        h("div", { class: "attn-kicker" }, icon("clock", "sm"), `Due now · ${hhmmLabel(slot.time)}`),
        h("div", { class: "attn-title" }, `${p.name}'s ${slot.medication}`),
        h("div", { class: "attn-body" }, `${slot.dose}${slot.instructions ? ` · ${slot.instructions}` : ""}`),
        h("div", { class: "attn-actions" }, actionButtons(slot, p.name))));
    }
  }
  for (const a of status.pendingActions) {
    cards.push(h("article", { class: "attn pending" },
      h("div", { class: "attn-kicker" }, icon("shield", "sm"), `Awaiting confirmation · ${a.createdBy}`),
      h("div", { class: "attn-title" }, "Refill request"),
      h("div", { class: "attn-body" }, a.summary),
      h("div", { class: "attn-actions" }, canWrite() ? h("button", { class: "btn btn-primary btn-sm", onclick: () => reviewPending(a) }, "Review") : h("span", { class: "tiny muted" }, "View only"))));
  }
  const pendingMeds = new Set(status.pendingActions.map((a) => a.medicationId).filter(Boolean));
  for (const f of forecast.filter((x) => x.urgency !== "ok" && !pendingMeds.has(x.medicationId))) {
    cards.push(h("article", { class: `attn ${f.urgency}` },
      h("div", { class: "attn-kicker" }, icon(f.urgency === "critical" ? "alert" : "box", "sm"), f.urgency === "critical" ? `Runs out in ${plural(f.daysLeft, "day")}` : `${f.daysLeft} days of supply`),
      h("div", { class: "attn-title" }, `${f.personName}'s ${f.medication}`),
      h("div", { class: "attn-body" }, f.advice),
      h("div", { class: "attn-actions" },
        !canWrite() ? h("span", { class: "tiny muted" }, "View only")
          : f.openRefillRequest ? h("button", { class: "btn btn-secondary btn-sm", onclick: () => recordPickup(f) }, "Record pickup")
            : h("button", { class: `btn ${f.urgency === "critical" ? "btn-primary" : "btn-secondary"} btn-sm`, onclick: () => requestRefill(f) }, icon("refill", "sm"), "Request refill"))));
  }
  if (!cards.length) {
    return h("div", { class: "all-clear" }, icon("shield", "lg"),
      h("div", {}, h("div", { class: "display" }, "Nothing needs you right now"), h("div", { class: "small" }, "No missed or due doses, no low supply, no pending requests.")));
  }
  return h("div", { class: "attention" }, cards);
}

function lanes(status) {
  const isToday = status.date === localYmd();
  const now = localMinutes();
  return status.people.map((p) => {
    const list = h("ul", { class: "doses" });
    const rows = new Map();
    for (const slot of p.slots) {
      const row = h("li", { class: `dose-row ${state.changed?.has(slotKey(slot)) ? "flash" : ""}`, id: `slot-${slotKey(slot).replace(/[^a-z0-9]/gi, "")}` },
        h("span", { class: "dose-time" }, hhmmLabel(slot.time)),
        h("span", { class: "dose-what" }, h("b", {}, slot.medication), h("small", {}, [slot.dose, slot.instructions, slot.state === "taken" || slot.state === "skipped" ? slotDescription(slot) : null].filter(Boolean).join(" · "))),
        stateChip(slot.state),
        h("span", { class: "dose-actions" }, actionButtons(slot, p.name, true)));
      rows.set(slotKey(slot), row);
      list.append(row);
    }
    const onSelect = (slot) => {
      const row = rows.get(slotKey(slot));
      row?.scrollIntoView({ behavior: "smooth", block: "center" });
      row?.classList.remove("flash");
      void row?.offsetWidth;
      row?.classList.add("flash");
    };
    const given = p.counts.taken;
    const next = p.slots.find((s) => s.state === "due" || s.state === "upcoming");
    return h("section", { class: "lane", "aria-label": `${p.name}'s doses` },
      h("div", { class: "lane-head" }, monogram(p.name), h("span", { class: "name" }, p.name),
        h("span", { class: "meta" }, `${given} of ${p.slots.length} given${next ? ` · next ${hhmmLabel(next.time)}` : ""}`)),
      p.slots.length ? dayTimeline(p, now, isToday, onSelect) : h("p", { class: "muted small" }, "Nothing scheduled."),
      list);
  });
}

function adherence(handoff) {
  const today = handoff.toDate;
  return h("section", { class: "card" },
    h("div", { class: "section-head" },
      h("div", {}, h("h2", { class: "section-title" }, "Adherence"), h("p", { class: "small muted" }, `Every scheduled dose, last ${handoff.days} days`)),
      h("a", { href: "#/handoff", class: "btn btn-ghost btn-sm" }, "Handoff report", icon("chevron", "sm"))),
    handoff.people.map((p) => h("div", { class: "adh-person" },
      h("div", { class: "ring-wrap" }, ring(p.overallAdherencePct, `last ${handoff.days} days`), h("span", { class: "who" }, p.name)),
      p.adherence.length ? adherenceGrid(p.adherence, today) : h("p", { class: "muted small" }, "No medications."))),
    stateLegend());
}

function supply(forecast) {
  const top = forecast.slice(0, 5);
  return h("section", { class: "card" },
    h("div", { class: "section-head" },
      h("div", {}, h("h2", { class: "section-title" }, "Supply runway"), h("p", { class: "small muted" }, "Days of medication left at the current schedule · dashed line = 7-day refill point")),
      h("a", { href: "#/supply", class: "btn btn-ghost btn-sm" }, "All supply", icon("chevron", "sm"))),
    h("div", { class: "runway" }, top.map((f) => h("div", { class: "runway-row" },
      h("div", { class: "runway-name" }, h("b", {}, f.medication), h("span", {}, f.personName)),
      h("div", {},
        runwayBar(f),
        h("div", { class: "runway-meta" },
          h("span", {}, h("b", { class: "num" }, plural(f.daysLeft, "day")), " left"),
          h("span", {}, f.openRefillRequest ? "Refill requested" : f.urgency === "critical" ? "Critical" : f.urgency === "soon" ? "Refill soon" : `Runs out ${fmtDateShort(f.runoutDate)}`)))))));
}

export function activityFeed(items, { limit = 12, newIds } = {}) {
  const list = h("div", { class: "feed" });
  let lastDay = "";
  for (const item of items.slice(0, limit)) {
    const day = localYmd(new Date(item.at));
    if (day !== lastDay) {
      lastDay = day;
      const label = day === localYmd() ? "Today" : day === localYmd(new Date(Date.now() - 86_400_000)) ? "Yesterday" : fmtDateLong(day);
      list.append(h("p", { class: "eyebrow feed-day" }, label));
    }
    list.append(h("div", { class: `feed-item ${item.kind === "extra_dose" ? "extra" : ""} ${newIds?.has(item.at + item.message) ? "new" : ""}` },
      monogram(item.actor), h("div", {}, h("b", { class: "small" }, item.actor), h("p", {}, item.message)),
      h("time", { datetime: item.at }, fmtTime(item.at))));
  }
  if (!items.length) list.append(h("p", { class: "muted" }, "No activity yet."));
  return list;
}

/** Same count as the "Needs you now" cards, so the numbers always agree. */
export function attentionCount(status, forecast) {
  const pendingMeds = new Set(status.pendingActions.map((a) => a.medicationId).filter(Boolean));
  return status.people.flatMap((p) => p.slots).filter((x) => x.state === "missed" || x.state === "due").length
    + status.pendingActions.length
    + forecast.filter((f) => f.urgency !== "ok" && !pendingMeds.has(f.medicationId)).length;
}

function glance(status, forecast) {
  const slots = status.people.flatMap((p) => p.slots);
  const given = slots.filter((x) => x.state === "taken").length;
  const needs = attentionCount(status, forecast);
  const low = forecast.filter((f) => f.urgency !== "ok").length;
  const stat = (label, value, of, tone) => h("div", { class: `glance-item ${tone ?? ""}` },
    h("dt", {}, label), h("dd", { class: "num" }, String(value), of != null ? h("span", {}, ` / ${of}`) : null));
  return h("dl", { class: "glance", "aria-label": "Today at a glance" },
    stat("Doses given", given, slots.length),
    stat("Need you now", needs, null, needs ? "alert" : "calm"),
    stat("Running low", low, null, low ? "warn" : "calm"));
}

export function renderToday() {
  const { status, forecast, handoff, activity } = state.data;
  const isToday = status.date === localYmd();
  const needCount = attentionCount(status, forecast);
  return h("div", { class: "view" },
    h("header", { class: "hero hero-today" },
      h("div", { class: "hero-copy" },
        h("p", { class: "eyebrow" }, isToday ? "Today" : "Schedule"),
        h("h1", { class: "display display-xl" }, fmtDateLong(status.date)),
        h("p", { class: "lede" }, summarySentence(status, forecast))),
      h("div", { class: "hero-side" },
        glance(status, forecast),
        h("div", { class: "sync", "aria-live": "polite" }, h("span", { class: "pulse" }), state.fetchedAt ? `Synced with the care circle ${relTime(state.fetchedAt.toISOString())}` : "Syncing…"))),
    h("section", { "aria-label": "Needs attention", class: "stack" },
      h("div", { class: "section-head" }, h("h2", { class: "section-title" }, needCount ? `Needs you now · ${needCount}` : "Needs you now")),
      attention(status, forecast)),
    h("section", { class: "card", style: "margin-top:28px" },
      h("div", { class: "section-head" },
        h("div", {}, h("h2", { class: "section-title" }, "Today's doses"), h("p", { class: "small muted" }, `Times in ${status.timezone.replace(/_/g, " ")}. Select a dose on the timeline to find it in the list.`))),
      lanes(status)),
    h("div", { class: "grid-2" }, adherence(handoff), supply(forecast)),
    h("section", { class: "card", style: "margin-top:20px" },
      h("div", { class: "section-head" },
        h("div", {}, h("h2", { class: "section-title" }, "Care circle"), h("p", { class: "small muted" }, "Who did what. Every record names the caregiver who made it."))),
      activityFeed(activity, { limit: 8, newIds: state.newActivity }),
      h("a", { href: "#/handoff", class: "btn btn-ghost btn-sm", style: "margin-top:8px" }, "Full history in the handoff report", icon("chevron", "sm"))));
}

export { slotKey };
