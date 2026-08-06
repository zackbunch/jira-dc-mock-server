import type { FastifyPluginAsync, FastifyReply } from "fastify";
import {
  issueAdjunctsState,
  type AttachmentRecord,
  type IssueLinkRecord,
  type WorklogRecord,
} from "../issue-adjuncts-state.js";
import { metadataState } from "../metadata/resources.js";
import { jiraError } from "../shared/errors.js";
import { jiraDate, serializeUser } from "../shared/serialization.js";
import type { JiraComment, JiraIssue } from "../types.js";

type JsonObject = Record<string, unknown>;

function fail(reply: FastifyReply, status: number, message: string, field?: string) {
  return reply
    .code(status)
    .send(field ? jiraError([], { [field]: message }) : jiraError([message]));
}

function bodyObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function findAttachment(
  app: Parameters<FastifyPluginAsync>[0],
  id: string,
): AttachmentRecord | undefined {
  return issueAdjunctsState(app.jira.store).attachments.find(
    (attachment) => attachment.id === id,
  );
}

function serializeAttachment(
  app: Parameters<FastifyPluginAsync>[0],
  attachment: AttachmentRecord,
) {
  const author = app.jira.store.state.users.find(
    (user) => user.name === attachment.authorName,
  );
  return {
    id: attachment.id,
    self: `${app.jira.baseUrl}/rest/api/2/attachment/${attachment.id}`,
    filename: attachment.filename,
    author: author ? serializeUser(author, app.jira.baseUrl) : undefined,
    created: attachment.created,
    size: attachment.size,
    mimeType: attachment.mimeType,
    content: `${app.jira.baseUrl}/secure/attachment/${attachment.id}/${encodeURIComponent(attachment.filename)}`,
    thumbnail: attachment.mimeType.startsWith("image/")
      ? `${app.jira.baseUrl}/secure/thumbnail/${attachment.id}`
      : undefined,
    issueId: attachment.issueId,
    temporaryUpload: {
      id: attachment.temporaryUploadId,
      state: "committed",
    },
  };
}

function findComment(
  app: Parameters<FastifyPluginAsync>[0],
  commentId: string,
): { issue: JiraIssue; comment: JiraComment } | undefined {
  for (const issue of app.jira.store.state.issues) {
    const comment = issue.fields.comment.comments.find((candidate) => candidate.id === commentId);
    if (comment) return { issue, comment };
  }
  return undefined;
}

function findIssueFromReference(
  app: Parameters<FastifyPluginAsync>[0],
  input: unknown,
): JiraIssue | undefined {
  const reference = bodyObject(input);
  const identity = reference?.id ?? reference?.key;
  return typeof identity === "string" ? app.jira.findIssue(identity) : undefined;
}

function serializeIssueReference(
  app: Parameters<FastifyPluginAsync>[0],
  issueId: string,
) {
  const issue = app.jira.store.state.issues.find((candidate) => candidate.id === issueId)!;
  return {
    id: issue.id,
    key: issue.key,
    self: `${app.jira.baseUrl}/rest/api/2/issue/${issue.id}`,
  };
}

function serializeIssueLink(
  app: Parameters<FastifyPluginAsync>[0],
  link: IssueLinkRecord,
) {
  const type = metadataState(app.jira.store).issueLinkTypes.find(
    (candidate) => candidate.id === link.typeId,
  );
  return {
    id: link.id,
    self: `${app.jira.baseUrl}/rest/api/2/issueLink/${link.id}`,
    type: type
      ? {
          ...type,
          self: `${app.jira.baseUrl}/rest/api/2/issueLinkType/${type.id}`,
        }
      : { id: link.typeId },
    inwardIssue: serializeIssueReference(app, link.inwardIssueId),
    outwardIssue: serializeIssueReference(app, link.outwardIssueId),
  };
}

function parseSince(value: unknown): number | undefined {
  if (value === undefined) return 0;
  const input = Array.isArray(value) ? value[0] : value;
  const parsed = Number(input);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function worklogChangePage(
  app: Parameters<FastifyPluginAsync>[0],
  route: "updated" | "deleted",
  values: Array<{ worklogId: number; updatedTime: number }>,
  since: number,
) {
  const matching = values
    .filter((value) => value.updatedTime > since)
    .sort((left, right) => left.updatedTime - right.updatedTime || left.worklogId - right.worklogId);
  const selected = matching.slice(0, 1000);
  const until = selected.at(-1)?.updatedTime ?? since;
  const isLastPage = matching.length <= selected.length;
  return {
    self: `${app.jira.baseUrl}/rest/api/2/worklog/${route}?since=${since}`,
    nextPage: isLastPage
      ? undefined
      : `${app.jira.baseUrl}/rest/api/2/worklog/${route}?since=${until}`,
    since,
    until,
    isLastPage,
    lastPage: isLastPage,
    values: selected,
  };
}

function serializeWorklog(
  app: Parameters<FastifyPluginAsync>[0],
  worklog: WorklogRecord,
) {
  const author = app.jira.store.state.users.find((user) => user.name === worklog.authorName)!;
  return {
    id: String(worklog.id),
    issueId: worklog.issueId,
    self: `${app.jira.baseUrl}/rest/api/2/issue/${worklog.issueId}/worklog/${worklog.id}`,
    author: serializeUser(author, app.jira.baseUrl),
    updateAuthor: serializeUser(author, app.jira.baseUrl),
    comment: worklog.comment,
    created: worklog.created,
    updated: worklog.updated,
    started: worklog.started,
    timeSpent: worklog.timeSpent,
    timeSpentSeconds: worklog.timeSpentSeconds,
  };
}

function autocompleteValues(app: Parameters<FastifyPluginAsync>[0], fieldName: string) {
  const field = fieldName.toLowerCase();
  if (field === "project") {
    return app.jira.store.state.projects.map((project) => ({
      value: project.key,
      displayName: `${project.key} - ${project.name}`,
    }));
  }
  if (field === "status") {
    return app.jira.store.state.statuses.map((status) => ({
      value: status.name,
      displayName: status.name,
    }));
  }
  if (field === "priority") {
    return app.jira.store.state.priorities.map((priority) => ({
      value: priority.name,
      displayName: priority.name,
    }));
  }
  if (field === "issuetype" || field === "type") {
    return app.jira.store.state.issueTypes.map((issueType) => ({
      value: issueType.name,
      displayName: issueType.name,
    }));
  }
  if (["assignee", "reporter"].includes(field)) {
    return app.jira.store.state.users.map((user) => ({
      value: user.name,
      displayName: user.displayName,
    }));
  }
  if (field === "labels") {
    return [...new Set(app.jira.store.state.issues.flatMap((issue) => issue.fields.labels))].map(
      (label) => ({ value: label, displayName: label }),
    );
  }
  if (field === "key" || field === "issuekey") {
    return app.jira.store.state.issues.map((issue) => ({
      value: issue.key,
      displayName: `${issue.key} - ${issue.fields.summary}`,
    }));
  }
  if (field === "summary") {
    return app.jira.store.state.issues.map((issue) => ({
      value: issue.fields.summary,
      displayName: issue.fields.summary,
    }));
  }
  return [];
}

const issueAdjunctRoutes: FastifyPluginAsync = async (app) => {
  app.get("/rest/api/2/attachment/meta", async () => ({
    enabled: true,
    uploadLimit: 10 * 1024 * 1024,
  }));

  app.get("/rest/api/2/attachment/:id/expand/human", async (request, reply) => {
    const { id } = request.params as { id: string };
    const attachment = findAttachment(app, id);
    if (!attachment) return fail(reply, 404, "The attachment does not exist.");
    return {
      id: Number(attachment.id),
      name: attachment.filename,
      mediaType: attachment.mimeType,
      totalEntryCount: attachment.archiveEntries.length,
      entries: Object.fromEntries(
        attachment.archiveEntries.map((entry) => [String(entry.entryIndex), { ...entry }]),
      ),
    };
  });

  app.get("/rest/api/2/attachment/:id/expand/raw", async (request, reply) => {
    const { id } = request.params as { id: string };
    const attachment = findAttachment(app, id);
    if (!attachment) return fail(reply, 404, "The attachment does not exist.");
    return {
      totalEntryCount: attachment.archiveEntries.length,
      entries: attachment.archiveEntries.map((entry) => ({ ...entry })),
    };
  });

  app.get("/rest/api/2/attachment/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const attachment = findAttachment(app, id);
    if (!attachment) return fail(reply, 404, "The attachment does not exist.");
    if (!app.jira.store.state.issues.some((issue) => issue.id === attachment.issueId)) {
      return fail(reply, 404, "The issue associated with the attachment does not exist.");
    }
    return serializeAttachment(app, attachment);
  });

  app.delete("/rest/api/2/attachment/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const state = issueAdjunctsState(app.jira.store);
    const attachment = state.attachments.find((candidate) => candidate.id === id);
    if (!attachment) return fail(reply, 404, "The attachment does not exist.");
    state.attachments.splice(state.attachments.indexOf(attachment), 1);
    delete state.temporaryUploads[attachment.temporaryUploadId];
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/comment/:commentId/properties", async (request, reply) => {
    const { commentId } = request.params as { commentId: string };
    if (!findComment(app, commentId)) return fail(reply, 404, "The comment does not exist.");
    const properties = issueAdjunctsState(app.jira.store).commentProperties[commentId] ?? {};
    return {
      keys: Object.keys(properties)
        .sort()
        .map((key) => ({
          key,
          self: `${app.jira.baseUrl}/rest/api/2/comment/${commentId}/properties/${encodeURIComponent(key)}`,
        })),
    };
  });

  app.get(
    "/rest/api/2/comment/:commentId/properties/:propertyKey",
    async (request, reply) => {
      const { commentId, propertyKey } = request.params as {
        commentId: string;
        propertyKey: string;
      };
      if (!findComment(app, commentId)) return fail(reply, 404, "The comment does not exist.");
      const value = issueAdjunctsState(app.jira.store).commentProperties[commentId]?.[propertyKey];
      if (value === undefined) return fail(reply, 404, "The comment property does not exist.");
      return { key: propertyKey, value };
    },
  );

  app.put(
    "/rest/api/2/comment/:commentId/properties/:propertyKey",
    async (request, reply) => {
      const { commentId, propertyKey } = request.params as {
        commentId: string;
        propertyKey: string;
      };
      if (!findComment(app, commentId)) return fail(reply, 404, "The comment does not exist.");
      if (!propertyKey || Buffer.byteLength(propertyKey, "utf8") > 255) {
        return fail(reply, 400, "The property key must contain at most 255 bytes.", "propertyKey");
      }
      if (request.body === undefined || request.body === null) {
        return fail(reply, 400, "A non-empty JSON property value is required.");
      }
      const serialized = JSON.stringify(request.body);
      if (!serialized || Buffer.byteLength(serialized, "utf8") > 32768) {
        return fail(reply, 400, "The property value must contain at most 32768 bytes.");
      }
      const state = issueAdjunctsState(app.jira.store);
      const properties = (state.commentProperties[commentId] ??= {});
      const created = properties[propertyKey] === undefined;
      properties[propertyKey] = serialized;
      app.jira.store.save();
      return reply.code(created ? 201 : 200).send();
    },
  );

  app.delete(
    "/rest/api/2/comment/:commentId/properties/:propertyKey",
    async (request, reply) => {
      const { commentId, propertyKey } = request.params as {
        commentId: string;
        propertyKey: string;
      };
      if (!findComment(app, commentId)) return fail(reply, 404, "The comment does not exist.");
      const properties = issueAdjunctsState(app.jira.store).commentProperties[commentId];
      if (!properties || properties[propertyKey] === undefined) {
        return fail(reply, 404, "The comment property does not exist.");
      }
      delete properties[propertyKey];
      app.jira.store.save();
      return reply.code(204).send();
    },
  );

  app.post("/rest/api/2/issueLink", async (request, reply) => {
    const body = bodyObject(request.body);
    if (!body) return fail(reply, 400, "An issue link body is required.");
    const inwardIssue = findIssueFromReference(app, body.inwardIssue);
    const outwardIssue = findIssueFromReference(app, body.outwardIssue);
    if (!inwardIssue || !outwardIssue) {
      return fail(reply, 404, "One of the linked issues does not exist.");
    }
    if (inwardIssue === outwardIssue) {
      return fail(reply, 400, "An issue cannot be linked to itself.");
    }
    const typeReference = bodyObject(body.type);
    const typeIdentity = typeReference?.id ?? typeReference?.name;
    const type = metadataState(app.jira.store).issueLinkTypes.find(
      (candidate) =>
        candidate.id === typeIdentity ||
        (typeof typeIdentity === "string" &&
          candidate.name.toLowerCase() === typeIdentity.toLowerCase()),
    );
    if (!type) return fail(reply, 404, "The issue link type does not exist.");
    const state = issueAdjunctsState(app.jira.store);
    if (
      state.issueLinks.some(
        (link) =>
          link.typeId === type.id &&
          link.inwardIssueId === inwardIssue.id &&
          link.outwardIssueId === outwardIssue.id,
      )
    ) {
      return fail(reply, 400, "This issue link already exists.");
    }
    const commentBody = bodyObject(body.comment);
    if (body.comment !== undefined) {
      if (typeof commentBody?.body !== "string" || !commentBody.body.trim()) {
        return fail(reply, 400, "The issue link comment must not be empty.", "comment");
      }
      const timestamp = jiraDate();
      const comment: JiraComment = {
        id: String(app.jira.store.state.commentCounter++),
        author: app.jira.currentUser(),
        body: commentBody.body,
        updateAuthor: app.jira.currentUser(),
        created: timestamp,
        updated: timestamp,
      };
      inwardIssue.fields.comment.comments.push(comment);
      inwardIssue.fields.comment.total = inwardIssue.fields.comment.comments.length;
      inwardIssue.fields.comment.maxResults = inwardIssue.fields.comment.comments.length;
    }
    state.issueLinks.push({
      id: String(state.issueLinkCounter++),
      typeId: type.id,
      inwardIssueId: inwardIssue.id,
      outwardIssueId: outwardIssue.id,
    });
    app.jira.store.save();
    return reply.code(201).send();
  });

  app.get("/rest/api/2/issueLink/:linkId", async (request, reply) => {
    const { linkId } = request.params as { linkId: string };
    if (!/^\d+$/.test(linkId)) return fail(reply, 400, "The issue link id must be numeric.");
    const link = issueAdjunctsState(app.jira.store).issueLinks.find(
      (candidate) => candidate.id === linkId,
    );
    if (!link) return fail(reply, 404, "The issue link does not exist.");
    if (
      !app.jira.store.state.issues.some((issue) => issue.id === link.inwardIssueId) ||
      !app.jira.store.state.issues.some((issue) => issue.id === link.outwardIssueId)
    ) {
      return fail(reply, 404, "A linked issue does not exist.");
    }
    return serializeIssueLink(app, link);
  });

  app.delete("/rest/api/2/issueLink/:linkId", async (request, reply) => {
    const { linkId } = request.params as { linkId: string };
    if (!/^\d+$/.test(linkId)) return fail(reply, 400, "The issue link id must be numeric.");
    const state = issueAdjunctsState(app.jira.store);
    const link = state.issueLinks.find((candidate) => candidate.id === linkId);
    if (!link) return fail(reply, 404, "The issue link does not exist.");
    state.issueLinks.splice(state.issueLinks.indexOf(link), 1);
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/jql/autocompletedata", async () => ({
    jqlReservedWords: [
      "and",
      "asc",
      "by",
      "desc",
      "empty",
      "in",
      "is",
      "not",
      "null",
      "or",
      "order",
    ],
    visibleFieldNames: [
      "assignee",
      "created",
      "issuekey",
      "issuetype",
      "labels",
      "priority",
      "project",
      "reporter",
      "status",
      "summary",
      "text",
      "updated",
    ],
    visibleFunctionNames: ["currentUser()"],
  }));

  app.get("/rest/api/2/jql/autocompletedata/suggestions", async (request, reply) => {
    const query = request.query as Record<string, string | string[] | undefined>;
    const fieldName = String(query.fieldName ?? "").trim();
    const predicateName = String(query.predicateName ?? "").trim().toLowerCase();
    let results = fieldName
      ? autocompleteValues(app, fieldName)
      : ["by", "from", "to"].includes(predicateName)
        ? app.jira.store.state.users.map((user) => ({
            value: user.name,
            displayName: user.displayName,
          }))
        : [];
    const filter = String(
      fieldName ? query.fieldValue ?? "" : query.predicateValue ?? "",
    ).toLowerCase();
    if (filter) {
      results = results.filter((result) =>
        `${result.value} ${result.displayName}`.toLowerCase().includes(filter),
      );
    }
    results.sort(
      (left, right) =>
        left.displayName.localeCompare(right.displayName) || left.value.localeCompare(right.value),
    );
    const startAt = parseSince(query.startAt);
    const requestedMaximum = parseSince(query.maxResults);
    if (startAt === undefined || requestedMaximum === undefined) {
      return fail(reply, 400, "startAt and maxResults must be non-negative integers.");
    }
    const maxResults = query.maxResults === undefined ? 50 : Math.min(requestedMaximum, 1000);
    const selected = results.slice(startAt, startAt + maxResults);
    return {
      startAt,
      maxResults,
      total: results.length,
      isLast: startAt + selected.length >= results.length,
      results: selected,
    };
  });

  app.get("/rest/api/2/worklog/updated", async (request, reply) => {
    const since = parseSince((request.query as { since?: unknown }).since);
    if (since === undefined) return fail(reply, 400, "since must be a non-negative integer.");
    const state = issueAdjunctsState(app.jira.store);
    return worklogChangePage(
      app,
      "updated",
      state.worklogs.map((worklog) => ({
        worklogId: worklog.id,
        updatedTime: worklog.updatedTime,
      })),
      since,
    );
  });

  app.get("/rest/api/2/worklog/deleted", async (request, reply) => {
    const since = parseSince((request.query as { since?: unknown }).since);
    if (since === undefined) return fail(reply, 400, "since must be a non-negative integer.");
    return worklogChangePage(
      app,
      "deleted",
      issueAdjunctsState(app.jira.store).deletedWorklogs,
      since,
    );
  });

  app.post("/rest/api/2/worklog/list", async (request, reply) => {
    const body = bodyObject(request.body);
    if (!body || !Array.isArray(body.ids)) {
      return fail(reply, 400, "A worklog id list is required.", "ids");
    }
    if (
      body.ids.length > 1000 ||
      !body.ids.every((id) => Number.isSafeInteger(id) && Number(id) >= 0)
    ) {
      return fail(reply, 400, "ids must contain at most 1000 integer worklog ids.", "ids");
    }
    const requested = new Set(body.ids as number[]);
    return issueAdjunctsState(app.jira.store).worklogs
      .filter(
        (worklog) =>
          requested.has(worklog.id) &&
          app.jira.store.state.issues.some((issue) => issue.id === worklog.issueId),
      )
      .sort((left, right) => left.id - right.id)
      .map((worklog) => serializeWorklog(app, worklog));
  });
};

export default issueAdjunctRoutes;
