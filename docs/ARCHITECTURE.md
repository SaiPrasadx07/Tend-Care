# Architecture

Tend has three layers. Each one is independently testable.

```
┌────────────── Browser: caregiver app + Alexa+ companion (web/) ──────────────────┐
│ Device UI (Web Speech in, speechSynthesis out)                                   │
│ MCP Apps host: sandbox-proxy.html → nested sandboxed iframe → ui://tend/care-board │
│ Browser MCP client (mcp-browser.js): Care feed, Inspector, proxied card tool calls │
└───────────────┬──────────────────────────────────────────────┬───────────────────┘
                │ POST /api/agent/turn (bearer)                │ POST /mcp (JSON-RPC, bearer)
┌───────────────▼──────────────────── Tend server (Node 24) ───▼───────────────────┐
│ http/app.ts   Host/Origin checks · rate limit · auth · CSP · static              │
│ agent/        CareAgent: per-turn MCP session + host policy (confirmation gate)  │
│               BedrockEngine (Converse tool use, Guardrails) | offline router     │
│               mcpClient.ts: SDK Client + StreamableHTTPClientTransport (traced)  │
│ mcp/server.ts McpServer per request, role-scoped tools, output schemas, MCP App  │
│ domain/       CareService (rules) → Store (node:sqlite)                          │
└───────────────┬──────────────────────────────────────────────────────────────────┘
                │ Converse API (HTTPS, SigV4)
        ┌───────▼────────┐
        │ Amazon Bedrock │  model with tool use (default Nova Pro) + optional Guardrail
        └────────────────┘
```

## Request flow for one voice turn

1. The browser captures speech (Web Speech API) and POSTs `{text, sessionId}` to `/api/agent/turn` with a short-lived session token.
2. `CareAgent.turn` opens an MCP session to `TEND_MCP_URL` **with the same bearer token**, so the MCP server sees the same caregiver. That's one round trip each for `initialize`, `notifications/initialized` and `tools/list`.
3. The engine plans:
   - **Bedrock:** `ConverseCommand` with `toolConfig` built from `tools/list`. Each `toolUse` becomes `tools/call`, and each result returns as a `toolResult` (`text` = voice sentence, `json` = `structuredContent`). This loops until `end_turn` (max 6 steps).
   - **Offline:** regex intents map to the same tool calls.
4. **Host policy** wraps every tool call. `confirm_action` is only forwarded if the current utterance is affirmative *and* the action id was offered to this session in an *earlier* turn.
5. For tools whose descriptor has `_meta.ui.resourceUri`, the agent fetches the resource once (`resources/read`) and returns it as a card along with the tool input and result.
6. The response carries the reply, per-tool traces, cards and the **raw JSON-RPC wire log**, all rendered by the browser.

## Why stateless Streamable HTTP

All care state lives in SQLite, not in an MCP session. So `/mcp` builds a fresh `McpServer` and `StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })` for each POST:

- Horizontal scaling and serverless hosting (e.g. Lambda) need no sticky sessions.
- The tool list can be **role-scoped per request** from the bearer token.
- `GET /mcp` (standalone SSE) and `DELETE /mcp` (session end) return 405, as the spec allows for servers without those features.

## Domain rules (src/domain/care.ts)

- **Slot matching:** a dose maps to the nearest scheduled slot among yesterday's and today's, ignoring slots more than 4 hours in the future. So a dose logged at 00:30 counts for the 20:00 slot the day before. An explicit `slot_time` overrides this.
- **Slot state:** taken or skipped (latest event wins) → **missed** if more than 90 minutes past → **due** from 60 minutes before → **upcoming**. Slots before a medication was added are ignored.
- **Double-dose guard:** if the slot is already `taken`, a second `taken` returns `outcome: "needs_confirmation"` and **writes nothing**. A confirmed extra dose is recorded with an `extra_dose` activity flag.
- **Stock:** `taken` decrements `dose_units`. Overriding taken → skipped restores stock. A pickup adds stock and consumes one refill.
- **Forecast:** `daysLeft = floor(stock / (dose_units × times/day))`. Critical at ≤ 3 days, soon at ≤ N (default 7). Advice depends on refills remaining and any open request.
- **Two-phase actions:** stored in `pending_actions` with a 15-minute TTL. They're resolved by compare-and-set (`UPDATE … WHERE status='pending'`) inside a transaction, so a double confirm can't create two refill requests.
- **Timezones:** pure `Intl` math (`zonedToUtc` with a DST-corrected second pass). It's tested on US DST transitions and the Asia/Kolkata half-hour offset.

## MCP surface (src/mcp/server.ts)

- Every tool result has `content[0]` = a voice-ready sentence, `content[1]` = the JSON (backwards compatibility), and `structuredContent` validated against `outputSchema`.
- Domain errors come back as `isError: true` with a typed prefix (`NOT_FOUND: …`) so the model can recover, for example by asking which person. Protocol and schema errors are handled by the SDK.
- `instructions` in the `initialize` result give the host the safety rules (no medical advice, two-phase confirmation, how to handle duplicates).

## MCP Apps implementation

- **Server:** registers `ui://tend/care-board` (`text/html;profile=mcp-app`, `_meta.ui.csp` with no external domains). Three read tools reference it.
- **View** (`src/mcp/ui/care-board.html`): dependency-free. Sends `ui/initialize` (protocol `2026-01-26`) then `ui/notifications/initialized`, renders on `ui/notifications/tool-result`, and reports `ui/notifications/size-changed`. When the host advertises `serverTools` (caregivers only), it shows **Mark given**, which calls `tools/call log_dose` and then refreshes with `get_care_status`.
- **Host** (`web/js/assistant.js` + `web/sandbox-proxy.html`): uses the spec's double-iframe sandbox proxy. The outer frame is opaque-origin with a CSP forbidding all network access. The inner `srcdoc` view inherits that CSP. The host answers `ui/initialize`, sends tool-input then tool-result, resizes on size-changed, and proxies `tools/call` for an allowlist of tools.

## Data model

`people`, `medications` (times as JSON `["08:00","20:00"]`), `dose_events` (slot date/time, status, recorded_at, logged_by), `notes`, `pending_actions`, `refill_requests`, `activity`. SQLite runs in WAL mode with foreign keys on.

## Caregiver web app (web/)

- **No build step, no framework.** It uses ES modules under `web/js/`, a token-based design system in `styles.css`, and self-hosted OFL fonts (Newsreader, Instrument Sans, JetBrains Mono), so the strict CSP (`script-src 'self'`) holds and the app works offline.
- **Data layer** (`api.js`): each refresh runs five parallel MCP `tools/call`s as the selected caregiver: `list_care_recipients`, `get_care_status`, `forecast_refills`, `get_handoff_report` and `get_recent_activity`. One shared `initialize` promise prevents duplicate handshakes. Writes go through the same tools, so the double-dose guard, two-phase refills and role scoping are enforced server-side. View-only users simply don't get action buttons, and the server would refuse them anyway.
- **Visuals** (`charts.js`): the day timeline is SVG with percentage coordinates, so it's crisp at any width without resize handling. The adherence heatmap is an accessible HTML grid (`role="table"`) fed by the handoff report's per-day `daily` grid. Supply runway bars are drawn against a 30-day scale with the 7-day refill point. Status always appears as icon + label + color, using a palette validated for color-vision deficiency on the ivory surface.
- **Live sync:** a 20 s poll while the tab is visible, a diff against the previous snapshot to highlight changed doses and new activity, and toasts for changes by other caregivers.
- **Developer workspace:** every JSON-RPC message from the dashboard, cards, inspector and assistant is kept in a ring buffer with source and latency, so the protocol stays inspectable without dominating the caregiver experience.
