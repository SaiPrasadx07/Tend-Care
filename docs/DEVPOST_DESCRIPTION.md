# Devpost submission text (draft; paste into the fields)

**Project name:** Tend: a care circle for Alexa+

**Tagline:** One shared, voice-first memory of a parent's medications for every sibling who helps, with guards against missed doses, double doses and empty bottles.

## Inspiration

When siblings share care of a parent, the most dangerous question in the house is *"did Mom already take her pill?"* One sibling gives the evening dose at 8:00; another walks in at 8:30 and doesn't know. Refills get noticed on the last tablet. Symptoms get mentioned in a chat thread and forgotten before the doctor visit. The kitchen smart speaker is where these questions are asked, usually with your hands full, so we built the memory Alexa+ is missing.

## What it does

Tend is an Alexa+ add-on built as a self-hosted **MCP server** (spec **2025-11-25**, **Streamable HTTP**). Caregivers just talk:

- *"Did Mom take her pills today?"*: what's taken (by whom, when), **missed**, due now and upcoming, as an interactive **MCP Apps** card.
- *"I just gave Dad his amlodipine"*: the dose is logged against the right scheduled slot and stock goes down. If a sibling already logged it, Tend **refuses and says who logged it and when (double-dose guard)**.
- *"When will we run out?"*: a runout forecast from stock × schedule, flagging prescriptions with no refills left.
- *"Reorder Mom's metformin"* → *"Yes"*: a **two-step** refill. The summary is read back, and only an explicit yes in a later turn executes it. The host enforces this, not the model.
- *"Note that Dad felt dizzy"* / *"Give me this week's handoff"*: observations plus adherence percentages and missed doses, ready for the next sibling or a doctor visit.
- Per-caregiver identity and a **view-only** role (e.g. a visiting nurse sees status, and write tools aren't even listed for them).
- **No medical advice**, enforced in the server instructions, the system prompt and an **Amazon Bedrock Guardrail**.

## How we built it

- **MCP server:** TypeScript on Node 24 with the official MCP SDK. Stateless Streamable HTTP (a fresh server per request, role-scoped tool lists from the bearer token). 13 tools with zod-validated inputs **and output schemas**, tool annotations (`readOnlyHint`, `destructiveHint`), and voice-ready text plus `structuredContent` in every result. SQLite (`node:sqlite`) keeps state across sessions and caregivers.
- **MCP Apps:** `ui://tend/care-board` (`text/html;profile=mcp-app`) renders status, refill and handoff results. We implemented the host side too: a sandbox proxy, the `ui/initialize` handshake, tool-result notifications, and a proxied `tools/call` for the card's **Mark given** button.
- **Caregiver app + Alexa+ companion:** a caregiver command center (day timelines, an adherence heatmap, supply runway, profiles and a printable handoff report) built entirely on Tend's MCP tools. A docked Alexa+ companion (voice in via Web Speech, voice out via speech synthesis) is a **real MCP client** too: every turn runs `initialize → tools/list → tools/call` over Streamable HTTP and refreshes the dashboard. A separate developer workspace shows the raw JSON-RPC, tool catalog and turn traces.
- **AWS (AWS Builder):** the assistant reasons on **Amazon Bedrock**'s Converse API with tool use. MCP `tools/list` becomes Bedrock tool specs, each `toolUse` becomes an MCP `tools/call`, and results return as text plus JSON. **Bedrock Guardrails** denies medical-advice topics, applied only to the user's words via `guardContent` so medication names in tool results don't false-trigger.
- **Safety and security:** the double-dose guard, two-phase actions with expiry and single-use compare-and-set, a host-side confirmation gate, bearer auth with short-lived HMAC session tokens for the browser, DNS-rebinding protection, rate limits, strict CSP and double-sandboxed MCP App views.
- **Conversation:** an intent-aware assistant that asks a short clarifying question for vague requests, answers clear ones narrowly, follows up with context ("What about tonight?"), and never writes on an assumption (ambiguous medicine → "for Mom or Dad?"; "she probably took it" → confirm first). Offline it's a deterministic intent engine composing replies from verified tool results; with AWS configured, Bedrock generates them under the same rules.
- **Tests:** 79 automated tests against the real HTTP server, covering protocol negotiation, auth, the guards, timezone/DST math, and the Bedrock tool loop with a scripted client (including a model that tries to self-confirm a refill and is blocked).

## Challenges we ran into

- Alexa+ add-on tooling is partner-only, so we built a faithful simulator and made every protocol message visible instead.
- Matching "I gave her the pill" to the right dose: e.g. 00:30 belongs to last night's 20:00 slot, and the math has to be correct across DST using only `Intl`.
- Letting the model propose consequential actions without letting it *confirm* them.
- Keeping a medical-advice guardrail from blocking legitimate tracking talk.

## Accomplishments we're proud of

- The double-dose guard: small, concrete, and exactly the kind of mistake shared care produces.
- A full MCP Apps round trip (server view + our own host) with a working in-card action.
- Every claim in this description is covered by an automated test or visible in the demo's protocol trace.

## What we learned

MCP's output schemas and Bedrock's tool blocks fit together almost perfectly. The hard part of voice agents is the *host policy* around the model, not the model call.

## What's next

Proactive nudges when a dose is 90 minutes late (SNS/EventBridge), Alexa+ household voice identity instead of tokens, real pharmacy refill APIs, and deployment on Lambda + DynamoDB or Bedrock AgentCore.

## Built with

typescript · node.js · model-context-protocol · mcp-apps · streamable-http · amazon-bedrock · bedrock-guardrails · amazon-nova · aws-sdk · express · sqlite · web-speech-api
