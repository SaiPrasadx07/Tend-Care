// Reset the local database and load the demo household.
// Usage: npm run seed
import { existsSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/domain/store.ts";
import { CareService } from "../src/domain/care.ts";
import { seedDemo } from "../src/seed.ts";

if (existsSync(".env")) process.loadEnvFile(".env");
const config = loadConfig();
const store = new Store(config.dbPath);
seedDemo(new CareService(store, { timezone: config.timezone }), { reset: true });
console.log(`Seeded demo data into ${config.dbPath} (timezone ${config.timezone}).`);
store.close();
