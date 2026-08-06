import type { FastifyPluginAsync } from "fastify";
import { jiraError } from "../shared/errors.js";
import { getResourceState } from "../store.js";

interface IndexSnapshot {
  absolutePath: string;
  timestamp: number;
}

interface ReindexTask {
  id: number;
  currentProgress: number;
  currentSubTask: string;
  finishTime: string;
  progressUrl: string;
  startTime: string;
  submittedTime: string;
  success: boolean;
  type: "FOREGROUND" | "BACKGROUND" | "BACKGROUND_PREFFERED" | "BACKGROUND_PREFERRED";
}

interface ReindexRequest {
  id: number;
  requestTime: string;
  startTime: string;
  completionTime: string;
  status: "COMPLETE";
  type: "IMMEDIATE";
}

interface IndexingState {
  snapshots: IndexSnapshot[];
  snapshotRunning: boolean;
  pendingSnapshotPath: string | null;
  snapshotCounter: number;
  taskCounter: number;
  tasks: ReindexTask[];
  requestCounter: number;
  requests: ReindexRequest[];
}

function defaultIndexingState(): IndexingState {
  return {
    snapshots: [
      {
        absolutePath: "/mock/jira/shared/index-snapshots/IndexSnapshot_seed.tar.sz",
        timestamp: 1_788_192_000_000,
      },
    ],
    snapshotRunning: false,
    pendingSnapshotPath: null,
    snapshotCounter: 2,
    taskCounter: 7001,
    tasks: [],
    requestCounter: 9001,
    requests: [],
  };
}

function isoNow(): string {
  return new Date().toISOString();
}

function asArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

const indexingRoutes: FastifyPluginAsync = async (app) => {
  const state = () =>
    getResourceState(app.jira.store, "indexing", defaultIndexingState);

  const taskResponse = (task: ReindexTask) => {
    const { id: _id, ...response } = task;
    return structuredClone(response);
  };

  const findTask = (taskId: unknown): ReindexTask | undefined => {
    const tasks = state().tasks;
    if (taskId === undefined) return tasks.at(-1);
    return tasks.find((candidate) => candidate.id === Number(taskId));
  };

  app.get("/rest/api/2/index/summary", async () => {
    const issues = app.jira.store.state.issues;
    const lastUpdated = issues
      .map((issue) => String(issue.fields.updated))
      .sort()
      .at(-1) ?? isoNow();
    return {
      nodeId: "jira-mock-node-1",
      reportTime: isoNow(),
      issueIndex: {
        indexReadable: true,
        countInArchive: 0,
        countInDatabase: issues.length,
        countInIndex: issues.length,
        lastUpdatedInDatabase: lastUpdated,
        lastUpdatedInIndex: lastUpdated,
      },
      replicationQueues: {
        "jira-mock-node-1": {
          queueSize: 0,
          lastConsumedOperation: { id: 1, replicationTime: lastUpdated },
          lastOperationInQueue: { id: 1, replicationTime: lastUpdated },
        },
      },
    };
  });

  app.get("/rest/api/2/index-snapshot", async () =>
    structuredClone(state().snapshots.at(-1)),
  );

  app.post("/rest/api/2/index-snapshot", async (_request, reply) => {
    const current = state();
    if (current.snapshotRunning) {
      return reply.code(409).send(jiraError(["An index snapshot is already being created."]));
    }
    const suffix = String(current.snapshotCounter++).padStart(4, "0");
    current.pendingSnapshotPath =
      `/mock/jira/shared/index-snapshots/IndexSnapshot_${suffix}.tar.sz`;
    current.snapshotRunning = true;
    app.jira.store.save();
    return reply.code(202).send({ futureAbsolutePath: current.pendingSnapshotPath });
  });

  app.get("/rest/api/2/index-snapshot/isRunning", async () => {
    const current = state();
    const running = current.snapshotRunning;
    if (running && current.pendingSnapshotPath) {
      current.snapshots.push({
        absolutePath: current.pendingSnapshotPath,
        timestamp: Date.now(),
      });
      current.pendingSnapshotPath = null;
      current.snapshotRunning = false;
      app.jira.store.save();
    }
    return { running };
  });

  const reindexQuerySchema = {
    type: "object",
    properties: { taskId: { type: "integer", minimum: 1 } },
  };

  app.get(
    "/rest/api/2/reindex",
    { schema: { querystring: reindexQuerySchema } },
    async (request, reply) => {
      const task = findTask((request.query as { taskId?: number }).taskId);
      if (!task) return reply.code(404).send(jiraError(["No reindex task was found."]));
      return taskResponse(task);
    },
  );

  app.post(
    "/rest/api/2/reindex",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            indexChangeHistory: { type: "boolean" },
            indexWorklogs: { type: "boolean" },
            indexComments: { type: "boolean" },
            type: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const query = request.query as { type?: string };
      const requestedType = (query.type ?? "BACKGROUND_PREFERRED").toUpperCase();
      const allowedTypes = new Set([
        "FOREGROUND",
        "BACKGROUND",
        "BACKGROUND_PREFFERED",
        "BACKGROUND_PREFERRED",
      ]);
      if (!allowedTypes.has(requestedType)) {
        return reply.code(400).send(jiraError(["Reindex type is not valid."]));
      }
      const now = isoNow();
      const current = state();
      const task: ReindexTask = {
        id: current.taskCounter++,
        currentProgress: 100,
        currentSubTask: "Reindex complete",
        finishTime: now,
        progressUrl: `${app.jira.baseUrl}/rest/api/2/reindex/progress`,
        startTime: now,
        submittedTime: now,
        success: true,
        type: requestedType as ReindexTask["type"],
      };
      current.tasks.push(task);
      app.jira.store.save();
      return reply.code(202).send(taskResponse(task));
    },
  );

  app.post(
    "/rest/api/2/reindex/issue",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            issueId: {
              oneOf: [
                { type: "string" },
                { type: "array", items: { type: "string" } },
              ],
            },
            indexChangeHistory: { type: "boolean" },
            indexWorklogs: { type: "boolean" },
            indexComments: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const identities = asArray((request.query as { issueId?: string | string[] }).issueId);
      const missing = identities.find((identity) => !app.jira.findIssue(identity));
      if (missing) {
        return reply.code(404).send(jiraError([`Issue ${missing} was not found.`]));
      }
      const now = isoNow();
      const current = state();
      const task: ReindexTask = {
        id: current.taskCounter++,
        currentProgress: 100,
        currentSubTask: `Reindexed ${identities.length || app.jira.store.state.issues.length} issues`,
        finishTime: now,
        progressUrl: `${app.jira.baseUrl}/rest/api/2/reindex/progress`,
        startTime: now,
        submittedTime: now,
        success: true,
        type: "BACKGROUND",
      };
      current.tasks.push(task);
      app.jira.store.save();
      return taskResponse(task);
    },
  );

  app.get(
    "/rest/api/2/reindex/progress",
    { schema: { querystring: reindexQuerySchema } },
    async (request, reply) => {
      const task = findTask((request.query as { taskId?: number }).taskId);
      if (!task) return reply.code(404).send(jiraError(["No reindex task was found."]));
      return taskResponse(task);
    },
  );

  app.post("/rest/api/2/reindex/request", async () => {
    const now = isoNow();
    const current = state();
    const request: ReindexRequest = {
      id: current.requestCounter++,
      requestTime: now,
      startTime: now,
      completionTime: now,
      status: "COMPLETE",
      type: "IMMEDIATE",
    };
    current.requests.push(request);
    app.jira.store.save();
    return request.id;
  });

  app.get(
    "/rest/api/2/reindex/request/bulk",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            requestId: {
              type: "array",
              items: { type: "integer", minimum: 1 },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const raw = (request.query as { requestId?: number | number[] }).requestId;
      const ids = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
      const found = state().requests.find((candidate) => ids.length === 0 || ids.includes(candidate.id));
      if (!found) return reply.code(404).send(jiraError(["No reindex requests were found."]));
      return structuredClone(found);
    },
  );

  app.get("/rest/api/2/reindex/request/:requestId", async (request, reply) => {
    const { requestId } = request.params as { requestId: string };
    const found = state().requests.find((candidate) => candidate.id === Number(requestId));
    if (!found) return reply.code(404).send(jiraError(["Reindex request was not found."]));
    return structuredClone(found);
  });
};

export default indexingRoutes;
