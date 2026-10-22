// The Alexa+ orb: Tend's assistant identity. Pure CSS layers driven by a
// data-state attribute. States are set only from real events (microphone
// started, request in flight, speech playing), never for decoration.
import { h } from "./ui.js";

export const ORB_STATES = ["idle", "listening", "thinking", "speaking", "success", "error", "unavailable", "forming"];

const LABELS = {
  idle: "Alexa+ is ready",
  listening: "Alexa+ is listening",
  thinking: "Alexa+ is checking the care record",
  speaking: "Alexa+ is speaking",
  success: "Done",
  error: "Something went wrong",
  unavailable: "Alexa+ is unavailable",
  forming: "Tend is starting",
};

/** Build orb markup. Used both by JS and mirrored statically in index.html for the splash. */
export function orbMarkup(size = 56) {
  return h("span", { class: "orb", "data-state": "idle", style: `--orb:${size}px`, role: "img", "aria-label": LABELS.idle },
    h("span", { class: "orb-halo" }),
    h("span", { class: "orb-ring" }),
    h("span", { class: "orb-ripple" }),
    h("span", { class: "orb-shell" }),
    h("span", { class: "orb-core" }),
    h("span", { class: "orb-glint" }));
}

function wrap(el) {
  let timer;
  const api = {
    el,
    state: el.dataset.state || "idle",
    set(state) {
      if (!ORB_STATES.includes(state)) return;
      clearTimeout(timer);
      api.state = state;
      el.dataset.state = state;
      el.setAttribute("aria-label", LABELS[state]);
      if (state !== "listening") api.level(null);
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
    /** Live microphone level 0..1 while listening; null when no meter is running. */
    level(v) {
      if (v == null) {
        el.style.removeProperty("--level");
        delete el.dataset.meter;
        return;
      }
      el.dataset.meter = "1";
      el.style.setProperty("--level", Math.max(0, Math.min(1, v)).toFixed(3));
    },
    /** Whether the speech engine currently hears speech (onspeechstart / onspeechend). */
    voice(on) {
      if (on) el.dataset.voice = "1";
      else delete el.dataset.voice;
    },
  };
  return api;
}

export function createOrb(size = 56) {
  return wrap(orbMarkup(size));
}

/** Attach an orb API to existing static markup (the splash screen). */
export function adoptOrb(el) {
  return wrap(el);
}
