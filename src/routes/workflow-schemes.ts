import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { jiraError } from "../shared/errors.js";
import { serializeUser } from "../shared/serialization.js";
import {
  type StoredWorkflowScheme,
  type WorkflowSchemesState,
  workflowSchemesState,
} from "../shared/workflow-schemes-state.js";

type Query = Record<string, string | boolean | number | undefined>;
type Body = Record<string, unknown>;

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

function schemeId(request: { params: unknown }): number {
  return Number((request.params as { id: string }).id);
}

function findScheme(state: WorkflowSchemesState, id: number): StoredWorkflowScheme | undefined {
  return state.schemes.find((scheme) => scheme.id === id);
}

function workflowExists(state: WorkflowSchemesState, name: string): boolean {
  return state.workflows.some((workflow) => workflow.name === name);
}

function issueTypeExists(app: Parameters<FastifyPluginAsync>[0], id: string): boolean {
  return app.jira.store.state.issueTypes.some((issueType) => issueType.id === id);
}

function createDraft(state: WorkflowSchemesState, parent: StoredWorkflowScheme): StoredWorkflowScheme {
  const draft: StoredWorkflowScheme = {
    ...structuredClone(parent),
    draft: true,
    revision: parent.revision + 1,
    originalDefaultWorkflow: parent.defaultWorkflow,
    originalIssueTypeMappings: structuredClone(parent.issueTypeMappings),
  };
  state.drafts[String(parent.id)] = draft;
  return draft;
}

function serializeScheme(
  app: Parameters<FastifyPluginAsync>[0],
  scheme: StoredWorkflowScheme,
) {
  const issueTypes = Object.fromEntries(
    Object.keys(scheme.issueTypeMappings)
      .map((id) => app.jira.store.state.issueTypes.find((issueType) => issueType.id === id))
      .filter((issueType) => issueType !== undefined)
      .map((issueType) => [
        issueType.id,
        {
          id: issueType.id,
          name: issueType.name,
          description: issueType.description ?? "",
          iconUrl: `${app.jira.baseUrl}/images/icons/issuetypes/${issueType.id}.png`,
          self: `${app.jira.baseUrl}/rest/api/2/issuetype/${issueType.id}`,
          subtask: Boolean(issueType.subtask),
        },
      ]),
  );
  return {
    id: scheme.id,
    name: scheme.name,
    description: scheme.description,
    draft: scheme.draft,
    self: `${app.jira.baseUrl}/rest/api/2/workflowscheme/${scheme.id}${scheme.draft ? "/draft" : ""}`,
    issueTypeMappings: structuredClone(scheme.issueTypeMappings),
    issueTypes,
    lastModified: `06/Aug/26 12:${String(scheme.revision % 60).padStart(2, "0")} PM`,
    lastModifiedUser: serializeUser(app.jira.currentUser(), app.jira.baseUrl),
    ...(scheme.defaultWorkflow === undefined ? {} : { defaultWorkflow: scheme.defaultWorkflow }),
    ...(scheme.draft
      ? {
          ...(scheme.originalDefaultWorkflow === undefined
            ? {}
            : { originalDefaultWorkflow: scheme.originalDefaultWorkflow }),
          originalIssueTypeMappings: structuredClone(scheme.originalIssueTypeMappings ?? {}),
        }
      : {}),
  };
}

function validateReferences(
  app: Parameters<FastifyPluginAsync>[0],
  state: WorkflowSchemesState,
  body: Body,
): string | undefined {
  if (body.name !== undefined && !text(body.name)) return "The workflow scheme name must not be empty.";
  if (body.defaultWorkflow !== undefined) {
    const defaultWorkflow = text(body.defaultWorkflow);
    if (!defaultWorkflow || !workflowExists(state, defaultWorkflow)) {
      return `Workflow '${defaultWorkflow ?? ""}' does not exist.`;
    }
  }
  if (body.issueTypeMappings !== undefined) {
    if (!body.issueTypeMappings || typeof body.issueTypeMappings !== "object" || Array.isArray(body.issueTypeMappings)) {
      return "issueTypeMappings must be an object.";
    }
    for (const [issueType, workflow] of Object.entries(body.issueTypeMappings as Record<string, unknown>)) {
      if (!issueTypeExists(app, issueType)) return `Issue type '${issueType}' does not exist.`;
      if (!text(workflow) || !workflowExists(state, String(workflow))) {
        return `Workflow '${String(workflow)}' does not exist.`;
      }
    }
  }
  return undefined;
}

function updateSchemeFields(scheme: StoredWorkflowScheme, body: Body): void {
  if (text(body.name)) scheme.name = text(body.name)!;
  if (body.description !== undefined && typeof body.description === "string") {
    scheme.description = body.description;
  }
  if (text(body.defaultWorkflow)) scheme.defaultWorkflow = text(body.defaultWorkflow)!;
  if (body.issueTypeMappings && typeof body.issueTypeMappings === "object" && !Array.isArray(body.issueTypeMappings)) {
    scheme.issueTypeMappings = structuredClone(body.issueTypeMappings as Record<string, string>);
  }
  scheme.revision += 1;
}

function selectedScheme(
  state: WorkflowSchemesState,
  parent: StoredWorkflowScheme,
  returnDraftIfExists: unknown,
): StoredWorkflowScheme {
  return bool(returnDraftIfExists) ? state.drafts[String(parent.id)] ?? parent : parent;
}

function mutationScheme(
  state: WorkflowSchemesState,
  parent: StoredWorkflowScheme,
  updateDraftIfNeeded: unknown,
): StoredWorkflowScheme {
  if (parent.projectIds.length > 0 && bool(updateDraftIfNeeded)) {
    return state.drafts[String(parent.id)] ?? createDraft(state, parent);
  }
  return parent;
}

function draftFor(
  state: WorkflowSchemesState,
  id: number,
): StoredWorkflowScheme | undefined {
  return state.drafts[String(id)];
}

const workflowSchemeRoutes: FastifyPluginAsync = async (app) => {
  app.get("/rest/api/2/workflow", async (request) => {
    const state = workflowSchemesState(app.jira.store);
    const requestedName = text((request.query as Query).workflowName);
    const workflows = requestedName
      ? state.workflows.filter((workflow) => workflow.name.toLowerCase() === requestedName.toLowerCase())
      : state.workflows;
    return workflows.map((workflow) => ({
      name: workflow.name,
      description: workflow.description,
      default: workflow.default,
      active: workflow.active,
      steps: structuredClone(workflow.steps),
      lastModifiedDate: "06/Aug/26 12:00 PM",
      lastModifiedUser: app.jira.currentUser().displayName,
      workflowSchemes: workflowSchemesState(app.jira.store).schemes
        .filter((scheme) =>
          scheme.defaultWorkflow === workflow.name ||
          Object.values(scheme.issueTypeMappings).includes(workflow.name),
        )
        .map((scheme) => ({ id: scheme.id, name: scheme.name })),
    }));
  });

  app.post("/rest/api/2/workflowscheme", async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    const state = workflowSchemesState(app.jira.store);
    const invalid = validateReferences(app, state, body);
    if (invalid) return error(reply, 400, invalid);
    const id = state.nextSchemeId++;
    const name = text(body.name) ?? `Workflow Scheme ${id}`;
    if (state.schemes.some((scheme) => scheme.name.toLowerCase() === name.toLowerCase())) {
      return error(reply, 400, `Workflow scheme '${name}' already exists.`);
    }
    const scheme: StoredWorkflowScheme = {
      id,
      name,
      description: typeof body.description === "string" ? body.description : "",
      defaultWorkflow: text(body.defaultWorkflow),
      issueTypeMappings:
        body.issueTypeMappings && typeof body.issueTypeMappings === "object"
          ? structuredClone(body.issueTypeMappings as Record<string, string>)
          : {},
      projectIds: [],
      revision: 1,
      draft: false,
    };
    state.schemes.push(scheme);
    app.jira.store.save();
    return reply.code(201).send(serializeScheme(app, scheme));
  });

  app.get("/rest/api/2/workflowscheme/:id", async (request, reply) => {
    const state = workflowSchemesState(app.jira.store);
    const parent = findScheme(state, schemeId(request));
    if (!parent) return error(reply, 404, "The workflow scheme does not exist.");
    return serializeScheme(app, selectedScheme(state, parent, (request.query as Query).returnDraftIfExists));
  });

  app.put("/rest/api/2/workflowscheme/:id", async (request, reply) => {
    const state = workflowSchemesState(app.jira.store);
    const parent = findScheme(state, schemeId(request));
    if (!parent) return error(reply, 404, "The workflow scheme does not exist.");
    const body = (request.body ?? {}) as Body;
    const invalid = validateReferences(app, state, body);
    if (invalid) return error(reply, 404, invalid);
    const scheme = mutationScheme(state, parent, body.updateDraftIfNeeded);
    updateSchemeFields(scheme, body);
    app.jira.store.save();
    return serializeScheme(app, scheme);
  });

  app.delete("/rest/api/2/workflowscheme/:id", async (request, reply) => {
    const state = workflowSchemesState(app.jira.store);
    const id = schemeId(request);
    const index = state.schemes.findIndex((scheme) => scheme.id === id);
    if (index < 0) return error(reply, 404, "The workflow scheme does not exist.");
    if (state.schemes[index].projectIds.length > 0) {
      return error(reply, 400, "An active workflow scheme cannot be deleted.");
    }
    state.schemes.splice(index, 1);
    delete state.drafts[String(id)];
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.post("/rest/api/2/workflowscheme/:id/createdraft", async (request, reply) => {
    const state = workflowSchemesState(app.jira.store);
    const parent = findScheme(state, schemeId(request));
    if (!parent) return error(reply, 404, "The parent workflow scheme does not exist.");
    const draft = createDraft(state, parent);
    app.jira.store.save();
    return reply.code(201).send(serializeScheme(app, draft));
  });

  app.get("/rest/api/2/workflowscheme/:id/default", async (request, reply) => {
    const state = workflowSchemesState(app.jira.store);
    const parent = findScheme(state, schemeId(request));
    if (!parent) return error(reply, 404, "The workflow scheme does not exist.");
    return serializeScheme(app, selectedScheme(state, parent, (request.query as Query).returnDraftIfExists));
  });

  app.put("/rest/api/2/workflowscheme/:id/default", async (request, reply) => {
    const state = workflowSchemesState(app.jira.store);
    const parent = findScheme(state, schemeId(request));
    if (!parent) return error(reply, 404, "The workflow scheme does not exist.");
    const body = (request.body ?? {}) as Body;
    const workflow = text(body.workflow);
    if (!workflow || !workflowExists(state, workflow)) return error(reply, 404, `Workflow '${workflow ?? ""}' does not exist.`);
    const scheme = mutationScheme(state, parent, body.updateDraftIfNeeded);
    scheme.defaultWorkflow = workflow;
    scheme.revision += 1;
    app.jira.store.save();
    return serializeScheme(app, scheme);
  });

  app.delete("/rest/api/2/workflowscheme/:id/default", async (request, reply) => {
    const state = workflowSchemesState(app.jira.store);
    const parent = findScheme(state, schemeId(request));
    if (!parent) return error(reply, 404, "The workflow scheme does not exist.");
    const scheme = mutationScheme(state, parent, (request.query as Query).updateDraftIfNeeded);
    delete scheme.defaultWorkflow;
    scheme.revision += 1;
    app.jira.store.save();
    return serializeScheme(app, scheme);
  });

  app.get("/rest/api/2/workflowscheme/:id/draft", async (request, reply) => {
    const state = workflowSchemesState(app.jira.store);
    if (!findScheme(state, schemeId(request))) return error(reply, 404, "The parent workflow scheme does not exist.");
    const draft = draftFor(state, schemeId(request));
    if (!draft) return error(reply, 404, "The draft workflow scheme does not exist.");
    return serializeScheme(app, draft);
  });

  app.put("/rest/api/2/workflowscheme/:id/draft", async (request, reply) => {
    const state = workflowSchemesState(app.jira.store);
    const parent = findScheme(state, schemeId(request));
    if (!parent) return error(reply, 404, "The parent workflow scheme does not exist.");
    const body = (request.body ?? {}) as Body;
    const invalid = validateReferences(app, state, body);
    if (invalid) return error(reply, 404, invalid);
    const draft = draftFor(state, parent.id) ?? createDraft(state, parent);
    updateSchemeFields(draft, body);
    app.jira.store.save();
    return serializeScheme(app, draft);
  });

  app.delete("/rest/api/2/workflowscheme/:id/draft", async (request, reply) => {
    const state = workflowSchemesState(app.jira.store);
    const id = schemeId(request);
    if (!findScheme(state, id) || !draftFor(state, id)) {
      return error(reply, 404, "The draft workflow scheme does not exist.");
    }
    delete state.drafts[String(id)];
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/workflowscheme/:id/draft/default", async (request, reply) => {
    const draft = draftFor(workflowSchemesState(app.jira.store), schemeId(request));
    if (!draft) return error(reply, 404, "The draft workflow scheme does not exist.");
    return serializeScheme(app, draft);
  });

  app.put("/rest/api/2/workflowscheme/:id/draft/default", async (request, reply) => {
    const state = workflowSchemesState(app.jira.store);
    const draft = draftFor(state, schemeId(request));
    if (!draft) return error(reply, 404, "The draft workflow scheme does not exist.");
    const workflow = text((request.body as Body | undefined)?.workflow);
    if (!workflow || !workflowExists(state, workflow)) return error(reply, 404, `Workflow '${workflow ?? ""}' does not exist.`);
    draft.defaultWorkflow = workflow;
    draft.revision += 1;
    app.jira.store.save();
    return serializeScheme(app, draft);
  });

  app.delete("/rest/api/2/workflowscheme/:id/draft/default", async (request, reply) => {
    const state = workflowSchemesState(app.jira.store);
    const draft = draftFor(state, schemeId(request));
    if (!draft) return error(reply, 404, "The draft workflow scheme does not exist.");
    delete draft.defaultWorkflow;
    draft.revision += 1;
    app.jira.store.save();
    return serializeScheme(app, draft);
  });

  app.get("/rest/api/2/workflowscheme/:id/draft/issuetype/:issueType", async (request, reply) => {
    const { issueType } = request.params as { issueType: string };
    const state = workflowSchemesState(app.jira.store);
    const draft = draftFor(state, schemeId(request));
    if (!draft || !issueTypeExists(app, issueType)) return error(reply, 404, "The draft workflow scheme or issue type does not exist.");
    const workflow = draft.issueTypeMappings[issueType];
    if (!workflow) return error(reply, 404, "The issue type has no explicit workflow mapping.");
    return { issueType, workflow, updateDraftIfNeeded: false };
  });

  app.put("/rest/api/2/workflowscheme/:id/draft/issuetype/:issueType", async (request, reply) => {
    const { issueType } = request.params as { issueType: string };
    const state = workflowSchemesState(app.jira.store);
    const draft = draftFor(state, schemeId(request));
    const workflow = text((request.body as Body | undefined)?.workflow);
    if (!draft || !issueTypeExists(app, issueType) || !workflow || !workflowExists(state, workflow)) {
      return error(reply, 404, "The draft workflow scheme, issue type, or workflow does not exist.");
    }
    draft.issueTypeMappings[issueType] = workflow;
    draft.revision += 1;
    app.jira.store.save();
    return serializeScheme(app, draft);
  });

  app.delete("/rest/api/2/workflowscheme/:id/draft/issuetype/:issueType", async (request, reply) => {
    const { issueType } = request.params as { issueType: string };
    const state = workflowSchemesState(app.jira.store);
    const draft = draftFor(state, schemeId(request));
    if (!draft || !issueTypeExists(app, issueType) || !draft.issueTypeMappings[issueType]) {
      return error(reply, 404, "The draft workflow scheme or issue type mapping does not exist.");
    }
    delete draft.issueTypeMappings[issueType];
    draft.revision += 1;
    app.jira.store.save();
    return serializeScheme(app, draft);
  });

  const workflowMappings = async (
    request: { params: unknown; query: unknown },
    reply: FastifyReply,
    draft: boolean,
  ) => {
    const state = workflowSchemesState(app.jira.store);
    const parent = findScheme(state, schemeId(request));
    if (!parent) return error(reply, 404, "The workflow scheme does not exist.");
    const scheme = draft
      ? draftFor(state, parent.id)
      : selectedScheme(state, parent, (request.query as Query).returnDraftIfExists);
    if (!scheme) return error(reply, 404, "The draft workflow scheme does not exist.");
    const workflowName = text((request.query as Query).workflowName);
    if (workflowName && !workflowExists(state, workflowName)) return error(reply, 404, `Workflow '${workflowName}' does not exist.`);
    if (!workflowName) return serializeScheme(app, scheme);
    const filtered = structuredClone(scheme);
    filtered.issueTypeMappings = Object.fromEntries(
      Object.entries(filtered.issueTypeMappings).filter(([, workflow]) => workflow === workflowName),
    );
    if (filtered.defaultWorkflow !== workflowName) delete filtered.defaultWorkflow;
    return serializeScheme(app, filtered);
  };

  app.get("/rest/api/2/workflowscheme/:id/draft/workflow", async (request, reply) => workflowMappings(request, reply, true));
  app.get("/rest/api/2/workflowscheme/:id/workflow", async (request, reply) => workflowMappings(request, reply, false));

  const putWorkflowMapping = async (
    request: { params: unknown; query: unknown; body: unknown },
    reply: FastifyReply,
    draft: boolean,
  ) => {
    const state = workflowSchemesState(app.jira.store);
    const parent = findScheme(state, schemeId(request));
    if (!parent) return error(reply, 404, "The workflow scheme does not exist.");
    const body = (request.body ?? {}) as Body;
    const previousWorkflow = text((request.query as Query).workflowName) ?? text(body.workflow);
    const nextWorkflow = text(body.workflow) ?? previousWorkflow;
    if (!previousWorkflow || !nextWorkflow || !workflowExists(state, previousWorkflow) || !workflowExists(state, nextWorkflow)) {
      return error(reply, 404, "The workflow mapping references an unknown workflow.");
    }
    const issueTypes = Array.isArray(body.issueTypes)
      ? body.issueTypes.filter((value): value is string => typeof value === "string")
      : undefined;
    if (issueTypes?.some((issueType) => !issueTypeExists(app, issueType))) {
      return error(reply, 404, "The workflow mapping references an unknown issue type.");
    }
    const scheme = draft
      ? draftFor(state, parent.id)
      : mutationScheme(state, parent, body.updateDraftIfNeeded);
    if (!scheme) return error(reply, 404, "The draft workflow scheme does not exist.");
    const currentlyMapped = Object.entries(scheme.issueTypeMappings)
      .filter(([, workflow]) => workflow === previousWorkflow)
      .map(([issueType]) => issueType);
    const mappedIssueTypes = issueTypes ?? currentlyMapped;
    for (const issueType of currentlyMapped) delete scheme.issueTypeMappings[issueType];
    for (const issueType of mappedIssueTypes) scheme.issueTypeMappings[issueType] = nextWorkflow;
    if (body.defaultMapping === true) scheme.defaultWorkflow = nextWorkflow;
    if (body.defaultMapping === false && scheme.defaultWorkflow === previousWorkflow) delete scheme.defaultWorkflow;
    scheme.revision += 1;
    app.jira.store.save();
    return serializeScheme(app, scheme);
  };

  app.put("/rest/api/2/workflowscheme/:id/draft/workflow", async (request, reply) => putWorkflowMapping(request, reply, true));
  app.put("/rest/api/2/workflowscheme/:id/workflow", async (request, reply) => putWorkflowMapping(request, reply, false));

  const deleteWorkflowMapping = async (
    request: { params: unknown; query: unknown },
    reply: FastifyReply,
    draft: boolean,
  ) => {
    const state = workflowSchemesState(app.jira.store);
    const parent = findScheme(state, schemeId(request));
    if (!parent) return error(reply, 404, "The workflow scheme does not exist.");
    const workflowName = text((request.query as Query).workflowName);
    if (!workflowName || !workflowExists(state, workflowName)) return error(reply, 404, "The workflow does not exist.");
    const scheme = draft
      ? draftFor(state, parent.id)
      : mutationScheme(state, parent, (request.query as Query).updateDraftIfNeeded);
    if (!scheme) return error(reply, 404, "The draft workflow scheme does not exist.");
    scheme.issueTypeMappings = Object.fromEntries(
      Object.entries(scheme.issueTypeMappings).filter(([, workflow]) => workflow !== workflowName),
    );
    if (scheme.defaultWorkflow === workflowName) delete scheme.defaultWorkflow;
    scheme.revision += 1;
    app.jira.store.save();
    return serializeScheme(app, scheme);
  };

  app.delete("/rest/api/2/workflowscheme/:id/draft/workflow", async (request, reply) => deleteWorkflowMapping(request, reply, true));
  app.delete("/rest/api/2/workflowscheme/:id/workflow", async (request, reply) => deleteWorkflowMapping(request, reply, false));

  app.get("/rest/api/2/workflowscheme/:id/issuetype/:issueType", async (request, reply) => {
    const { issueType } = request.params as { issueType: string };
    const state = workflowSchemesState(app.jira.store);
    const parent = findScheme(state, schemeId(request));
    if (!parent || !issueTypeExists(app, issueType)) return error(reply, 404, "The workflow scheme or issue type does not exist.");
    const scheme = selectedScheme(state, parent, (request.query as Query).returnDraftIfExists);
    const workflow = scheme.issueTypeMappings[issueType];
    if (!workflow) return error(reply, 404, "The issue type has no explicit workflow mapping.");
    return { issueType, workflow, updateDraftIfNeeded: false };
  });

  app.put("/rest/api/2/workflowscheme/:id/issuetype/:issueType", async (request, reply) => {
    const { issueType } = request.params as { issueType: string };
    const state = workflowSchemesState(app.jira.store);
    const parent = findScheme(state, schemeId(request));
    const body = (request.body ?? {}) as Body;
    const workflow = text(body.workflow);
    if (!parent || !issueTypeExists(app, issueType) || !workflow || !workflowExists(state, workflow)) {
      return error(reply, 404, "The workflow scheme, issue type, or workflow does not exist.");
    }
    const scheme = mutationScheme(state, parent, body.updateDraftIfNeeded);
    scheme.issueTypeMappings[issueType] = workflow;
    scheme.revision += 1;
    app.jira.store.save();
    return serializeScheme(app, scheme);
  });

  app.delete("/rest/api/2/workflowscheme/:id/issuetype/:issueType", async (request, reply) => {
    const { issueType } = request.params as { issueType: string };
    const state = workflowSchemesState(app.jira.store);
    const parent = findScheme(state, schemeId(request));
    if (!parent || !issueTypeExists(app, issueType)) return error(reply, 404, "The workflow scheme or issue type does not exist.");
    const scheme = mutationScheme(state, parent, (request.query as Query).updateDraftIfNeeded);
    if (!scheme.issueTypeMappings[issueType]) return error(reply, 404, "The issue type has no explicit workflow mapping.");
    delete scheme.issueTypeMappings[issueType];
    scheme.revision += 1;
    app.jira.store.save();
    return serializeScheme(app, scheme);
  });
};

export default workflowSchemeRoutes;
