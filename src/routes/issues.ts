import type { FastifyPluginAsync } from "fastify";
import { jiraError } from "../shared/errors.js";
import { findByIdOrName, findUser, parseInteger } from "../shared/parameters.js";
import {
  jiraDate,
  serializeComment,
  serializeIssue,
  serializeStatus,
} from "../shared/serialization.js";
import { availableTransitions } from "../shared/transitions.js";
import type { JiraComment, JiraIssue } from "../types.js";

interface IssueWriteBody {
  fields?: Record<string, unknown>;
  update?: Record<string, Array<Record<string, unknown>>>;
}

const issueRoutes: FastifyPluginAsync = async (app) => {
  app.post("/rest/api/2/issue", async (request, reply) => {
    const body = (request.body ?? {}) as IssueWriteBody;
    const fields = body.fields ?? {};
    const errors: Record<string, string> = {};
    const { store, baseUrl } = app.jira;

    const projectInput = fields.project;
    const project = store.state.projects.find((candidate) => {
      if (typeof projectInput === "string") {
        return candidate.key === projectInput || candidate.id === projectInput;
      }
      if (!projectInput || typeof projectInput !== "object") return false;
      const value = projectInput as { key?: unknown; id?: unknown };
      return candidate.key === value.key || candidate.id === value.id;
    });
    const issueType = findByIdOrName(store.state.issueTypes, fields.issuetype);
    const priority = fields.priority
      ? findByIdOrName(store.state.priorities, fields.priority)
      : store.state.priorities.find((candidate) => candidate.name === "Medium")!;
    const assignee =
      fields.assignee === undefined ? null : findUser(store.state.users, fields.assignee);

    if (!project) errors.project = "project is required and must identify a visible project";
    if (!issueType) errors.issuetype = "issue type is required and must be valid";
    if (typeof fields.summary !== "string" || !fields.summary.trim()) {
      errors.summary = "You must specify a summary of the issue.";
    }
    if (!priority) errors.priority = "Priority is invalid.";
    if (fields.assignee !== undefined && assignee === undefined) {
      errors.assignee = "User does not exist.";
    }
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
    const knownFields = new Set([
      "project",
      "issuetype",
      "summary",
      "description",
      "priority",
      "assignee",
      "reporter",
      "labels",
    ]);
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
        reporter: app.jira.currentUser(),
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
    const issue = app.jira.findIssue(issueIdOrKey);
    if (!issue) {
      return reply
        .code(404)
        .send(jiraError(["Issue does not exist or you do not have permission to see it."]));
    }
    return serializeIssue(issue, app.jira.baseUrl, query.fields);
  });

  app.put("/rest/api/2/issue/:issueIdOrKey", async (request, reply) => {
    const { issueIdOrKey } = request.params as { issueIdOrKey: string };
    const issue = app.jira.findIssue(issueIdOrKey);
    if (!issue) {
      return reply
        .code(404)
        .send(jiraError(["Issue does not exist or you do not have permission to see it."]));
    }

    const body = (request.body ?? {}) as IssueWriteBody;
    const fields = body.fields ?? {};
    const errors: Record<string, string> = {};
    const { store } = app.jira;
    if ("status" in fields) errors.status = "Status must be changed with a workflow transition.";
    if (
      "summary" in fields &&
      (typeof fields.summary !== "string" || !fields.summary.trim())
    ) {
      errors.summary = "You must specify a summary of the issue.";
    }
    const assignee =
      "assignee" in fields ? findUser(store.state.users, fields.assignee) : undefined;
    if ("assignee" in fields && assignee === undefined) errors.assignee = "User does not exist.";
    const priority =
      "priority" in fields
        ? findByIdOrName(store.state.priorities, fields.priority)
        : undefined;
    if ("priority" in fields && !priority) errors.priority = "Priority is invalid.";
    if (Object.keys(errors).length > 0) return reply.code(400).send(jiraError([], errors));

    if (typeof fields.summary === "string") issue.fields.summary = fields.summary.trim();
    if (fields.description === null || typeof fields.description === "string") {
      issue.fields.description = fields.description;
    }
    if (assignee !== undefined) issue.fields.assignee = assignee;
    if (priority) issue.fields.priority = priority;
    if (Array.isArray(fields.labels)) issue.fields.labels = fields.labels.map(String);
    for (const [field, value] of Object.entries(fields)) {
      if (field.startsWith("customfield_")) issue.fields[field] = value;
    }

    for (const [field, operations] of Object.entries(body.update ?? {})) {
      if (field !== "labels") continue;
      for (const operation of operations) {
        if ("set" in operation && Array.isArray(operation.set)) {
          issue.fields.labels = operation.set.map(String);
        }
        if ("add" in operation) issue.fields.labels.push(String(operation.add));
        if ("remove" in operation) {
          issue.fields.labels = issue.fields.labels.filter(
            (label) => label !== String(operation.remove),
          );
        }
      }
    }

    issue.fields.updated = jiraDate();
    store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/issue/:issueIdOrKey/comment", async (request, reply) => {
    const { issueIdOrKey } = request.params as { issueIdOrKey: string };
    const query = request.query as { startAt?: string; maxResults?: string };
    const issue = app.jira.findIssue(issueIdOrKey);
    if (!issue) {
      return reply
        .code(404)
        .send(jiraError(["Issue does not exist or you do not have permission to see it."]));
    }
    const startAt = parseInteger(query.startAt, 0);
    const maxResults = parseInteger(query.maxResults, 50, 100);
    const comments = issue.fields.comment.comments.slice(startAt, startAt + maxResults);
    return {
      startAt,
      maxResults,
      total: issue.fields.comment.comments.length,
      comments: comments.map((comment) =>
        serializeComment(comment, issue, app.jira.baseUrl),
      ),
    };
  });

  app.post("/rest/api/2/issue/:issueIdOrKey/comment", async (request, reply) => {
    const { issueIdOrKey } = request.params as { issueIdOrKey: string };
    const issue = app.jira.findIssue(issueIdOrKey);
    if (!issue) {
      return reply
        .code(404)
        .send(jiraError(["Issue does not exist or you do not have permission to see it."]));
    }
    const body = (request.body ?? {}) as { body?: unknown };
    if (typeof body.body !== "string" || !body.body.trim()) {
      return reply.code(400).send(jiraError([], { comment: "Comment body must not be empty." }));
    }
    const timestamp = jiraDate();
    const comment: JiraComment = {
      id: String(app.jira.store.state.commentCounter++),
      author: app.jira.currentUser(),
      body: body.body,
      updateAuthor: app.jira.currentUser(),
      created: timestamp,
      updated: timestamp,
    };
    issue.fields.comment.comments.push(comment);
    issue.fields.comment.total = issue.fields.comment.comments.length;
    issue.fields.comment.maxResults = issue.fields.comment.comments.length;
    issue.fields.updated = timestamp;
    app.jira.store.save();
    return reply.code(201).send(serializeComment(comment, issue, app.jira.baseUrl));
  });

  app.get("/rest/api/2/issue/:issueIdOrKey/transitions", async (request, reply) => {
    const { issueIdOrKey } = request.params as { issueIdOrKey: string };
    const issue = app.jira.findIssue(issueIdOrKey);
    if (!issue) {
      return reply
        .code(404)
        .send(jiraError(["Issue does not exist or you do not have permission to see it."]));
    }
    return {
      expand: "transitions",
      transitions: availableTransitions(
        issue.fields.status,
        app.jira.store.state.statuses,
      ).map((transition) => ({
        ...transition,
        to: serializeStatus(transition.to, app.jira.baseUrl),
      })),
    };
  });

  app.post("/rest/api/2/issue/:issueIdOrKey/transitions", async (request, reply) => {
    const { issueIdOrKey } = request.params as { issueIdOrKey: string };
    const issue = app.jira.findIssue(issueIdOrKey);
    if (!issue) {
      return reply
        .code(404)
        .send(jiraError(["Issue does not exist or you do not have permission to see it."]));
    }
    const body = (request.body ?? {}) as { transition?: { id?: unknown } };
    const transitionId = body.transition?.id;
    const transition = availableTransitions(
      issue.fields.status,
      app.jira.store.state.statuses,
    ).find((candidate) => candidate.id === String(transitionId));
    if (!transition) {
      return reply.code(400).send(jiraError(["Transition id is not valid for this issue."]));
    }
    issue.fields.status = transition.to;
    issue.fields.updated = jiraDate();
    app.jira.store.save();
    return reply.code(204).send();
  });
};

export default issueRoutes;
