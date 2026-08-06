import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../src/app.js";
import {
  assertArrayItemsMatchResponse,
  assertEmptyResponseDocumented,
  assertMatchesResponse,
  assertMatchesSchema,
  authorization,
  officialSpecification,
} from "./helpers/official-contract.js";

type Method = "GET" | "POST" | "PUT" | "DELETE";

const preserved = new Set([
  "GET /api/2/issue/{issueIdOrKey}",
  "GET /api/2/issue/{issueIdOrKey}/comment",
  "GET /api/2/issue/{issueIdOrKey}/transitions",
  "POST /api/2/issue",
  "POST /api/2/issue/{issueIdOrKey}/comment",
  "POST /api/2/issue/{issueIdOrKey}/transitions",
  "PUT /api/2/issue/{issueIdOrKey}",
]);

const missingIssueOperations = new Set(
  Object.entries(
    (officialSpecification as unknown as {
      paths: Record<string, Record<string, { tags?: string[] }>>;
    }).paths,
  ).flatMap(([path, methods]) =>
    path.startsWith("/api/2/")
      ? Object.entries(methods)
          .filter(([, operation]) => operation.tags?.includes("issue"))
          .map(([method]) => `${method.toUpperCase()} ${path}`)
          .filter((key) => !preserved.has(key))
      : [],
  ),
);

test("all missing issue operations follow Jira 10.3 and persist", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "jira-issue-core-"));
  const dataFile = join(directory, "state.json");
  let app = buildApp({ dataFile, baseUrl: "http://jira.test" });
  const visited = new Set<string>();
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const call = async (
    contractPath: string,
    method: Method,
    url: string,
    options: {
      payload?: unknown;
      status?: number;
      schema?: "exact" | "array-items" | "empty";
      contentType?: string;
      headers?: Record<string, string>;
    } = {},
  ) => {
    visited.add(`${method} ${contractPath}`);
    const response = await app.inject({
      method,
      url,
      headers: {
        ...authorization,
        ...(options.payload === undefined ? {} : { "content-type": options.contentType ?? "application/json" }),
        ...options.headers,
      },
      payload: (typeof options.payload === "string" && options.contentType === undefined
        ? JSON.stringify(options.payload)
        : options.payload) as never,
    });
    const status = options.status ?? 200;
    assert.equal(response.statusCode, status, `${method} ${url}: ${response.body}`);
    const schema = options.schema ?? "exact";
    if (schema === "empty") {
      assertEmptyResponseDocumented(contractPath, method, status);
      if (status === 204) assert.equal(response.body, "");
      return { response, body: response.body ? response.json() : undefined };
    }
    const body = response.json();
    if (schema === "array-items") assertArrayItemsMatchResponse(contractPath, method, status, body);
    else assertMatchesResponse(contractPath, method, status, body);
    return { response, body };
  };

  const expectError = async (method: Method, url: string, status: number, payload?: unknown) => {
    const response = await app.inject({
      method,
      url,
      headers: {
        ...authorization,
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      payload: payload as never,
    });
    assert.equal(response.statusCode, status, `${method} ${url}: ${response.body}`);
    const body = response.json();
    assert.ok(Array.isArray(body.errorMessages));
    assert.equal(typeof body.errors, "object");
  };

  const create = async (summary: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/rest/api/2/issue",
      headers: { ...authorization, "content-type": "application/json" },
      payload: { fields: { project: { key: "T100ZB" }, issuetype: { id: "10003" }, summary } },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json() as { id: string; key: string };
  };

  const primaryKey = "T100ZB-1";
  const parent = await create("Parent for issue-core subtask contract");

  {
    const { body } = await call("/api/2/issue/bulk", "POST", "/rest/api/2/issue/bulk", {
      status: 201,
      payload: {
        issueUpdates: [
          { fields: { project: { key: "T100ZB" }, issuetype: { id: "10003" }, summary: "First bulk subtask", parent: { key: parent.key }, reporter: { name: "frank.lillo" } }, properties: [{ key: "bulk.order", value: "first" }] },
          { fields: { project: { key: "T100ZB" }, issuetype: { id: "10003" }, summary: "Second bulk subtask", parent: { key: parent.key }, reporter: { name: "frank.lillo" } } },
          { fields: { project: { key: "MISSING" }, issuetype: { id: "10003" }, summary: "Invalid bulk issue" } },
        ],
      },
    });
    assert.equal(body.issues.length, 2);
    assert.equal(body.errors.length, 1);
    assert.equal(body.errors[0].failedElementNumber, 2);
  }
  await expectError("POST", "/rest/api/2/issue/bulk", 400, { issueUpdates: [] });

  {
    const { body } = await call("/api/2/issue/createmeta/{projectIdOrKey}/issuetypes", "GET", "/rest/api/2/issue/createmeta/T100ZB/issuetypes?startAt=0&maxResults=1");
    assert.equal(body.startAt, 0);
    assert.equal(body.maxResults, 1);
    assert.equal(body.issueTypes.length, 1);
    assert.equal(typeof body.issueTypes[0].id, "string");
  }
  {
    const { body } = await call("/api/2/issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}", "GET", "/rest/api/2/issue/createmeta/T100ZB/issuetypes/10003?startAt=0&maxResults=2");
    assert.equal(body.startAt, 0);
    assert.equal(body.maxResults, 2);
    assert.equal(body.fields.length, 2);
    assert.equal(body.fields[0].fieldId, "summary");
  }
  await expectError("GET", "/rest/api/2/issue/createmeta/MISSING/issuetypes", 400);

  {
    const { body } = await call("/api/2/issue/picker", "GET", "/rest/api/2/issue/picker?query=golden&currentProjectId=10002&showSubTasks=false");
    assert.ok(Array.isArray(body.sections));
    assert.ok(body.sections[0].issues.some((issue: { key: string }) => issue.key === primaryKey));
  }

  await call("/api/2/issue/{issueIdOrKey}/assignee", "PUT", `/rest/api/2/issue/${primaryKey}/assignee`, {
    payload: { name: "frank.lillo" }, status: 204, schema: "empty",
  });
  await expectError("PUT", `/rest/api/2/issue/${primaryKey}/assignee`, 404, { name: "missing" });

  const multipart = "--jira-boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"contract.txt\"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--jira-boundary--\r\n";
  {
    const { body } = await call("/api/2/issue/{issueIdOrKey}/attachments", "POST", `/rest/api/2/issue/${primaryKey}/attachments`, {
      payload: multipart,
      contentType: "multipart/form-data; boundary=jira-boundary",
      headers: { "x-atlassian-token": "no-check" },
      schema: "array-items",
    });
    assert.equal(body[0].filename, "contract.txt");
    assert.equal(typeof body[0].size, "number");
  }

  const addedComment = await app.inject({
    method: "POST", url: `/rest/api/2/issue/${primaryKey}/comment`,
    headers: { ...authorization, "content-type": "application/json" },
    payload: { body: "Issue-core comment" },
  });
  assert.equal(addedComment.statusCode, 201, addedComment.body);
  const commentId = addedComment.json().id as string;
  const disposableComment = await app.inject({
    method: "POST", url: `/rest/api/2/issue/${primaryKey}/comment`,
    headers: { ...authorization, "content-type": "application/json" },
    payload: { body: "Disposable comment" },
  });
  const disposableCommentId = disposableComment.json().id as string;

  {
    const { body } = await call("/api/2/issue/{issueIdOrKey}/comment/{id}", "GET", `/rest/api/2/issue/${primaryKey}/comment/${commentId}?expand=renderedBody`);
    assert.equal(body.id, commentId);
    assert.equal(body.renderedBody, "Issue-core comment");
  }
  {
    const { body } = await call("/api/2/issue/{issueIdOrKey}/comment/{id}", "PUT", `/rest/api/2/issue/${primaryKey}/comment/${commentId}?expand=renderedBody`, {
      payload: { body: "Updated issue-core comment", visibility: { type: "group", value: "jira-software-users" }, properties: [{ key: "reviewed", value: "yes" }] },
    });
    assert.equal(body.body, "Updated issue-core comment");
    assert.equal(body.renderedBody, "Updated issue-core comment");
  }
  await call("/api/2/issue/{issueIdOrKey}/comment/{id}/pin", "PUT", `/rest/api/2/issue/${primaryKey}/comment/${commentId}/pin`, {
    payload: true, status: 204, schema: "empty",
  });
  {
    const { body } = await call("/api/2/issue/{issueIdOrKey}/pinned-comments", "GET", `/rest/api/2/issue/${primaryKey}/pinned-comments`, { schema: "array-items" });
    assert.equal(body[0].comment.id, commentId);
    assert.equal(body[0].pinnedBy, "developer");
  }
  await call("/api/2/issue/{issueIdOrKey}/comment/{id}", "DELETE", `/rest/api/2/issue/${primaryKey}/comment/${disposableCommentId}`, {
    status: 204, schema: "empty",
  });
  await expectError("GET", `/rest/api/2/issue/${primaryKey}/comment/${disposableCommentId}`, 404);

  {
    const { body } = await call("/api/2/issue/{issueIdOrKey}/editmeta", "GET", `/rest/api/2/issue/${primaryKey}/editmeta`);
    assert.equal(body.fields.summary.required, true);
    assert.ok(Array.isArray(body.fields.priority.allowedValues));
  }
  await call("/api/2/issue/{issueIdOrKey}/notify", "POST", `/rest/api/2/issue/${primaryKey}/notify`, {
    payload: { subject: "Contract notification", textBody: "The issue changed.", htmlBody: "<p>The issue changed.</p>", to: { users: [{ name: "frank.lillo" }], watchers: true }, restrict: { permissions: [{ key: "BROWSE_PROJECTS" }] } },
    status: 204, schema: "empty",
  });
  await expectError("POST", `/rest/api/2/issue/${primaryKey}/notify`, 400, { subject: "Missing recipients", textBody: "Hello" });

  await call("/api/2/issue/{issueIdOrKey}/properties/{propertyKey}", "PUT", `/rest/api/2/issue/${primaryKey}/properties/contract.state`, {
    payload: "enabled", status: 201, schema: "empty",
  });
  {
    const { body } = await call("/api/2/issue/{issueIdOrKey}/properties", "GET", `/rest/api/2/issue/${primaryKey}/properties`);
    assert.ok(body.keys.some((key: { key: string }) => key.key === "contract.state"));
  }
  {
    const { body } = await call("/api/2/issue/{issueIdOrKey}/properties/{propertyKey}", "GET", `/rest/api/2/issue/${primaryKey}/properties/contract.state`);
    assert.deepEqual(body, { key: "contract.state", value: "enabled" });
  }
  await call("/api/2/issue/{issueIdOrKey}/properties/{propertyKey}", "PUT", `/rest/api/2/issue/${primaryKey}/properties/contract.state`, {
    payload: "persisted", status: 200, schema: "empty",
  });

  const firstLink = await call("/api/2/issue/{issueIdOrKey}/remotelink", "POST", `/rest/api/2/issue/${primaryKey}/remotelink`, {
    payload: { globalId: "contract:first", application: { type: "com.example.tracker", name: "Example Tracker" }, relationship: "relates to", object: { url: "https://example.test/tickets/1", title: "Remote ticket one", summary: "A linked ticket", status: { resolved: false }, icon: { title: "Ticket", url16x16: "https://example.test/icon.png" } } },
  });
  const linkId = firstLink.body.id as string;
  {
    const { body } = await call("/api/2/issue/{issueIdOrKey}/remotelink", "GET", `/rest/api/2/issue/${primaryKey}/remotelink?globalId=contract%3Afirst`, { schema: "array-items" });
    assert.equal(body.length, 1);
    assert.equal(body[0].globalId, "contract:first");
  }
  {
    const { body } = await call("/api/2/issue/{issueIdOrKey}/remotelink/{linkId}", "GET", `/rest/api/2/issue/${primaryKey}/remotelink/${linkId}`);
    assert.equal(body.object.title, "Remote ticket one");
  }
  await call("/api/2/issue/{issueIdOrKey}/remotelink/{linkId}", "PUT", `/rest/api/2/issue/${primaryKey}/remotelink/${linkId}`, {
    payload: { globalId: "contract:first", relationship: "blocks", object: { url: "https://example.test/tickets/1", title: "Updated remote ticket" } },
    status: 204, schema: "empty",
  });
  await call("/api/2/issue/{issueIdOrKey}/remotelink", "POST", `/rest/api/2/issue/${primaryKey}/remotelink`, {
    payload: { globalId: "contract:delete-by-global", object: { url: "https://example.test/tickets/2", title: "Delete by global id" } },
  });
  await call("/api/2/issue/{issueIdOrKey}/remotelink", "DELETE", `/rest/api/2/issue/${primaryKey}/remotelink?globalId=contract%3Adelete-by-global`, {
    status: 204, schema: "empty",
  });
  await expectError("GET", `/rest/api/2/issue/${primaryKey}/remotelink/not-a-number`, 400);

  {
    const { body } = await call("/api/2/issue/{issueIdOrKey}/subtask", "GET", `/rest/api/2/issue/${parent.key}/subtask`, { schema: "array-items" });
    assert.equal(body.length, 2);
    assert.equal(body[0].fields.summary, "First bulk subtask");
  }
  {
    const { body } = await call("/api/2/issue/{issueIdOrKey}/subtask/move", "GET", `/rest/api/2/issue/${parent.key}/subtask/move`);
    assert.equal(body, true);
  }
  await call("/api/2/issue/{issueIdOrKey}/subtask/move", "POST", `/rest/api/2/issue/${parent.key}/subtask/move`, {
    payload: { original: 0, current: 1 }, status: 204, schema: "empty",
  });
  await expectError("POST", `/rest/api/2/issue/${parent.key}/subtask/move`, 400, { original: 99, current: 0 });

  await call("/api/2/issue/{issueIdOrKey}/votes", "POST", `/rest/api/2/issue/${primaryKey}/votes`, { schema: "empty" });
  {
    const { body } = await call("/api/2/issue/{issueIdOrKey}/votes", "GET", `/rest/api/2/issue/${primaryKey}/votes`);
    assert.equal(body.votes, 1);
    assert.equal(body.hasVoted, true);
  }
  await expectError("POST", `/rest/api/2/issue/${primaryKey}/votes`, 404);

  await call("/api/2/issue/{issueIdOrKey}/watchers", "POST", `/rest/api/2/issue/${primaryKey}/watchers?userName=frank.lillo`, {
    status: 204, schema: "empty",
  });
  {
    const { body } = await call("/api/2/issue/{issueIdOrKey}/watchers", "GET", `/rest/api/2/issue/${primaryKey}/watchers`);
    assert.equal(body.watchCount, 1);
    assert.equal(body.watchers[0].name, "frank.lillo");
  }
  await expectError("POST", `/rest/api/2/issue/${primaryKey}/watchers?userName=missing`, 400);

  const addedWorklog = await call("/api/2/issue/{issueIdOrKey}/worklog", "POST", `/rest/api/2/issue/${primaryKey}/worklog?adjustEstimate=manual&reduceBy=30m`, {
    payload: { comment: "Initial issue-core work", started: deterministicDate, timeSpent: "1h 30m", visibility: { type: "group", value: "jira-software-users" } },
    status: 201,
  });
  const worklogId = addedWorklog.body.id as string;
  {
    const { body } = await call("/api/2/issue/{issueIdOrKey}/worklog", "GET", `/rest/api/2/issue/${primaryKey}/worklog`);
    assert.equal(body.total, 1);
    assert.equal(body.worklogs[0].timeSpentSeconds, 5400);
  }
  {
    const { body } = await call("/api/2/issue/{issueIdOrKey}/worklog/{id}", "GET", `/rest/api/2/issue/${primaryKey}/worklog/${worklogId}`);
    assert.equal(body.id, worklogId);
  }
  {
    const { body } = await call("/api/2/issue/{issueIdOrKey}/worklog/{id}", "PUT", `/rest/api/2/issue/${primaryKey}/worklog/${worklogId}?adjustEstimate=leave`, {
      payload: { comment: "Updated persistent worklog", timeSpentSeconds: 7200 },
    });
    assert.equal(body.comment, "Updated persistent worklog");
    assert.equal(body.timeSpentSeconds, 7200);
  }
  await expectError("POST", `/rest/api/2/issue/${primaryKey}/worklog?adjustEstimate=new`, 400, { timeSpent: "1h" });

  await call("/api/2/issue/{issueIdOrKey}/archive", "PUT", `/rest/api/2/issue/${primaryKey}/archive?notifyUsers=false`, {
    status: 204, schema: "empty",
  });
  await expectError("PUT", `/rest/api/2/issue/${primaryKey}/archive`, 403);
  {
    const { response, body } = await call("/api/2/issue/archive", "POST", "/rest/api/2/issue/archive?notifyUsers=true", {
      payload: parent.key,
      contentType: "text/plain",
      schema: "empty",
    });
    const plainSchema = ((officialSpecification as unknown as { paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema?: Record<string, unknown> }> }> }>> }).paths["/api/2/issue/archive"].post.responses["200"].content?.["text/plain"]?.schema);
    assert.ok(plainSchema);
    assertMatchesSchema(plainSchema, body, "POST /api/2/issue/archive text/plain response");
    assert.equal(response.headers["content-type"]?.startsWith("text/plain"), true);
    assert.deepEqual(body.succeeded, [parent.key]);
  }

  await app.close();
  app = buildApp({ dataFile, baseUrl: "http://jira.test" });
  {
    const response = await app.inject({ method: "GET", url: `/rest/api/2/issue/${primaryKey}`, headers: authorization });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().fields.assignee.name, "frank.lillo");
    assert.equal(response.json().fields.archived, true);
  }
  {
    const response = await app.inject({ method: "GET", url: `/rest/api/2/issue/${primaryKey}/properties/contract.state`, headers: authorization });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().value, "persisted");
  }
  {
    const response = await app.inject({ method: "GET", url: `/rest/api/2/issue/${primaryKey}/remotelink/${linkId}`, headers: authorization });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().object.title, "Updated remote ticket");
  }
  {
    const response = await app.inject({ method: "GET", url: `/rest/api/2/issue/${primaryKey}/worklog/${worklogId}`, headers: authorization });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().comment, "Updated persistent worklog");
  }
  {
    const response = await app.inject({ method: "GET", url: `/rest/api/2/issue/${primaryKey}/pinned-comments`, headers: authorization });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json()[0].comment.id, commentId);
  }

  await call("/api/2/issue/{issueIdOrKey}/restore", "PUT", `/rest/api/2/issue/${primaryKey}/restore?notifyUsers=false`, {
    status: 204, schema: "empty",
  });
  await expectError("PUT", `/rest/api/2/issue/${primaryKey}/restore`, 403);
  await call("/api/2/issue/{issueIdOrKey}/votes", "DELETE", `/rest/api/2/issue/${primaryKey}/votes`, {
    status: 204, schema: "empty",
  });
  await call("/api/2/issue/{issueIdOrKey}/watchers", "DELETE", `/rest/api/2/issue/${primaryKey}/watchers?username=frank.lillo`, {
    status: 204, schema: "empty",
  });
  await call("/api/2/issue/{issueIdOrKey}/worklog/{id}", "DELETE", `/rest/api/2/issue/${primaryKey}/worklog/${worklogId}?adjustEstimate=manual&increaseBy=2h`, {
    status: 204, schema: "empty",
  });
  await call("/api/2/issue/{issueIdOrKey}/remotelink/{linkId}", "DELETE", `/rest/api/2/issue/${primaryKey}/remotelink/${linkId}`, {
    status: 204, schema: "empty",
  });
  await call("/api/2/issue/{issueIdOrKey}/properties/{propertyKey}", "DELETE", `/rest/api/2/issue/${primaryKey}/properties/contract.state`, {
    status: 204, schema: "empty",
  });

  await expectError("DELETE", `/rest/api/2/issue/${parent.key}`, 400);
  await call("/api/2/issue/{issueIdOrKey}", "DELETE", `/rest/api/2/issue/${parent.key}?deleteSubtasks=true`, {
    status: 204, schema: "empty",
  });
  await expectError("GET", `/rest/api/2/issue/${parent.key}`, 404);

  assert.equal(missingIssueOperations.size, 41);
  assert.deepEqual(
    [...visited].sort(),
    [...missingIssueOperations].sort(),
    "the focused test must call every missing issue operation",
  );

  {
    const response = await app.inject({ method: "POST", url: "/__admin/reset", headers: authorization });
    assert.equal(response.statusCode, 204);
  }
  {
    const response = await app.inject({ method: "GET", url: `/rest/api/2/issue/${primaryKey}`, headers: authorization });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().fields.archived, undefined);
    assert.equal(response.json().fields.assignee.name, "developer");
  }
  {
    const response = await app.inject({ method: "GET", url: `/rest/api/2/issue/${primaryKey}/worklog`, headers: authorization });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().total, 0, "first access after reset re-seeds namespaced issue state");
  }
});

const deterministicDate = "2026-08-06T12:00:00.000+0000";
