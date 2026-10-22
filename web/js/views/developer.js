// Technical workspace: protocol diagnostics for builders and judges.
// Everything shown here is real traffic captured from this page and the agent.
import { state, client, actor } from "../api.js";
import { h, icon, fmtTime, toast } from "../ui.js";

let tab = "overview";
let toolsCache = null;
let toolsFor = null;

function summarize(m) {
  if (typeof m === "string") return m;
  if (m?.method) return `${m.method}${m.method === "tools/call" ? ` · ${m.params?.name}` : ""}`;
  if (m?.error) return `error: ${m.error.message}`;
  if (m?.result?.protocolVersion) return `result · initialize (${m.result.protocolVersion})`;
  if (m?.result?.tools) return `result · ${m.result.tools.length} tools`;
  if (m?.result?.isError) return "result · isError";
  if (m?.result) return "result";
  return "message";
}

async function loadTools() {
  if (toolsCache && toolsFor === state.actorId) return toolsCache;
  const res = await client().listTools("inspector");
  toolsCache = res.tools;
  toolsFor = state.actorId;
  return toolsCache;
}

function overview(root) {
  const cfg = state.config;
  const init = client().initialized;
  const dashCalls = state.wire.filter((w) => w.source === "dashboard" && w.direction === "server→client" && typeof w.ms === "number");
  const avg = dashCalls.length ? Math.round(dashCalls.reduce((a, w) => a + w.ms, 0) / dashCalls.length) : null;
  const engine = cfg.engine === "bedrock"
    ? `Amazon Bedrock (Converse + tool use) · ${cfg.model}${cfg.guardrail ? " · Guardrail on" : ""}`
    : "Offline intent router (no LLM). AWS credentials not configured, so Bedrock is not in use";
  root.append(
    h("div", { class: "grid-2", style: "margin-top:0" },
      h("section", { class: "card" },
        h("h2", { class: "section-title" }, "MCP server"),
        h("dl", { class: "kv", style: "margin-top:14px" },
          h("dt", {}, "Endpoint"), h("dd", {}, `${location.origin}${cfg.server.mcpPath}`),
          h("dt", {}, "Transport"), h("dd", {}, "Streamable HTTP · stateless · JSON responses"),
          h("dt", {}, "Negotiated protocol"), h("dd", {}, init?.protocolVersion ?? "(not yet initialized)"),
          h("dt", {}, "Server"), h("dd", {}, init ? `${init.serverInfo.name} ${init.serverInfo.version}` : `${cfg.server.name} ${cfg.server.version}`),
          h("dt", {}, "Capabilities"), h("dd", {}, init ? Object.keys(init.capabilities).join(", ") : "—"),
          h("dt", {}, "Extensions"), h("dd", {}, "io.modelcontextprotocol/ui (MCP Apps) · ui://tend/care-board"),
          h("dt", {}, "Auth"), h("dd", {}, `Bearer · this page uses a 1-hour HMAC session token for ${actor()?.name} (${actor()?.role})`))),
      h("section", { class: "card" },
        h("h2", { class: "section-title" }, "Assistant & traffic"),
        h("dl", { class: "kv", style: "margin-top:14px" },
          h("dt", {}, "Engine"), h("dd", {}, engine),
          h("dt", {}, "Messages captured"), h("dd", {}, String(state.wire.length)),
          h("dt", {}, "Avg dashboard call"), h("dd", {}, avg == null ? "—" : `${avg} ms (browser → /mcp → SQLite → browser)`),
          h("dt", {}, "Assistant turns"), h("dd", {}, String(state.turns.length)),
          h("dt", {}, "Household timezone"), h("dd", {}, cfg.timezone)))),
    init?.instructions ? h("section", { class: "card" }, h("h2", { class: "section-title" }, "Server instructions"), h("pre", { class: "code", style: "white-space:pre-wrap" }, init.instructions)) : null);
}

async function tools(root) {
  const list = await loadTools();
  root.append(h("p", { class: "small muted" }, `${list.length} tools visible to ${actor()?.name} (${actor()?.role}). Write tools are not even listed for view-only caregivers.`),
    h("div", { class: "tool-grid" }, list.map((t) => {
      const a = t.annotations ?? {};
      const props = Object.entries(t.inputSchema?.properties ?? {});
      const req = new Set(t.inputSchema?.required ?? []);
      return h("article", { class: "tool-card" },
        h("h4", {}, t.name,
          a.readOnlyHint ? h("span", { class: "hint" }, "read-only") : h("span", { class: "hint write" }, "write"),
          a.destructiveHint ? h("span", { class: "hint destructive" }, "destructive") : null,
          t._meta?.ui?.resourceUri ? h("span", { class: "hint app" }, "MCP App") : null),
        h("p", {}, t.description),
        props.length ? h("ul", { class: "params" }, props.map(([k, v]) => h("li", {}, h("code", {}, k), req.has(k) ? " (required)" : "", v.description ? `: ${v.description}` : v.type ? `: ${v.type}` : ""))) : h("p", { class: "tiny muted" }, "No arguments."),
        t.outputSchema ? h("details", {}, h("summary", { class: "tiny muted" }, "Output schema"), h("pre", { class: "code" }, JSON.stringify(t.outputSchema, null, 2))) : null);
    })));
}

async function inspector(root) {
  const list = await loadTools();
  const select = h("select", {}, list.map((t) => h("option", { value: t.name }, t.name)));
  const args = h("textarea", { rows: 6, spellcheck: "false", style: "font-family:var(--mono);font-size:13px" });
  const out = h("pre", { class: "code" }, "Result appears here.");
  const example = () => {
    const t = list.find((x) => x.name === select.value);
    const o = {};
    for (const k of t?.inputSchema?.required ?? []) {
      const p = t.inputSchema.properties[k];
      o[k] = p.type === "number" || p.type === "integer" ? 1 : p.type === "array" ? ["08:00"] : "";
    }
    args.value = JSON.stringify(o, null, 2);
  };
  select.addEventListener("change", example);
  example();
  const run = h("button", {
    class: "btn btn-primary", onclick: async () => {
      let parsed;
      try { parsed = JSON.parse(args.value || "{}"); } catch { out.textContent = "Arguments must be valid JSON."; return; }
      out.textContent = "Calling…";
      const t0 = performance.now();
      try {
        const res = await client().callTool(select.value, parsed, "inspector");
        out.textContent = `// ${Math.round(performance.now() - t0)} ms\n${JSON.stringify(res, null, 2)}`;
      } catch (err) {
        out.textContent = `JSON-RPC error ${err.code ?? ""}: ${err.message}`;
      }
    },
  }, icon("terminal", "sm"), "Call tool");
  root.append(h("section", { class: "card" },
    h("p", { class: "small muted", style: "margin-top:0" }, "Calls go straight from this browser to the MCP server over Streamable HTTP as the selected caregiver. No model is involved. Write tools change real data."),
    h("div", { class: "form-row" }, h("label", { class: "field" }, "Tool", select)),
    h("label", { class: "field", style: "margin-top:12px" }, "Arguments (JSON)", args),
    h("div", { class: "form-actions", style: "justify-content:flex-start" }, run),
    out));
}

function traffic(root) {
  const src = h("select", {}, ["all", "dashboard", "assistant", "card", "inspector"].map((v) => h("option", { value: v }, v === "all" ? "All sources" : v)));
  const q = h("input", { type: "search", placeholder: "Filter by method or tool…" });
  const listEl = h("div", { class: "traffic" });
  const detail = h("pre", { class: "code" }, "Select a message to see its JSON.");
  const draw = () => {
    const items = state.wire.filter((w) => (src.value === "all" || w.source === src.value) && (!q.value || JSON.stringify(w.message).toLowerCase().includes(q.value.toLowerCase()))).slice(-200).reverse();
    listEl.replaceChildren(...items.map((w) => {
      const err = typeof w.message === "object" && (w.message?.error || w.message?.result?.isError);
      return h("div", { class: `traffic-row ${err ? "err" : ""}`, tabindex: 0, onclick: () => { detail.textContent = typeof w.message === "string" ? w.message : JSON.stringify(w.message, null, 2); } },
        h("span", { class: "num tiny muted" }, fmtTime(w.at)),
        h("span", { class: "src" }, w.source ?? "—"),
        h("span", { class: "dir" }, w.direction === "client→server" ? "→" : "←"),
        h("span", { class: "m" }, summarize(w.message)),
        h("span", { class: "st" }, w.httpStatus ? `${w.httpStatus}${w.ms != null ? ` · ${w.ms}ms` : ""}` : ""));
    }));
    if (!items.length) listEl.append(h("p", { class: "muted small" }, "No messages match."));
  };
  src.addEventListener("change", draw);
  q.addEventListener("input", draw);
  draw();
  root.append(h("div", { class: "filters" }, src, q, h("span", { class: "tiny muted" }, "Newest first · last 200")), h("div", { class: "grid-2", style: "margin-top:0;align-items:start" }, listEl, h("div", { style: "position:sticky;top:80px" }, detail)));
}

function turns(root) {
  if (!state.turns.length) {
    root.append(h("p", { class: "muted" }, "No assistant turns yet. Ask the Alexa+ companion something."));
    return;
  }
  for (const t of state.turns) {
    root.append(h("article", { class: "turn-trace" },
      h("div", { class: "section-head", style: "margin-bottom:6px" },
        h("span", { class: "q" }, `“${t.text}”`),
        h("span", { class: "tiny muted" }, `${t.actor} · ${fmtTime(t.at)} · ${t.engine === "bedrock" ? "Amazon Bedrock" : "offline router"} · ${t.ms} ms${t.usage ? ` · ${t.usage.modelCalls} model calls · ${t.usage.inputTokens + t.usage.outputTokens} tokens` : ""}`)),
      t.guardrail?.intervened ? h("div", { class: "callout warn" }, "Amazon Bedrock Guardrail blocked this request before any tool ran.") : null,
      t.tools.map((s, i) => h("div", { class: "step" },
        h("span", { class: "num tiny muted" }, String(i + 1)),
        h("div", {},
          h("span", { class: "tname" }, s.name), " ",
          s.blockedByHost ? h("span", { class: "hint destructive" }, "blocked by host policy") : s.isError ? h("span", { class: "hint destructive" }, "error") : null,
          h("div", { class: "args" }, JSON.stringify(s.arguments)),
          h("div", { class: "small" }, s.speech)))),
      h("p", { class: "small", style: "margin:8px 0 0" }, h("b", {}, "Reply: "), t.reply),
      t.speech && t.speech !== t.reply ? h("p", { class: "tiny muted", style: "margin:4px 0 0" }, h("b", {}, "Spoken as: "), t.speech) : null));
  }
}

function modeBanner() {
  const cfg = state.config;
  return cfg.engine === "bedrock"
    ? h("div", { class: "callout info mode" }, icon("sparkle", "sm"), h("span", {}, h("b", {}, "Model mode. "), `Amazon Bedrock (${cfg.model}) chooses tools and writes replies. The host still enforces the confirmation gate and the server enforces permissions and the double-dose guard.`))
    : h("div", { class: "callout mode" }, icon("info", "sm"), h("span", {}, h("b", {}, "Offline mode. "), "No language model is connected. Tend's intent router picks tools deterministically and composes replies from their verified results. Set AWS credentials to use Amazon Bedrock."));
}

export function renderDeveloper() {
  try {
    const want = sessionStorage.getItem("tend.devtab");
    if (want) { tab = want; sessionStorage.removeItem("tend.devtab"); }
  } catch { /* storage unavailable */ }
  const body = h("div");
  const tabs = [["overview", "Overview"], ["tools", "Tools"], ["inspector", "Inspector"], ["traffic", "Traffic"], ["turns", "Assistant turns"]];
  const tabBar = h("div", { class: "tabs", role: "tablist" }, tabs.map(([id, label]) => h("button", {
    role: "tab", "aria-selected": String(tab === id), onclick: () => { tab = id; draw(); },
  }, label)));
  const draw = async () => {
    for (const b of tabBar.children) b.setAttribute("aria-selected", String(b.textContent === tabs.find((t) => t[0] === tab)[1]));
    body.replaceChildren();
    try {
      if (tab === "overview") overview(body);
      else if (tab === "tools") await tools(body);
      else if (tab === "inspector") await inspector(body);
      else if (tab === "traffic") traffic(body);
      else turns(body);
    } catch (err) {
      toast(err.message, "error");
    }
  };
  draw();
  return h("div", { class: "view dev" },
    h("header", { class: "hero", style: "margin-bottom:0" },
      h("div", {}, h("p", { class: "eyebrow" }, "Developer workspace"), h("h1", { class: "display display-xl" }, "Under the hood"),
        h("p", { class: "lede" }, "Tend is a self-hosted MCP server. Everything the care circle sees above comes from these tools, over this protocol, with these permissions."))),
    modeBanner(), tabBar, body);
}
