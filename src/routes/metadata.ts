import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { jiraError } from "../shared/errors.js";
import {
  metadataState,
  systemFields,
  type CustomFieldOption,
  type IssueLinkType,
  type MetadataField,
  type Resolution,
} from "../metadata/resources.js";

type Query = Record<string, string | string[] | undefined>;

function fail(reply: FastifyReply, status: number, message: string, field?: string) {
  return reply.code(status).send(
    field ? jiraError([], { [field]: message }) : jiraError([message]),
  );
}

function strings(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value])
    .flatMap((item) => item.split(","))
    .map((item) => item.trim())
    .filter(Boolean);
}

function integer(
  value: string | string[] | undefined,
  fallback: number,
): number | undefined {
  if (value === undefined) return fallback;
  const raw = Array.isArray(value) ? value[0] : value;
  if (!/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

function page<T>(values: T[], query: Query, defaultMax = 100) {
  const startAt = integer(query.startAt, 0);
  const maxResults = integer(query.maxResults, defaultMax);
  if (startAt === undefined || maxResults === undefined) return undefined;
  const selected = values.slice(startAt, startAt + maxResults);
  return {
    maxResults,
    startAt,
    total: values.length,
    isLast: startAt + selected.length >= values.length,
    values: selected,
  };
}

function namedUrl(baseUrl: string, group: string, id: string | number): string {
  return `${baseUrl}/rest/api/2/${group}/${id}`;
}

function issueTypeJson(baseUrl: string, value: Record<string, unknown>) {
  return {
    ...structuredClone(value),
    self: namedUrl(baseUrl, "issuetype", String(value.id)),
  };
}

function priorityJson(baseUrl: string, value: Record<string, unknown>) {
  return {
    ...structuredClone(value),
    self: namedUrl(baseUrl, "priority", String(value.id)),
    iconUrl: `${baseUrl}/images/icons/priorities/${value.id}.svg`,
    statusColor: value.id === "1" ? "#d04437" : "#4a6785",
  };
}

function statusCategoryJson(baseUrl: string, value: Record<string, unknown>) {
  return {
    ...structuredClone(value),
    self: namedUrl(baseUrl, "statuscategory", String(value.id)),
  };
}

function statusJson(baseUrl: string, value: Record<string, unknown>) {
  return {
    ...structuredClone(value),
    self: namedUrl(baseUrl, "status", String(value.id)),
    iconUrl: `${baseUrl}/images/icons/statuses/${value.id}.svg`,
    statusCategory: statusCategoryJson(
      baseUrl,
      value.statusCategory as Record<string, unknown>,
    ),
  };
}

function resolutionJson(baseUrl: string, value: Resolution) {
  return {
    ...structuredClone(value),
    self: namedUrl(baseUrl, "resolution", value.id),
    iconUrl: `${baseUrl}/images/icons/statuses/resolved.svg`,
  };
}

function fieldJson(field: MetadataField) {
  const { type: _type, searcherKey: _searcherKey, projectIds: _projectIds,
    issueTypeIds: _issueTypeIds, screenIds: _screenIds,
    lastValueUpdate: _lastValueUpdate, description: _description, ...result } = field;
  return structuredClone(result);
}

function customFieldJson(baseUrl: string, field: MetadataField) {
  const numericId = Number(field.id.replace(/^customfield_/, ""));
  const projectIds = field.projectIds ?? [];
  return {
    id: field.id,
    numericId,
    name: field.name,
    description: field.description ?? "",
    type: field.type ?? field.schema.custom,
    searcherKey: field.searcherKey ?? "",
    self: `${baseUrl}/rest/api/2/customFields/${field.id}`,
    isLocked: false,
    isManaged: false,
    isTrusted: true,
    isAllProjects: projectIds.length === 0,
    projectIds,
    projectsCount: projectIds.length,
    issueTypeIds: field.issueTypeIds ?? [],
    screensCount: field.screenIds?.length ?? 0,
    issuesWithValue: 0,
    lastValueUpdate: field.lastValueUpdate ?? "2026-01-01T00:00:00.000Z",
  };
}

function optionJson(baseUrl: string, option: CustomFieldOption) {
  const { customFieldId: _customFieldId, ...result } = option;
  return {
    ...structuredClone(result),
    self: namedUrl(baseUrl, "customFieldOption", option.id),
  };
}

function linkTypeJson(baseUrl: string, linkType: IssueLinkType) {
  return {
    ...structuredClone(linkType),
    self: namedUrl(baseUrl, "issueLinkType", linkType.id),
  };
}

function normalizedCustomFieldId(value: string): string {
  return value.startsWith("customfield_") ? value : `customfield_${value}`;
}

function bodyObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

const metadataRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser(
    /^multipart\/form-data(?:;.*)?$/,
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  app.get("/rest/api/2/field", async () => {
    const state = metadataState(app.jira.store);
    return [...systemFields, ...state.customFields].map(fieldJson);
  });

  app.post("/rest/api/2/field", async (request, reply) => {
    const body = bodyObject(request.body);
    if (!body) return fail(reply, 400, "The custom field definition must be a JSON object.");
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const type = typeof body.type === "string" ? body.type.trim() : "";
    if (!name) return fail(reply, 400, "A custom field name is required.", "name");
    if (!type) return fail(reply, 400, "A custom field type is required.", "type");
    const state = metadataState(app.jira.store);
    if (state.customFields.some((field) => field.name.toLowerCase() === name.toLowerCase())) {
      return fail(reply, 400, "A custom field with this name already exists.", "name");
    }
    const projectIds = Array.isArray(body.projectIds) ? body.projectIds : [];
    if (!projectIds.every((id) => Number.isInteger(id) && app.jira.store.state.projects.some((project) => project.id === String(id)))) {
      return fail(reply, 400, "projectIds must identify visible projects.", "projectIds");
    }
    const issueTypeIds = Array.isArray(body.issueTypeIds) ? body.issueTypeIds : [];
    if (!issueTypeIds.every((id) => typeof id === "string" && app.jira.store.state.issueTypes.some((issueType) => issueType.id === id))) {
      return fail(reply, 400, "issueTypeIds must identify existing issue types.", "issueTypeIds");
    }
    const numericId = state.customFieldCounter++;
    const field: MetadataField = {
      id: `customfield_${numericId}`,
      name,
      description: typeof body.description === "string" ? body.description : "",
      custom: true,
      orderable: true,
      navigable: true,
      searchable: true,
      clauseNames: [name, `cf[${numericId}]`],
      schema: { type: "string", custom: type, customId: numericId },
      type,
      searcherKey: typeof body.searcherKey === "string" ? body.searcherKey : "",
      projectIds: projectIds as number[],
      issueTypeIds: issueTypeIds as string[],
      screenIds: [],
      lastValueUpdate: "2026-08-06T00:00:00.000Z",
    };
    state.customFields.push(field);
    app.jira.store.save();
    return reply.code(201).send(fieldJson(field));
  });

  app.get("/rest/api/2/customFields", async (request, reply) => {
    const query = request.query as Query;
    const state = metadataState(app.jira.store);
    let fields = [...state.customFields];
    const search = typeof query.search === "string" ? query.search.trim().toLowerCase() : "";
    if (search) fields = fields.filter((field) => `${field.name} ${field.description ?? ""}`.toLowerCase().includes(search));
    const types = new Set(strings(query.types));
    if (types.size) fields = fields.filter((field) => types.has(field.type ?? ""));
    const projectIds = new Set(strings(query.projectIds).map(Number));
    if (projectIds.size) fields = fields.filter((field) => (field.projectIds ?? []).length === 0 || (field.projectIds ?? []).some((id) => projectIds.has(id)));
    const screenIds = new Set(strings(query.screenIds).map(Number));
    if (screenIds.size) fields = fields.filter((field) => (field.screenIds ?? []).some((id) => screenIds.has(id)));
    if (typeof query.lastValueUpdate === "string" && query.lastValueUpdate) {
      const cutoff = Date.parse(query.lastValueUpdate);
      if (Number.isNaN(cutoff)) return fail(reply, 400, "lastValueUpdate must be an ISO date-time.", "lastValueUpdate");
      fields = fields.filter((field) => Date.parse(field.lastValueUpdate ?? "") >= cutoff);
    }
    const sortColumn = typeof query.sortColumn === "string" ? query.sortColumn : "name";
    if (!["name", "id", "lastValueUpdate"].includes(sortColumn)) return fail(reply, 400, "Unsupported sortColumn.", "sortColumn");
    fields.sort((left, right) => String(left[sortColumn as keyof MetadataField] ?? "").localeCompare(String(right[sortColumn as keyof MetadataField] ?? "")));
    const sortOrder = String(query.sortOrder ?? "ASC").toUpperCase();
    if (sortOrder !== "ASC" && sortOrder !== "DESC") return fail(reply, 400, "sortOrder must be ASC or DESC.", "sortOrder");
    if (sortOrder === "DESC") fields.reverse();
    const result = page(fields.map((field) => customFieldJson(app.jira.baseUrl, field)), query);
    if (!result) return fail(reply, 400, "startAt and maxResults must be non-negative integers.");
    return result;
  });

  app.delete("/rest/api/2/customFields", async (request, reply) => {
    const ids = strings((request.query as Query).ids).map(normalizedCustomFieldId);
    if (!ids.length) return fail(reply, 400, "At least one custom field id is required.", "ids");
    const state = metadataState(app.jira.store);
    const deleted = ids.filter((id) => state.customFields.some((field) => field.id === id));
    if (!deleted.length) return fail(reply, 400, "No custom fields were removed.");
    const deletedSet = new Set(deleted);
    state.customFields = state.customFields.filter((field) => !deletedSet.has(field.id));
    state.customFieldOptions = state.customFieldOptions.filter((option) => !deletedSet.has(option.customFieldId));
    app.jira.store.save();
    const notDeletedCustomFields = Object.fromEntries(ids.filter((id) => !deletedSet.has(id)).map((id) => [id, "Custom field does not exist."]));
    return { deletedCustomFields: deleted, notDeletedCustomFields, message: "Custom fields bulk delete operation finished." };
  });

  app.get("/rest/api/2/customFields/:customFieldId/options", async (request, reply) => {
    const { customFieldId } = request.params as { customFieldId: string };
    const fieldId = normalizedCustomFieldId(customFieldId);
    const state = metadataState(app.jira.store);
    if (!state.customFields.some((field) => field.id === fieldId)) return fail(reply, 404, "The custom field does not exist.");
    const query = request.query as Query;
    const requestedProjects = strings(query.projectIds);
    if (requestedProjects.some((id) => !app.jira.store.state.projects.some((project) => project.id === id))) return fail(reply, 400, "projectIds must identify visible projects.", "projectIds");
    const requestedTypes = strings(query.issueTypeIds);
    if (requestedTypes.some((id) => !app.jira.store.state.issueTypes.some((type) => type.id === id))) return fail(reply, 400, "issueTypeIds must identify existing issue types.", "issueTypeIds");
    const field = state.customFields.find((candidate) => candidate.id === fieldId)!;
    let options = state.customFieldOptions.filter((option) => option.customFieldId === fieldId);
    if (requestedProjects.length && (field.projectIds ?? []).length && !requestedProjects.some((id) => field.projectIds?.includes(Number(id)))) options = [];
    if (requestedTypes.length && (field.issueTypeIds ?? []).length && !requestedTypes.some((id) => field.issueTypeIds?.includes(id))) options = [];
    const search = typeof query.query === "string" ? query.query.toLowerCase() : "";
    if (search) options = options.filter((option) => option.value.toLowerCase().includes(search));
    const maxResults = integer(query.maxResults, 100);
    const pageNumber = integer(query.page, 1);
    if (maxResults === undefined || pageNumber === undefined || pageNumber < 1) return fail(reply, 400, "page and maxResults must be positive integers.");
    const start = (pageNumber - 1) * maxResults;
    return { options: options.slice(start, start + maxResults).map((option) => optionJson(app.jira.baseUrl, option)), total: options.length };
  });

  app.get("/rest/api/2/customFieldOption/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const option = metadataState(app.jira.store).customFieldOptions.find((candidate) => String(candidate.id) === id);
    if (!option) return fail(reply, 404, "The custom field option does not exist.");
    return optionJson(app.jira.baseUrl, option);
  });

  app.get("/rest/api/2/issueLinkType", async () => ({
    issueLinkTypes: metadataState(app.jira.store).issueLinkTypes.map((value) => linkTypeJson(app.jira.baseUrl, value)),
  }));

  app.post("/rest/api/2/issueLinkType", async (request, reply) => {
    const body = bodyObject(request.body);
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const inward = typeof body?.inward === "string" ? body.inward.trim() : "";
    const outward = typeof body?.outward === "string" ? body.outward.trim() : "";
    if (!name || !inward || !outward) return fail(reply, 400, "name, inward, and outward are required.");
    const state = metadataState(app.jira.store);
    if (state.issueLinkTypes.some((value) => value.name.toLowerCase() === name.toLowerCase())) return fail(reply, 400, "An issue link type with this name already exists.", "name");
    state.issueLinkTypes.push({ id: String(state.issueLinkTypeCounter++), name, inward, outward });
    app.jira.store.save();
    return reply.code(201).send();
  });

  app.get("/rest/api/2/issueLinkType/:issueLinkTypeId", async (request, reply) => {
    const { issueLinkTypeId } = request.params as { issueLinkTypeId: string };
    if (!/^\d+$/.test(issueLinkTypeId)) return fail(reply, 400, "The issue link type id must be numeric.");
    const linkType = metadataState(app.jira.store).issueLinkTypes.find((value) => value.id === issueLinkTypeId);
    if (!linkType) return fail(reply, 404, "The issue link type does not exist.");
    return linkTypeJson(app.jira.baseUrl, linkType);
  });

  app.put("/rest/api/2/issueLinkType/:issueLinkTypeId", async (request, reply) => {
    const { issueLinkTypeId } = request.params as { issueLinkTypeId: string };
    if (!/^\d+$/.test(issueLinkTypeId)) return fail(reply, 400, "The issue link type id must be numeric.");
    const state = metadataState(app.jira.store);
    const linkType = state.issueLinkTypes.find((value) => value.id === issueLinkTypeId);
    if (!linkType) return fail(reply, 404, "The issue link type does not exist.");
    const body = bodyObject(request.body);
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const inward = typeof body?.inward === "string" ? body.inward.trim() : "";
    const outward = typeof body?.outward === "string" ? body.outward.trim() : "";
    if (!name || !inward || !outward) return fail(reply, 400, "name, inward, and outward are required.");
    if (state.issueLinkTypes.some((value) => value.id !== issueLinkTypeId && value.name.toLowerCase() === name.toLowerCase())) return fail(reply, 400, "An issue link type with this name already exists.", "name");
    Object.assign(linkType, { name, inward, outward });
    app.jira.store.save();
    return reply.code(200).send();
  });

  app.delete("/rest/api/2/issueLinkType/:issueLinkTypeId", async (request, reply) => {
    const { issueLinkTypeId } = request.params as { issueLinkTypeId: string };
    if (!/^\d+$/.test(issueLinkTypeId)) return fail(reply, 400, "The issue link type id must be numeric.");
    const state = metadataState(app.jira.store);
    const index = state.issueLinkTypes.findIndex((value) => value.id === issueLinkTypeId);
    if (index < 0) return fail(reply, 404, "The issue link type does not exist.");
    state.issueLinkTypes.splice(index, 1);
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/issuetype", async () => app.jira.store.state.issueTypes.map((value) => issueTypeJson(app.jira.baseUrl, value as unknown as Record<string, unknown>)));

  app.post("/rest/api/2/issuetype", async (request, reply) => {
    const body = bodyObject(request.body);
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const type = body?.type;
    if (!name || (type !== "standard" && type !== "subtask")) return fail(reply, 400, "A name and a type of standard or subtask are required.");
    if (app.jira.store.state.issueTypes.some((value) => value.name.toLowerCase() === name.toLowerCase())) return fail(reply, 409, "An issue type with this name already exists.");
    const state = metadataState(app.jira.store);
    const nextId = String(state.issueTypeCounter++);
    app.jira.store.state.issueTypes.push({ id: nextId, name, description: typeof body?.description === "string" ? body.description : "", subtask: type === "subtask" });
    app.jira.store.save();
    return reply.code(201).send();
  });

  app.get("/rest/api/2/issuetype/page", async (request, reply) => {
    const query = request.query as Query;
    const requestedProjects = strings(query.projectIds);
    if (requestedProjects.some((id) => !app.jira.store.state.projects.some((project) => project.id === id))) return fail(reply, 400, "projectIds must identify visible projects.", "projectIds");
    const search = typeof query.query === "string" ? query.query.toLowerCase() : "";
    const values = app.jira.store.state.issueTypes.filter((value) => value.name.toLowerCase().includes(search)).map((value) => issueTypeJson(app.jira.baseUrl, value as unknown as Record<string, unknown>));
    const result = page(values, query);
    if (!result) return fail(reply, 400, "startAt and maxResults must be non-negative integers.");
    return result;
  });

  app.get("/rest/api/2/issuetype/:id/alternatives", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!app.jira.store.state.issueTypes.some((value) => value.id === id)) return fail(reply, 404, "The issue type does not exist.");
    return app.jira.store.state.issueTypes.filter((value) => value.id !== id).map((value) => issueTypeJson(app.jira.baseUrl, value as unknown as Record<string, unknown>));
  });

  app.post("/rest/api/2/issuetype/:id/avatar/temporary", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!app.jira.store.state.issueTypes.some((value) => value.id === id)) return fail(reply, 404, "The issue type does not exist.");
    const body = request.body;
    const size = Buffer.isBuffer(body) ? body.length : 0;
    const multipart = Buffer.isBuffer(body) ? body.toString("utf8") : "";
    if (!size || !/Content-Disposition:[^\r\n]*name="file"/i.test(multipart)) return fail(reply, 400, "A multipart avatar file is required.");
    const state = metadataState(app.jira.store);
    state.temporaryAvatars[id] = { size, contentType: request.headers["content-type"] ?? "multipart/form-data" };
    app.jira.store.save();
    const cropping = { cropperOffsetX: 0, cropperOffsetY: 0, cropperWidth: 128, needsCropping: true, url: `${app.jira.baseUrl}/secure/temporaryavatar?issueTypeId=${id}` };
    return reply.code(201).type("text/html").send(JSON.stringify(cropping));
  });

  app.post("/rest/api/2/issuetype/:id/avatar", async (request, reply) => {
    const { id } = request.params as { id: string };
    const issueType = app.jira.store.state.issueTypes.find((value) => value.id === id);
    if (!issueType) return fail(reply, 404, "The issue type does not exist.");
    const body = bodyObject(request.body);
    const width = body?.cropperWidth;
    if (!body || !Number.isInteger(width) || Number(width) <= 0 || !Number.isInteger(body.cropperOffsetX) || Number(body.cropperOffsetX) < 0 || !Number.isInteger(body.cropperOffsetY) || Number(body.cropperOffsetY) < 0) return fail(reply, 400, "Cropping coordinates must be non-negative integers and width must be positive.");
    const state = metadataState(app.jira.store);
    if (!state.temporaryAvatars[id]) return fail(reply, 400, "No temporary avatar has been uploaded for this issue type.");
    const avatar = { id: String(state.avatarCounter++), issueTypeId: id, owner: "developer", selected: true };
    state.avatars.forEach((value) => { if (value.issueTypeId === id) value.selected = false; });
    state.avatars.push(avatar);
    delete state.temporaryAvatars[id];
    Object.assign(issueType, { avatarId: Number(avatar.id), iconUrl: `${app.jira.baseUrl}/secure/issuetypeavatar?avatarId=${avatar.id}` });
    app.jira.store.save();
    return reply.code(201).send({ id: avatar.id, owner: avatar.owner, selected: avatar.selected });
  });

  app.get("/rest/api/2/issuetype/:issueTypeId/properties", async (request, reply) => {
    const { issueTypeId } = request.params as { issueTypeId: string };
    if (!/^\d+$/.test(issueTypeId)) return fail(reply, 400, "The issue type id is invalid.");
    if (!app.jira.store.state.issueTypes.some((value) => value.id === issueTypeId)) return fail(reply, 404, "The issue type does not exist.");
    const properties = metadataState(app.jira.store).issueTypeProperties[issueTypeId] ?? {};
    return { keys: Object.keys(properties).sort().map((key) => ({ key, self: `${app.jira.baseUrl}/rest/api/2/issuetype/${issueTypeId}/properties/${encodeURIComponent(key)}` })) };
  });

  app.get("/rest/api/2/issuetype/:issueTypeId/properties/:propertyKey", async (request, reply) => {
    const { issueTypeId, propertyKey } = request.params as { issueTypeId: string; propertyKey: string };
    if (!/^\d+$/.test(issueTypeId)) return fail(reply, 400, "The issue type id is invalid.");
    if (!app.jira.store.state.issueTypes.some((value) => value.id === issueTypeId)) return fail(reply, 404, "The issue type does not exist.");
    const properties = metadataState(app.jira.store).issueTypeProperties[issueTypeId] ?? {};
    if (!(propertyKey in properties)) return fail(reply, 404, "The issue type property does not exist.");
    const value = properties[propertyKey];
    return { key: propertyKey, value: typeof value === "string" ? value : JSON.stringify(value) };
  });

  app.put("/rest/api/2/issuetype/:issueTypeId/properties/:propertyKey", async (request, reply) => {
    const { issueTypeId, propertyKey } = request.params as { issueTypeId: string; propertyKey: string };
    if (!/^\d+$/.test(issueTypeId)) return fail(reply, 400, "The issue type id is invalid.");
    if (!app.jira.store.state.issueTypes.some((value) => value.id === issueTypeId)) return fail(reply, 404, "The issue type does not exist.");
    if (!propertyKey || Buffer.byteLength(propertyKey) > 255) return fail(reply, 400, "The property key must not exceed 255 bytes.");
    const body = bodyObject(request.body);
    if (!body || !("value" in body) || body.value === "" || body.value === undefined || Buffer.byteLength(JSON.stringify(body.value)) > 32768) return fail(reply, 400, "The property value must be non-empty JSON no larger than 32768 bytes.");
    const state = metadataState(app.jira.store);
    const properties = (state.issueTypeProperties[issueTypeId] ??= {});
    const existed = propertyKey in properties;
    properties[propertyKey] = "value" in body ? body.value : body;
    app.jira.store.save();
    return reply.code(existed ? 200 : 201).send();
  });

  app.delete("/rest/api/2/issuetype/:issueTypeId/properties/:propertyKey", async (request, reply) => {
    const { issueTypeId, propertyKey } = request.params as { issueTypeId: string; propertyKey: string };
    if (!/^\d+$/.test(issueTypeId)) return fail(reply, 400, "The issue type id is invalid.");
    if (!app.jira.store.state.issueTypes.some((value) => value.id === issueTypeId)) return fail(reply, 404, "The issue type does not exist.");
    const properties = metadataState(app.jira.store).issueTypeProperties[issueTypeId] ?? {};
    if (!(propertyKey in properties)) return fail(reply, 404, "The issue type property does not exist.");
    delete properties[propertyKey];
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/issuetype/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const issueType = app.jira.store.state.issueTypes.find((value) => value.id === id);
    if (!issueType) return fail(reply, 404, "The issue type does not exist.");
    return issueTypeJson(app.jira.baseUrl, issueType as unknown as Record<string, unknown>);
  });

  app.put("/rest/api/2/issuetype/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const issueType = app.jira.store.state.issueTypes.find((value) => value.id === id);
    if (!issueType) return fail(reply, 404, "The issue type does not exist.");
    const body = bodyObject(request.body);
    if (!body) return fail(reply, 400, "The issue type update must be a JSON object.");
    if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) return fail(reply, 400, "The issue type name is invalid.", "name");
    if (body.avatarId !== undefined && (!Number.isInteger(body.avatarId) || !metadataState(app.jira.store).avatars.some((avatar) => Number(avatar.id) === body.avatarId))) return fail(reply, 400, "The avatar does not exist.", "avatarId");
    const name = typeof body.name === "string" ? body.name.trim() : issueType.name;
    if (app.jira.store.state.issueTypes.some((value) => value.id !== id && value.name.toLowerCase() === name.toLowerCase())) return fail(reply, 409, "An issue type with this name already exists.");
    Object.assign(issueType, { name, ...(typeof body.description === "string" ? { description: body.description } : {}), ...(Number.isInteger(body.avatarId) ? { avatarId: body.avatarId } : {}) });
    for (const issue of app.jira.store.state.issues) if (issue.fields.issuetype.id === id) issue.fields.issuetype = issueType;
    app.jira.store.save();
    return reply.code(200).send();
  });

  app.delete("/rest/api/2/issuetype/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as Query;
    const index = app.jira.store.state.issueTypes.findIndex((value) => value.id === id);
    if (index < 0) return fail(reply, 404, "The issue type does not exist.");
    const affected = app.jira.store.state.issues.filter((issue) => issue.fields.issuetype.id === id);
    const alternativeId = typeof query.alternativeIssueTypeId === "string" ? query.alternativeIssueTypeId : undefined;
    const alternative = alternativeId ? app.jira.store.state.issueTypes.find((value) => value.id === alternativeId && value.id !== id) : undefined;
    if (alternativeId && !alternative) return fail(reply, 400, "alternativeIssueTypeId must identify another existing issue type.");
    const removed = app.jira.store.state.issueTypes[index];
    if (alternative && Boolean(removed.subtask) !== Boolean(alternative.subtask)) return fail(reply, 400, "The alternative issue type must have the same subtask classification.");
    if (affected.length && !alternative) return fail(reply, 400, "An existing alternativeIssueTypeId is required to migrate associated issues.");
    if (alternative) for (const issue of affected) issue.fields.issuetype = alternative;
    app.jira.store.state.issueTypes.splice(index, 1);
    const state = metadataState(app.jira.store);
    delete state.issueTypeProperties[id];
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/priority", async () => app.jira.store.state.priorities.map((value) => priorityJson(app.jira.baseUrl, value as unknown as Record<string, unknown>)));

  app.get("/rest/api/2/priority/page", async (request, reply) => {
    const query = request.query as Query;
    const requestedProjects = strings(query.projectIds);
    if (requestedProjects.some((id) => !app.jira.store.state.projects.some((project) => project.id === id))) return fail(reply, 400, "projectIds must identify visible projects.", "projectIds");
    const search = typeof query.query === "string" ? query.query.toLowerCase() : "";
    const values = app.jira.store.state.priorities.filter((value) => value.name.toLowerCase().includes(search)).map((value) => priorityJson(app.jira.baseUrl, value as unknown as Record<string, unknown>));
    const result = page(values, query);
    if (!result) return fail(reply, 400, "startAt and maxResults must be non-negative integers.");
    return result;
  });

  app.get("/rest/api/2/priority/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const priority = app.jira.store.state.priorities.find((value) => value.id === id);
    if (!priority) return fail(reply, 404, "The priority does not exist.");
    return priorityJson(app.jira.baseUrl, priority as unknown as Record<string, unknown>);
  });

  app.get("/rest/api/2/resolution", async () => metadataState(app.jira.store).resolutions.map((value) => resolutionJson(app.jira.baseUrl, value)));

  app.get("/rest/api/2/resolution/page", async (request, reply) => {
    const query = request.query as Query;
    const search = typeof query.query === "string" ? query.query.toLowerCase() : "";
    const values = metadataState(app.jira.store).resolutions.filter((value) => value.name.toLowerCase().includes(search)).map((value) => resolutionJson(app.jira.baseUrl, value));
    const result = page(values, query);
    if (!result) return fail(reply, 400, "startAt and maxResults must be non-negative integers.");
    return result;
  });

  app.get("/rest/api/2/resolution/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const resolution = metadataState(app.jira.store).resolutions.find((value) => value.id === id);
    if (!resolution) return fail(reply, 404, "The resolution does not exist.");
    return resolutionJson(app.jira.baseUrl, resolution);
  });

  app.get("/rest/api/2/status", async () => app.jira.store.state.statuses.map((value) => statusJson(app.jira.baseUrl, value as unknown as Record<string, unknown>)));

  app.get("/rest/api/2/status/page", async (request, reply) => {
    const query = request.query as Query;
    const projects = strings(query.projectIds);
    if (projects.some((id) => !app.jira.store.state.projects.some((project) => project.id === id))) return fail(reply, 400, "projectIds must identify visible projects.", "projectIds");
    const types = strings(query.issueTypeIds);
    if (types.some((id) => !app.jira.store.state.issueTypes.some((type) => type.id === id))) return fail(reply, 400, "issueTypeIds must identify existing issue types.", "issueTypeIds");
    const search = typeof query.query === "string" ? query.query.toLowerCase() : "";
    const values = app.jira.store.state.statuses.filter((value) => value.name.toLowerCase().includes(search)).map((value) => statusJson(app.jira.baseUrl, value as unknown as Record<string, unknown>));
    const result = page(values, query);
    if (!result) return fail(reply, 400, "startAt and maxResults must be non-negative integers.");
    return result;
  });

  app.get("/rest/api/2/status/:idOrName", async (request, reply) => {
    const { idOrName } = request.params as { idOrName: string };
    const decoded = decodeURIComponent(idOrName).toLowerCase();
    const status = app.jira.store.state.statuses.find((value) => value.id === idOrName || value.name.toLowerCase() === decoded);
    if (!status) return fail(reply, 404, "The status does not exist.");
    return statusJson(app.jira.baseUrl, status as unknown as Record<string, unknown>);
  });

  app.get("/rest/api/2/statuscategory", async () => {
    const categories = new Map<number, Record<string, unknown>>();
    for (const status of app.jira.store.state.statuses) categories.set(status.statusCategory.id, status.statusCategory as unknown as Record<string, unknown>);
    return [...categories.values()].map((value) => statusCategoryJson(app.jira.baseUrl, value));
  });

  app.get("/rest/api/2/statuscategory/:idOrKey", async (request, reply) => {
    const { idOrKey } = request.params as { idOrKey: string };
    const decoded = decodeURIComponent(idOrKey).toLowerCase();
    const category = app.jira.store.state.statuses.map((value) => value.statusCategory).find((value) => String(value.id) === idOrKey || value.key.toLowerCase() === decoded);
    if (!category) return fail(reply, 404, "The status category does not exist.");
    return statusCategoryJson(app.jira.baseUrl, category as unknown as Record<string, unknown>);
  });
};

export default metadataRoutes;
