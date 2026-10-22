import { state, setHandoffDays } from "../api.js";
import { h, icon, fmtDateLong, fmtDateShort, fmtDay, fmtTime, hhmmLabel, toast, plural, monogram } from "../ui.js";
import { adherenceGrid, stateLegend, stackBar } from "../charts.js";

function person(p, toDate) {
  return h("section", { class: "doc-section" },
    h("h3", {}, monogram(p.name), p.name, h("span", { class: "pct num" }, p.overallAdherencePct == null ? "—" : `${p.overallAdherencePct}%`)),
    h("p", { class: "small muted", style: "margin:0" }, p.overallAdherencePct == null ? "No doses were due in this period." : "of scheduled doses were given"),
    h("h4", {}, "By medication"),
    p.adherence.map((a) => h("div", { class: "bar-line" },
      h("span", {}, a.medication, h("span", { class: "tiny muted" }, ` · ${a.taken}/${a.scheduled} given${a.skipped ? `, ${a.skipped} skipped` : ""}${a.missed ? `, ${a.missed} missed` : ""}`)),
      stackBar(a),
      h("span", { class: "num", style: "text-align:right;font-weight:600" }, a.adherencePct == null ? "—" : `${a.adherencePct}%`))),
    p.adherence.length ? h("div", { style: "margin-top:14px" }, adherenceGrid(p.adherence, toDate)) : null,
    h("h4", {}, "Missed doses"),
    p.missedDoses.length
      ? h("ul", { class: "plain" }, p.missedDoses.map((m) => h("li", {}, `${fmtDateShort(m.date)}, ${hhmmLabel(m.time)}: ${m.medication}`)))
      : h("p", { class: "small muted", style: "margin:0" }, "None."),
    h("h4", {}, "Notes & observations"),
    p.notes.length
      ? h("ul", { class: "notes" }, p.notes.map((n) => h("li", { class: `note ${n.category}` }, h("p", {}, n.text), h("div", { class: "by" }, `${n.category} · ${n.loggedBy} · ${fmtDay(n.at)}, ${fmtTime(n.at)}`))))
      : h("p", { class: "small muted", style: "margin:0" }, "None recorded."));
}

export function renderHandoff() {
  const r = state.data.handoff;
  const days = [3, 7, 14];
  return h("div", { class: "view" },
    h("div", { class: "toolbar no-print" },
      h("div", { class: "segmented", role: "group", "aria-label": "Report period" }, days.map((d) => h("button", {
        "aria-pressed": String(r.days === d),
        onclick: async () => { await setHandoffDays(d); },
      }, `${d} days`))),
      h("div", { style: "display:flex;gap:8px" },
        h("button", {
          class: "btn btn-secondary btn-sm", onclick: async () => {
            try { await navigator.clipboard.writeText(state.data.handoffSpeech); toast("Summary copied"); } catch { toast("Clipboard isn't available here.", "error"); }
          },
        }, icon("copy", "sm"), "Copy summary"),
        h("button", { class: "btn btn-primary btn-sm", onclick: () => window.print() }, icon("print", "sm"), "Print or save PDF"))),
    h("article", { class: "doc" },
      h("header", { class: "doc-head" },
        h("div", {}, h("p", { class: "eyebrow" }, "Care handoff"), h("h1", { class: "display" }, `${fmtDateShort(r.fromDate)} – ${fmtDateShort(r.toDate)}`)),
        h("div", { class: "doc-meta" }, `Generated ${fmtDateLong(r.toDate)}, ${fmtTime(r.generatedAt)}`, h("br"), `${plural(r.days, "day")} · ${r.people.map((p) => p.name).join(" & ")}`)),
      h("p", { class: "doc-summary" }, state.data.handoffSpeech),
      r.people.map((p) => person(p, r.toDate)),
      h("section", { class: "doc-section" },
        h("h3", {}, "Supply & refills"),
        r.supplyAlerts.length
          ? h("ul", { class: "plain" }, r.supplyAlerts.map((a) => h("li", {}, `${a.personName}'s ${a.medication}: ${plural(a.daysLeft, "day")} left (runs out ${fmtDateShort(a.runoutDate)}). ${a.advice}`)))
          : h("p", { class: "small muted" }, "No medication runs out within a week."),
        r.openRefillRequests.length ? h("p", { class: "small" }, `Open refill requests: ${r.openRefillRequests.map((o) => `${o.personName}'s ${o.medication} (by ${o.requestedBy})`).join("; ")}.`) : null),
      h("section", { class: "doc-section" },
        h("h3", {}, "Recent care-circle activity"),
        h("ul", { class: "plain" }, r.recentActivity.map((a) => h("li", {}, `${fmtDay(a.at)}, ${fmtTime(a.at)}: ${a.message}`)))),
      stateLegend(),
      h("p", { class: "tiny muted", style: "margin-top:28px" }, "Prepared by Tend from caregiver-logged records. Not medical advice; share with the care team as a record of what was logged.")));
}
