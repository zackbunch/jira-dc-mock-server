import type { FastifyPluginAsync } from "fastify";
import {
  serializeNamedResource,
  serializeStatus,
} from "../shared/serialization.js";

const metadataRoutes: FastifyPluginAsync = async (app) => {
  app.get("/rest/api/2/field", async () => [
    {
      id: "summary",
      name: "Summary",
      custom: false,
      orderable: true,
      navigable: true,
      searchable: true,
      schema: { type: "string", system: "summary" },
    },
    {
      id: "description",
      name: "Description",
      custom: false,
      orderable: true,
      navigable: true,
      searchable: true,
      schema: { type: "string", system: "description" },
    },
    {
      id: "status",
      name: "Status",
      custom: false,
      orderable: true,
      navigable: true,
      searchable: true,
      schema: { type: "status", system: "status" },
    },
    {
      id: "assignee",
      name: "Assignee",
      custom: false,
      orderable: true,
      navigable: true,
      searchable: true,
      schema: { type: "user", system: "assignee" },
    },
    {
      id: "labels",
      name: "Labels",
      custom: false,
      orderable: true,
      navigable: true,
      searchable: true,
      schema: { type: "array", items: "string", system: "labels" },
    },
    {
      id: "customfield_10002",
      name: "Story Points",
      custom: true,
      orderable: true,
      navigable: true,
      searchable: true,
      schema: {
        type: "number",
        custom: "com.atlassian.jira.plugin.system.customfieldtypes:float",
        customId: 10002,
      },
    },
  ]);

  app.get("/rest/api/2/issuetype", async () =>
    app.jira.store.state.issueTypes.map((value) =>
      serializeNamedResource(value, app.jira.baseUrl, "issuetype"),
    ),
  );
  app.get("/rest/api/2/priority", async () =>
    app.jira.store.state.priorities.map((value) =>
      serializeNamedResource(value, app.jira.baseUrl, "priority"),
    ),
  );
  app.get("/rest/api/2/status", async () =>
    app.jira.store.state.statuses.map((value) => serializeStatus(value, app.jira.baseUrl)),
  );
};

export default metadataRoutes;
