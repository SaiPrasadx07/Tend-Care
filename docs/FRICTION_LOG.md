# Friction log

Genuine friction hit while building Tend (Oct 21–23, 2026). Each entry follows the format the rules ask for: task, steps, expected vs. actual, severity, workaround, suggestion.

---

### 1. Testing a self-hosted MCP server against a real Alexa+ isn't possible

- **Task:** Validate Tend's MCP server end to end inside Alexa+.
- **Steps:** Read the Alexa+ add-on docs, then looked for a way to register a custom MCP endpoint, a CLI, or the Web Simulator.
- **Expected:** Some public path, even a sandbox, to point Alexa+ at a self-hosted Streamable HTTP MCP URL.
- **Actual:** The MCP Toolkit, Category SDK, CLI and Web Simulator are preview, select-partner only. The official FAQ confirms there's no way for participants to connect a self-hosted server to a device or console.
- **Severity:** High. You can't verify the most important integration: how Alexa+ actually chooses and phrases tool calls.
- **Workaround:** Built our own Alexa+ simulator. It's a real MCP client with a Bedrock agent, and it logs every JSON-RPC message so judges can see the protocol traffic.
- **Suggestion:** Publish a public Web Simulator mode that accepts an arbitrary HTTPS MCP URL plus a bearer header, even if rate-limited and text-only.

### 2. Unclear how Alexa+ renders MCP results (structuredContent, MCP Apps, `_meta`)

- **Task:** Design results that look good on an Echo Show.
- **Steps:** Searched the add-on docs for screen and card guidance on MCP tool results.
- **Expected:** Guidance on whether Alexa+ reads `content` text, `structuredContent`, or MCP Apps `ui://` resources, and on what's supported for display (sizes, theming, `ui/` methods).
- **Actual:** We couldn't find this in public docs. The judging criteria mention "media support (cards, carousels)" and "MCP Apps", but not which mechanism Alexa+ supports.
- **Severity:** Medium. We may be optimizing for a rendering path that Alexa+ doesn't use.
- **Workaround:** Followed the open MCP Apps spec (`2026-01-26`) and also return a voice-ready sentence as the first text block, so either path works.
- **Suggestion:** A "rendering MCP results on Alexa+ devices" doc page: which content types are read aloud, which `_meta.ui` fields are honored, and screen dimensions per device.

### 3. Official rules and FAQ pages couldn't be fetched by tooling

- **Task:** Have our AI coding assistant verify the rules and FAQ directly (we used Claude Code).
- **Steps:** HTTP fetches of `amazonappdev2026.devpost.com/rules` and `/details/faqs` from the CLI.
- **Expected:** Readable HTML.
- **Actual:** `403` behind a bot challenge ("Enable JavaScript and cookies to continue"). It only worked through a headless-browser reader.
- **Severity:** Low for humans, medium for agentic workflows. Requirements had to be cross-checked by hand.
- **Workaround:** Headless-browser rendering service, then a manual check.
- **Suggestion:** Publish the rules and FAQ also as a static Markdown or JSON file (or in the resources GitHub org) so assistants can ground on them.

### 4. AWS Promotional Credits ran out before the build window ended

- **Task:** Use Bedrock without personal billing risk.
- **Steps:** Checked the credits form (rules section 4).
- **Expected:** Credits available through the stated Oct 21 deadline.
- **Actual:** The "Oct 7 update: out of credit codes" notice. Late joiners pay for Bedrock themselves.
- **Severity:** Medium for students and solo builders.
- **Workaround:** Kept Bedrock off the hot path in development (an offline router plus a scripted Bedrock mock in tests), with live calls only for validation and the demo.
- **Suggestion:** A small, automatically applied Bedrock allowance per registered participant, or a shared sandbox account with tight quotas.

### 5. Two protocol versions to track (core MCP vs. MCP Apps)

- **Task:** Implement the MCP Apps host handshake.
- **Steps:** Implemented `ui/initialize` per the ext-apps spec.
- **Expected:** One version string.
- **Actual:** Core MCP negotiates `2025-11-25`, while the MCP Apps dialect uses its own `protocolVersion: "2026-01-26"` inside `ui/initialize`, and the hackathon text only mentions the core version.
- **Severity:** Low.
- **Workaround:** Documented both in the code and README.
- **Suggestion:** The Alexa+ docs should state which MCP Apps spec revision Alexa+ targets.

---

<!-- Add Bedrock-specific entries here only after observing them in a live run (npm run smoke:bedrock / demo). -->
