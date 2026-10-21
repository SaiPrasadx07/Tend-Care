# Product feedback (for the Devpost "Product Feedback" field)

> **Before submitting:** the Bedrock and Guardrails statements below describe how the integration is built and tested with a mocked client. Re-check them against what you actually saw in the live run (`npm run smoke:bedrock`, demo recording) and edit anything that didn't hold.

## Which developer tools, APIs and SDKs did you use, and for what?

- **Model Context Protocol (spec 2025-11-25), TypeScript SDK `@modelcontextprotocol/sdk` 1.32:** Tend's self-hosted MCP server (`McpServer`, stateless `StreamableHTTPServerTransport`) and the simulator's MCP client (`Client`, `StreamableHTTPClientTransport`).
- **MCP Apps extension (`io.modelcontextprotocol/ui`, 2026-01-26):** the interactive care-board card (`ui://tend/care-board`) and our own host implementation with the sandbox proxy.
- **Amazon Bedrock Runtime (Converse API with tool use) via AWS SDK for JavaScript v3:** the assistant's reasoning. It maps speech to MCP tool calls and phrases replies for voice.
- **Amazon Bedrock Guardrails** (`@aws-sdk/client-bedrock` to create, `guardrailConfig` + `guardContent` at runtime): a denied topic for medical advice, plus a prompt-attack filter.
- Alexa+ (target platform): simulated in a web app per the official FAQ, because the add-on tooling is partner-only.

## What worked well?

- **MCP TypeScript SDK:** zod input *and* output schemas, with automatic `structuredContent` validation, made the tool contract trustworthy. Stateless Streamable HTTP is about 10 lines, and the SDK client let us write true end-to-end tests against the real HTTP server.
- **Bedrock Converse API:** one request shape across models, and native `toolUse`/`toolResult` blocks map almost 1:1 onto MCP `tools/call`. The `json` tool-result block lets us hand back MCP `structuredContent` unchanged.
- **Guardrails `guardContent`:** being able to guard *only the user's words* is what makes a "no medical advice" policy workable next to tool results full of medication names.
- **Documentation:** the MCP Streamable HTTP spec page linked from the Resources page is clear about Accept headers, 202 for notifications, and the DNS-rebinding warning.

## What needs work?

- **Alexa+ access:** there's no public way to point Alexa+ (or its Web Simulator) at a self-hosted MCP URL, so the core integration can't be validated by participants. See friction log #1.
- **Rendering guidance:** we couldn't find documentation on how Alexa+ presents MCP results (`content` vs `structuredContent` vs MCP Apps) or on device screen constraints. See friction log #2.
- **Version clarity:** state which MCP Apps revision Alexa+ targets, alongside core MCP 2025-11-25.
- **Credits:** they ran out on Oct 7, before the published request deadline.

## How was your onboarding experience (zero to hello world)?

MCP hello-world over Streamable HTTP took under an hour with the SDK. A Bedrock Converse call needs only credentials, model access and a model or inference-profile ID. The slow part was confirming *what counts as an Alexa+ submission*: the FAQ entry "a web page that acts as an actual MCP client … satisfies the requirement" was the key unblocker and deserves to be on the Alexa+ resources section itself.

## Would you build with these again?

**Yes.** MCP plus Bedrock tool use is a clean way to give an assistant real, stateful, safety-checked capabilities, and a household voice assistant is exactly where shared care coordination belongs. We'd want public Alexa+ add-on tooling to ship it for real.

## AWS services used (AWS Builder mini challenge)

Amazon Bedrock Runtime (Converse API, tool use) is the reasoning layer of the Alexa+ experience. Amazon Bedrock Guardrails enforces "no medical advice" (denied topics plus a prompt-attack filter), applied only to user input via `guardContent`. See [AWS_INTEGRATION.md](AWS_INTEGRATION.md).

## Feature requests (optional field)

| Request | Why it matters to Tend | Priority |
|---|---|---|
| Public Alexa+ Web Simulator that accepts a custom MCP URL + auth header | Validate real tool selection and phrasing before launch | Critical |
| Documented Alexa+ support for MCP Apps / `structuredContent` on Echo Show | Our care board is the main visual surface | Important |
| Alexa+ household identity → MCP auth (who in the home is speaking) | Per-caregiver attribution without separate tokens | Important |
| Proactive notifications from an MCP server (e.g. "Mom's 8 PM dose is 90 minutes late") | Missed-dose nudges are the next most valuable feature | Nice-to-have |
