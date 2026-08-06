import type { onRouteHookHandler } from "fastify";

export const enrichRouteSchema: onRouteHookHandler = (routeOptions) => {
  const url = routeOptions.url;
  if (!url.startsWith("/rest/") && !url.startsWith("/__admin/")) return;

  const method = String(
    Array.isArray(routeOptions.method) ? routeOptions.method[0] : routeOptions.method,
  ).toUpperCase();
  const schema = (routeOptions.schema ??= {}) as Record<string, unknown>;
  const pathParameters = [...url.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]);
  const tag = url.includes("/comment")
    ? "Comments"
    : url.includes("/transitions")
      ? "Transitions"
      : url.includes("/issue")
        ? "Issues"
        : url.includes("/search")
          ? "Search"
          : url.includes("/project")
            ? "Projects"
            : url.includes("/__admin/")
              ? "Administration"
              : url.match(/\/(field|issuetype|priority|status)$/)
                ? "Metadata"
                : "System";

  const summaries: Record<string, string> = {
    "GET /rest/api/2/serverInfo": "Get Jira server information",
    "GET /rest/api/2/myself": "Get the current user",
    "GET /rest/api/2/project": "List visible projects",
    "GET /rest/api/2/project/:projectIdOrKey": "Get a project",
    "GET /rest/api/2/field": "List Jira fields",
    "GET /rest/api/2/issuetype": "List issue types",
    "GET /rest/api/2/priority": "List priorities",
    "GET /rest/api/2/status": "List statuses",
    "GET /rest/api/2/search": "Search issues with JQL",
    "POST /rest/api/2/search": "Search issues with JQL",
    "POST /rest/api/2/issue": "Create an issue",
    "GET /rest/api/2/issue/:issueIdOrKey": "Get an issue",
    "PUT /rest/api/2/issue/:issueIdOrKey": "Edit an issue",
    "GET /rest/api/2/issue/:issueIdOrKey/comment": "List issue comments",
    "POST /rest/api/2/issue/:issueIdOrKey/comment": "Add an issue comment",
    "GET /rest/api/2/issue/:issueIdOrKey/transitions": "List available transitions",
    "POST /rest/api/2/issue/:issueIdOrKey/transitions": "Perform an issue transition",
    "POST /__admin/reset": "Reset all mock data",
  };

  schema.tags ??= [tag];
  schema.summary ??= summaries[`${method} ${url}`] ?? `${method} ${url}`;
  schema.security ??= [{ bearerAuth: [] }, { basicAuth: [] }];

  if (pathParameters.length > 0) {
    schema.params ??= {
      type: "object",
      properties: Object.fromEntries(
        pathParameters.map((parameter) => [parameter, { type: "string" }]),
      ),
      required: pathParameters,
    };
  }

  const searchProperties = {
    jql: {
      type: "string",
      description: "For example: project = T100ZB AND status = \"To Do\"",
    },
    startAt: { type: "integer", minimum: 0, default: 0 },
    maxResults: { type: "integer", minimum: 0, maximum: 100, default: 50 },
    validateQuery: { type: "boolean" },
  };

  if (url === "/rest/api/2/search") {
    if (method === "POST") {
      schema.body = {
        type: "object",
        properties: {
          ...searchProperties,
          fields: { type: "array", items: { type: "string" } },
          expand: { type: "array", items: { type: "string" } },
        },
      };
    } else {
      schema.querystring = {
        type: "object",
        properties: {
          ...searchProperties,
          fields: { type: "array", items: { type: "string" } },
          expand: { type: "string" },
        },
      };
    }
  } else if (url === "/rest/api/2/issue" && method === "POST") {
    schema.body = {
      type: "object",
      required: ["fields"],
      properties: {
        fields: {
          type: "object",
          additionalProperties: true,
          description:
            "Jira fields such as project, issuetype, summary, description, assignee, labels, and customfield_*.",
        },
      },
    };
  } else if (url === "/rest/api/2/issue/:issueIdOrKey" && method === "PUT") {
    schema.body = {
      type: "object",
      properties: {
        fields: { type: "object", additionalProperties: true },
        update: { type: "object", additionalProperties: true },
      },
    };
  } else if (url.endsWith("/comment") && method === "POST") {
    schema.body = {
      type: "object",
      required: ["body"],
      properties: {
        body: { type: "string", description: "Plain Jira Data Center comment text." },
      },
    };
  } else if (url.endsWith("/transitions") && method === "POST") {
    schema.body = {
      type: "object",
      required: ["transition"],
      properties: {
        transition: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", description: "ID returned by the transitions endpoint." },
          },
        },
      },
    };
  }
};
