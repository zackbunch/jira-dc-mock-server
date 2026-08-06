import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { JiraProject, JiraUser } from "../types.js";
import {
  getProjectAssetsState,
  type ComponentAssigneeType,
  type ProjectCategory,
  type ProjectComponent,
  type ProjectVersion,
  type RemoteVersionLink,
  uniqueIssueIds,
} from "../project-assets-state.js";
import { jiraError } from "../shared/errors.js";
import { parseInteger } from "../shared/parameters.js";
import { serializeUser } from "../shared/serialization.js";

type JsonRecord = Record<string, unknown>;

const assigneeTypes = new Set<ComponentAssigneeType>([
  "PROJECT_DEFAULT",
  "COMPONENT_LEAD",
  "PROJECT_LEAD",
  "UNASSIGNED",
]);

function bodyRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function projectByIdentity(projects: JiraProject[], identity: unknown): JiraProject | undefined {
  if (typeof identity === "number") identity = String(identity);
  if (typeof identity !== "string") return undefined;
  return projects.find(
    (project) =>
      project.id === identity || project.key.toLowerCase() === identity.toLowerCase(),
  );
}

function requestedProject(body: JsonRecord, projects: JiraProject[]): JiraProject | undefined {
  return projectByIdentity(projects, body.projectId ?? body.project);
}

function projectError(reply: FastifyReply) {
  return reply.code(404).send(jiraError(["No project could be found with the supplied key or id."]));
}

function missingError(reply: FastifyReply, resource: string) {
  return reply.code(404).send(jiraError([`The requested ${resource} does not exist.`]));
}

function invalidError(reply: FastifyReply, message: string, field?: string) {
  return reply
    .code(400)
    .send(jiraError(field ? [] : [message], field ? { [field]: message } : {}));
}

function serializeComponent(
  component: ProjectComponent,
  projects: JiraProject[],
  users: JiraUser[],
  baseUrl: string,
): JsonRecord {
  const project = projects.find((candidate) => candidate.id === component.projectId);
  const lead = users.find((candidate) => candidate.name === component.leadUserName);
  return {
    id: component.id,
    self: `${baseUrl}/rest/api/2/component/${component.id}`,
    name: component.name,
    description: component.description,
    project: project?.key ?? component.projectId,
    leadUserName: component.leadUserName,
    lead: lead ? serializeUser(lead, baseUrl) : undefined,
    assigneeType: component.assigneeType,
    archived: component.archived,
    deleted: component.deleted,
  };
}

function serializeCategory(category: ProjectCategory, baseUrl: string): JsonRecord {
  return {
    id: category.id,
    self: `${baseUrl}/rest/api/2/projectCategory/${category.id}`,
    name: category.name,
    description: category.description,
  };
}

function serializeVersion(
  version: ProjectVersion,
  projects: JiraProject[],
  baseUrl: string,
  expand?: string,
): JsonRecord {
  const project = projects.find((candidate) => candidate.id === version.projectId);
  const now = Date.now();
  const releaseTime = version.releaseDate ? Date.parse(version.releaseDate) : Number.NaN;
  return {
    id: version.id,
    self: `${baseUrl}/rest/api/2/version/${version.id}`,
    name: version.name,
    description: version.description,
    projectId: Number(version.projectId),
    project: project?.key ?? version.projectId,
    archived: version.archived,
    released: version.released,
    releaseDate: version.releaseDate,
    startDate: version.startDate,
    releaseDateSet: version.releaseDate !== undefined,
    startDateSet: version.startDate !== undefined,
    overdue: !version.released && Number.isFinite(releaseTime) && releaseTime < now,
    userReleaseDate: version.releaseDate,
    userStartDate: version.startDate,
    expand,
    moveUnfixedIssuesTo: `${baseUrl}/rest/api/2/version/${version.id}/move`,
  };
}

function parseProjectIds(value: unknown): Set<string> | undefined {
  if (value === undefined) return undefined;
  const entries = (Array.isArray(value) ? value : [value]).flatMap((entry) =>
    String(entry).split(","),
  );
  return new Set(entries.map((entry) => entry.trim()).filter(Boolean));
}

function normalizeDate(value: unknown): string | undefined | null {
  if (value === undefined || value === null || value === "") return value === undefined ? undefined : null;
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function serializeRemoteLink(link: RemoteVersionLink, baseUrl: string): JsonRecord {
  return {
    self:
      link.self ??
      `${baseUrl}/rest/api/2/version/${encodeURIComponent(link.versionId)}/remotelink/${encodeURIComponent(link.globalId)}`,
    name: link.name,
    link: link.link,
  };
}

function issueIdsExist(ids: string[], existingIds: Set<string>): boolean {
  return ids.every((id) => existingIds.has(id));
}

function validRemoteLinkValue(value: unknown): value is string | undefined {
  if (value === undefined) return true;
  if (typeof value !== "string") return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

const projectAssetRoutes: FastifyPluginAsync = async (app) => {
  app.post("/rest/api/2/component", async (request, reply) => {
    const body = bodyRecord(request.body);
    if (!body) return invalidError(reply, "A component body is required.");
    const name = nonEmptyString(body.name);
    if (!name) return invalidError(reply, "You must specify a component name.", "name");
    const project = requestedProject(body, app.jira.store.state.projects);
    if (!project) return projectError(reply);
    const state = getProjectAssetsState(app.jira.store);
    if (
      state.components.some(
        (component) =>
          !component.deleted &&
          component.projectId === project.id &&
          component.name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      return invalidError(reply, "A component with this name already exists.", "name");
    }
    const assigneeType = optionalString(body.assigneeType) ?? "PROJECT_DEFAULT";
    if (!assigneeTypes.has(assigneeType as ComponentAssigneeType)) {
      return invalidError(reply, "The assignee type is not valid.", "assigneeType");
    }
    const leadUserName = optionalString(body.leadUserName);
    if (
      leadUserName &&
      !app.jira.store.state.users.some(
        (user) => user.name.toLowerCase() === leadUserName.toLowerCase(),
      )
    ) {
      return invalidError(reply, "The component lead does not exist.", "leadUserName");
    }
    const component: ProjectComponent = {
      id: String(state.componentCounter++),
      name,
      description: optionalString(body.description),
      projectId: project.id,
      leadUserName,
      assigneeType: assigneeType as ComponentAssigneeType,
      archived: body.archived === true,
      deleted: false,
      issueIds: [],
    };
    state.components.push(component);
    app.jira.store.save();
    return reply
      .code(201)
      .send(
        serializeComponent(
          component,
          app.jira.store.state.projects,
          app.jira.store.state.users,
          app.jira.baseUrl,
        ),
      );
  });

  app.get("/rest/api/2/component/page", async (request) => {
    const query = request.query as {
      maxResults?: string;
      query?: string;
      projectIds?: string | string[];
      startAt?: string;
    };
    const startAt = parseInteger(query.startAt, 0);
    const maxResults = parseInteger(query.maxResults, 100, 1000);
    const search = (query.query ?? "").trim().toLowerCase();
    const projectIds = parseProjectIds(query.projectIds);
    const state = getProjectAssetsState(app.jira.store);
    const matches = state.components
      .filter(
        (component) =>
          !component.deleted &&
          !component.archived &&
          (!search || component.name.toLowerCase().includes(search)) &&
          (!projectIds || projectIds.has(component.projectId)),
      )
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    const values = matches.slice(startAt, startAt + maxResults).map((component) =>
      serializeComponent(
        component,
        app.jira.store.state.projects,
        app.jira.store.state.users,
        app.jira.baseUrl,
      ),
    );
    const base = `${app.jira.baseUrl}/rest/api/2/component/page`;
    const nextStart = startAt + values.length;
    return {
      self: `${base}?startAt=${startAt}&maxResults=${maxResults}`,
      nextPage:
        nextStart < matches.length
          ? `${base}?startAt=${nextStart}&maxResults=${maxResults}`
          : undefined,
      startAt,
      maxResults,
      total: matches.length,
      isLast: nextStart >= matches.length,
      values,
    };
  });

  app.get("/rest/api/2/component/:id/relatedIssueCounts", async (request, reply) => {
    const { id } = request.params as { id: string };
    const component = getProjectAssetsState(app.jira.store).components.find(
      (candidate) => candidate.id === id && !candidate.deleted,
    );
    if (!component) return missingError(reply, "component");
    const issueIds = new Set(app.jira.store.state.issues.map((issue) => issue.id));
    return {
      issueCount: uniqueIssueIds(component.issueIds).filter((issueId) => issueIds.has(issueId))
        .length,
      self: `${app.jira.baseUrl}/rest/api/2/component/${component.id}`,
    };
  });

  app.get("/rest/api/2/component/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const component = getProjectAssetsState(app.jira.store).components.find(
      (candidate) => candidate.id === id && !candidate.deleted,
    );
    if (!component) return missingError(reply, "component");
    return serializeComponent(
      component,
      app.jira.store.state.projects,
      app.jira.store.state.users,
      app.jira.baseUrl,
    );
  });

  app.put("/rest/api/2/component/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const state = getProjectAssetsState(app.jira.store);
    const component = state.components.find(
      (candidate) => candidate.id === id && !candidate.deleted,
    );
    if (!component) return missingError(reply, "component");
    const body = bodyRecord(request.body);
    if (!body) return invalidError(reply, "A component body is required.");
    if (body.project !== undefined || body.projectId !== undefined) {
      const project = requestedProject(body, app.jira.store.state.projects);
      if (!project) return projectError(reply);
      if (
        component.issueIds.some((issueId) => {
          const issue = app.jira.store.state.issues.find((candidate) => candidate.id === issueId);
          return !issue || issue.fields.project.id !== project.id;
        })
      ) {
        return invalidError(
          reply,
          "The component cannot be moved because one of its issues is not in the destination project.",
        );
      }
      component.projectId = project.id;
    }
    if (body.name !== undefined) {
      const name = nonEmptyString(body.name);
      if (!name) return invalidError(reply, "You must specify a component name.", "name");
      if (
        state.components.some(
          (candidate) =>
            candidate !== component &&
            !candidate.deleted &&
            candidate.projectId === component.projectId &&
            candidate.name.toLowerCase() === name.toLowerCase(),
        )
      ) {
        return invalidError(reply, "A component with this name already exists.", "name");
      }
      component.name = name;
    }
    if (body.description !== undefined) component.description = optionalString(body.description);
    if (body.archived !== undefined) component.archived = body.archived === true;
    if (body.assigneeType !== undefined) {
      if (!assigneeTypes.has(body.assigneeType as ComponentAssigneeType)) {
        return invalidError(reply, "The assignee type is not valid.", "assigneeType");
      }
      component.assigneeType = body.assigneeType as ComponentAssigneeType;
    }
    if (body.leadUserName !== undefined) {
      const lead = nonEmptyString(body.leadUserName);
      if (
        !lead ||
        !app.jira.store.state.users.some(
          (user) => user.name.toLowerCase() === lead.toLowerCase(),
        )
      ) {
        return invalidError(reply, "The component lead does not exist.", "leadUserName");
      }
      component.leadUserName = lead;
    }
    app.jira.store.save();
    return serializeComponent(
      component,
      app.jira.store.state.projects,
      app.jira.store.state.users,
      app.jira.baseUrl,
    );
  });

  app.delete("/rest/api/2/component/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { moveIssuesTo?: string };
    const state = getProjectAssetsState(app.jira.store);
    const component = state.components.find(
      (candidate) => candidate.id === id && !candidate.deleted,
    );
    if (!component) return missingError(reply, "component");
    const existingIssueIds = new Set(app.jira.store.state.issues.map((issue) => issue.id));
    if (!issueIdsExist(component.issueIds, existingIssueIds)) {
      return invalidError(reply, "The component refers to an issue that does not exist.");
    }
    if (query.moveIssuesTo) {
      const target = state.components.find(
        (candidate) => candidate.id === query.moveIssuesTo && !candidate.deleted,
      );
      if (!target) return missingError(reply, "replacement component");
      if (target.id === component.id || target.projectId !== component.projectId) {
        return invalidError(reply, "The replacement component must be a different component in the same project.");
      }
      target.issueIds = uniqueIssueIds([...target.issueIds, ...component.issueIds]);
    }
    component.issueIds = [];
    component.deleted = true;
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/projectCategory", async () =>
    getProjectAssetsState(app.jira.store).categories
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
      .map((category) => serializeCategory(category, app.jira.baseUrl)),
  );

  app.post("/rest/api/2/projectCategory", async (request, reply) => {
    const body = bodyRecord(request.body);
    if (!body) return invalidError(reply, "A project category body is required.");
    const name = nonEmptyString(body.name);
    if (!name) return invalidError(reply, "You must specify a project category name.", "name");
    const state = getProjectAssetsState(app.jira.store);
    if (state.categories.some((category) => category.name.toLowerCase() === name.toLowerCase())) {
      return reply.code(409).send(jiraError(["A project category with this name already exists."]));
    }
    const category: ProjectCategory = {
      id: String(state.categoryCounter++),
      name,
      description: optionalString(body.description),
    };
    state.categories.push(category);
    app.jira.store.save();
    return reply.code(201).send(serializeCategory(category, app.jira.baseUrl));
  });

  app.get("/rest/api/2/projectCategory/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const category = getProjectAssetsState(app.jira.store).categories.find(
      (candidate) => candidate.id === id,
    );
    if (!category) return missingError(reply, "project category");
    return serializeCategory(category, app.jira.baseUrl);
  });

  app.put("/rest/api/2/projectCategory/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const state = getProjectAssetsState(app.jira.store);
    const category = state.categories.find((candidate) => candidate.id === id);
    if (!category) return missingError(reply, "project category");
    const body = bodyRecord(request.body);
    if (!body) return invalidError(reply, "A project category body is required.");
    if (body.name !== undefined) {
      const name = nonEmptyString(body.name);
      if (!name) return invalidError(reply, "You must specify a project category name.", "name");
      if (
        state.categories.some(
          (candidate) =>
            candidate !== category && candidate.name.toLowerCase() === name.toLowerCase(),
        )
      ) {
        return reply.code(409).send(jiraError(["A project category with this name already exists."]));
      }
      category.name = name;
    }
    if (body.description !== undefined) category.description = optionalString(body.description);
    app.jira.store.save();
    return serializeCategory(category, app.jira.baseUrl);
  });

  app.delete("/rest/api/2/projectCategory/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const state = getProjectAssetsState(app.jira.store);
    const index = state.categories.findIndex((candidate) => candidate.id === id);
    if (index < 0) return missingError(reply, "project category");
    state.categories.splice(index, 1);
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/version/remotelink", async (request) => {
    const query = request.query as { globalId?: string };
    const links = getProjectAssetsState(app.jira.store).remoteLinks
      .filter((link) => !query.globalId || link.globalId === query.globalId)
      .sort(
        (left, right) =>
          left.versionId.localeCompare(right.versionId) || left.globalId.localeCompare(right.globalId),
      )
      .map((link) => serializeRemoteLink(link, app.jira.baseUrl));
    return { links };
  });

  app.get("/rest/api/2/version", async (request) => {
    const query = request.query as {
      maxResults?: number | string;
      query?: string;
      projectIds?: string | string[];
      startAt?: number | string;
    };
    const startAt = parseInteger(query.startAt, 0);
    const maxResults = parseInteger(query.maxResults, 100, 1000);
    const search = (query.query ?? "").trim().toLowerCase();
    const projectIds = parseProjectIds(query.projectIds);
    const versions = getProjectAssetsState(app.jira.store).versions.filter(
      (version) =>
        (!search || version.name.toLowerCase().includes(search)) &&
        (!projectIds || projectIds.has(version.projectId)),
    );
    const values = versions.slice(startAt, startAt + maxResults).map((version) =>
      serializeVersion(version, app.jira.store.state.projects, app.jira.baseUrl),
    );
    const nextStart = startAt + values.length;
    const base = `${app.jira.baseUrl}/rest/api/2/version`;
    // The generated 10.3 contract references VersionBean here, but Jira returns a
    // page. VersionBean has no required/additionalProperties constraint, so this
    // faithful page also validates against the pinned generated response schema.
    return {
      self: `${base}?startAt=${startAt}&maxResults=${maxResults}`,
      nextPage:
        nextStart < versions.length
          ? `${base}?startAt=${nextStart}&maxResults=${maxResults}`
          : undefined,
      startAt,
      maxResults,
      total: versions.length,
      isLast: nextStart >= versions.length,
      values,
    };
  });

  app.post("/rest/api/2/version", async (request, reply) => {
    const body = bodyRecord(request.body);
    if (!body) return invalidError(reply, "A version body is required.");
    const name = nonEmptyString(body.name);
    if (!name) return invalidError(reply, "You must specify a version name.", "name");
    const project = requestedProject(body, app.jira.store.state.projects);
    if (!project) return projectError(reply);
    const state = getProjectAssetsState(app.jira.store);
    if (
      state.versions.some(
        (version) =>
          version.projectId === project.id && version.name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      return invalidError(reply, "A version with this name already exists.", "name");
    }
    const releaseDate = normalizeDate(body.releaseDate);
    const startDate = normalizeDate(body.startDate);
    if (releaseDate === null) return invalidError(reply, "The release date is not valid.", "releaseDate");
    if (startDate === null) return invalidError(reply, "The start date is not valid.", "startDate");
    const version: ProjectVersion = {
      id: String(state.versionCounter++),
      name,
      description: optionalString(body.description),
      projectId: project.id,
      archived: body.archived === true,
      released: body.released === true,
      releaseDate,
      startDate,
      fixedIssueIds: [],
      affectedIssueIds: [],
    };
    state.versions.push(version);
    app.jira.store.save();
    return reply
      .code(201)
      .send(serializeVersion(version, app.jira.store.state.projects, app.jira.baseUrl));
  });

  app.get("/rest/api/2/version/:id/relatedIssueCounts", async (request, reply) => {
    const { id } = request.params as { id: string };
    const version = getProjectAssetsState(app.jira.store).versions.find(
      (candidate) => candidate.id === id,
    );
    if (!version) return missingError(reply, "version");
    const issueIds = new Set(app.jira.store.state.issues.map((issue) => issue.id));
    return {
      issuesFixedCount: uniqueIssueIds(version.fixedIssueIds).filter((issueId) => issueIds.has(issueId))
        .length,
      issuesAffectedCount: uniqueIssueIds(version.affectedIssueIds).filter((issueId) =>
        issueIds.has(issueId),
      ).length,
      issueCountWithCustomFieldsShowingVersion: 0,
      customFieldNames: [],
      self: `${app.jira.baseUrl}/rest/api/2/version/${version.id}`,
    };
  });

  app.get("/rest/api/2/version/:id/unresolvedIssueCount", async (request, reply) => {
    const { id } = request.params as { id: string };
    const version = getProjectAssetsState(app.jira.store).versions.find(
      (candidate) => candidate.id === id,
    );
    if (!version) return missingError(reply, "version");
    const fixedIds = new Set(version.fixedIssueIds);
    return {
      issuesUnresolvedCount: app.jira.store.state.issues.filter(
        (issue) => fixedIds.has(issue.id) && issue.fields.status.statusCategory.key !== "done",
      ).length,
      self: `${app.jira.baseUrl}/rest/api/2/version/${version.id}`,
    };
  });

  app.post("/rest/api/2/version/:id/move", async (request, reply) => {
    const { id } = request.params as { id: string };
    const state = getProjectAssetsState(app.jira.store);
    const version = state.versions.find((candidate) => candidate.id === id);
    if (!version) return missingError(reply, "version");
    const body = bodyRecord(request.body);
    if (!body) return invalidError(reply, "A version move body is required.");
    const after = optionalString(body.after);
    const position = optionalString(body.position);
    if ((after ? 1 : 0) + (position ? 1 : 0) !== 1) {
      return invalidError(reply, "Specify exactly one of after or position.");
    }
    const currentIndex = state.versions.indexOf(version);
    const projectVersions = state.versions.filter(
      (candidate) => candidate.projectId === version.projectId,
    );
    let targetIndex: number;
    if (after) {
      const targetId = after.match(/\/version\/([^/?#]+)/)?.[1];
      const target = state.versions.find((candidate) => candidate.id === targetId);
      if (!target || target.projectId !== version.projectId || target === version) {
        return invalidError(reply, "The after link must identify another version in the same project.", "after");
      }
      state.versions.splice(currentIndex, 1);
      targetIndex = state.versions.indexOf(target) + 1;
    } else {
      if (!(["First", "Last", "Earlier", "Later"] as string[]).includes(position!)) {
        return invalidError(reply, "The version position is not valid.", "position");
      }
      const projectIndex = projectVersions.indexOf(version);
      let reference: ProjectVersion | undefined;
      if (position === "First") reference = projectVersions[0];
      if (position === "Last") reference = projectVersions.at(-1);
      if (position === "Earlier") reference = projectVersions[Math.max(0, projectIndex - 1)];
      if (position === "Later") reference = projectVersions[Math.min(projectVersions.length - 1, projectIndex + 1)];
      if (!reference || reference === version) {
        return serializeVersion(version, app.jira.store.state.projects, app.jira.baseUrl);
      }
      state.versions.splice(currentIndex, 1);
      const referenceIndex = state.versions.indexOf(reference);
      targetIndex = position === "Last" || position === "Later" ? referenceIndex + 1 : referenceIndex;
    }
    state.versions.splice(targetIndex, 0, version);
    app.jira.store.save();
    return serializeVersion(version, app.jira.store.state.projects, app.jira.baseUrl);
  });

  app.put("/rest/api/2/version/:id/mergeto/:moveIssuesTo", async (request, reply) => {
    const { id, moveIssuesTo } = request.params as { id: string; moveIssuesTo: string };
    const state = getProjectAssetsState(app.jira.store);
    const source = state.versions.find((candidate) => candidate.id === id);
    const target = state.versions.find((candidate) => candidate.id === moveIssuesTo);
    if (!source || !target) return missingError(reply, "version");
    if (source === target || source.projectId !== target.projectId) {
      return invalidError(reply, "Versions can only be merged into a different version in the same project.");
    }
    const existingIssueIds = new Set(app.jira.store.state.issues.map((issue) => issue.id));
    if (
      !issueIdsExist(source.fixedIssueIds, existingIssueIds) ||
      !issueIdsExist(source.affectedIssueIds, existingIssueIds)
    ) {
      return invalidError(reply, "The source version refers to an issue that does not exist.");
    }
    target.fixedIssueIds = uniqueIssueIds([...target.fixedIssueIds, ...source.fixedIssueIds]);
    target.affectedIssueIds = uniqueIssueIds([...target.affectedIssueIds, ...source.affectedIssueIds]);
    state.versions.splice(state.versions.indexOf(source), 1);
    state.remoteLinks = state.remoteLinks.filter((link) => link.versionId !== source.id);
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.post("/rest/api/2/version/:id/removeAndSwap", async (request, reply) => {
    const { id } = request.params as { id: string };
    const state = getProjectAssetsState(app.jira.store);
    const source = state.versions.find((candidate) => candidate.id === id);
    if (!source) return missingError(reply, "version");
    const body = bodyRecord(request.body);
    if (!body) return invalidError(reply, "A replacement body is required.");
    if (
      body.customFieldReplacementList !== undefined &&
      !Array.isArray(body.customFieldReplacementList)
    ) {
      return invalidError(reply, "The custom field replacement list is not valid.");
    }
    const fixedTargetId = body.moveFixIssuesTo === undefined ? undefined : String(body.moveFixIssuesTo);
    const affectedTargetId =
      body.moveAffectedIssuesTo === undefined ? undefined : String(body.moveAffectedIssuesTo);
    const fixedTarget = fixedTargetId
      ? state.versions.find((candidate) => candidate.id === fixedTargetId)
      : undefined;
    const affectedTarget = affectedTargetId
      ? state.versions.find((candidate) => candidate.id === affectedTargetId)
      : undefined;
    for (const target of [fixedTarget, affectedTarget]) {
      if (target && (target === source || target.projectId !== source.projectId)) {
        return invalidError(reply, "Replacement versions must be different versions in the same project.");
      }
    }
    if ((fixedTargetId && !fixedTarget) || (affectedTargetId && !affectedTarget)) {
      return invalidError(reply, "A replacement version does not exist.");
    }
    for (const replacement of (body.customFieldReplacementList ?? []) as unknown[]) {
      const value = bodyRecord(replacement);
      if (
        !value ||
        !Number.isInteger(value.customFieldId) ||
        !Number.isInteger(value.moveTo)
      ) {
        return invalidError(reply, "A custom field replacement is not valid.");
      }
      const replacementVersion = state.versions.find(
        (candidate) => candidate.id === String(value.moveTo),
      );
      if (
        !replacementVersion ||
        replacementVersion === source ||
        replacementVersion.projectId !== source.projectId
      ) {
        return invalidError(reply, "A custom field replacement version is not valid.");
      }
    }
    const existingIssueIds = new Set(app.jira.store.state.issues.map((issue) => issue.id));
    if (
      !issueIdsExist(source.fixedIssueIds, existingIssueIds) ||
      !issueIdsExist(source.affectedIssueIds, existingIssueIds)
    ) {
      return invalidError(reply, "The version refers to an issue that does not exist.");
    }
    if (fixedTarget) {
      fixedTarget.fixedIssueIds = uniqueIssueIds([...fixedTarget.fixedIssueIds, ...source.fixedIssueIds]);
    }
    if (affectedTarget) {
      affectedTarget.affectedIssueIds = uniqueIssueIds([
        ...affectedTarget.affectedIssueIds,
        ...source.affectedIssueIds,
      ]);
    }
    state.versions.splice(state.versions.indexOf(source), 1);
    state.remoteLinks = state.remoteLinks.filter((link) => link.versionId !== source.id);
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/version/:versionId/remotelink", async (request, reply) => {
    const { versionId } = request.params as { versionId: string };
    const state = getProjectAssetsState(app.jira.store);
    if (!state.versions.some((version) => version.id === versionId)) {
      return missingError(reply, "version");
    }
    return {
      links: state.remoteLinks
        .filter((link) => link.versionId === versionId)
        .sort((left, right) => left.globalId.localeCompare(right.globalId))
        .map((link) => serializeRemoteLink(link, app.jira.baseUrl)),
    };
  });

  app.post("/rest/api/2/version/:versionId/remotelink", async (request, reply) => {
    const { versionId } = request.params as { versionId: string };
    const state = getProjectAssetsState(app.jira.store);
    if (!state.versions.some((version) => version.id === versionId)) {
      return missingError(reply, "version");
    }
    const body = bodyRecord(request.body);
    if (!body) return invalidError(reply, "A remote link body is required.");
    const name = optionalString(body.name);
    const link = optionalString(body.link);
    if (!validRemoteLinkValue(body.link)) {
      return invalidError(reply, "The remote link data must be well-formed JSON.", "link");
    }
    if (!name && !link) return invalidError(reply, "The remote link payload is empty.");
    const globalId = nonEmptyString(body.globalId) ?? `generated-${state.remoteLinkCounter++}`;
    const existing = state.remoteLinks.find(
      (candidate) => candidate.versionId === versionId && candidate.globalId === globalId,
    );
    if (existing) {
      existing.name = name;
      existing.link = link;
      existing.self = optionalString(body.self);
    } else {
      state.remoteLinks.push({
        versionId,
        globalId,
        name,
        link,
        self: optionalString(body.self),
      });
    }
    app.jira.store.save();
    return reply.code(201).send();
  });

  app.delete("/rest/api/2/version/:versionId/remotelink", async (request, reply) => {
    const { versionId } = request.params as { versionId: string };
    const state = getProjectAssetsState(app.jira.store);
    if (!state.versions.some((version) => version.id === versionId)) {
      return missingError(reply, "version");
    }
    state.remoteLinks = state.remoteLinks.filter((link) => link.versionId !== versionId);
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get(
    "/rest/api/2/version/:versionId/remotelink/:globalId",
    async (request, reply) => {
      const { versionId, globalId } = request.params as {
        versionId: string;
        globalId: string;
      };
      const state = getProjectAssetsState(app.jira.store);
      if (!state.versions.some((version) => version.id === versionId)) {
        return missingError(reply, "version");
      }
      const link = state.remoteLinks.find(
        (candidate) => candidate.versionId === versionId && candidate.globalId === globalId,
      );
      if (!link) return missingError(reply, "remote version link");
      return serializeRemoteLink(link, app.jira.baseUrl);
    },
  );

  app.post(
    "/rest/api/2/version/:versionId/remotelink/:globalId",
    async (request, reply) => {
      const { versionId, globalId } = request.params as {
        versionId: string;
        globalId: string;
      };
      const state = getProjectAssetsState(app.jira.store);
      if (!state.versions.some((version) => version.id === versionId)) {
        return missingError(reply, "version");
      }
      const body = bodyRecord(request.body);
      if (!body) return invalidError(reply, "A remote link body is required.");
      const name = optionalString(body.name);
      const linkValue = optionalString(body.link);
      if (!validRemoteLinkValue(body.link)) {
        return invalidError(reply, "The remote link data must be well-formed JSON.", "link");
      }
      if (!name && !linkValue) return invalidError(reply, "The remote link payload is empty.");
      const existing = state.remoteLinks.find(
        (candidate) => candidate.versionId === versionId && candidate.globalId === globalId,
      );
      if (existing) {
        existing.name = name;
        existing.link = linkValue;
        existing.self = optionalString(body.self);
      } else {
        state.remoteLinks.push({
          versionId,
          globalId,
          name,
          link: linkValue,
          self: optionalString(body.self),
        });
      }
      app.jira.store.save();
      return reply.code(201).send();
    },
  );

  app.delete(
    "/rest/api/2/version/:versionId/remotelink/:globalId",
    async (request, reply) => {
      const { versionId, globalId } = request.params as {
        versionId: string;
        globalId: string;
      };
      const state = getProjectAssetsState(app.jira.store);
      if (!state.versions.some((version) => version.id === versionId)) {
        return missingError(reply, "version");
      }
      const index = state.remoteLinks.findIndex(
        (link) => link.versionId === versionId && link.globalId === globalId,
      );
      if (index < 0) return missingError(reply, "remote version link");
      state.remoteLinks.splice(index, 1);
      app.jira.store.save();
      return reply.code(204).send();
    },
  );

  app.get("/rest/api/2/version/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { expand?: string };
    const version = getProjectAssetsState(app.jira.store).versions.find(
      (candidate) => candidate.id === id,
    );
    if (!version) return missingError(reply, "version");
    return serializeVersion(
      version,
      app.jira.store.state.projects,
      app.jira.baseUrl,
      query.expand,
    );
  });

  app.put("/rest/api/2/version/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const state = getProjectAssetsState(app.jira.store);
    const version = state.versions.find((candidate) => candidate.id === id);
    if (!version) return missingError(reply, "version");
    const body = bodyRecord(request.body);
    if (!body) return invalidError(reply, "A version body is required.");
    if (body.project !== undefined || body.projectId !== undefined) {
      const project = requestedProject(body, app.jira.store.state.projects);
      if (!project) return projectError(reply);
      if (
        [...version.fixedIssueIds, ...version.affectedIssueIds].some((issueId) => {
          const issue = app.jira.store.state.issues.find((candidate) => candidate.id === issueId);
          return !issue || issue.fields.project.id !== project.id;
        })
      ) {
        return invalidError(
          reply,
          "The version cannot be moved because one of its issues is not in the destination project.",
        );
      }
      version.projectId = project.id;
    }
    if (body.name !== undefined) {
      const name = nonEmptyString(body.name);
      if (!name) return invalidError(reply, "You must specify a version name.", "name");
      if (
        state.versions.some(
          (candidate) =>
            candidate !== version &&
            candidate.projectId === version.projectId &&
            candidate.name.toLowerCase() === name.toLowerCase(),
        )
      ) {
        return invalidError(reply, "A version with this name already exists.", "name");
      }
      version.name = name;
    }
    if (body.description !== undefined) version.description = optionalString(body.description);
    if (body.archived !== undefined) version.archived = body.archived === true;
    if (body.released !== undefined) version.released = body.released === true;
    if (body.releaseDate !== undefined) {
      const releaseDate = normalizeDate(body.releaseDate);
      if (releaseDate === null) return invalidError(reply, "The release date is not valid.", "releaseDate");
      version.releaseDate = releaseDate;
    }
    if (body.startDate !== undefined) {
      const startDate = normalizeDate(body.startDate);
      if (startDate === null) return invalidError(reply, "The start date is not valid.", "startDate");
      version.startDate = startDate;
    }
    app.jira.store.save();
    return reply.code(200).send();
  });
};

export default projectAssetRoutes;
