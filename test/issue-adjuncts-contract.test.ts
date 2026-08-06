import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { buildApp } from "../src/app.js";
import {
  assertArrayItemsMatchResponse,
  assertEmptyResponseDocumented,
  assertMatchesResponse,
  authorization,
} from "./helpers/official-contract.js";

type Method = "GET" | "POST" | "PUT" | "DELETE";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "jira-issue-adjuncts-"));
  const dataFile = join(directory, "state.json");
  const apps: ReturnType<typeof buildApp>[] = [];
  const open = () => {
    const app = buildApp({ dataFile, baseUrl: "http://jira.test" });
    apps.push(app);
    return app;
  };
  t.after(async () => {
    await Promise.all(apps.map(async (app) => app.close()));
    rmSync(directory, { recursive: true, force: true });
  });
  return { open };
}

async function call(
  app: ReturnType<typeof buildApp>,
  method: Method,
  url: string,
  payload?: Record<string, unknown>,
) {
  const response = await app.inject({
    method,
    url,
    headers: authorization,
    ...(payload === undefined ? {} : { payload }),
  });
  return {
    response,
    body: response.body.length ? (response.json() as unknown) : undefined,
  };
}

function object(value: unknown): Record<string, any> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, any>;
}

test("all issue adjunct success operations follow the Jira 10.3 schemas", async (t) => {
  const app = fixture(t).open();

  let result = await call(app, "GET", "/rest/api/2/attachment/meta");
  assert.equal(result.response.statusCode, 200);
  assertMatchesResponse("/api/2/attachment/meta", "get", 200, result.body);
  assert.equal(object(result.body).enabled, true);
  assert.equal(object(result.body).uploadLimit, 10 * 1024 * 1024);

  result = await call(app, "GET", "/rest/api/2/attachment/30000");
  assert.equal(result.response.statusCode, 200);
  assertMatchesResponse("/api/2/attachment/{id}", "get", 200, result.body);
  let body = object(result.body);
  assert.equal(body.filename, "platform-diagnostics.zip");
  assert.equal(body.issueId, "10004");
  assert.deepEqual(body.temporaryUpload, { id: "temporary-30000", state: "committed" });

  result = await call(app, "GET", "/rest/api/2/attachment/30000/expand/human");
  assert.equal(result.response.statusCode, 200);
  assertMatchesResponse("/api/2/attachment/{id}/expand/human", "get", 200, result.body);
  body = object(result.body);
  assert.equal(body.totalEntryCount, 2);
  assert.equal(body.entries["0"].name, "diagnostics/build.log");

  result = await call(app, "GET", "/rest/api/2/attachment/30000/expand/raw");
  assert.equal(result.response.statusCode, 200);
  assertMatchesResponse("/api/2/attachment/{id}/expand/raw", "get", 200, result.body);
  body = object(result.body);
  assert.equal(body.entries.length, 2);
  assert.equal(body.entries[1].mediaType, "application/json");

  result = await call(app, "DELETE", "/rest/api/2/attachment/30001");
  assert.equal(result.response.statusCode, 204);
  assert.equal(result.response.body, "");
  assertEmptyResponseDocumented("/api/2/attachment/{id}", "delete", 204);

  const commentCreate = await call(app, "POST", "/rest/api/2/issue/T100ZB-1/comment", {
    body: "Property-bearing synthetic comment.",
  });
  assert.equal(commentCreate.response.statusCode, 201);
  const commentId = object(commentCreate.body).id as string;

  result = await call(app, "GET", `/rest/api/2/comment/${commentId}/properties`);
  assert.equal(result.response.statusCode, 200);
  assertMatchesResponse(
    "/api/2/comment/{commentId}/properties",
    "get",
    200,
    result.body,
  );
  assert.deepEqual(object(result.body).keys, []);

  result = await call(
    app,
    "PUT",
    `/rest/api/2/comment/${commentId}/properties/agent.context`,
    { source: "integration-test", enabled: true },
  );
  assert.equal(result.response.statusCode, 201);
  assert.equal(result.response.body, "");
  assertEmptyResponseDocumented(
    "/api/2/comment/{commentId}/properties/{propertyKey}",
    "put",
    201,
  );

  result = await call(
    app,
    "PUT",
    `/rest/api/2/comment/${commentId}/properties/agent.context`,
    { source: "updated" },
  );
  assert.equal(result.response.statusCode, 200);
  assert.equal(result.response.body, "");
  assertEmptyResponseDocumented(
    "/api/2/comment/{commentId}/properties/{propertyKey}",
    "put",
    200,
  );

  result = await call(
    app,
    "GET",
    `/rest/api/2/comment/${commentId}/properties/agent.context`,
  );
  assert.equal(result.response.statusCode, 200);
  assertMatchesResponse(
    "/api/2/comment/{commentId}/properties/{propertyKey}",
    "get",
    200,
    result.body,
  );
  assert.deepEqual(JSON.parse(object(result.body).value), { source: "updated" });

  result = await call(app, "GET", `/rest/api/2/comment/${commentId}/properties`);
  assert.equal(object(result.body).keys[0].key, "agent.context");

  result = await call(
    app,
    "DELETE",
    `/rest/api/2/comment/${commentId}/properties/agent.context`,
  );
  assert.equal(result.response.statusCode, 204);
  assert.equal(result.response.body, "");
  assertEmptyResponseDocumented(
    "/api/2/comment/{commentId}/properties/{propertyKey}",
    "delete",
    204,
  );

  result = await call(app, "POST", "/rest/api/2/issueLink", {
    type: { name: "Relates" },
    inwardIssue: { key: "T101LIB-1" },
    outwardIssue: { id: "10002" },
    comment: { body: "Linked for authentication release coordination." },
  });
  assert.equal(result.response.statusCode, 201);
  assert.equal(result.response.body, "");
  assertEmptyResponseDocumented("/api/2/issueLink", "post", 201);

  result = await call(app, "GET", "/rest/api/2/issueLink/50001");
  assert.equal(result.response.statusCode, 200);
  assertMatchesResponse("/api/2/issueLink/{linkId}", "get", 200, result.body);
  body = object(result.body);
  assert.equal(body.type.name, "Relates");
  assert.equal(body.inwardIssue.key, "T101LIB-1");
  assert.equal(body.outwardIssue.key, "T101LIB-2");

  const linkedComments = await call(
    app,
    "GET",
    "/rest/api/2/issue/T101LIB-1/comment",
  );
  assert.equal(object(linkedComments.body).comments.at(-1).body, "Linked for authentication release coordination.");

  result = await call(app, "DELETE", "/rest/api/2/issueLink/50001");
  assert.equal(result.response.statusCode, 204);
  assert.equal(result.response.body, "");
  assertEmptyResponseDocumented("/api/2/issueLink/{linkId}", "delete", 204);

  result = await call(app, "GET", "/rest/api/2/jql/autocompletedata");
  assert.equal(result.response.statusCode, 200);
  assertMatchesResponse("/api/2/jql/autocompletedata", "get", 200, result.body);
  body = object(result.body);
  assert.ok(body.visibleFieldNames.includes("project"));
  assert.ok(body.jqlReservedWords.includes("order"));

  result = await call(
    app,
    "GET",
    "/rest/api/2/jql/autocompletedata/suggestions?fieldName=project&fieldValue=T10&startAt=1&maxResults=1",
  );
  assert.equal(result.response.statusCode, 200);
  assertMatchesResponse(
    "/api/2/jql/autocompletedata/suggestions",
    "get",
    200,
    result.body,
  );
  body = object(result.body);
  assert.equal(body.startAt, 1);
  assert.equal(body.maxResults, 1);
  assert.equal(body.total, 3);
  assert.equal(body.results.length, 1);

  result = await call(
    app,
    "GET",
    "/rest/api/2/jql/autocompletedata/suggestions?predicateName=by&predicateValue=dev",
  );
  assert.equal(object(result.body).results[0].value, "developer");

  result = await call(app, "GET", "/rest/api/2/worklog/updated?since=1760000001500");
  assert.equal(result.response.statusCode, 200);
  assertMatchesResponse("/api/2/worklog/updated", "get", 200, result.body);
  body = object(result.body);
  assert.deepEqual(
    body.values.map((change: { worklogId: number }) => change.worklogId),
    [40001, 40002],
  );
  assert.equal(body.isLastPage, true);

  result = await call(app, "GET", "/rest/api/2/worklog/deleted?since=0");
  assert.equal(result.response.statusCode, 200);
  assertMatchesResponse("/api/2/worklog/deleted", "get", 200, result.body);
  assert.deepEqual(object(result.body).values, [
    { worklogId: 40003, updatedTime: 1760000004000 },
  ]);

  result = await call(app, "POST", "/rest/api/2/worklog/list", {
    ids: [40002, 40000, 99999],
  });
  assert.equal(result.response.statusCode, 200);
  // The generated response references one item even though Jira returns an array.
  assertArrayItemsMatchResponse("/api/2/worklog/list", "post", 200, result.body);
  assert.deepEqual(
    (result.body as { id: string }[]).map((worklog) => worklog.id),
    ["40000", "40002"],
  );
});

test("issue adjuncts validate references and persist through restart and reset", async (t) => {
  const { open } = fixture(t);
  let app = open();

  let result = await call(app, "GET", "/rest/api/2/attachment/99999");
  assert.equal(result.response.statusCode, 404);
  assert.ok(Array.isArray(object(result.body).errorMessages));

  result = await call(app, "GET", "/rest/api/2/comment/99999/properties");
  assert.equal(result.response.statusCode, 404);

  result = await call(app, "POST", "/rest/api/2/issueLink", {
    type: { id: "10000" },
    inwardIssue: { key: "MISSING-1" },
    outwardIssue: { key: "T100ZB-1" },
  });
  assert.equal(result.response.statusCode, 404);

  result = await call(app, "POST", "/rest/api/2/issueLink", {
    type: { id: "99999" },
    inwardIssue: { key: "T100ZB-1" },
    outwardIssue: { key: "T100ZB-2" },
  });
  assert.equal(result.response.statusCode, 404);

  result = await call(app, "GET", "/rest/api/2/issueLink/not-a-number");
  assert.equal(result.response.statusCode, 400);
  result = await call(app, "GET", "/rest/api/2/worklog/updated?since=-1");
  assert.equal(result.response.statusCode, 400);
  result = await call(app, "POST", "/rest/api/2/worklog/list", { ids: ["40000"] });
  assert.equal(result.response.statusCode, 400);
  result = await call(
    app,
    "GET",
    "/rest/api/2/jql/autocompletedata/suggestions?startAt=-1",
  );
  assert.equal(result.response.statusCode, 400);

  const createdComment = await call(app, "POST", "/rest/api/2/issue/T100ZB-2/comment", {
    body: "Persistent comment property target.",
  });
  const commentId = object(createdComment.body).id as string;
  result = await call(
    app,
    "PUT",
    `/rest/api/2/comment/${commentId}/properties/persistent.context`,
    { retained: true },
  );
  assert.equal(result.response.statusCode, 201);

  result = await call(app, "POST", "/rest/api/2/issueLink", {
    type: { id: "10002" },
    inwardIssue: { key: "T100ZB-2" },
    outwardIssue: { key: "T100ZB-3" },
  });
  assert.equal(result.response.statusCode, 201);

  result = await call(app, "DELETE", "/rest/api/2/attachment/30001");
  assert.equal(result.response.statusCode, 204);

  await app.close();
  app = open();

  result = await call(
    app,
    "GET",
    `/rest/api/2/comment/${commentId}/properties/persistent.context`,
  );
  assert.equal(result.response.statusCode, 200);
  assert.deepEqual(JSON.parse(object(result.body).value), { retained: true });
  result = await call(app, "GET", "/rest/api/2/issueLink/50001");
  assert.equal(result.response.statusCode, 200);
  result = await call(app, "GET", "/rest/api/2/attachment/30001");
  assert.equal(result.response.statusCode, 404);

  result = await call(app, "POST", "/__admin/reset");
  assert.equal(result.response.statusCode, 204);
  result = await call(
    app,
    "GET",
    `/rest/api/2/comment/${commentId}/properties/persistent.context`,
  );
  assert.equal(result.response.statusCode, 404);
  result = await call(app, "GET", "/rest/api/2/issueLink/50001");
  assert.equal(result.response.statusCode, 404);
  result = await call(app, "GET", "/rest/api/2/issueLink/50000");
  assert.equal(result.response.statusCode, 200);
  result = await call(app, "GET", "/rest/api/2/attachment/30001");
  assert.equal(result.response.statusCode, 200);
});
