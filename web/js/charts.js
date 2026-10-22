// Hand-built visualisations. Every mark is computed from MCP tool output;
// status is always encoded by icon + label as well as colour.
import { h, s, icon, hhmmLabel, fmtTime, fmtDateShort, weekdayLetter, STATE_META, withTip } from "./ui.js";

const STATE_COLOR = {
  taken: "var(--st-taken)",
  missed: "var(--st-missed)",
  skipped: "var(--st-skipped)",
  due: "var(--st-due)",
  upcoming: "var(--paper)",
  untracked: "var(--st-untracked)",
};
const ICON_PATH = {
  taken: "M5 12.5l4.2 4.2L19 7",
  missed: "M12 6.5v7M12 17.5v.5",
  skipped: "M5 12h14M13 6l6 6-6 6",
  due: "M12 7v5l3 2",
  upcoming: "M12 7v5l3 2",
};

function hm(t) {
  const [a, b] = t.split(":").map(Number);
  return a * 60 + b;
}

export function slotDescription(slot) {
  const who = slot.loggedBy ? ` by ${slot.loggedBy}` : "";
  const at = slot.recordedAt ? ` at ${fmtTime(slot.recordedAt)}` : "";
  return {
    taken: `Given${at}${who}`,
    skipped: `Marked skipped${at}${who}`,
    missed: "Not logged. Past the 90-minute window",
    due: "Due now",
    upcoming: "Scheduled",
  }[slot.state];
}

/** A person's day: hours axis, past shading, now line and one marker per scheduled dose. */
export function dayTimeline(person, nowMin, isToday, onSelect) {
  const times = person.slots.map((x) => hm(x.time));
  const start = Math.min(6 * 60, Math.floor((Math.min(...times, 6 * 60) - 30) / 60) * 60);
  const end = Math.max(23 * 60, Math.ceil((Math.max(...times, 22 * 60) + 30) / 60) * 60);
  const pct = (m) => `${(((Math.min(Math.max(m, start), end) - start) / (end - start)) * 100).toFixed(3)}%`;

  const groups = new Map();
  for (const slot of person.slots) {
    const list = groups.get(slot.time) ?? [];
    list.push(slot);
    groups.set(slot.time, list);
  }
  const maxStack = Math.max(1, ...[...groups.values()].map((g) => g.length));
  const height = Math.max(76, 40 + maxStack * 26);
  const midY = (height - 22) / 2 + 4;
  const axisY = height - 20;

  const svg = s("svg", { class: "timeline-svg", style: `height:${height}px`, role: "img", "aria-label": `${person.name}'s doses today on a timeline` });
  if (isToday && nowMin > start) svg.append(s("rect", { class: "past", x: "0", y: 0, width: pct(nowMin), height: axisY, rx: 6 }));
  svg.append(s("line", { class: "axis-line", x1: "0", x2: "100%", y1: axisY, y2: axisY }));
  for (let m = Math.ceil(start / 180) * 180; m <= end; m += 180) {
    svg.append(s("line", { class: "tick", x1: pct(m), x2: pct(m), y1: axisY, y2: axisY + 4 }));
    const hr = m / 60;
    const label = hr === 0 || hr === 24 ? "12 AM" : hr === 12 ? "Noon" : `${hr % 12} ${hr < 12 ? "AM" : "PM"}`;
    svg.append(s("text", { class: "tick-label", x: pct(m), y: axisY + 16, "text-anchor": "middle" }, label));
  }
  if (isToday && nowMin >= start && nowMin <= end) {
    svg.append(s("line", { class: "now-line", x1: pct(nowMin), x2: pct(nowMin), y1: 0, y2: axisY }));
    svg.append(s("text", { class: "now-label", x: pct(nowMin), y: -4, "text-anchor": "middle" }, "Now"));
  }
  for (const [time, list] of groups) {
    list.forEach((slot, i) => {
      const y = midY + (i - (list.length - 1) / 2) * 26;
      const color = STATE_COLOR[slot.state];
      const g = s("g", { class: "dose-mark", tabindex: 0, role: "button", "aria-label": `${hhmmLabel(time)} ${slot.medication}: ${STATE_META[slot.state].label}` });
      g.append(s("circle", { class: "halo", cx: pct(hm(time)), cy: y, r: 16, fill: "var(--teal-tint)" }));
      g.append(s("circle", { class: `ring ${slot.state}`, cx: pct(hm(time)), cy: y, r: 11, fill: color }));
      const iconColor = slot.state === "upcoming" ? "var(--st-upcoming-ink)" : "#fff";
      const nested = s("svg", { x: pct(hm(time)), y: y - 7, width: 14, height: 14, overflow: "visible" });
      nested.append(s("path", { d: ICON_PATH[slot.state], transform: "translate(-7 0) scale(.5833)", fill: "none", stroke: iconColor, "stroke-width": 3, "stroke-linecap": "round", "stroke-linejoin": "round" }));
      g.append(nested);
      withTip(g, `${hhmmLabel(time)} · ${slot.medication}`, slotDescription(slot));
      g.addEventListener("click", () => onSelect?.(slot));
      g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect?.(slot); } });
      svg.append(g);
    });
  }
  return svg;
}

export function ring(pct, label = "7-day") {
  const r = 34;
  const c = 2 * Math.PI * r;
  const svg = s("svg", { class: "ring-svg", viewBox: "0 0 84 84", role: "img", "aria-label": pct == null ? "No doses due yet" : `${pct}% of doses given, ${label}` });
  svg.append(s("circle", { class: "track", cx: 42, cy: 42, r, fill: "none", "stroke-width": 7 }));
  if (pct != null) {
    const v = s("circle", { class: "value", cx: 42, cy: 42, r, fill: "none", "stroke-width": 7, "stroke-dasharray": c, "stroke-dashoffset": c, transform: "rotate(-90 42 42)" });
    svg.append(v);
    requestAnimationFrame(() => requestAnimationFrame(() => v.setAttribute("stroke-dashoffset", String(c * (1 - pct / 100)))));
  }
  svg.append(s("text", { x: 42, y: 45, "text-anchor": "middle", class: "num" }, pct == null ? "—" : `${pct}`));
  svg.append(s("text", { x: 42, y: 60, "text-anchor": "middle", class: "unit" }, pct == null ? "" : "% given"));
  return svg;
}

/** Medication × day grid; each day is split into its scheduled slots. */
export function adherenceGrid(lines, today) {
  const dates = lines[0]?.daily.map((d) => d.date) ?? [];
  const grid = h("div", { class: "hm", role: "table", "aria-label": "Doses by day", style: `--days:${dates.length}` });
  grid.append(h("div", { class: "hm-row hm-head", role: "row" },
    h("span", { role: "columnheader", class: "hm-label" }, h("span", { class: "sr-only" }, "Medication")),
    dates.map((d) => h("span", { role: "columnheader", class: `hm-day ${d === today ? "today" : ""}`, title: fmtDateShort(d) }, d === today ? "Today" : weekdayLetter(d)))));
  for (const line of lines) {
    const row = h("div", { class: "hm-row", role: "row" }, h("span", { role: "rowheader", class: "hm-label" }, line.medication));
    for (const day of line.daily) {
      const cell = h("span", { role: "cell", class: "hm-cell" });
      for (const slot of day.slots) {
        const box = h("span", { class: `hm-slot ${slot.state}`, tabindex: 0, "aria-label": `${fmtDateShort(day.date)} ${hhmmLabel(slot.time)}: ${STATE_META[slot.state].label}` });
        if (slot.state !== "untracked" && slot.state !== "upcoming") box.append(icon(STATE_META[slot.state].icon));
        withTip(box, `${line.medication} · ${hhmmLabel(slot.time)}`, `${fmtDateShort(day.date)}: ${STATE_META[slot.state].label}`);
        cell.append(box);
      }
      row.append(cell);
    }
    grid.append(row);
  }
  return grid;
}

export function stateLegend(states = ["taken", "missed", "skipped", "upcoming", "untracked"]) {
  return h("div", { class: "legend", "aria-hidden": "true" }, states.map((st) =>
    h("span", {}, h("span", { class: `hm-slot legend-swatch ${st}` }, st === "untracked" || st === "upcoming" ? null : icon(STATE_META[st].icon)), STATE_META[st].label)));
}

/** Days-of-supply bar against a 30-day scale with the 7-day refill threshold marked. */
export function runwayBar(item, scale = 30, threshold = 7) {
  const p = Math.min(item.daysLeft / scale, 1);
  const svg = s("svg", { role: "img", "aria-label": `${item.daysLeft} days of supply left` });
  svg.append(s("rect", { class: "track", x: 0, y: 4, width: "100%", height: 12, rx: 6 }));
  if (p > 0) svg.append(s("rect", { class: `fill ${item.urgency}`, x: 0, y: 4, width: `${Math.max(p * 100, 2)}%`, height: 12, rx: 6 }));
  const tx = `${(threshold / scale) * 100}%`;
  svg.append(s("line", { class: "threshold", x1: tx, x2: tx, y1: 0, y2: 20 }));
  return h("div", { class: "runway-bar" }, svg);
}

/** Stacked given / skipped / missed bar for a medication's window. */
export function stackBar(line) {
  const total = line.scheduled || 1;
  const seg = (n, cls) => (n > 0 ? h("span", { style: `width:${(n / total) * 100}%;background:var(--st-${cls})`, title: `${n} ${cls}` }) : null);
  return h("div", { class: "bar-track", role: "img", "aria-label": `${line.taken} given, ${line.skipped} skipped, ${line.missed} missed of ${line.scheduled}` },
    seg(line.taken, "taken"), seg(line.skipped, "skipped"), seg(line.missed, "missed"));
}
