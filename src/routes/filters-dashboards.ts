import type { FastifyPluginAsync } from "fastify";
import { JqlError, searchWithJql } from "../jql.js";
import { jiraError } from "../shared/errors.js";
import { parseInteger } from "../shared/parameters.js";
import { serializeUser } from "../shared/serialization.js";
import { getResourceState } from "../store.js";

interface FilterPermission {
  id: number;
  type: string;
  view: boolean;
  edit: boolean;
  group?: { name: string; self: string };
  project?: { id: string; key: string; name: string; self: string };
  user?: ReturnType<typeof serializeUser>;
}

interface SavedFilter {
  id: string;
  name: string;
  description: string;
  jql: string;
  favourite: boolean;
  columns: string[] | null;
  permissions: FilterPermission[];
}

interface DashboardRecord {
  id: string;
  name: string;
  items: Record<string, Record<string, string>>;
}

interface FilterDashboardState {
  filterCounter: number;
  permissionCounter: number;
  defaultShareScope: "GLOBAL" | "AUTHENTICATED" | "PRIVATE";
  filters: SavedFilter[];
  dashboards: DashboardRecord[];
}

function defaultState(): FilterDashboardState {
  return {
    filterCounter: 12002,
    permissionCounter: 14001,
    defaultShareScope: "PRIVATE",
    filters: [
      {
        id: "12000",
        name: "T100 Open Work",
        description: "Open synthetic software-factory work",
        jql: "project = T100ZB AND status != Done ORDER BY key ASC",
        favourite: true,
        columns: ["key", "summary", "status", "assignee", "priority"],
        permissions: [{ id: 14000, type: "global", view: true, edit: false }],
      },
      {
        id: "12001",
        name: "Common Library Bugs",
        description: "Synthetic defects in the shared library project",
        jql: "project = T101LIB AND issuetype = Bug",
        favourite: false,
        columns: null,
        permissions: [],
      },
    ],
    dashboards: [
      {
        id: "10000",
        name: "System Dashboard",
        items: {
          "20000": {
            "mock.display.mode": JSON.stringify({ layout: "compact", refreshMinutes: 15 }),
          },
        },
      },
      { id: "10001", name: "Software Factory Overview", items: { "20001": {} } },
    ],
  };
}

const filtersDashboardsRoutes: FastifyPluginAsync = async (app) => {
  const state = () => getResourceState(app.jira.store, "filters-dashboards", defaultState);
  const findFilter = (id: string) => state().filters.find((filter) => filter.id === id);
  const findDashboard = (id: string) =>
    state().dashboards.find((dashboard) => dashboard.id === id);

  const filterBean = (filter: SavedFilter) => ({
    id: filter.id,
    name: filter.name,
    description: filter.description,
    jql: filter.jql,
    favourite: filter.favourite,
    editable: true,
    owner: serializeUser(app.jira.currentUser(), app.jira.baseUrl),
    self: `${app.jira.baseUrl}/rest/api/2/filter/${filter.id}`,
    searchUrl: `${app.jira.baseUrl}/rest/api/2/search?jql=${encodeURIComponent(filter.jql)}`,
    viewUrl: `${app.jira.baseUrl}/issues/?filter=${filter.id}`,
    sharePermissions: structuredClone(filter.permissions),
    sharedUsers: { size: 0, items: [], maxResults: 0, startAt: 0, endIndex: 0 },
  });

  const validateJql = (jql: string): string | undefined => {
    try {
      searchWithJql(app.jira.store.state.issues, jql, {
        currentUsername: app.jira.currentUser().name,
      });
      return undefined;
    } catch (error) {
      return error instanceof JqlError ? error.message : "JQL is invalid.";
    }
  };

  const filterBodySchema = {
    type: "object",
    required: ["name", "jql"],
    properties: {
      name: { type: "string", minLength: 1 },
      description: { type: "string" },
      jql: { type: "string", minLength: 1 },
      favourite: { type: "boolean" },
    },
    additionalProperties: true,
  };

  app.post(
    "/rest/api/2/filter",
    { schema: { body: filterBodySchema } },
    async (request, reply) => {
      const body = request.body as {
        name: string;
        description?: string;
        jql: string;
        favourite?: boolean;
      };
      const jqlError = validateJql(body.jql);
      if (jqlError) return reply.code(400).send(jiraError([jqlError]));
      const current = state();
      const filter: SavedFilter = {
        id: String(current.filterCounter++),
        name: body.name.trim(),
        description: body.description ?? "",
        jql: body.jql,
        favourite: body.favourite ?? false,
        columns: null,
        permissions:
          current.defaultShareScope === "PRIVATE"
            ? []
            : [{
                id: current.permissionCounter++,
                type: current.defaultShareScope === "GLOBAL" ? "global" : "authenticated",
                view: true,
                edit: false,
              }],
      };
      current.filters.push(filter);
      app.jira.store.save();
      return filterBean(filter);
    },
  );

  app.get("/rest/api/2/filter/defaultShareScope", async () => ({
    scope: state().defaultShareScope,
  }));
  app.put(
    "/rest/api/2/filter/defaultShareScope",
    {
      schema: {
        body: {
          type: "object",
          required: ["scope"],
          properties: {
            scope: { type: "string", enum: ["GLOBAL", "AUTHENTICATED", "PRIVATE"] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      state().defaultShareScope = (
        request.body as { scope: FilterDashboardState["defaultShareScope"] }
      ).scope;
      app.jira.store.save();
      return { scope: state().defaultShareScope };
    },
  );

  app.get("/rest/api/2/filter/favourite", async () =>
    state().filters.filter((filter) => filter.favourite).map(filterBean),
  );

  app.get("/rest/api/2/filter/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const filter = findFilter(id);
    if (!filter) return reply.code(404).send(jiraError(["Filter was not found."]));
    return filterBean(filter);
  });

  app.put(
    "/rest/api/2/filter/:id",
    { schema: { body: filterBodySchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const filter = findFilter(id);
      if (!filter) return reply.code(404).send(jiraError(["Filter was not found."]));
      const body = request.body as {
        name: string;
        description?: string;
        jql: string;
        favourite?: boolean;
      };
      const jqlError = validateJql(body.jql);
      if (jqlError) return reply.code(400).send(jiraError([jqlError]));
      filter.name = body.name.trim();
      filter.description = body.description ?? filter.description;
      filter.jql = body.jql;
      filter.favourite = body.favourite ?? filter.favourite;
      app.jira.store.save();
      return filterBean(filter);
    },
  );

  app.delete("/rest/api/2/filter/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const index = state().filters.findIndex((filter) => filter.id === id);
    if (index < 0) return reply.code(400).send(jiraError(["Filter was not found."]));
    state().filters.splice(index, 1);
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/filter/:id/columns", async (request, reply) => {
    const { id } = request.params as { id: string };
    const filter = findFilter(id);
    if (!filter) return reply.code(404).send(jiraError(["Filter was not found."]));
    return { columns: filter.columns ?? ["key", "summary", "status", "assignee"] };
  });
  app.put(
    "/rest/api/2/filter/:id/columns",
    {
      schema: {
        body: {
          type: "object",
          required: ["columns"],
          properties: {
            columns: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const filter = findFilter(id);
      if (!filter) return reply.code(404).send(jiraError(["Filter was not found."]));
      filter.columns = [...new Set((request.body as { columns: string[] }).columns)];
      app.jira.store.save();
      return reply.code(200).send();
    },
  );
  app.delete("/rest/api/2/filter/:id/columns", async (request, reply) => {
    const { id } = request.params as { id: string };
    const filter = findFilter(id);
    if (!filter) return reply.code(500).send(jiraError(["Filter was not found."]));
    filter.columns = null;
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/filter/:id/permission", async (request, reply) => {
    const { id } = request.params as { id: string };
    const filter = findFilter(id);
    if (!filter) return reply.code(404).send(jiraError(["Filter was not found."]));
    return structuredClone(filter.permissions);
  });
  app.post(
    "/rest/api/2/filter/:id/permission",
    {
      schema: {
        body: {
          type: "object",
          required: ["type"],
          properties: {
            type: { type: "string" },
            view: { type: "boolean" },
            edit: { type: "boolean" },
            groupname: { type: "string" },
            projectId: { type: "string" },
            userKey: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const filter = findFilter(id);
      if (!filter) return reply.code(404).send(jiraError(["Filter was not found."]));
      const body = request.body as {
        type: string;
        view?: boolean;
        edit?: boolean;
        groupname?: string;
        projectId?: string;
        userKey?: string;
      };
      const permission: FilterPermission = {
        id: state().permissionCounter++,
        type: body.type,
        view: body.view ?? true,
        edit: body.edit ?? false,
      };
      if (body.groupname) {
        permission.group = {
          name: body.groupname,
          self: `${app.jira.baseUrl}/rest/api/2/group?groupname=${encodeURIComponent(body.groupname)}`,
        };
      }
      if (body.projectId) {
        const project = app.jira.store.state.projects.find(
          (candidate) => candidate.id === body.projectId || candidate.key === body.projectId,
        );
        if (!project) return reply.code(400).send(jiraError(["Project was not found."]));
        permission.project = {
          id: project.id,
          key: project.key,
          name: project.name,
          self: `${app.jira.baseUrl}/rest/api/2/project/${project.id}`,
        };
      }
      if (body.userKey) {
        const user = app.jira.store.state.users.find(
          (candidate) => candidate.key === body.userKey || candidate.name === body.userKey,
        );
        if (!user) return reply.code(400).send(jiraError(["User was not found."]));
        permission.user = serializeUser(user, app.jira.baseUrl);
      }
      filter.permissions.push(permission);
      app.jira.store.save();
      return reply.code(201).send(structuredClone(permission));
    },
  );

  app.get("/rest/api/2/filter/:id/permission/:permissionId", async (request, reply) => {
    const { id, permissionId } = request.params as { id: string; permissionId: string };
    const filter = findFilter(id);
    const permission = filter?.permissions.find((candidate) => candidate.id === Number(permissionId));
    if (!permission) return reply.code(404).send(jiraError(["Share permission was not found."]));
    return structuredClone(permission);
  });

  app.delete("/rest/api/2/filter/:id/permission/:permission_id", async (request, reply) => {
    const parameters = request.params as { id: string; permission_id: string };
    const filter = findFilter(parameters.id);
    const permissionId = Number(parameters.permission_id);
    const index = filter?.permissions.findIndex((candidate) => candidate.id === permissionId) ?? -1;
    if (!filter || index < 0) {
      return reply.code(404).send(jiraError(["Share permission was not found."]));
    }
    filter.permissions.splice(index, 1);
    app.jira.store.save();
    return reply.code(204).send();
  });

  const dashboardBean = (dashboard: DashboardRecord) => ({
    id: dashboard.id,
    name: dashboard.name,
    self: `${app.jira.baseUrl}/rest/api/2/dashboard/${dashboard.id}`,
    view: `${app.jira.baseUrl}/secure/Dashboard.jspa?selectPageId=${dashboard.id}`,
  });

  app.get("/rest/api/2/dashboard", async (request) => {
    const query = request.query as { filter?: string; startAt?: string; maxResults?: string };
    const startAt = parseInteger(query.startAt, 0);
    const maxResults = parseInteger(query.maxResults, 20, 100);
    const matches = state().dashboards.filter(
      (dashboard) => !query.filter || dashboard.name.toLowerCase().includes(query.filter.toLowerCase()),
    );
    return {
      startAt,
      maxResults,
      total: matches.length,
      dashboards: matches.slice(startAt, startAt + maxResults).map(dashboardBean),
    };
  });
  app.get("/rest/api/2/dashboard/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const dashboard = findDashboard(id);
    if (!dashboard) return reply.code(404).send(jiraError(["Dashboard was not found."]));
    return dashboardBean(dashboard);
  });

  const dashboardItem = (
    dashboardId: string,
    itemId: string,
  ): { dashboard?: DashboardRecord; properties?: Record<string, string> } => {
    const dashboard = findDashboard(dashboardId);
    return { dashboard, properties: dashboard?.items[itemId] };
  };

  app.get(
    "/rest/api/2/dashboard/:dashboardId/items/:itemId/properties",
    async (request, reply) => {
      const { dashboardId, itemId } = request.params as { dashboardId: string; itemId: string };
      const { properties } = dashboardItem(dashboardId, itemId);
      if (!properties) return reply.code(404).send(jiraError(["Dashboard item was not found."]));
      return {
        keys: Object.keys(properties).sort().map((key) => ({
          key,
          self: `${app.jira.baseUrl}/rest/api/2/dashboard/${dashboardId}/items/${itemId}/properties/${encodeURIComponent(key)}`,
        })),
      };
    },
  );
  app.get(
    "/rest/api/2/dashboard/:dashboardId/items/:itemId/properties/:propertyKey",
    async (request, reply) => {
      const { dashboardId, itemId, propertyKey } = request.params as {
        dashboardId: string;
        itemId: string;
        propertyKey: string;
      };
      const { properties } = dashboardItem(dashboardId, itemId);
      if (!properties || !(propertyKey in properties)) {
        return reply.code(404).send(jiraError(["Dashboard item property was not found."]));
      }
      return { key: propertyKey, value: properties[propertyKey] };
    },
  );
  app.put(
    "/rest/api/2/dashboard/:dashboardId/items/:itemId/properties/:propertyKey",
    async (request, reply) => {
      const { dashboardId, itemId, propertyKey } = request.params as {
        dashboardId: string;
        itemId: string;
        propertyKey: string;
      };
      const { properties } = dashboardItem(dashboardId, itemId);
      if (!properties) return reply.code(404).send(jiraError(["Dashboard item was not found."]));
      const created = !(propertyKey in properties);
      properties[propertyKey] =
        typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? null);
      app.jira.store.save();
      return reply.code(created ? 201 : 200).send();
    },
  );
  app.delete(
    "/rest/api/2/dashboard/:dashboardId/items/:itemId/properties/:propertyKey",
    async (request, reply) => {
      const { dashboardId, itemId, propertyKey } = request.params as {
        dashboardId: string;
        itemId: string;
        propertyKey: string;
      };
      const { properties } = dashboardItem(dashboardId, itemId);
      if (!properties || !(propertyKey in properties)) {
        return reply.code(404).send(jiraError(["Dashboard item property was not found."]));
      }
      delete properties[propertyKey];
      app.jira.store.save();
      return reply.code(204).send();
    },
  );
};

export default filtersDashboardsRoutes;
