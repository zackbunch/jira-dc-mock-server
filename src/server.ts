import { resolve } from "node:path";
import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";
const app = buildApp({
  dataFile: resolve(process.env.DATA_FILE ?? "./data/state.json"),
  baseUrl: process.env.JIRA_BASE_URL ?? `http://localhost:${port}`,
  requireAuth: process.env.JIRA_REQUIRE_AUTH !== "false",
  token: process.env.JIRA_MOCK_TOKEN ?? "local-test-token",
  username: process.env.JIRA_MOCK_USERNAME ?? "developer",
  password: process.env.JIRA_MOCK_PASSWORD ?? "developer",
  logger: true,
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down Jira mock server");
  await app.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
