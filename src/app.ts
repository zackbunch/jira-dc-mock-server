import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { JqlError, searchWithJql } from "./jql.js";
import { JiraStore } from "./store.js";
import type {
  JiraComment,
  JiraError,
  JiraIssue,
  JiraNamedResource,
  JiraProject,
  JiraStatus,
  JiraUser,
} from "./types.js";

export interface AppOptions {
  dataFile: string;
  baseUrl?: string;
  requireAuth?: boolean;
  token?: string;
  username?: string;
  password?: string;
  logger?: boolean;
}

interface SearchInput {
  jql?: string;
  startAt?: number | string;
  maxResults?: number | string;
  fields?: string | string[];
  expand?: string;
}

interface IssueWriteBody {
  fields?: Record<string, unknown>;
  update?: Record<string, Array<Record<string, unknown>>>;
}

function jiraError(errorMessages: string[] = [], errors: Record<string, string> = {}): JiraError {
  return { errorMessages, errors };
}

function jiraDate(date = new Date()): string {
  return date.toISOString().replace("Z", "+0000");
}

function absoluteUrl(baseUrl: string, value: string): string {
  return value.startsWith("http") ? value : `${baseUrl}${value}`;
}

function serializeUser(user: JiraUser, baseUrl: string): JiraUser {
  return {
    ...structuredClone(user),
    self: `${baseUrl}/rest/api/2/user?username=${encodeURIComponent(user.name)}`,
    avatarUrls: Object.fromEntries(
      Object.entries(user.avatarUrls).map(([size, url]) => [size, absoluteUrl(baseUrl, url)]),
    ),
  };
}

function serializeNamedResource(
  resource: JiraNamedResource,
  baseUrl: string,
  group: "issuetype" | "priority",
): JiraNamedResource {
  return {
    ...structuredClone(resource),
    self: `${baseUrl}/rest/api/2/${group}/${resource.id}`,
  };
}

function serializeStatus(status: JiraStatus, baseUrl: string): JiraStatus {
  return {
    ...structuredClone(status),
    self: `${baseUrl}/rest/api/2/status/${status.id}`,
    statusCategory: {
      ...structuredClone(status.statusCategory),
      self: `${baseUrl}/rest/api/2/statuscategory/${status.statusCategory.id}`,
    },
  };
}

function serializeProject(project: JiraProject, baseUrl: string): JiraProject {
  return {
    ...structuredClone(project),
    self: `${baseUrl}/rest/api/2/project/${project.id}`,
    lead: serializeUser(project.lead, baseUrl),
    avatarUrls: Object.fromEntries(
      Object.entries(project.avatarUrls).map(([size, url]) => [size, absoluteUrl(baseUrl, url)]),
    ),
  };
}

function requestedFields(input: string | string[] | undefined): Set<string> | undefined {
  if (input === undefined) return undefined;
  const values = (Array.isArray(input) ? input : [input])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.includes("*all") || values.includes("*navigable")) return undefined;
  return new Set(values.filter((value) => !value.startsWith("-")));
}

function serializeIssue(
  issue: JiraIssue,
  baseUrl: string,
  fieldsSelection?: string | string[],
): JiraIssue {
  const result = structuredClone(issue);
  result.self = `${baseUrl}/rest/api/2/issue/${issue.id}`;
  result.fields.project = serializeProject(issue.fields.project, baseUrl);
  result.fields.issuetype = serializeNamedResource(issue.fields.issuetype, baseUrl, "issuetype");
  result.fields.priority = serializeNamedResource(issue.fields.priority, baseUrl, "priority");
  result.fields.status = serializeStatus(issue.fields.status, baseUrl);
  result.fields.reporter = serializeUser(issue.fields.reporter, baseUrl);
  result.fields.assignee = issue.fields.assignee
    ? serializeUser(issue.fields.assignee, baseUrl)
    : null;
  result.fields.comment.comments = issue.fields.comment.comments.map((comment) =>
    serializeComment(comment, issue, baseUrl),
  );

  const selected = requestedFields(fieldsSelection);
  if (selected) {
    result.fields = Object.fromEntries(
      Object.entries(result.fields).filter(([field]) => selected.has(field)),
    ) as typeof result.fields;
  }
  return result;
}

function serializeComment(comment: JiraComment, issue: JiraIssue, baseUrl: string): JiraComment {
  return {
    ...structuredClone(comment),
    self: `${baseUrl}/rest/api/2/issue/${issue.id}/comment/${comment.id}`,
    author: serializeUser(comment.author, baseUrl),
    updateAuthor: serializeUser(comment.updateAuthor, baseUrl),
  };
}

function parseInteger(value: number | string | undefined, fallback: number, maximum?: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return maximum === undefined ? parsed : Math.min(parsed, maximum);
}

function findByIdOrName<T extends { id: string; name: string }>(
  source: T[],
  input: unknown,
): T | undefined {
  if (typeof input === "string") {
    return source.find(
      (entry) => entry.id === input || entry.name.toLowerCase() === input.toLowerCase(),
    );
  }
  if (input && typeof input === "object") {
    const candidate = input as { id?: unknown; name?: unknown };
    return source.find(
      (entry) =>
        (typeof candidate.id === "string" && entry.id === candidate.id) ||
        (typeof candidate.name === "string" &&
          entry.name.toLowerCase() === candidate.name.toLowerCase()),
    );
  }
  return undefined;
}

function findUser(users: JiraUser[], input: unknown): JiraUser | null | undefined {
  if (input === null) return null;
  if (typeof input === "string") {
    return users.find(
      (user) => user.name.toLowerCase() === input.toLowerCase() || user.key === input,
    );
  }
  if (input && typeof input === "object") {
    const candidate = input as { name?: unknown; key?: unknown };
    const identity = typeof candidate.name === "string" ? candidate.name : candidate.key;
    if (typeof identity === "string") return findUser(users, identity);
  }
  return undefined;
}

function availableTransitions(status: JiraStatus, statuses: JiraStatus[]) {
  const byName = (name: string) => statuses.find((candidate) => candidate.name === name)!;
  if (status.name === "To Do") {
    return [{ id: "21", name: "Start Progress", to: byName("In Progress"), hasScreen: false }];
  }
  if (status.name === "In Progress") {
    return [
      { id: "31", name: "Resolve Issue", to: byName("Done"), hasScreen: false },
      { id: "41", name: "Stop Progress", to: byName("To Do"), hasScreen: false },
    ];
  }
  return [{ id: "51", name: "Reopen Issue", to: byName("To Do"), hasScreen: false }];
}

function isAuthenticated(request: FastifyRequest, options: Required<Pick<AppOptions, "token" | "username" | "password">>): boolean {
  const authorization = request.headers.authorization;
  if (!authorization) return false;
  if (authorization === `Bearer ${options.token}`) return true;
  if (!authorization.startsWith("Basic ")) return false;

  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    return decoded === `${options.username}:${options.password}`;
  } catch {
    return false;
  }
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const store = new JiraStore(options.dataFile);
  const baseUrl = (options.baseUrl ?? "http://localhost:8080").replace(/\/$/, "");

  app.addHook("onRoute", (routeOptions) => {
    const url = routeOptions.url;
    if (!url.startsWith("/rest/") && !url.startsWith("/__admin/")) return;

    const method = String(Array.isArray(routeOptions.method) ? routeOptions.method[0] : routeOptions.method).toUpperCase();
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

    schema.tags = [tag];
    schema.summary = summaries[`${method} ${url}`] ?? `${method} ${url}`;
    schema.security = [{ bearerAuth: [] }, { basicAuth: [] }];

    if (pathParameters.length > 0) {
      schema.params = {
        type: "object",
        properties: Object.fromEntries(
          pathParameters.map((parameter) => [parameter, { type: "string" }]),
        ),
        required: pathParameters,
      };
    }

    const searchProperties = {
      jql: { type: "string", description: "For example: project = ENG AND status = \"To Do\"" },
      startAt: { type: "integer", minimum: 0, default: 0 },
      maxResults: { type: "integer", minimum: 0, maximum: 100, default: 50 },
      fields: {
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
      },
      expand: { type: "string" },
    };

    if (url === "/rest/api/2/search") {
      if (method === "POST") {
        schema.body = { type: "object", properties: searchProperties, additionalProperties: false };
      } else {
        schema.querystring = { type: "object", properties: searchProperties };
      }
    } else if (url === "/rest/api/2/issue" && method === "POST") {
      schema.body = {
        type: "object",
        required: ["fields"],
        properties: {
          fields: {
            type: "object",
            additionalProperties: true,
            description: "Jira fields such as project, issuetype, summary, description, assignee, labels, and customfield_*.",
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
        properties: { body: { type: "string", description: "Plain Jira Data Center comment text." } },
      };
    } else if (url.endsWith("/transitions") && method === "POST") {
      schema.body = {
        type: "object",
        required: ["transition"],
        properties: {
          transition: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string", description: "ID returned by the transitions endpoint." } },
          },
        },
      };
    }
  });

  app.register(swagger, {
    openapi: {
      info: {
        title: "Jira Data Center 10.3.5 Mock API",
        description: "Stateful local REST API mock for Jira-agent development. This implements a curated subset of Jira Data Center, not the full product.",
        version: "0.1.0",
      },
      servers: [{ url: baseUrl, description: "Local mock server" }],
      tags: [
        { name: "System" },
        { name: "Metadata" },
        { name: "Projects" },
        { name: "Search" },
        { name: "Issues" },
        { name: "Comments" },
        { name: "Transitions" },
        { name: "Administration" },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "PAT" },
          basicAuth: { type: "http", scheme: "basic" },
        },
      },
    },
  });
  app.register(swaggerUi, {
    routePrefix: "/documentation",
    staticCSP: true,
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
      persistAuthorization: true,
    },
  });

  const auth = {
    token: options.token ?? "local-test-token",
    username: options.username ?? "developer",
    password: options.password ?? "developer",
  };
  const requireAuth = options.requireAuth ?? true;

  const currentUser = () =>
    store.state.users.find((user) => user.name === auth.username) ?? store.state.users[0];
  const findIssue = (identity: string) =>
    store.state.issues.find(
      (issue) =>
        issue.id === identity || issue.key.toLowerCase() === identity.toLowerCase(),
    );

  app.addHook("onRequest", async (request, reply) => {
    const protectedPath = request.url.startsWith("/rest/") || request.url.startsWith("/__admin/");
    if (requireAuth && protectedPath && !isAuthenticated(request, auth)) {
      reply.header("WWW-Authenticate", 'Basic realm="Jira"');
      return reply.code(401).send(jiraError(["Client must be authenticated to access this resource."]));
    }
  });

  app.register(async (app) => {
    app.get("/health", {
    schema: {
      tags: ["System"],
      summary: "Check server health",
      security: [],
    },
  }, async () => ({ status: "ok", product: "Jira Data Center mock", version: "10.3.5" }));

  app.get("/rest/api/2/serverInfo", async () => ({
    baseUrl,
    version: "10.3.5",
    versionNumbers: [10, 3, 5],
    deploymentType: "Data Center",
    buildNumber: 1003005,
    buildDate: "2025-02-20T00:00:00.000+0000",
    serverTime: jiraDate(),
    scmInfo: "mock",
    serverTitle: "Local Jira Data Center 10.3.5 Mock",
    healthChecks: [],
  }));

  app.get("/rest/api/2/myself", async () => serializeUser(currentUser(), baseUrl));

  app.get("/rest/api/2/project", async (request) => {
    const query = request.query as { includeArchived?: string | boolean };
    const includeArchived = String(query.includeArchived ?? "false") === "true";
    return store.state.projects
      .filter((project) => includeArchived || !project.archived)
      .map((project) => serializeProject(project, baseUrl));
  });

  app.get("/rest/api/2/project/:projectIdOrKey", async (request, reply) => {
    const { projectIdOrKey } = request.params as { projectIdOrKey: string };
    const project = store.state.projects.find(
      (candidate) =>
        candidate.id === projectIdOrKey ||
        candidate.key.toLowerCase() === projectIdOrKey.toLowerCase(),
    );
    if (!project) return reply.code(404).send(jiraError(["No project could be found with key or id."]));
    return serializeProject(project, baseUrl);
  });

  app.get("/rest/api/2/field", async () => [
    { id: "summary", name: "Summary", custom: false, orderable: true, navigable: true, searchable: true, schema: { type: "string", system: "summary" } },
    { id: "description", name: "Description", custom: false, orderable: true, navigable: true, searchable: true, schema: { type: "string", system: "description" } },
    { id: "status", name: "Status", custom: false, orderable: true, navigable: true, searchable: true, schema: { type: "status", system: "status" } },
    { id: "assignee", name: "Assignee", custom: false, orderable: true, navigable: true, searchable: true, schema: { type: "user", system: "assignee" } },
    { id: "labels", name: "Labels", custom: false, orderable: true, navigable: true, searchable: true, schema: { type: "array", items: "string", system: "labels" } },
    { id: "customfield_10002", name: "Story Points", custom: true, orderable: true, navigable: true, searchable: true, schema: { type: "number", custom: "com.atlassian.jira.plugin.system.customfieldtypes:float", customId: 10002 } },
  ]);

  app.get("/rest/api/2/issuetype", async () =>
    store.state.issueTypes.map((value) => serializeNamedResource(value, baseUrl, "issuetype")),
  );
  app.get("/rest/api/2/priority", async () =>
    store.state.priorities.map((value) => serializeNamedResource(value, baseUrl, "priority")),
  );
  app.get("/rest/api/2/status", async () =>
    store.state.statuses.map((value) => serializeStatus(value, baseUrl)),
  );

  const runSearch = async (input: SearchInput, reply: FastifyReply) => {
    try {
      const matches = searchWithJql(store.state.issues, input.jql, {
        currentUsername: currentUser().name,
      });
      const startAt = parseInteger(input.startAt, 0);
      const maxResults = parseInteger(input.maxResults, 50, 100);
      const page = matches.slice(startAt, startAt + maxResults);
      return {
        expand: "schema,names",
        startAt,
        maxResults,
        total: matches.length,
        issues: page.map((issue) => serializeIssue(issue, baseUrl, input.fields)),
      };
    } catch (error) {
      if (error instanceof JqlError) {
        return reply.code(400).send(jiraError([error.message]));
      }
      throw error;
    }
  };

  app.get("/rest/api/2/search", async (request, reply) =>
    runSearch(request.query as SearchInput, reply),
  );
  app.post("/rest/api/2/search", async (request, reply) =>
    runSearch((request.body ?? {}) as SearchInput, reply),
  );

  app.post("/rest/api/2/issue", async (request, reply) => {
    const body = (request.body ?? {}) as IssueWriteBody;
    const fields = body.fields ?? {};
    const errors: Record<string, string> = {};

    const projectInput = fields.project;
    const project = store.state.projects.find((candidate) => {
      if (typeof projectInput === "string") return candidate.key === projectInput || candidate.id === projectInput;
      if (!projectInput || typeof projectInput !== "object") return false;
      const value = projectInput as { key?: unknown; id?: unknown };
      return candidate.key === value.key || candidate.id === value.id;
    });
    const issueType = findByIdOrName(store.state.issueTypes, fields.issuetype);
    const priority = fields.priority
      ? findByIdOrName(store.state.priorities, fields.priority)
      : store.state.priorities.find((candidate) => candidate.name === "Medium")!;
    const assignee = fields.assignee === undefined ? null : findUser(store.state.users, fields.assignee);

    if (!project) errors.project = "project is required and must identify a visible project";
    if (!issueType) errors.issuetype = "issue type is required and must be valid";
    if (typeof fields.summary !== "string" || !fields.summary.trim()) errors.summary = "You must specify a summary of the issue.";
    if (!priority) errors.priority = "Priority is invalid.";
    if (fields.assignee !== undefined && assignee === undefined) errors.assignee = "User does not exist.";
    if (Object.keys(errors).length > 0 || !project || !issueType || !priority) {
      return reply.code(400).send(jiraError([], errors));
    }

    const nextNumber =
      Math.max(
        0,
        ...store.state.issues
          .filter((issue) => issue.fields.project.key === project.key)
          .map((issue) => Number(issue.key.split("-").at(-1)) || 0),
      ) + 1;
    const timestamp = jiraDate();
    const knownFields = new Set(["project", "issuetype", "summary", "description", "priority", "assignee", "reporter", "labels"]);
    const customFields = Object.fromEntries(
      Object.entries(fields).filter(([name]) => !knownFields.has(name)),
    );
    const created: JiraIssue = {
      expand: "renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations",
      id: String(store.state.issueCounter++),
      key: `${project.key}-${nextNumber}`,
      fields: {
        project,
        issuetype: issueType,
        summary: String(fields.summary).trim(),
        description: typeof fields.description === "string" ? fields.description : null,
        status: store.state.statuses.find((status) => status.name === "To Do")!,
        priority,
        assignee: assignee ?? null,
        reporter: currentUser(),
        labels: Array.isArray(fields.labels) ? fields.labels.map(String) : [],
        created: timestamp,
        updated: timestamp,
        comment: { comments: [], maxResults: 0, total: 0, startAt: 0 },
        ...customFields,
      },
    };
    store.state.issues.push(created);
    store.save();
    return reply.code(201).send({
      id: created.id,
      key: created.key,
      self: `${baseUrl}/rest/api/2/issue/${created.id}`,
    });
  });

  app.get("/rest/api/2/issue/:issueIdOrKey", async (request, reply) => {
    const { issueIdOrKey } = request.params as { issueIdOrKey: string };
    const query = request.query as { fields?: string | string[] };
    const issue = findIssue(issueIdOrKey);
    if (!issue) return reply.code(404).send(jiraError(["Issue does not exist or you do not have permission to see it."]));
    return serializeIssue(issue, baseUrl, query.fields);
  });

  app.put("/rest/api/2/issue/:issueIdOrKey", async (request, reply) => {
    const { issueIdOrKey } = request.params as { issueIdOrKey: string };
    const issue = findIssue(issueIdOrKey);
    if (!issue) return reply.code(404).send(jiraError(["Issue does not exist or you do not have permission to see it."]));

    const body = (request.body ?? {}) as IssueWriteBody;
    const fields = body.fields ?? {};
    const errors: Record<string, string> = {};
    if ("status" in fields) errors.status = "Status must be changed with a workflow transition.";
    if ("summary" in fields && (typeof fields.summary !== "string" || !fields.summary.trim())) {
      errors.summary = "You must specify a summary of the issue.";
    }
    const assignee = "assignee" in fields ? findUser(store.state.users, fields.assignee) : undefined;
    if ("assignee" in fields && assignee === undefined) errors.assignee = "User does not exist.";
    const priority = "priority" in fields
      ? findByIdOrName(store.state.priorities, fields.priority)
      : undefined;
    if ("priority" in fields && !priority) errors.priority = "Priority is invalid.";
    if (Object.keys(errors).length > 0) return reply.code(400).send(jiraError([], errors));

    if (typeof fields.summary === "string") issue.fields.summary = fields.summary.trim();
    if (fields.description === null || typeof fields.description === "string") issue.fields.description = fields.description;
    if (assignee !== undefined) issue.fields.assignee = assignee;
    if (priority) issue.fields.priority = priority;
    if (Array.isArray(fields.labels)) issue.fields.labels = fields.labels.map(String);
    for (const [field, value] of Object.entries(fields)) {
      if (field.startsWith("customfield_")) issue.fields[field] = value;
    }

    for (const [field, operations] of Object.entries(body.update ?? {})) {
      if (field !== "labels") continue;
      for (const operation of operations) {
        if ("set" in operation && Array.isArray(operation.set)) issue.fields.labels = operation.set.map(String);
        if ("add" in operation) issue.fields.labels.push(String(operation.add));
        if ("remove" in operation) issue.fields.labels = issue.fields.labels.filter((label) => label !== String(operation.remove));
      }
    }

    issue.fields.updated = jiraDate();
    store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/issue/:issueIdOrKey/comment", async (request, reply) => {
    const { issueIdOrKey } = request.params as { issueIdOrKey: string };
    const query = request.query as { startAt?: string; maxResults?: string };
    const issue = findIssue(issueIdOrKey);
    if (!issue) return reply.code(404).send(jiraError(["Issue does not exist or you do not have permission to see it."]));
    const startAt = parseInteger(query.startAt, 0);
    const maxResults = parseInteger(query.maxResults, 50, 100);
    const comments = issue.fields.comment.comments.slice(startAt, startAt + maxResults);
    return {
      startAt,
      maxResults,
      total: issue.fields.comment.comments.length,
      comments: comments.map((comment) => serializeComment(comment, issue, baseUrl)),
    };
  });

  app.post("/rest/api/2/issue/:issueIdOrKey/comment", async (request, reply) => {
    const { issueIdOrKey } = request.params as { issueIdOrKey: string };
    const issue = findIssue(issueIdOrKey);
    if (!issue) return reply.code(404).send(jiraError(["Issue does not exist or you do not have permission to see it."]));
    const body = (request.body ?? {}) as { body?: unknown };
    if (typeof body.body !== "string" || !body.body.trim()) {
      return reply.code(400).send(jiraError([], { comment: "Comment body must not be empty." }));
    }
    const timestamp = jiraDate();
    const comment: JiraComment = {
      id: String(store.state.commentCounter++),
      author: currentUser(),
      body: body.body,
      updateAuthor: currentUser(),
      created: timestamp,
      updated: timestamp,
    };
    issue.fields.comment.comments.push(comment);
    issue.fields.comment.total = issue.fields.comment.comments.length;
    issue.fields.comment.maxResults = issue.fields.comment.comments.length;
    issue.fields.updated = timestamp;
    store.save();
    return reply.code(201).send(serializeComment(comment, issue, baseUrl));
  });

  app.get("/rest/api/2/issue/:issueIdOrKey/transitions", async (request, reply) => {
    const { issueIdOrKey } = request.params as { issueIdOrKey: string };
    const issue = findIssue(issueIdOrKey);
    if (!issue) return reply.code(404).send(jiraError(["Issue does not exist or you do not have permission to see it."]));
    return {
      expand: "transitions",
      transitions: availableTransitions(issue.fields.status, store.state.statuses).map((transition) => ({
        ...transition,
        to: serializeStatus(transition.to, baseUrl),
      })),
    };
  });

  app.post("/rest/api/2/issue/:issueIdOrKey/transitions", async (request, reply) => {
    const { issueIdOrKey } = request.params as { issueIdOrKey: string };
    const issue = findIssue(issueIdOrKey);
    if (!issue) return reply.code(404).send(jiraError(["Issue does not exist or you do not have permission to see it."]));
    const body = (request.body ?? {}) as { transition?: { id?: unknown } };
    const transitionId = body.transition?.id;
    const transition = availableTransitions(issue.fields.status, store.state.statuses).find(
      (candidate) => candidate.id === String(transitionId),
    );
    if (!transition) {
      return reply.code(400).send(jiraError(["Transition id is not valid for this issue."]));
    }
    issue.fields.status = transition.to;
    issue.fields.updated = jiraDate();
    store.save();
    return reply.code(204).send();
  });

    app.post("/__admin/reset", async (_request, reply) => {
      store.reset();
      return reply.code(204).send();
    });
  });

  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send(jiraError(["The requested resource does not exist."])),
  );

  return app;
}
