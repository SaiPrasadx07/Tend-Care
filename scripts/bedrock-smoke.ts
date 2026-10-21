// Verifies Amazon Bedrock access for the configured model, including tool use.
// Usage: npm run smoke:bedrock   (reads AWS credentials from the standard AWS chain)
import { existsSync } from "node:fs";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { loadConfig } from "../src/config.ts";

if (existsSync(".env")) process.loadEnvFile(".env");
const config = loadConfig();
const client = new BedrockRuntimeClient({ region: config.awsRegion });
console.log(`Region: ${config.awsRegion}\nModel:  ${config.bedrockModelId}\nGuardrail: ${config.guardrail ? `${config.guardrail.id} v${config.guardrail.version}` : "none"}`);

const started = Date.now();
try {
  const res = await client.send(
    new ConverseCommand({
      modelId: config.bedrockModelId,
      system: [{ text: "You are a test harness. Always call the tool." }],
      messages: [{ role: "user", content: [{ text: "Check today's medication status for Mom." }] }],
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: "get_care_status",
              description: "Get today's care status for a person.",
              inputSchema: { json: { type: "object", properties: { person: { type: "string" } } } },
            },
          },
        ],
      },
      inferenceConfig: { maxTokens: 200, temperature: 0 },
      ...(config.guardrail ? { guardrailConfig: { guardrailIdentifier: config.guardrail.id, guardrailVersion: config.guardrail.version } } : {}),
    }),
  );
  const toolUse = res.output?.message?.content?.find((c) => "toolUse" in c && c.toolUse)?.toolUse;
  console.log(`OK in ${Date.now() - started} ms. stopReason=${res.stopReason} tokens=${res.usage?.totalTokens ?? "?"}`);
  console.log(toolUse ? `Tool use works: ${toolUse.name}(${JSON.stringify(toolUse.input)})` : "WARNING: the model answered without calling the tool.");
} catch (err) {
  const name = err instanceof Error ? err.name : "Error";
  const message = err instanceof Error ? err.message : String(err);
  console.error(`FAILED: ${name}: ${message}`);
  const hints: Record<string, string> = {
    CredentialsProviderError: "No AWS credentials found. Run `aws configure` (or set AWS_PROFILE / AWS_ACCESS_KEY_ID).",
    AccessDeniedException: "The IAM identity lacks bedrock:InvokeModel, or model access isn't enabled for this model in the Bedrock console.",
    ValidationException: "Check BEDROCK_MODEL_ID. Cross-region inference profiles look like us.amazon.nova-pro-v1:0 and must match your region's geography.",
    ResourceNotFoundException: "Model or guardrail not found in this region.",
    ThrottlingException: "Throttled. Wait a moment and retry.",
  };
  if (hints[name]) console.error(`Hint: ${hints[name]}`);
  process.exitCode = 1;
}
