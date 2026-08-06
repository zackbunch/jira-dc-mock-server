import type { FastifyPluginAsync } from "fastify";
import { jiraError } from "../shared/errors.js";
import { getResourceState } from "../store.js";

interface ApplicationProperty {
  key: string;
  value: string;
  example?: string;
}

interface ReadOnlyModeStatus {
  enabled: boolean;
  endTime: string;
  message: string;
  timeZone: string;
}

interface SystemSettingsState {
  properties: Record<string, ApplicationProperty>;
  issueNavigatorColumns: string[];
  configuredBaseUrl: string;
  readOnlyMode: ReadOnlyModeStatus;
  monitoring: {
    appEnabled: boolean;
    ipdEnabled: boolean;
    jmxExposed: boolean;
  };
}

function defaultSystemSettings(baseUrl: string): SystemSettingsState {
  return {
    properties: {
      "jira.clone.prefix": {
        key: "jira.clone.prefix",
        value: "CLONE - ",
        example: "Prefix added to cloned issue summaries",
      },
      "jira.issue.actions.order": {
        key: "jira.issue.actions.order",
        value: "desc",
        example: "Newest issue activity first",
      },
      "jira.title": {
        key: "jira.title",
        value: "Local Jira Data Center 10.3.5 Mock",
        example: "Synthetic Jira instance title",
      },
    },
    issueNavigatorColumns: ["key", "summary", "status", "assignee", "updated"],
    configuredBaseUrl: baseUrl,
    readOnlyMode: {
      enabled: false,
      endTime: "",
      message: "Jira is currently in read-only mode for maintenance.",
      timeZone: "UTC",
    },
    monitoring: {
      appEnabled: true,
      ipdEnabled: true,
      jmxExposed: false,
    },
  };
}

function parseFormBody(value: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  const parameters = new URLSearchParams(value);
  for (const key of new Set(parameters.keys())) {
    const values = parameters.getAll(key);
    result[key] = values.length === 1 ? values[0] : values;
  }
  return result;
}

const systemSettingsRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => done(null, parseFormBody(String(body))),
  );

  const state = () =>
    getResourceState(app.jira.store, "system-settings", () =>
      defaultSystemSettings(app.jira.baseUrl),
    );

  app.get("/rest/api/2/configuration", async () => ({
    attachmentsEnabled: true,
    issueLinkingEnabled: true,
    subTasksEnabled: true,
    timeTrackingEnabled: true,
    unassignedIssuesAllowed: true,
    votingEnabled: true,
    watchingEnabled: true,
    timeTrackingConfiguration: {
      defaultUnit: "hour",
      timeFormat: "pretty",
      workingDaysPerWeek: 5,
      workingHoursPerDay: 8,
    },
  }));

  app.get(
    "/rest/api/2/application-properties",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["permissionLevel", "key"],
          properties: {
            permissionLevel: { type: "string", minLength: 1 },
            keyFilter: { type: "string" },
            key: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const query = request.query as { key: string; keyFilter?: string };
      const property = state().properties[query.key];
      if (!property || (query.keyFilter && !property.key.startsWith(query.keyFilter))) {
        return reply.code(404).send(jiraError(["Application property was not found."]));
      }
      return structuredClone(property);
    },
  );

  app.get("/rest/api/2/application-properties/advanced-settings", async () => {
    const properties = Object.values(state().properties).sort((left, right) =>
      left.key.localeCompare(right.key),
    );
    return structuredClone(properties[0]);
  });

  app.put(
    "/rest/api/2/application-properties/:id",
    {
      schema: {
        body: {
          type: "object",
          required: ["value"],
          properties: { value: { type: "string" } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { value: string };
      const property = state().properties[id];
      if (!property) {
        return reply.code(404).send(jiraError(["Application property was not found."]));
      }
      property.value = body.value;
      app.jira.store.save();
      return structuredClone(property);
    },
  );

  app.put(
    "/rest/api/2/settings/baseUrl",
    {
      schema: { body: { type: "string", minLength: 1 } },
    },
    async (request, reply) => {
      const candidate = request.body as string;
      let parsed: URL;
      try {
        parsed = new URL(candidate);
      } catch {
        return reply.code(400).send(jiraError(["The specified base URL is not valid."]));
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return reply.code(400).send(jiraError(["The specified base URL is not valid."]));
      }
      state().configuredBaseUrl = parsed.href.replace(/\/$/, "");
      app.jira.store.save();
      return reply.code(200).send();
    },
  );

  app.get("/rest/api/2/settings/columns", async () => ({
    columns: [...state().issueNavigatorColumns],
  }));

  app.put(
    "/rest/api/2/settings/columns",
    {
      schema: {
        body: {
          type: "object",
          required: ["columns"],
          properties: {
            columns: {
              oneOf: [
                { type: "string", minLength: 1 },
                { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
              ],
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { columns: string | string[] };
      const columns = Array.isArray(body.columns) ? body.columns : [body.columns];
      state().issueNavigatorColumns = [...new Set(columns)];
      app.jira.store.save();
      return reply.code(200).send();
    },
  );

  app.get("/rest/api/2/readonly-mode", async () => structuredClone(state().readOnlyMode));

  app.put(
    "/rest/api/2/readonly-mode",
    {
      schema: {
        body: {
          type: "object",
          required: ["enabled"],
          properties: {
            enabled: { type: "boolean" },
            endTime: { type: "string" },
            message: { type: "string" },
            timeZone: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as Partial<ReadOnlyModeStatus> & { enabled: boolean };
      const current = state().readOnlyMode;
      current.enabled = body.enabled;
      for (const field of ["endTime", "message", "timeZone"] as const) {
        if (body[field] !== undefined) current[field] = body[field] ?? "";
      }
      app.jira.store.save();
      return reply.code(200).send();
    },
  );

  app.get("/rest/api/2/monitoring/app", async () => ({
    enabled: state().monitoring.appEnabled,
  }));
  app.post(
    "/rest/api/2/monitoring/app",
    {
      schema: {
        body: {
          type: "object",
          required: ["enabled"],
          properties: { enabled: { type: "boolean" } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      state().monitoring.appEnabled = (request.body as { enabled: boolean }).enabled;
      app.jira.store.save();
      return reply.code(204).send();
    },
  );

  app.get("/rest/api/2/monitoring/ipd", async () => ({
    enabled: state().monitoring.ipdEnabled,
  }));
  app.post(
    "/rest/api/2/monitoring/ipd",
    {
      schema: {
        body: {
          type: "object",
          required: ["enabled"],
          properties: { enabled: { type: "boolean" } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      state().monitoring.ipdEnabled = (request.body as { enabled: boolean }).enabled;
      app.jira.store.save();
      return reply.code(204).send();
    },
  );

  app.get("/rest/api/2/monitoring/jmx/areMetricsExposed", async () =>
    state().monitoring.jmxExposed,
  );
  app.get(
    "/rest/api/2/monitoring/jmx/getAvailableMetrics",
    async (_request, reply) =>
      reply
        .type("application/json")
        .send(JSON.stringify("issues.total,projects.total,requests.active,index.queue.size")),
  );
  app.post("/rest/api/2/monitoring/jmx/startExposing", async (_request, reply) => {
    state().monitoring.jmxExposed = true;
    app.jira.store.save();
    return reply.code(200).send();
  });
  app.post("/rest/api/2/monitoring/jmx/stopExposing", async (_request, reply) => {
    state().monitoring.jmxExposed = false;
    app.jira.store.save();
    return reply.code(200).send();
  });
};

export default systemSettingsRoutes;
