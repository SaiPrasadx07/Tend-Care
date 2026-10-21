# AWS integration (AWS Builder mini challenge)

## Services used

| Service | Where | Role in the product |
|---|---|---|
| **Amazon Bedrock Runtime: Converse API with tool use** | `src/agent/bedrock.ts` | The reasoning layer of the Alexa+ simulator. It turns natural speech into Tend MCP tool calls, chains them (e.g. resolve the person, then check status), and phrases the answer for voice. |
| **Amazon Bedrock Guardrails** (optional) | `scripts/create-guardrail.ts`, `guardrailConfig` + `guardContent` in `bedrock.ts` | Enforces "no medical advice" at the platform level: dose changes, interactions and diagnosis are denied topics, and the prompt-attack filter is on. |
| AWS SDK for JavaScript v3 | `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-bedrock` | Clients with standard credential-chain resolution, retries and SigV4 |

## How MCP and Bedrock connect

```
user text ──► Converse(system, messages, toolConfig = MCP tools/list → toolSpec[])
                 │ stopReason = tool_use
                 ▼
            toolUse{name,input} ──► MCP tools/call (Streamable HTTP, caregiver's bearer)
                 ▲                       │
                 │   toolResult{text: speech, json: structuredContent, status}
                 └───────────────────────┘
            … until stopReason = end_turn → spoken reply
```

Implementation details worth knowing:

- **Schema bridging:** MCP `inputSchema` (JSON Schema) is passed through as `toolSpec.inputSchema.json`. The `$schema` keyword is stripped because Bedrock tool schemas don't need it (`toBedrockTool`).
- **Result bridging:** the voice sentence goes back as a `text` block and the validated `structuredContent` as a `json` block, so the model has both the phrasing and the exact data. Tool errors use `status: "error"`.
- **Host policy outside the model:** the model can *propose* `confirm_action`, but the host only forwards it after an explicit yes in a later turn. This is tested with a scripted Bedrock client that tries to self-confirm.
- **Guardrail scoping:** with a guardrail, the user turn is sent as `guardContent`, so only the user's words are evaluated. Tool results such as "Metformin 500 mg, 2 refills left" are legitimate and must not trip the medical-advice topic. A blocked turn returns the guardrail's message and is *not* added to history, so later turns aren't re-blocked.
- **History:** kept per session and caregiver, bounded to 24 messages, always trimmed to start on a real user utterance (never an orphaned `toolResult`).
- **Model choice:** `BEDROCK_MODEL_ID` (default `us.amazon.nova-pro-v1:0`, a cross-region inference profile). Any Converse model that supports tool use works.

## IAM (least privilege)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["bedrock:InvokeModel"], "Resource": [
        "arn:aws:bedrock:*::foundation-model/amazon.nova-pro-v1:0",
        "arn:aws:bedrock:*:<ACCOUNT_ID>:inference-profile/us.amazon.nova-pro-v1:0" ] },
    { "Effect": "Allow", "Action": ["bedrock:ApplyGuardrail"], "Resource": "arn:aws:bedrock:*:<ACCOUNT_ID>:guardrail/*" }
  ]
}
```

`scripts/create-guardrail.ts` additionally needs `bedrock:CreateGuardrail` and `bedrock:CreateGuardrailVersion`, run once by an admin.

## Verifying it live

```bash
npm run smoke:bedrock   # one Converse call with a tool: prints stopReason, tool use, tokens
npm start               # badge shows "Amazon Bedrock · <model>"; the MCP traffic panel shows model calls and tokens per turn
```

## Cost control

- No always-on AWS resources. Bedrock is billed per token, only when someone speaks.
- About 2–3 Converse calls per turn. Tool definitions dominate input tokens (13 tools).
- `TEND_AGENT_ENGINE=offline` turns off model calls entirely.

## Possible next steps

- **Amazon Bedrock AgentCore Runtime** to host the agent loop, and AgentCore Gateway to front the MCP server.
- **AWS Lambda + DynamoDB:** the `Store` class is the single persistence seam; the stateless `/mcp` design already fits Lambda.
- **Amazon SNS / EventBridge** to notify the care circle when a dose is missed past grace or a refill is requested.
