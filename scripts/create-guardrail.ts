// Creates the Amazon Bedrock Guardrail Tend uses to refuse medical advice
// (dose changes, interactions, diagnosis) while still allowing care tracking.
// Usage: npm run guardrail:create   then put the printed values in .env
import { existsSync } from "node:fs";
import { BedrockClient, CreateGuardrailCommand, CreateGuardrailVersionCommand } from "@aws-sdk/client-bedrock";
import { loadConfig } from "../src/config.ts";

if (existsSync(".env")) process.loadEnvFile(".env");
const { awsRegion } = loadConfig();
const client = new BedrockClient({ region: awsRegion });

const blocked = "I can't give medical advice. Please check with the pharmacist or doctor. I can add a note so the care circle sees it.";

const created = await client.send(
  new CreateGuardrailCommand({
    name: `tend-no-medical-advice-${Date.now().toString(36)}`,
    description: "Tend care-circle add-on: block clinical advice, allow medication tracking and coordination.",
    topicPolicyConfig: {
      topicsConfig: [
        {
          name: "Medical dosing and treatment advice",
          type: "DENY",
          definition:
            "Requests for a recommendation to start, stop, double, skip, split or change the dose or timing of a medication, to combine medications, or whether a symptom means a medication should be changed.",
          examples: [
            "She missed her morning pill, should she take two tonight?",
            "Can Dad take ibuprofen with his amlodipine?",
            "Dad is dizzy, should he stop his blood pressure medicine?",
            "Is it okay to cut the metformin dose in half?",
          ],
        },
        {
          name: "Diagnosis",
          type: "DENY",
          definition: "Requests to diagnose a condition or interpret symptoms or test results.",
          examples: ["What is causing Mom's chest pain?", "Does this rash mean an allergic reaction?"],
        },
      ],
    },
    contentPolicyConfig: {
      filtersConfig: [
        { type: "HATE", inputStrength: "MEDIUM", outputStrength: "MEDIUM" },
        { type: "INSULTS", inputStrength: "MEDIUM", outputStrength: "MEDIUM" },
        { type: "MISCONDUCT", inputStrength: "MEDIUM", outputStrength: "MEDIUM" },
        { type: "PROMPT_ATTACK", inputStrength: "HIGH", outputStrength: "NONE" },
      ],
    },
    blockedInputMessaging: blocked,
    blockedOutputsMessaging: blocked,
  }),
);
const version = await client.send(new CreateGuardrailVersionCommand({ guardrailIdentifier: created.guardrailId!, description: "v1" }));
console.log("Guardrail created. Add to .env:");
console.log(`BEDROCK_GUARDRAIL_ID=${created.guardrailId}`);
console.log(`BEDROCK_GUARDRAIL_VERSION=${version.version}`);
