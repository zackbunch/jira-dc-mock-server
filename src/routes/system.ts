import type { FastifyPluginAsync } from "fastify";
import { jiraDate, serializeUser } from "../shared/serialization.js";

const systemRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/health",
    {
      schema: {
        tags: ["System"],
        summary: "Check server health",
        security: [],
      },
    },
    async () => ({ status: "ok", product: "Jira Data Center mock", version: "10.3.5" }),
  );

  app.get("/rest/api/2/serverInfo", async () => ({
    baseUrl: app.jira.baseUrl,
    version: "10.3.5",
    versionNumbers: [10, 3, 5],
    deploymentType: "Data Center",
    buildNumber: 1003005,
    buildDate: "2025-02-20T00:00:00.000+0000",
    serverTime: jiraDate(),
    scmInfo: "mock",
    serverTitle: "Local Jira Data Center 10.3.5 Mock",
  }));

  app.get("/rest/api/2/myself", async () =>
    serializeUser(app.jira.currentUser(), app.jira.baseUrl),
  );
};

export default systemRoutes;
