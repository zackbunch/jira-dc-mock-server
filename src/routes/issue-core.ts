import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { jiraError } from "../shared/errors.js";
import {
  type IssueChange,
  type StoredRemoteLink,
  type StoredWorklog,
  issueCoreState,
} from "../shared/issue-core-state.js";
import { findByIdOrName, findUser, parseInteger } from "../shared/parameters.js";
import {
  jiraDate,
  serializeComment,
  serializeIssue,
  serializeProject,
  serializeUser,
} from "../shared/serialization.js";
import type { JiraComment, JiraIssue, JiraNamedResource, JiraUser } from "../types.js";

type Query = Record<string, string | boolean | number | undefined>;
type Body = Record<string, unknown>;

const deterministicDate = "2026-08-06T12:00:00.000+0000";

function error(reply: FastifyReply, status: number, message: string) {
  return reply.code(status).send(jiraError([message]));
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return fallback;
}

function issueId(request: { params: unknown }): string {
  return (request.params as { issueIdOrKey: string }).issueIdOrKey;
}

function commentFor(issue: JiraIssue, id: string): JiraComment | undefined {
  return issue.fields.comment.comments.find((comment) => comment.id === id);
}

function issueTypeJson(app: Parameters<FastifyPluginAsync>[0], issueType: JiraNamedResource) {
  return {
    id: issueType.id,
    name: issueType.name,
    description: issueType.description ?? "",
    iconUrl: `${app.jira.baseUrl}/images/icons/issuetypes/${issueType.id}.png`,
    self: `${app.jira.baseUrl}/rest/api/2/issuetype/${issueType.id}`,
    subtask: Boolean(issueType.subtask),
  };
}

function fieldMetadata(app: Parameters<FastifyPluginAsync>[0]) {
  return [
    {
      fieldId: "summary",
      name: "Summary",
      required: true,
      hasDefaultValue: false,
      operations: ["set"],
      schema: { type: "string", system: "summary" },
      allowedValues: [],
    },
    {
      fieldId: "description",
      name: "Description",
      required: false,
      hasDefaultValue: false,
      operations: ["set"],
      schema: { type: "string", system: "description" },
      allowedValues: [],
    },
    {
      fieldId: "priority",
      name: "Priority",
      required: false,
      hasDefaultValue: true,
      defaultValue: { id: "3", name: "Medium" },
      operations: ["set"],
      schema: { type: "priority", system: "priority" },
      allowedValues: app.jira.store.state.priorities.map((priority) => ({ id: priority.id, name: priority.name })),
    },
    {
      fieldId: "assignee",
      name: "Assignee",
      required: false,
      hasDefaultValue: false,
      operations: ["set"],
      schema: { type: "user", system: "assignee" },
      allowedValues: app.jira.store.state.users.map((user) => ({ name: user.name, key: user.key, displayName: user.displayName })),
    },
    {
      fieldId: "labels",
      name: "Labels",
      required: false,
      hasDefaultValue: false,
      operations: ["set", "add", "remove"],
      schema: { type: "array", items: "string", system: "labels" },
      allowedValues: [],
    },
  ];
}

function addChange(
  app: Parameters<FastifyPluginAsync>[0],
  issue: JiraIssue,
  field: string,
  from: unknown,
  to: unknown,
) {
  const state = issueCoreState(app.jira.store);
  const change: IssueChange = {
    id: state.nextChangeId++,
    field,
    from,
    to,
    authorName: app.jira.currentUser().name,
    created: deterministicDate,
  };
  (state.changes[issue.id] ??= []).push(change);
}

function parseTimeSpent(value: string): number | undefined {
  if (/^\d+$/.test(value)) return Number(value);
  let total = 0;
  let matched = false;
  for (const match of value.matchAll(/(\d+)\s*([wdhm])/gi)) {
    matched = true;
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    total += amount * ({ w: 5 * 8 * 3600, d: 8 * 3600, h: 3600, m: 60 }[unit] ?? 0);
  }
  return matched && total > 0 ? total : undefined;
}

function worklogBody(app: Parameters<FastifyPluginAsync>[0], worklog: StoredWorklog) {
  const author = app.jira.store.state.users.find((user) => user.name === worklog.authorName) ?? app.jira.currentUser();
  const updateAuthor = app.jira.store.state.users.find((user) => user.name === worklog.updateAuthorName) ?? author;
  return {
    id: worklog.id,
    issueId: worklog.issueId,
    self: `${app.jira.baseUrl}/rest/api/2/issue/${worklog.issueId}/worklog/${worklog.id}`,
    author: serializeUser(author, app.jira.baseUrl),
    updateAuthor: serializeUser(updateAuthor, app.jira.baseUrl),
    comment: worklog.comment,
    created: worklog.created,
    updated: worklog.updated,
    started: worklog.started,
    timeSpent: worklog.timeSpent,
    timeSpentSeconds: worklog.timeSpentSeconds,
    ...(worklog.visibility ? { visibility: structuredClone(worklog.visibility) } : {}),
  };
}

function remoteLinkBody(app: Parameters<FastifyPluginAsync>[0], link: StoredRemoteLink) {
  return {
    id: link.id,
    self: `${app.jira.baseUrl}/rest/api/2/issue/${link.issueId}/remotelink/${link.id}`,
    ...(link.globalId ? { globalId: link.globalId } : {}),
    ...(link.application ? { application: structuredClone(link.application) } : {}),
    ...(link.relationship ? { relationship: link.relationship } : {}),
    object: structuredClone(link.object),
  };
}

function validateEstimate(query: Query): string | undefined {
  const adjustment = text(query.adjustEstimate) ?? "auto";
  if (!new Set(["new", "leave", "manual", "auto"]).has(adjustment)) {
    return "adjustEstimate must be one of new, leave, manual, or auto.";
  }
  if (adjustment === "new" && !text(query.newEstimate)) return "newEstimate is required when adjustEstimate is new.";
  if (adjustment === "manual" && !text(query.reduceBy) && !text(query.increaseBy)) {
    return "reduceBy or increaseBy is required when adjustEstimate is manual.";
  }
  return undefined;
}

function makeIssue(
  app: Parameters<FastifyPluginAsync>[0],
  fields: Record<string, unknown>,
): { issue?: JiraIssue; errors?: Record<string, string> } {
  const projectInput = fields.project;
  const project = app.jira.store.state.projects.find((candidate) => {
    if (typeof projectInput === "string") return candidate.id === projectInput || candidate.key === projectInput;
    if (!projectInput || typeof projectInput !== "object") return false;
    const value = projectInput as { id?: unknown; key?: unknown };
    return candidate.id === value.id || candidate.key === value.key;
  });
  const issueType = findByIdOrName(app.jira.store.state.issueTypes, fields.issuetype);
  const priority = fields.priority
    ? findByIdOrName(app.jira.store.state.priorities, fields.priority)
    : app.jira.store.state.priorities.find((candidate) => candidate.name === "Medium");
  const assignee = fields.assignee === undefined ? null : findUser(app.jira.store.state.users, fields.assignee);
  const reporter = fields.reporter === undefined ? app.jira.currentUser() : findUser(app.jira.store.state.users, fields.reporter);
  const errors: Record<string, string> = {};
  if (!project) errors.project = "project must identify a visible project";
  if (!issueType) errors.issuetype = "issuetype must identify a valid issue type";
  if (!text(fields.summary)) errors.summary = "You must specify a summary of the issue.";
  if (!priority) errors.priority = "Priority is invalid.";
  if (fields.assignee !== undefined && assignee === undefined) errors.assignee = "User does not exist.";
  if (fields.reporter !== undefined && (reporter === undefined || reporter === null)) errors.reporter = "User does not exist.";
  const parentInput = fields.parent;
  const parentIdentity = typeof parentInput === "string"
    ? parentInput
    : parentInput && typeof parentInput === "object"
      ? text((parentInput as Body).key) ?? text((parentInput as Body).id)
      : undefined;
  const parent = parentIdentity ? app.jira.findIssue(parentIdentity) : undefined;
  if (parentIdentity && !parent) errors.parent = "Parent issue does not exist.";
  if (Object.keys(errors).length || !project || !issueType || !priority || !reporter) return { errors };
  const nextNumber = Math.max(
    0,
    ...app.jira.store.state.issues
      .filter((issue) => issue.fields.project.key === project.key)
      .map((issue) => Number(issue.key.split("-").at(-1)) || 0),
  ) + 1;
  const known = new Set(["project", "issuetype", "summary", "description", "priority", "assignee", "reporter", "labels", "parent"]);
  const issue: JiraIssue = {
    expand: "renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations",
    id: String(app.jira.store.state.issueCounter++),
    key: `${project.key}-${nextNumber}`,
    fields: {
      project,
      issuetype: issueType,
      summary: text(fields.summary)!,
      description: typeof fields.description === "string" ? fields.description : null,
      status: app.jira.store.state.statuses.find((status) => status.name === "To Do")!,
      priority,
      assignee: assignee ?? null,
      reporter,
      labels: Array.isArray(fields.labels) ? fields.labels.map(String) : [],
      created: deterministicDate,
      updated: deterministicDate,
      comment: { comments: [], maxResults: 0, total: 0, startAt: 0 },
      ...(parent ? { parent: { id: parent.id, key: parent.key, self: `${app.jira.baseUrl}/rest/api/2/issue/${parent.id}` } } : {}),
      ...Object.fromEntries(Object.entries(fields).filter(([key]) => !known.has(key))),
    },
  };
  app.jira.store.state.issues.push(issue);
  if (parent) {
    const state = issueCoreState(app.jira.store);
    (state.subtasks[parent.id] ??= []).push(issue.id);
    state.parentBySubtask[issue.id] = parent.id;
  }
  return { issue };
}

const issueCoreRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser(/^multipart\/form-data(?:;.*)?$/, { parseAs: "buffer" }, (_request, body, done) => done(null, body));

  app.post("/rest/api/2/issue/archive", async (request, reply) => {
    const raw = typeof request.body === "string" ? request.body : "";
    const keys = raw.replace(/[\[\]"]/g, "").split(/[\s,]+/).map((key) => key.trim()).filter(Boolean);
    if (!keys.length) return error(reply, 404, "At least one issue key is required.");
    const state = issueCoreState(app.jira.store);
    const succeeded: string[] = [];
    const failed: Array<{ key: string; reason: string }> = [];
    for (const key of keys) {
      const issue = app.jira.findIssue(key);
      if (!issue) failed.push({ key, reason: "Issue does not exist." });
      else if (state.archivedIssueIds.includes(issue.id)) failed.push({ key, reason: "Issue is already archived." });
      else {
        state.archivedIssueIds.push(issue.id);
        issue.fields.archived = true;
        succeeded.push(issue.key);
        addChange(app, issue, "archived", false, true);
      }
    }
    app.jira.store.save();
    return reply.type("text/plain").send(JSON.stringify({ succeeded, failed }));
  });

  app.post("/rest/api/2/issue/bulk", async (request, reply) => {
    const updates = (request.body as { issueUpdates?: unknown } | undefined)?.issueUpdates;
    if (!Array.isArray(updates) || updates.length === 0) return error(reply, 400, "issueUpdates must contain at least one issue.");
    const issues: Array<{ id: string; key: string; self: string }> = [];
    const errors: Array<{ failedElementNumber: number; status: number; elementErrors: ReturnType<typeof jiraError> }> = [];
    for (const [index, raw] of updates.entries()) {
      const update = raw && typeof raw === "object" ? raw as Body : {};
      const fields = update.fields && typeof update.fields === "object" ? update.fields as Record<string, unknown> : {};
      const result = makeIssue(app, fields);
      if (!result.issue) {
        errors.push({ failedElementNumber: index, status: 400, elementErrors: jiraError([], result.errors) });
        continue;
      }
      const issue = result.issue;
      issues.push({ id: issue.id, key: issue.key, self: `${app.jira.baseUrl}/rest/api/2/issue/${issue.id}` });
      if (Array.isArray(update.properties)) {
        const properties = issueCoreState(app.jira.store).properties[issue.id] ??= {};
        for (const property of update.properties as Array<Body>) {
          const key = text(property.key);
          if (key) properties[key] = property.value;
        }
      }
    }
    app.jira.store.save();
    return reply.code(201).send({ issues, errors });
  });

  app.get("/rest/api/2/issue/createmeta/:projectIdOrKey/issuetypes", async (request, reply) => {
    const { projectIdOrKey } = request.params as { projectIdOrKey: string };
    const project = app.jira.store.state.projects.find((candidate) => candidate.id === projectIdOrKey || candidate.key === projectIdOrKey);
    if (!project) return error(reply, 400, "The project does not exist or is not visible.");
    const query = request.query as Query;
    const startAt = parseInteger(query.startAt as string | undefined, 0);
    const maxResults = parseInteger(query.maxResults as string | undefined, 50, 100);
    const all = app.jira.store.state.issueTypes.map((issueType) => issueTypeJson(app, issueType));
    return { startAt, maxResults, total: all.length, issueTypes: all.slice(startAt, startAt + maxResults) };
  });

  app.get("/rest/api/2/issue/createmeta/:projectIdOrKey/issuetypes/:issueTypeId", async (request, reply) => {
    const { projectIdOrKey, issueTypeId } = request.params as { projectIdOrKey: string; issueTypeId: string };
    const project = app.jira.store.state.projects.find((candidate) => candidate.id === projectIdOrKey || candidate.key === projectIdOrKey);
    const issueType = app.jira.store.state.issueTypes.find((candidate) => candidate.id === issueTypeId);
    if (!project || !issueType) return error(reply, 400, "The project or issue type does not exist or is not visible.");
    const query = request.query as Query;
    const startAt = parseInteger(query.startAt as string | undefined, 0);
    const maxResults = parseInteger(query.maxResults as string | undefined, 50, 100);
    const all = fieldMetadata(app);
    return { startAt, maxResults, total: all.length, fields: all.slice(startAt, startAt + maxResults) };
  });

  app.get("/rest/api/2/issue/picker", async (request) => {
    const query = request.query as Query;
    const needle = (text(query.query) ?? "").toLowerCase();
    const currentProject = text(query.currentProjectId);
    const currentIssue = text(query.currentIssueKey);
    const showSubTasks = bool(query.showSubTasks, true);
    const state = issueCoreState(app.jira.store);
    const issues = app.jira.store.state.issues.filter((issue) =>
      issue.key !== currentIssue &&
      !state.archivedIssueIds.includes(issue.id) &&
      (!currentProject || issue.fields.project.id === currentProject || issue.fields.project.key === currentProject) &&
      (showSubTasks || !state.parentBySubtask[issue.id]) &&
      [issue.key, issue.fields.summary].some((value) => value.toLowerCase().includes(needle)),
    );
    return {
      sections: [{
        id: "suggested",
        label: "Suggested Issues",
        msg: `${issues.length} matching issues`,
        sub: "Issue key and summary matches",
        issues: issues.slice(0, 20).map((issue) => ({
          key: issue.key,
          keyHtml: issue.key,
          summary: issue.fields.summary,
          summaryText: issue.fields.summary,
          img: `${app.jira.baseUrl}/images/icons/issuetypes/${issue.fields.issuetype.id}.png`,
        })),
      }],
    };
  });

  app.delete("/rest/api/2/issue/:issueIdOrKey", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    if (!issue) return error(reply, 404, "The issue does not exist.");
    const state = issueCoreState(app.jira.store);
    const subtasks = state.subtasks[issue.id] ?? [];
    if (subtasks.length && !bool((request.query as Query).deleteSubtasks)) {
      return error(reply, 400, "deleteSubtasks=true is required when the issue has subtasks.");
    }
    const deletedIds = new Set([issue.id, ...subtasks]);
    app.jira.store.state.issues = app.jira.store.state.issues.filter((candidate) => !deletedIds.has(candidate.id));
    for (const id of deletedIds) {
      delete state.properties[id];
      delete state.votes[id];
      delete state.watchers[id];
      delete state.pinnedComments[id];
      delete state.subtasks[id];
      delete state.parentBySubtask[id];
      delete state.changes[id];
    }
    state.archivedIssueIds = state.archivedIssueIds.filter((id) => !deletedIds.has(id));
    state.attachments = state.attachments.filter((attachment) => !deletedIds.has(attachment.issueId));
    state.remoteLinks = state.remoteLinks.filter((link) => !deletedIds.has(link.issueId));
    state.worklogs = state.worklogs.filter((worklog) => !deletedIds.has(worklog.issueId));
    for (const [parent, children] of Object.entries(state.subtasks)) {
      state.subtasks[parent] = children.filter((id) => !deletedIds.has(id));
    }
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.put("/rest/api/2/issue/:issueIdOrKey/archive", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    if (!issue) return error(reply, 404, "The issue does not exist.");
    const state = issueCoreState(app.jira.store);
    if (state.archivedIssueIds.includes(issue.id)) return error(reply, 403, "The issue is already archived.");
    state.archivedIssueIds.push(issue.id);
    issue.fields.archived = true;
    addChange(app, issue, "archived", false, true);
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.put("/rest/api/2/issue/:issueIdOrKey/restore", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    if (!issue) return error(reply, 404, "The issue does not exist.");
    const state = issueCoreState(app.jira.store);
    if (!state.archivedIssueIds.includes(issue.id)) return error(reply, 403, "The issue is not archived.");
    state.archivedIssueIds = state.archivedIssueIds.filter((id) => id !== issue.id);
    issue.fields.archived = false;
    addChange(app, issue, "archived", true, false);
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.put("/rest/api/2/issue/:issueIdOrKey/assignee", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    if (!issue) return error(reply, 404, "The issue does not exist.");
    const body = (request.body ?? {}) as Body;
    const identity = body.name === null || body.key === null ? null : body.name ?? body.key;
    const assignee = findUser(app.jira.store.state.users, identity);
    if (assignee === undefined) return error(reply, 404, "The user does not exist.");
    const old = issue.fields.assignee?.name ?? null;
    issue.fields.assignee = assignee;
    issue.fields.updated = deterministicDate;
    addChange(app, issue, "assignee", old, assignee?.name ?? null);
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.post("/rest/api/2/issue/:issueIdOrKey/attachments", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    if (!issue) return error(reply, 404, "The issue does not exist.");
    if (request.headers["x-atlassian-token"] !== "no-check") return error(reply, 403, "X-Atlassian-Token: no-check is required.");
    const data = Buffer.isBuffer(request.body) ? request.body : Buffer.from("");
    const match = data.toString("utf8").match(/filename="([^"]+)"/i);
    const filename = match?.[1] ?? "attachment.bin";
    const state = issueCoreState(app.jira.store);
    const attachment = { id: String(state.nextAttachmentId++), issueId: issue.id, filename, mimeType: "application/octet-stream", size: data.length, created: "2026-08-06T12:00:00.000Z" };
    state.attachments.push(attachment);
    app.jira.store.save();
    const author = serializeUser(app.jira.currentUser(), app.jira.baseUrl);
    return [{
      id: attachment.id,
      self: `${app.jira.baseUrl}/rest/api/2/attachment/${attachment.id}`,
      filename,
      author,
      created: attachment.created,
      size: attachment.size,
      mimeType: attachment.mimeType,
      content: `${app.jira.baseUrl}/secure/attachment/${attachment.id}/${encodeURIComponent(filename)}`,
      thumbnail: `${app.jira.baseUrl}/secure/thumbnail/${attachment.id}`,
    }];
  });

  app.get("/rest/api/2/issue/:issueIdOrKey/comment/:id", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    const { id } = request.params as { id: string };
    const comment = issue ? commentFor(issue, id) : undefined;
    if (!issue || !comment) return error(reply, 404, "The comment does not exist.");
    const result = serializeComment(comment, issue, app.jira.baseUrl) as unknown as Record<string, unknown>;
    if (text((request.query as Query).expand)?.split(",").includes("renderedBody")) result.renderedBody = comment.body;
    return result;
  });

  app.put("/rest/api/2/issue/:issueIdOrKey/comment/:id", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    const { id } = request.params as { id: string };
    const comment = issue ? commentFor(issue, id) : undefined;
    if (!issue || !comment) return error(reply, 400, "The comment does not exist.");
    const body = (request.body ?? {}) as Body;
    if (!text(body.body)) return error(reply, 400, "Comment body must not be empty.");
    const old = comment.body;
    comment.body = text(body.body)!;
    comment.updated = deterministicDate;
    comment.updateAuthor = app.jira.currentUser();
    if (body.visibility && typeof body.visibility === "object") (comment as JiraComment & { visibility?: unknown }).visibility = structuredClone(body.visibility);
    if (Array.isArray(body.properties)) (comment as JiraComment & { properties?: unknown[] }).properties = structuredClone(body.properties);
    issue.fields.updated = deterministicDate;
    addChange(app, issue, "comment", old, comment.body);
    app.jira.store.save();
    const result = serializeComment(comment, issue, app.jira.baseUrl) as unknown as Record<string, unknown>;
    if (text((request.query as Query).expand)?.split(",").includes("renderedBody")) result.renderedBody = comment.body;
    return result;
  });

  app.delete("/rest/api/2/issue/:issueIdOrKey/comment/:id", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    const { id } = request.params as { id: string };
    const index = issue?.fields.comment.comments.findIndex((comment) => comment.id === id) ?? -1;
    if (!issue || index < 0) return error(reply, 400, "The comment does not exist.");
    issue.fields.comment.comments.splice(index, 1);
    issue.fields.comment.total = issue.fields.comment.comments.length;
    issue.fields.comment.maxResults = issue.fields.comment.comments.length;
    delete issueCoreState(app.jira.store).pinnedComments[issue.id]?.[id];
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.put("/rest/api/2/issue/:issueIdOrKey/comment/:id/pin", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    const { id } = request.params as { id: string };
    if (!issue || !commentFor(issue, id)) return error(reply, 404, "The comment does not exist.");
    if (typeof request.body !== "boolean") return error(reply, 400, "The request body must be a boolean.");
    const pinned = issueCoreState(app.jira.store).pinnedComments[issue.id] ??= {};
    if (request.body) pinned[id] = { pinnedBy: app.jira.currentUser().name, pinnedDate: deterministicDate };
    else delete pinned[id];
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/issue/:issueIdOrKey/pinned-comments", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    if (!issue) return error(reply, 404, "The issue does not exist.");
    const pinned = issueCoreState(app.jira.store).pinnedComments[issue.id] ?? {};
    return Object.entries(pinned).flatMap(([id, metadata]) => {
      const comment = commentFor(issue, id);
      return comment ? [{ comment: serializeComment(comment, issue, app.jira.baseUrl), ...metadata }] : [];
    });
  });

  app.get("/rest/api/2/issue/:issueIdOrKey/editmeta", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    if (!issue) return error(reply, 404, "The issue does not exist.");
    return { fields: Object.fromEntries(fieldMetadata(app).map((field) => [field.fieldId, field])) };
  });

  app.post("/rest/api/2/issue/:issueIdOrKey/notify", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    if (!issue) return error(reply, 404, "The issue does not exist.");
    const body = (request.body ?? {}) as Body;
    const subject = text(body.subject);
    if (!subject || (!text(body.textBody) && !text(body.htmlBody)) || !body.to || typeof body.to !== "object") {
      return error(reply, 400, "subject, a message body, and recipients are required.");
    }
    issueCoreState(app.jira.store).notifications.push({ issueId: issue.id, subject, textBody: text(body.textBody), htmlBody: text(body.htmlBody), recipients: structuredClone(body.to as Record<string, unknown>) });
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/issue/:issueIdOrKey/properties", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    if (!issue) return error(reply, 404, "The issue does not exist.");
    const properties = issueCoreState(app.jira.store).properties[issue.id] ?? {};
    return { keys: Object.keys(properties).sort().map((key) => ({ key, self: `${app.jira.baseUrl}/rest/api/2/issue/${issue.key}/properties/${encodeURIComponent(key)}` })) };
  });

  app.get("/rest/api/2/issue/:issueIdOrKey/properties/:propertyKey", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    const { propertyKey } = request.params as { propertyKey: string };
    if (!issue) return error(reply, 404, "The issue does not exist.");
    const value = issueCoreState(app.jira.store).properties[issue.id]?.[propertyKey];
    if (value === undefined) return error(reply, 404, "The issue property does not exist.");
    return { key: propertyKey, value };
  });

  app.put("/rest/api/2/issue/:issueIdOrKey/properties/:propertyKey", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    const { propertyKey } = request.params as { propertyKey: string };
    if (!issue) return error(reply, 404, "The issue does not exist.");
    if (!propertyKey || Buffer.byteLength(propertyKey) > 255) return error(reply, 400, "The property key must be at most 255 bytes.");
    const properties = issueCoreState(app.jira.store).properties[issue.id] ??= {};
    const existed = propertyKey in properties;
    properties[propertyKey] = request.body;
    addChange(app, issue, `property:${propertyKey}`, existed ? "updated" : undefined, request.body);
    app.jira.store.save();
    return reply.code(existed ? 200 : 201).send();
  });

  app.delete("/rest/api/2/issue/:issueIdOrKey/properties/:propertyKey", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    const { propertyKey } = request.params as { propertyKey: string };
    if (!issue) return error(reply, 404, "The issue does not exist.");
    const properties = issueCoreState(app.jira.store).properties[issue.id];
    if (!properties || !(propertyKey in properties)) return error(reply, 404, "The issue property does not exist.");
    delete properties[propertyKey];
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/issue/:issueIdOrKey/remotelink", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    if (!issue) return error(reply, 404, "The issue does not exist.");
    const globalId = text((request.query as Query).globalId);
    return issueCoreState(app.jira.store).remoteLinks
      .filter((link) => link.issueId === issue.id && (!globalId || link.globalId === globalId))
      .map((link) => remoteLinkBody(app, link));
  });

  app.post("/rest/api/2/issue/:issueIdOrKey/remotelink", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    if (!issue) return error(reply, 404, "The issue does not exist.");
    const body = (request.body ?? {}) as Body;
    if (!body.object || typeof body.object !== "object" || !text((body.object as Body).url) || !text((body.object as Body).title)) {
      return error(reply, 400, "Remote object url and title are required.");
    }
    const state = issueCoreState(app.jira.store);
    const globalId = text(body.globalId);
    let link = globalId ? state.remoteLinks.find((candidate) => candidate.issueId === issue.id && candidate.globalId === globalId) : undefined;
    if (!link) {
      link = { id: String(state.nextRemoteLinkId++), issueId: issue.id, object: {} };
      state.remoteLinks.push(link);
    }
    link.globalId = globalId;
    link.application = body.application && typeof body.application === "object" ? structuredClone(body.application as Record<string, unknown>) : undefined;
    link.relationship = text(body.relationship);
    link.object = structuredClone(body.object as Record<string, unknown>);
    app.jira.store.save();
    return remoteLinkBody(app, link);
  });

  app.delete("/rest/api/2/issue/:issueIdOrKey/remotelink", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    const globalId = text((request.query as Query).globalId);
    if (!issue || !globalId) return error(reply, 404, "The issue or remote link does not exist.");
    const state = issueCoreState(app.jira.store);
    const index = state.remoteLinks.findIndex((link) => link.issueId === issue.id && link.globalId === globalId);
    if (index < 0) return error(reply, 404, "The remote link does not exist.");
    state.remoteLinks.splice(index, 1);
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/issue/:issueIdOrKey/remotelink/:linkId", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    const { linkId } = request.params as { linkId: string };
    if (!/^\d+$/.test(linkId)) return error(reply, 400, "linkId must be numeric.");
    const link = issueCoreState(app.jira.store).remoteLinks.find((candidate) => candidate.issueId === issue?.id && candidate.id === linkId);
    if (!issue || !link) return error(reply, 404, "The issue or remote link does not exist.");
    return remoteLinkBody(app, link);
  });

  app.put("/rest/api/2/issue/:issueIdOrKey/remotelink/:linkId", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    const { linkId } = request.params as { linkId: string };
    const state = issueCoreState(app.jira.store);
    const link = state.remoteLinks.find((candidate) => candidate.issueId === issue?.id && candidate.id === linkId);
    const body = (request.body ?? {}) as Body;
    if (!issue || !link) return error(reply, 404, "The issue or remote link does not exist.");
    if (!body.object || typeof body.object !== "object" || !text((body.object as Body).url) || !text((body.object as Body).title)) {
      return error(reply, 400, "Remote object url and title are required.");
    }
    link.globalId = text(body.globalId);
    link.application = body.application && typeof body.application === "object" ? structuredClone(body.application as Record<string, unknown>) : undefined;
    link.relationship = text(body.relationship);
    link.object = structuredClone(body.object as Record<string, unknown>);
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.delete("/rest/api/2/issue/:issueIdOrKey/remotelink/:linkId", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    const { linkId } = request.params as { linkId: string };
    const state = issueCoreState(app.jira.store);
    const index = state.remoteLinks.findIndex((candidate) => candidate.issueId === issue?.id && candidate.id === linkId);
    if (!issue || index < 0) return error(reply, 404, "The issue or remote link does not exist.");
    state.remoteLinks.splice(index, 1);
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/issue/:issueIdOrKey/subtask", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    if (!issue) return error(reply, 404, "The issue does not exist.");
    return (issueCoreState(app.jira.store).subtasks[issue.id] ?? []).flatMap((id) => {
      const child = app.jira.store.state.issues.find((candidate) => candidate.id === id);
      return child ? [{ id: child.id, key: child.key, self: `${app.jira.baseUrl}/rest/api/2/issue/${child.id}`, fields: { summary: child.fields.summary, status: child.fields.status, priority: child.fields.priority, issuetype: child.fields.issuetype } }] : [];
    });
  });

  app.get("/rest/api/2/issue/:issueIdOrKey/subtask/move", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    if (!issue) return error(reply, 404, "The issue does not exist.");
    return (issueCoreState(app.jira.store).subtasks[issue.id] ?? []).length > 1;
  });

  app.post("/rest/api/2/issue/:issueIdOrKey/subtask/move", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    if (!issue) return error(reply, 404, "The issue does not exist.");
    const body = (request.body ?? {}) as Body;
    const original = Number(body.original);
    const current = Number(body.current);
    const subtasks = issueCoreState(app.jira.store).subtasks[issue.id] ?? [];
    if (!Number.isInteger(original) || !Number.isInteger(current) || original < 0 || current < 0 || original >= subtasks.length || current >= subtasks.length) {
      return error(reply, 400, "original and current must be valid subtask indexes.");
    }
    const [moved] = subtasks.splice(original, 1);
    subtasks.splice(current, 0, moved);
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/issue/:issueIdOrKey/votes", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    if (!issue) return error(reply, 404, "The issue does not exist.");
    const names = issueCoreState(app.jira.store).votes[issue.id] ?? [];
    return { self: `${app.jira.baseUrl}/rest/api/2/issue/${issue.key}/votes`, votes: names.length, hasVoted: names.includes(app.jira.currentUser().name), voters: names.flatMap((name) => {
      const user = app.jira.store.state.users.find((candidate) => candidate.name === name);
      return user ? [serializeUser(user, app.jira.baseUrl)] : [];
    }) };
  });

  app.post("/rest/api/2/issue/:issueIdOrKey/votes", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    if (!issue) return error(reply, 404, "The issue does not exist.");
    const voters = issueCoreState(app.jira.store).votes[issue.id] ??= [];
    const username = app.jira.currentUser().name;
    if (voters.includes(username)) return error(reply, 404, "The current user has already voted.");
    voters.push(username);
    app.jira.store.save();
    return reply.code(200).send();
  });

  app.delete("/rest/api/2/issue/:issueIdOrKey/votes", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    const username = app.jira.currentUser().name;
    const voters = issue ? issueCoreState(app.jira.store).votes[issue.id] ?? [] : [];
    if (!issue || !voters.includes(username)) return error(reply, 404, "The issue or vote does not exist.");
    issueCoreState(app.jira.store).votes[issue.id] = voters.filter((name) => name !== username);
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/issue/:issueIdOrKey/watchers", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    if (!issue) return error(reply, 404, "The issue does not exist.");
    const names = issueCoreState(app.jira.store).watchers[issue.id] ?? [];
    return { self: `${app.jira.baseUrl}/rest/api/2/issue/${issue.key}/watchers`, watchCount: names.length, isWatching: names.includes(app.jira.currentUser().name), watchers: names.flatMap((name) => {
      const user = app.jira.store.state.users.find((candidate) => candidate.name === name);
      return user ? [serializeUser(user, app.jira.baseUrl)] : [];
    }) };
  });

  app.post("/rest/api/2/issue/:issueIdOrKey/watchers", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    if (!issue) return error(reply, 404, "The issue does not exist.");
    const bodyName = typeof request.body === "string" ? text(request.body) : undefined;
    const username = text((request.query as Query).userName) ?? bodyName ?? app.jira.currentUser().name;
    if (!app.jira.store.state.users.some((user) => user.name === username)) return error(reply, 400, "The user does not exist.");
    const watchers = issueCoreState(app.jira.store).watchers[issue.id] ??= [];
    if (!watchers.includes(username)) watchers.push(username);
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.delete("/rest/api/2/issue/:issueIdOrKey/watchers", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    if (!issue) return error(reply, 404, "The issue does not exist.");
    const query = request.query as Query;
    const username = text(query.userName) ?? text(query.username);
    if (!username) return error(reply, 400, "A username is required.");
    if (!app.jira.store.state.users.some((user) => user.name === username)) return error(reply, 400, "The user does not exist.");
    issueCoreState(app.jira.store).watchers[issue.id] = (issueCoreState(app.jira.store).watchers[issue.id] ?? []).filter((name) => name !== username);
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/issue/:issueIdOrKey/worklog", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    if (!issue) return error(reply, 404, "The issue does not exist.");
    const worklogs = issueCoreState(app.jira.store).worklogs.filter((worklog) => worklog.issueId === issue.id).map((worklog) => worklogBody(app, worklog));
    return { startAt: 0, maxResults: worklogs.length, total: worklogs.length, worklogs };
  });

  app.post("/rest/api/2/issue/:issueIdOrKey/worklog", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    if (!issue) return error(reply, 404, "The issue does not exist.");
    const invalidEstimate = validateEstimate(request.query as Query);
    if (invalidEstimate) return error(reply, 400, invalidEstimate);
    const body = (request.body ?? {}) as Body;
    const seconds = typeof body.timeSpentSeconds === "number" ? body.timeSpentSeconds : text(body.timeSpent) ? parseTimeSpent(text(body.timeSpent)!) : undefined;
    if (!seconds || seconds <= 0) return error(reply, 400, "A positive timeSpent or timeSpentSeconds is required.");
    const state = issueCoreState(app.jira.store);
    const worklog: StoredWorklog = {
      id: String(state.nextWorklogId++), issueId: issue.id,
      authorName: app.jira.currentUser().name, updateAuthorName: app.jira.currentUser().name,
      comment: typeof body.comment === "string" ? body.comment : "",
      created: deterministicDate, updated: deterministicDate,
      started: text(body.started) ?? deterministicDate,
      timeSpent: text(body.timeSpent) ?? `${seconds}s`, timeSpentSeconds: seconds,
      ...(body.visibility && typeof body.visibility === "object" ? { visibility: structuredClone(body.visibility as StoredWorklog["visibility"]) } : {}),
    };
    state.worklogs.push(worklog);
    addChange(app, issue, "timespent", 0, seconds);
    app.jira.store.save();
    return reply.code(201).send(worklogBody(app, worklog));
  });

  app.get("/rest/api/2/issue/:issueIdOrKey/worklog/:id", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    const { id } = request.params as { id: string };
    const worklog = issueCoreState(app.jira.store).worklogs.find((candidate) => candidate.issueId === issue?.id && candidate.id === id);
    if (!issue || !worklog) return error(reply, 404, "The worklog does not exist.");
    return worklogBody(app, worklog);
  });

  app.put("/rest/api/2/issue/:issueIdOrKey/worklog/:id", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    const { id } = request.params as { id: string };
    const state = issueCoreState(app.jira.store);
    const worklog = state.worklogs.find((candidate) => candidate.issueId === issue?.id && candidate.id === id);
    if (!issue || !worklog) return error(reply, 404, "The worklog does not exist.");
    const invalidEstimate = validateEstimate(request.query as Query);
    if (invalidEstimate) return error(reply, 400, invalidEstimate);
    const body = (request.body ?? {}) as Body;
    if (!Object.keys(body).some((field) => ["comment", "visibility", "started", "timeSpent", "timeSpentSeconds"].includes(field))) {
      return error(reply, 400, "At least one editable worklog field is required.");
    }
    if (body.comment !== undefined && typeof body.comment === "string") worklog.comment = body.comment;
    if (text(body.started)) worklog.started = text(body.started)!;
    const seconds = typeof body.timeSpentSeconds === "number" ? body.timeSpentSeconds : text(body.timeSpent) ? parseTimeSpent(text(body.timeSpent)!) : undefined;
    if ((body.timeSpent !== undefined || body.timeSpentSeconds !== undefined) && (!seconds || seconds <= 0)) return error(reply, 400, "Time spent must be positive.");
    if (seconds) {
      worklog.timeSpentSeconds = seconds;
      worklog.timeSpent = text(body.timeSpent) ?? `${seconds}s`;
    }
    if (body.visibility && typeof body.visibility === "object") worklog.visibility = structuredClone(body.visibility as StoredWorklog["visibility"]);
    worklog.updateAuthorName = app.jira.currentUser().name;
    worklog.updated = deterministicDate;
    app.jira.store.save();
    return worklogBody(app, worklog);
  });

  app.delete("/rest/api/2/issue/:issueIdOrKey/worklog/:id", async (request, reply) => {
    const issue = app.jira.findIssue(issueId(request));
    const { id } = request.params as { id: string };
    const invalidEstimate = validateEstimate(request.query as Query);
    if (invalidEstimate) return error(reply, 400, invalidEstimate);
    const state = issueCoreState(app.jira.store);
    const index = state.worklogs.findIndex((candidate) => candidate.issueId === issue?.id && candidate.id === id);
    if (!issue || index < 0) return error(reply, 404, "The worklog does not exist.");
    state.worklogs.splice(index, 1);
    app.jira.store.save();
    return reply.code(204).send();
  });
};

export default issueCoreRoutes;
