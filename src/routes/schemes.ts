import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  getSchemesState,
  type IssueTypeScheme,
  type PermissionGrant,
  type PermissionHolder,
  type PermissionScheme,
} from "../schemes-state.js";
import { jiraError } from "../shared/errors.js";
import { serializeNamedResource, serializeProject } from "../shared/serialization.js";

type Query = Record<string, string | string[] | undefined>;

function error(reply: FastifyReply, status: number, message: string, field?: string) {
  return reply.code(status).send(field ? jiraError([], { [field]: message }) : jiraError([message]));
}

function bodyObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function integer(value: string | string[] | undefined, fallback: number): number | undefined {
  if (value === undefined) return fallback;
  const text = Array.isArray(value) ? value[0] : value;
  return /^\d+$/.test(text) ? Number(text) : undefined;
}

function permissionGrantJson(baseUrl: string, schemeId: number, grant: PermissionGrant) {
  return {
    ...structuredClone(grant),
    self: `${baseUrl}/rest/api/2/permissionscheme/${schemeId}/permission/${grant.id}`,
  };
}

function permissionSchemeJson(baseUrl: string, scheme: PermissionScheme) {
  return {
    id: scheme.id,
    name: scheme.name,
    description: scheme.description,
    expand: "permissions",
    self: `${baseUrl}/rest/api/2/permissionscheme/${scheme.id}`,
    permissions: scheme.permissions.map((grant) => permissionGrantJson(baseUrl, scheme.id, grant)),
  };
}

function issueTypeSchemeJson(
  app: Parameters<FastifyPluginAsync>[0],
  scheme: IssueTypeScheme,
) {
  const issueTypes = scheme.issueTypeIds
    .map((id) => app.jira.store.state.issueTypes.find((value) => value.id === id))
    .filter((value) => value !== undefined)
    .map((value) => serializeNamedResource(value, app.jira.baseUrl, "issuetype"));
  const defaultIssueType = issueTypes.find((value) => value.id === scheme.defaultIssueTypeId);
  return {
    id: scheme.id,
    name: scheme.name,
    description: scheme.description,
    expand: "issueTypes",
    self: `${app.jira.baseUrl}/rest/api/2/issuetypescheme/${scheme.id}`,
    defaultIssueType,
    issueTypes,
  };
}

function notificationSchemeJson(baseUrl: string, scheme: {
  id: number;
  name: string;
  description: string;
  notificationSchemeEvents: Record<string, unknown>;
}) {
  return {
    ...structuredClone(scheme),
    expand: "notificationSchemeEvents",
    self: `${baseUrl}/rest/api/2/notificationscheme/${scheme.id}`,
  };
}

function securityLevelJson(baseUrl: string, level: { id: string; name: string; description: string }) {
  return {
    ...structuredClone(level),
    self: `${baseUrl}/rest/api/2/securitylevel/${level.id}`,
  };
}

function validHolder(
  holder: unknown,
  users: Array<{ id?: string; key: string; name: string }>,
): holder is PermissionHolder {
  const value = bodyObject(holder);
  if (!value || typeof value.type !== "string" || !value.type.trim()) return false;
  const type = value.type;
  const parameter = value.parameter;
  if (type === "anyone" || type === "projectLead" || type === "reporter" || type === "assignee") {
    return parameter === undefined || typeof parameter === "string";
  }
  if (typeof parameter !== "string" || !parameter.trim()) return false;
  if (type === "user") {
    return users.some((user) => user.name === parameter || user.key === parameter || user.id === parameter);
  }
  return ["group", "projectRole", "applicationRole", "userCustomField", "groupCustomField"].includes(type);
}

function grantFromBody(
  value: unknown,
  users: Array<{ id?: string; key: string; name: string }>,
  id: number,
): PermissionGrant | undefined {
  const body = bodyObject(value);
  if (!body || typeof body.permission !== "string" || !body.permission.trim() || !validHolder(body.holder, users)) return undefined;
  return {
    id,
    permission: body.permission.trim(),
    holder: {
      type: body.holder.type.trim(),
      ...(typeof body.holder.parameter === "string" ? { parameter: body.holder.parameter.trim() } : {}),
    },
  };
}

function issueTypeIds(body: Record<string, unknown>): string[] | undefined {
  const ids = body.issueTypeIds ?? body.issueTypeIDs;
  return Array.isArray(ids) && ids.every((value) => typeof value === "string")
    ? [...new Set(ids as string[])]
    : undefined;
}

const schemesRoutes: FastifyPluginAsync = async (app) => {
  app.get("/rest/api/2/issuesecurityschemes", async () => {
    const state = getSchemesState(app.jira.store);
    return {
      issueSecuritySchemes: state.issueSecuritySchemes.map((scheme) => ({
        ...structuredClone(scheme),
        self: `${app.jira.baseUrl}/rest/api/2/issuesecurityschemes/${scheme.id}`,
        levels: scheme.levels.map((level) => securityLevelJson(app.jira.baseUrl, level)),
      })),
    };
  });

  app.get("/rest/api/2/issuesecurityschemes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const scheme = getSchemesState(app.jira.store).issueSecuritySchemes.find((value) => String(value.id) === id);
    if (!scheme) return error(reply, 404, "The issue security scheme does not exist.");
    return {
      ...structuredClone(scheme),
      self: `${app.jira.baseUrl}/rest/api/2/issuesecurityschemes/${scheme.id}`,
      levels: scheme.levels.map((level) => securityLevelJson(app.jira.baseUrl, level)),
    };
  });

  app.get("/rest/api/2/securitylevel/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const level = getSchemesState(app.jira.store).issueSecuritySchemes.flatMap((scheme) => scheme.levels).find((value) => value.id === id);
    if (!level) return error(reply, 404, "The issue security level does not exist.");
    return securityLevelJson(app.jira.baseUrl, level);
  });

  app.get("/rest/api/2/issuetypescheme", async () => ({
    schemes: getSchemesState(app.jira.store).issueTypeSchemes.map((scheme) => issueTypeSchemeJson(app, scheme)),
  }));

  app.post("/rest/api/2/issuetypescheme", async (request, reply) => {
    const body = bodyObject(request.body);
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const ids = body ? issueTypeIds(body) : undefined;
    const defaultId = typeof body?.defaultIssueTypeId === "string" ? body.defaultIssueTypeId : "";
    if (!name || !ids?.length || !defaultId) return error(reply, 400, "name, defaultIssueTypeId, and issueTypeIds are required.");
    if (!ids.includes(defaultId)) return error(reply, 400, "defaultIssueTypeId must be included in issueTypeIds.", "defaultIssueTypeId");
    if (ids.some((id) => !app.jira.store.state.issueTypes.some((type) => type.id === id))) return error(reply, 400, "issueTypeIds must identify existing issue types.", "issueTypeIds");
    const state = getSchemesState(app.jira.store);
    if (state.issueTypeSchemes.some((scheme) => scheme.name.toLowerCase() === name.toLowerCase())) return error(reply, 400, "An issue type scheme with this name already exists.", "name");
    const scheme: IssueTypeScheme = { id: String(state.issueTypeSchemeCounter++), name, description: typeof body?.description === "string" ? body.description : "", defaultIssueTypeId: defaultId, issueTypeIds: ids };
    state.issueTypeSchemes.push(scheme);
    state.issueTypeProjectAssociations[scheme.id] = [];
    app.jira.store.save();
    return reply.code(200).send(issueTypeSchemeJson(app, scheme));
  });

  app.get("/rest/api/2/issuetypescheme/:schemeId/associations", async (request, reply) => {
    const { schemeId } = request.params as { schemeId: string };
    const state = getSchemesState(app.jira.store);
    if (!state.issueTypeSchemes.some((scheme) => scheme.id === schemeId)) return error(reply, 404, "The issue type scheme does not exist.");
    const projectIds = state.issueTypeProjectAssociations[schemeId] ?? [];
    return projectIds.map((id) => app.jira.store.state.projects.find((project) => project.id === id)).filter((project) => project !== undefined).map((project) => serializeProject(project, app.jira.baseUrl));
  });

  async function associate(request: FastifyRequest, reply: FastifyReply, replace: boolean) {
    const { schemeId } = request.params as { schemeId: string };
    const state = getSchemesState(app.jira.store);
    if (!state.issueTypeSchemes.some((scheme) => scheme.id === schemeId)) return error(reply, 404, "The issue type scheme does not exist.");
    const body = bodyObject(request.body);
    if (!body || !Array.isArray(body.idsOrKeys) || !body.idsOrKeys.every((value) => typeof value === "string")) return error(reply, 400, "idsOrKeys must be an array of project ids or keys.", "idsOrKeys");
    const projects = (body.idsOrKeys as string[]).map((idOrKey) => app.jira.store.state.projects.find((project) => project.id === idOrKey || project.key.toLowerCase() === idOrKey.toLowerCase()));
    if (projects.some((project) => !project)) return error(reply, 400, "Every idsOrKeys value must identify a visible project.", "idsOrKeys");
    const ids = [...new Set(projects.map((project) => project!.id))];
    for (const associations of Object.values(state.issueTypeProjectAssociations)) {
      for (const id of ids) {
        const index = associations.indexOf(id);
        if (index >= 0) associations.splice(index, 1);
      }
    }
    state.issueTypeProjectAssociations[schemeId] = replace
      ? ids
      : [...new Set([...(state.issueTypeProjectAssociations[schemeId] ?? []), ...ids])];
    app.jira.store.save();
    return reply.code(200).send();
  }

  app.put("/rest/api/2/issuetypescheme/:schemeId/associations", async (request, reply) => associate(request, reply, true));
  app.post("/rest/api/2/issuetypescheme/:schemeId/associations", async (request, reply) => associate(request, reply, false));

  app.delete("/rest/api/2/issuetypescheme/:schemeId/associations", async (request, reply) => {
    const { schemeId } = request.params as { schemeId: string };
    const state = getSchemesState(app.jira.store);
    if (!state.issueTypeSchemes.some((scheme) => scheme.id === schemeId)) return error(reply, 404, "The issue type scheme does not exist.");
    state.issueTypeProjectAssociations[schemeId] = [];
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.delete("/rest/api/2/issuetypescheme/:schemeId/associations/:projIdOrKey", async (request, reply) => {
    const { schemeId, projIdOrKey } = request.params as { schemeId: string; projIdOrKey: string };
    const state = getSchemesState(app.jira.store);
    if (!state.issueTypeSchemes.some((scheme) => scheme.id === schemeId)) return error(reply, 404, "The issue type scheme does not exist.");
    const project = app.jira.store.state.projects.find((value) => value.id === projIdOrKey || value.key.toLowerCase() === projIdOrKey.toLowerCase());
    if (!project) return error(reply, 404, "The project does not exist.");
    const associations = state.issueTypeProjectAssociations[schemeId] ?? [];
    if (!associations.includes(project.id)) return error(reply, 404, "The project is not associated with this issue type scheme.");
    state.issueTypeProjectAssociations[schemeId] = associations.filter((id) => id !== project.id);
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/issuetypescheme/:schemeId", async (request, reply) => {
    const { schemeId } = request.params as { schemeId: string };
    const scheme = getSchemesState(app.jira.store).issueTypeSchemes.find((value) => value.id === schemeId);
    if (!scheme) return error(reply, 404, "The issue type scheme does not exist.");
    return issueTypeSchemeJson(app, scheme);
  });

  app.put("/rest/api/2/issuetypescheme/:schemeId", async (request, reply) => {
    const { schemeId } = request.params as { schemeId: string };
    const state = getSchemesState(app.jira.store);
    const scheme = state.issueTypeSchemes.find((value) => value.id === schemeId);
    if (!scheme) return error(reply, 404, "The issue type scheme does not exist.");
    const body = bodyObject(request.body);
    if (!body) return error(reply, 400, "The issue type scheme update must be a JSON object.");
    const name = body.name === undefined ? scheme.name : typeof body.name === "string" ? body.name.trim() : "";
    const ids = body.issueTypeIds === undefined && body.issueTypeIDs === undefined ? scheme.issueTypeIds : issueTypeIds(body);
    const defaultId = body.defaultIssueTypeId === undefined ? scheme.defaultIssueTypeId : typeof body.defaultIssueTypeId === "string" ? body.defaultIssueTypeId : "";
    if (!name || !ids?.length || !defaultId || !ids.includes(defaultId)) return error(reply, 400, "The name, default issue type, or issue type list is invalid.");
    if (ids.some((id) => !app.jira.store.state.issueTypes.some((type) => type.id === id))) return error(reply, 400, "issueTypeIds must identify existing issue types.", "issueTypeIds");
    if (state.issueTypeSchemes.some((value) => value.id !== schemeId && value.name.toLowerCase() === name.toLowerCase())) return error(reply, 400, "An issue type scheme with this name already exists.", "name");
    Object.assign(scheme, { name, issueTypeIds: ids, defaultIssueTypeId: defaultId, ...(typeof body.description === "string" ? { description: body.description } : {}) });
    app.jira.store.save();
    return issueTypeSchemeJson(app, scheme);
  });

  app.delete("/rest/api/2/issuetypescheme/:schemeId", async (request, reply) => {
    const { schemeId } = request.params as { schemeId: string };
    const state = getSchemesState(app.jira.store);
    const index = state.issueTypeSchemes.findIndex((value) => value.id === schemeId);
    if (index < 0) return error(reply, 404, "The issue type scheme does not exist.");
    if (schemeId === "10000") return error(reply, 400, "The default issue type scheme cannot be deleted.");
    if ((state.issueTypeProjectAssociations[schemeId] ?? []).length) return error(reply, 400, "An issue type scheme associated with projects cannot be deleted.");
    state.issueTypeSchemes.splice(index, 1);
    delete state.issueTypeProjectAssociations[schemeId];
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/notificationscheme", async (request, reply) => {
    const query = request.query as Query;
    const startAt = integer(query.startAt, 0);
    const maxResults = integer(query.maxResults, 50);
    if (startAt === undefined || maxResults === undefined) return error(reply, 400, "startAt and maxResults must be non-negative integers.");
    const all = getSchemesState(app.jira.store).notificationSchemes.map((scheme) => notificationSchemeJson(app.jira.baseUrl, scheme));
    const values = all.slice(startAt, startAt + maxResults);
    const isLast = startAt + values.length >= all.length;
    return {
      self: `${app.jira.baseUrl}/rest/api/2/notificationscheme?startAt=${startAt}&maxResults=${maxResults}`,
      startAt,
      maxResults,
      total: all.length,
      isLast,
      ...(!isLast ? { nextPage: `${app.jira.baseUrl}/rest/api/2/notificationscheme?startAt=${startAt + maxResults}&maxResults=${maxResults}` } : {}),
      values,
    };
  });

  app.get("/rest/api/2/notificationscheme/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!/^\d+$/.test(id)) return error(reply, 404, "The notification scheme does not exist.");
    const scheme = getSchemesState(app.jira.store).notificationSchemes.find((value) => value.id === Number(id));
    if (!scheme) return error(reply, 404, "The notification scheme does not exist.");
    return notificationSchemeJson(app.jira.baseUrl, scheme);
  });

  app.get("/rest/api/2/permissionscheme", async () => ({
    permissionSchemes: getSchemesState(app.jira.store).permissionSchemes.map((scheme) => permissionSchemeJson(app.jira.baseUrl, scheme)),
  }));

  app.post("/rest/api/2/permissionscheme", async (request, reply) => {
    const body = bodyObject(request.body);
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) return error(reply, 400, "A permission scheme name is required.", "name");
    const state = getSchemesState(app.jira.store);
    if (state.permissionSchemes.some((scheme) => scheme.name.toLowerCase() === name.toLowerCase())) return error(reply, 400, "A permission scheme with this name already exists.", "name");
    const permissions: PermissionGrant[] = [];
    if (body?.permissions !== undefined) {
      if (!Array.isArray(body.permissions)) return error(reply, 400, "permissions must be an array.", "permissions");
      for (const item of body.permissions) {
        const grant = grantFromBody(item, app.jira.store.state.users, state.permissionGrantCounter + permissions.length);
        if (!grant) return error(reply, 400, "Each permission grant requires a valid permission and holder.", "permissions");
        permissions.push(grant);
      }
      state.permissionGrantCounter += permissions.length;
    }
    const scheme: PermissionScheme = { id: state.permissionSchemeCounter++, name, description: typeof body?.description === "string" ? body.description : "", permissions };
    state.permissionSchemes.push(scheme);
    state.permissionSchemeAttributes[String(scheme.id)] = {};
    app.jira.store.save();
    return reply.code(201).send(permissionSchemeJson(app.jira.baseUrl, scheme));
  });

  app.get("/rest/api/2/permissionscheme/:permissionSchemeId/attribute/:attributeKey", async (request, reply) => {
    const { permissionSchemeId, attributeKey } = request.params as { permissionSchemeId: string; attributeKey: string };
    const state = getSchemesState(app.jira.store);
    if (!state.permissionSchemes.some((scheme) => String(scheme.id) === permissionSchemeId)) return error(reply, 404, "The permission scheme does not exist.");
    const value = state.permissionSchemeAttributes[permissionSchemeId]?.[attributeKey];
    if (value === undefined) return error(reply, 404, "The permission scheme attribute does not exist.");
    return { key: attributeKey, value };
  });

  app.put("/rest/api/2/permissionscheme/:permissionSchemeId/attribute/:key", async (request, reply) => {
    const { permissionSchemeId, key } = request.params as { permissionSchemeId: string; key: string };
    const state = getSchemesState(app.jira.store);
    if (!state.permissionSchemes.some((scheme) => String(scheme.id) === permissionSchemeId)) return error(reply, 404, "The permission scheme does not exist.");
    if (!key || Buffer.byteLength(key) > 255 || typeof request.body !== "string" || !request.body.length) return error(reply, 400, "A non-empty text attribute and valid key are required.");
    (state.permissionSchemeAttributes[permissionSchemeId] ??= {})[key] = request.body;
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/permissionscheme/:schemeId/permission", async (request, reply) => {
    const { schemeId } = request.params as { schemeId: string };
    const scheme = getSchemesState(app.jira.store).permissionSchemes.find((value) => String(value.id) === schemeId);
    if (!scheme) return error(reply, 404, "The permission scheme does not exist.");
    return { expand: "permissions", permissions: scheme.permissions.map((grant) => permissionGrantJson(app.jira.baseUrl, scheme.id, grant)) };
  });

  app.post("/rest/api/2/permissionscheme/:schemeId/permission", async (request, reply) => {
    const { schemeId } = request.params as { schemeId: string };
    const state = getSchemesState(app.jira.store);
    const scheme = state.permissionSchemes.find((value) => String(value.id) === schemeId);
    if (!scheme) return error(reply, 404, "The permission scheme does not exist.");
    const grant = grantFromBody(request.body, app.jira.store.state.users, state.permissionGrantCounter);
    if (!grant) return error(reply, 400, "A valid permission and holder are required.");
    state.permissionGrantCounter += 1;
    scheme.permissions.push(grant);
    app.jira.store.save();
    return reply.code(201).send(permissionGrantJson(app.jira.baseUrl, scheme.id, grant));
  });

  app.get("/rest/api/2/permissionscheme/:schemeId/permission/:permissionId", async (request, reply) => {
    const { schemeId, permissionId } = request.params as { schemeId: string; permissionId: string };
    const scheme = getSchemesState(app.jira.store).permissionSchemes.find((value) => String(value.id) === schemeId);
    if (!scheme) return error(reply, 404, "The permission scheme does not exist.");
    const grant = scheme.permissions.find((value) => String(value.id) === permissionId);
    if (!grant) return error(reply, 404, "The permission grant does not exist.");
    return permissionGrantJson(app.jira.baseUrl, scheme.id, grant);
  });

  app.delete("/rest/api/2/permissionscheme/:schemeId/permission/:permissionId", async (request, reply) => {
    const { schemeId, permissionId } = request.params as { schemeId: string; permissionId: string };
    const scheme = getSchemesState(app.jira.store).permissionSchemes.find((value) => String(value.id) === schemeId);
    if (!scheme) return error(reply, 404, "The permission scheme does not exist.");
    const index = scheme.permissions.findIndex((value) => String(value.id) === permissionId);
    if (index < 0) return error(reply, 404, "The permission grant does not exist.");
    scheme.permissions.splice(index, 1);
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/permissionscheme/:schemeId", async (request, reply) => {
    const { schemeId } = request.params as { schemeId: string };
    const scheme = getSchemesState(app.jira.store).permissionSchemes.find((value) => String(value.id) === schemeId);
    if (!scheme) return error(reply, 404, "The permission scheme does not exist.");
    return permissionSchemeJson(app.jira.baseUrl, scheme);
  });

  app.put("/rest/api/2/permissionscheme/:schemeId", async (request, reply) => {
    const { schemeId } = request.params as { schemeId: string };
    const state = getSchemesState(app.jira.store);
    const scheme = state.permissionSchemes.find((value) => String(value.id) === schemeId);
    if (!scheme) return error(reply, 404, "The permission scheme does not exist.");
    const body = bodyObject(request.body);
    const name = body?.name === undefined ? scheme.name : typeof body.name === "string" ? body.name.trim() : "";
    if (!body || !name) return error(reply, 400, "A permission scheme name is required.", "name");
    if (state.permissionSchemes.some((value) => value.id !== scheme.id && value.name.toLowerCase() === name.toLowerCase())) return error(reply, 400, "A permission scheme with this name already exists.", "name");
    let permissions = scheme.permissions;
    if (body.permissions !== undefined) {
      if (!Array.isArray(body.permissions)) return error(reply, 400, "permissions must be an array.", "permissions");
      permissions = [];
      for (const item of body.permissions) {
        const grant = grantFromBody(item, app.jira.store.state.users, state.permissionGrantCounter + permissions.length);
        if (!grant) return error(reply, 400, "Each permission grant requires a valid permission and holder.", "permissions");
        permissions.push(grant);
      }
      state.permissionGrantCounter += permissions.length;
    }
    Object.assign(scheme, { name, permissions, ...(typeof body.description === "string" ? { description: body.description } : {}) });
    app.jira.store.save();
    return permissionSchemeJson(app.jira.baseUrl, scheme);
  });

  app.delete("/rest/api/2/permissionscheme/:schemeId", async (request, reply) => {
    const { schemeId } = request.params as { schemeId: string };
    const state = getSchemesState(app.jira.store);
    const index = state.permissionSchemes.findIndex((value) => String(value.id) === schemeId);
    if (index < 0) return error(reply, 404, "The permission scheme does not exist.");
    state.permissionSchemes.splice(index, 1);
    delete state.permissionSchemeAttributes[schemeId];
    app.jira.store.save();
    return reply.code(204).send();
  });
};

export default schemesRoutes;
