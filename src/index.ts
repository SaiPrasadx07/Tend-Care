import { existsSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { Store } from "./domain/store.ts";
import { CareService } from "./domain/care.ts";
import { Auth } from "./http/auth.ts";
import { createApp } from "./http/app.ts";
import { createAgent } from "./agent/agent.ts";
import { seedDemo } from "./seed.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

const config = loadConfig();
const store = new Store(config.dbPath);
const care = new CareService(store, { timezone: config.timezone });
if (store.listPeople().length === 0 && config.demoMode) {
  seedDemo(care);
  console.log("[tend] Seeded demo household (Lakshmi & Ravi, cared for by Priya & Arjun).");
}
const auth = new Auth(config.caregivers, config.sessionSecret);
const agent = createAgent(config);
const app = createApp({ config, care, auth, agent });

const server = app.listen(config.port, config.host, () => {
  console.log(`[tend] MCP endpoint (Streamable HTTP): http://${config.host}:${config.port}/mcp`);
  console.log(`[tend] Alexa+ simulator:               http://${config.host}:${config.port}/`);
  console.log(`[tend] Agent engine: ${agent.engineName}${agent.modelId ? ` (${agent.modelId}, ${config.awsRegion})` : ""} | timezone ${config.timezone} | demo mode ${config.demoMode ? "on" : "off"}`);
  if (config.caregiversGenerated) {
    console.log("[tend] TEND_CAREGIVERS not set: generated ephemeral caregiver tokens (not printed). Set it in .env to connect external MCP clients.");
  }
});

function shutdown() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
