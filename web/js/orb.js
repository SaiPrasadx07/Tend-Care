// The Alexa+ orb: Tend's assistant identity. Pure CSS layers driven by a
// data-state attribute. States are set only from real events (microphone
// started, request in flight, speech playing), never for decoration.
import { h } from "./ui.js";

export const ORB_STATES = ["idle", "listening", "thinking", "speaking", "success", "error", "unavailable"];

const LABELS = {
  idle: "Alexa+ is ready",
  listening: "Alexa+ is listening",
  thinking: "Alexa+ is checking the care record",
  speaking: "Alexa+ is speaking",
  success: "Done",
  error: "Something went wrong",
  unavailable: "Alexa+ is unavailable",
};

/** Build orb markup. Used both by JS and mirrored statically in index.html for the splash. */
export function orbMarkup(size = 56) {
  return h("span", { class: "orb", "data-state": "idle", style: `--orb:${size}px`, role: "img", "aria-label": LABELS.idle },
    h("span", { class: "orb-halo" }),
    h("span", { class: "orb-ripple" }),
    h("span", { class: "orb-shell" }),
    h("span", { class: "orb-core" }),
    h("span", { class: "orb-glint" }));
}

export function createOrb(size = 56) {
  const el = orbMarkup(size);
  let timer;
  const api = {
    el,
    state: "idle",
    set(state) {
      if (!ORB_STATES.includes(state)) return;
      clearTimeout(timer);
      api.state = state;
      el.dataset.state = state;
      el.setAttribute("aria-label", LABELS[state]);
    },
    /** Transient acknowledgement after a confirmed result, then back to rest. */
    flash(state, ms = 1400) {
      api.set(state);
      timer = setTimeout(() => api.set("idle"), ms);
    },
    /** A brief brightening, e.g. on each spoken word boundary. */
    pulse() {
      el.classList.remove("pulse");
      void el.offsetWidth;
      el.classList.add("pulse");
    },
  };
  return api;
}

/** Attach an orb API to existing static markup (the splash screen). */
export function adoptOrb(el) {
  const api = createOrb();
  api.el = el;
  const set = api.set;
  api.set = (state) => {
    set(state);
    el.dataset.state = state;
    el.setAttribute("aria-label", LABELS[state]);
  };
  return api;
}
