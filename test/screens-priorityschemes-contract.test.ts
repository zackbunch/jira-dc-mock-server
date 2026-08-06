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
  const directory = mkdtempSync(join(tmpdir(), "jira-screens-priorityschemes-"));
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

test("all screens and priority scheme success operations follow the pinned contract", async (t) => {
  const app = fixture(t).open();

  let result = await call(
    app,
    "GET",
    "/rest/api/2/priorityschemes?startAt=1&maxResults=1&expand=schemes.projectKeys",
  );
  assert.equal(result.response.statusCode, 200);
  assertMatchesResponse("/api/2/priorityschemes", "get", 200, result.body);
  let body = object(result.body);
  assert.equal(body.startAt, 1);
  assert.equal(body.maxResults, 1);
  assert.equal(body.total, 2);
  assert.deepEqual(body.schemes[0].projectKeys, ["T100ZB"]);

  result = await call(app, "POST", "/rest/api/2/priorityschemes", {
    name: "Shared Delivery Priorities",
    description: "Priority scheme for shared delivery work.",
    optionIds: ["1", "2", "3"],
    defaultOptionId: "2",
    projectKeys: ["T101OPS"],
  });
  assert.equal(result.response.statusCode, 201);
  assertMatchesResponse("/api/2/priorityschemes", "post", 201, result.body);
  const createdScheme = object(result.body);
  assert.equal(createdScheme.id, 10001);
  assert.deepEqual(createdScheme.projectKeys, ["T101OPS"]);

  result = await call(app, "GET", `/rest/api/2/priorityschemes/${createdScheme.id}`);
  assert.equal(result.response.statusCode, 200);
  assertMatchesResponse("/api/2/priorityschemes/{schemeId}", "get", 200, result.body);
  assert.equal(object(result.body).name, "Shared Delivery Priorities");

  result = await call(app, "PUT", `/rest/api/2/priorityschemes/${createdScheme.id}`, {
    name: "Shared Engineering Priorities",
    description: "Updated priority scheme.",
    optionIds: ["1", "2", "3", "4"],
    defaultOptionId: "3",
    projectKeys: ["T101LIB"],
  });
  assert.equal(result.response.statusCode, 200);
  assertMatchesResponse("/api/2/priorityschemes/{schemeId}", "put", 200, result.body);
  assert.deepEqual(object(result.body).projectKeys, ["T101LIB"]);

  result = await call(app, "DELETE", `/rest/api/2/priorityschemes/${createdScheme.id}`);
  assert.equal(result.response.statusCode, 204);
  assert.equal(result.response.body, "");
  assertEmptyResponseDocumented("/api/2/priorityschemes/{schemeId}", "delete", 204);

  result = await call(app, "GET", "/rest/api/2/priorityschemes/0");
  assert.deepEqual(object(result.body).projectKeys, ["T101LIB", "T101OPS"]);

  result = await call(
    app,
    "GET",
    "/rest/api/2/screens?search=default&expand=tabs&startAt=0&maxResults=1",
  );
  assert.equal(result.response.statusCode, 201);
  // The pinned operation has no response schema due to a generated-contract defect.
  assertEmptyResponseDocumented("/api/2/screens", "get", 201);
  body = object(result.body);
  assert.equal(body.total, 1);
  assert.equal(body.values[0].name, "Default Screen");
  assert.equal(body.values[0].tabs.length, 2);

  result = await call(app, "GET", "/rest/api/2/screens/1/availableFields");
  assert.equal(result.response.statusCode, 200);
  assertArrayItemsMatchResponse(
    "/api/2/screens/{screenId}/availableFields",
    "get",
    200,
    result.body,
  );
  assert.ok((result.body as { id: string }[]).some((field) => field.id === "labels"));

  result = await call(app, "GET", "/rest/api/2/screens/1/tabs?projectKey=T100ZB");
  assert.equal(result.response.statusCode, 200);
  assertArrayItemsMatchResponse("/api/2/screens/{screenId}/tabs", "get", 200, result.body);
  assert.deepEqual(
    (result.body as { id: number }[]).map((tab) => tab.id),
    [10000, 10001],
  );

  result = await call(app, "POST", "/rest/api/2/screens/1/tabs", {
    name: "Deployment",
  });
  assert.equal(result.response.statusCode, 200);
  assertMatchesResponse("/api/2/screens/{screenId}/tabs", "post", 200, result.body);
  const tabId = object(result.body).id as number;

  result = await call(app, "PUT", `/rest/api/2/screens/1/tabs/${tabId}`, {
    name: "Release deployment",
  });
  assert.equal(result.response.statusCode, 200);
  assertMatchesResponse("/api/2/screens/{screenId}/tabs/{tabId}", "put", 200, result.body);
  assert.equal(object(result.body).name, "Release deployment");

  result = await call(app, "POST", `/rest/api/2/screens/1/tabs/${tabId}/move/0`);
  assert.equal(result.response.statusCode, 204);
  assert.equal(result.response.body, "");
  assertEmptyResponseDocumented(
    "/api/2/screens/{screenId}/tabs/{tabId}/move/{pos}",
    "post",
    204,
  );

  result = await call(app, "GET", "/rest/api/2/screens/1/tabs");
  assert.equal((result.body as { id: number }[])[0].id, tabId);

  result = await call(app, "DELETE", `/rest/api/2/screens/1/tabs/${tabId}`);
  assert.equal(result.response.statusCode, 204);
  assert.equal(result.response.body, "");
  assertEmptyResponseDocumented(
    "/api/2/screens/{screenId}/tabs/{tabId}",
    "delete",
    204,
  );

  result = await call(
    app,
    "GET",
    "/rest/api/2/screens/1/tabs/10000/fields?projectKey=T101LIB",
  );
  assert.equal(result.response.statusCode, 200);
  assertArrayItemsMatchResponse(
    "/api/2/screens/{screenId}/tabs/{tabId}/fields",
    "get",
    200,
    result.body,
  );
  assert.equal((result.body as { id: string }[])[0].id, "summary");

  result = await call(app, "POST", "/rest/api/2/screens/1/tabs/10000/fields", {
    fieldId: "customfield_10002",
  });
  assert.equal(result.response.statusCode, 200);
  assertMatchesResponse(
    "/api/2/screens/{screenId}/tabs/{tabId}/fields",
    "post",
    200,
    result.body,
  );
  assert.equal(object(result.body).type, "custom");

  result = await call(
    app,
    "PUT",
    "/rest/api/2/screens/1/tabs/10000/fields/customfield_10002/updateShowWhenEmptyIndicator/true",
  );
  assert.equal(result.response.statusCode, 204);
  assert.equal(result.response.body, "");
  assertEmptyResponseDocumented(
    "/api/2/screens/{screenId}/tabs/{tabId}/fields/{id}/updateShowWhenEmptyIndicator/{newValue}",
    "put",
    204,
  );

  result = await call(
    app,
    "POST",
    "/rest/api/2/screens/1/tabs/10000/fields/customfield_10002/move",
    { position: "First" },
  );
  assert.equal(result.response.statusCode, 204);
  assert.equal(result.response.body, "");
  assertEmptyResponseDocumented(
    "/api/2/screens/{screenId}/tabs/{tabId}/fields/{id}/move",
    "post",
    204,
  );

  result = await call(app, "GET", "/rest/api/2/screens/1/tabs/10000/fields");
  assert.equal((result.body as { id: string; showWhenEmpty: boolean }[])[0].id, "customfield_10002");
  assert.equal(
    (result.body as { id: string; showWhenEmpty: boolean }[])[0].showWhenEmpty,
    true,
  );

  result = await call(
    app,
    "POST",
    "/rest/api/2/screens/1/tabs/10000/fields/customfield_10002/move",
    {
      after:
        "http://jira.test/rest/api/2/screens/1/tabs/10000/fields/status",
    },
  );
  assert.equal(result.response.statusCode, 204);
  result = await call(app, "GET", "/rest/api/2/screens/1/tabs/10000/fields");
  assert.equal((result.body as { id: string }[]).at(-1)?.id, "customfield_10002");

  result = await call(
    app,
    "DELETE",
    "/rest/api/2/screens/1/tabs/10000/fields/customfield_10002",
  );
  assert.equal(result.response.statusCode, 204);
  assert.equal(result.response.body, "");
  assertEmptyResponseDocumented(
    "/api/2/screens/{screenId}/tabs/{tabId}/fields/{id}",
    "delete",
    204,
  );

  result = await call(app, "POST", "/rest/api/2/screens/addToDefault/labels");
  assert.equal(result.response.statusCode, 204);
  assert.equal(result.response.body, "");
  assertEmptyResponseDocumented("/api/2/screens/addToDefault/{fieldId}", "post", 204);

  result = await call(app, "GET", "/rest/api/2/screens/1/tabs/10000/fields");
  assert.ok((result.body as { id: string }[]).some((field) => field.id === "labels"));
});

test("screens and priority schemes validate references, persist, restart, and reset", async (t) => {
  const { open } = fixture(t);
  let app = open();

  let result = await call(app, "POST", "/rest/api/2/priorityschemes", {
    name: "Invalid priorities",
    optionIds: ["999"],
    defaultOptionId: "999",
  });
  assert.equal(result.response.statusCode, 400);
  assert.ok(Array.isArray(object(result.body).errorMessages));

  result = await call(app, "POST", "/rest/api/2/priorityschemes", {
    name: "Invalid project association",
    optionIds: ["1", "2"],
    defaultOptionId: "2",
    projectKeys: ["MISSING"],
  });
  assert.equal(result.response.statusCode, 400);

  result = await call(app, "GET", "/rest/api/2/priorityschemes/99999");
  assert.equal(result.response.statusCode, 404);
  result = await call(app, "DELETE", "/rest/api/2/priorityschemes/0");
  assert.equal(result.response.statusCode, 400);
  result = await call(app, "GET", "/rest/api/2/priorityschemes?startAt=-1");
  assert.equal(result.response.statusCode, 400);

  result = await call(app, "GET", "/rest/api/2/screens/999/availableFields");
  assert.equal(result.response.statusCode, 400);
  result = await call(app, "GET", "/rest/api/2/screens/1/tabs?projectKey=MISSING");
  assert.equal(result.response.statusCode, 400);
  result = await call(app, "DELETE", "/rest/api/2/screens/2/tabs/10002");
  assert.equal(result.response.statusCode, 412);
  result = await call(
    app,
    "PUT",
    "/rest/api/2/screens/1/tabs/10000/fields/summary/updateShowWhenEmptyIndicator/not-bool",
  );
  assert.equal(result.response.statusCode, 400);

  result = await call(app, "POST", "/rest/api/2/priorityschemes", {
    name: "Persistent priorities",
    description: "Survives restart.",
    optionIds: ["1", "2", "3"],
    defaultOptionId: "2",
  });
  assert.equal(result.response.statusCode, 201);
  const schemeId = object(result.body).id as number;

  result = await call(app, "POST", "/rest/api/2/screens/1/tabs", {
    name: "Persistent tab",
  });
  assert.equal(result.response.statusCode, 200);
  const tabId = object(result.body).id as number;

  result = await call(app, "POST", `/rest/api/2/screens/1/tabs/${tabId}/fields`, {
    fieldId: "customfield_10003",
  });
  assert.equal(result.response.statusCode, 200);

  await app.close();
  app = open();

  result = await call(app, "GET", `/rest/api/2/priorityschemes/${schemeId}`);
  assert.equal(result.response.statusCode, 200);
  assert.equal(object(result.body).name, "Persistent priorities");
  result = await call(app, "GET", "/rest/api/2/screens/1/tabs");
  assert.ok((result.body as { id: number }[]).some((tab) => tab.id === tabId));
  result = await call(app, "GET", `/rest/api/2/screens/1/tabs/${tabId}/fields`);
  assert.deepEqual(
    (result.body as { id: string }[]).map((field) => field.id),
    ["customfield_10003"],
  );

  result = await call(app, "POST", "/__admin/reset");
  assert.equal(result.response.statusCode, 204);
  result = await call(app, "GET", `/rest/api/2/priorityschemes/${schemeId}`);
  assert.equal(result.response.statusCode, 404);
  result = await call(app, "GET", "/rest/api/2/screens/1/tabs");
  assert.deepEqual(
    (result.body as { id: number }[]).map((tab) => tab.id),
    [10000, 10001],
  );
  result = await call(app, "GET", "/rest/api/2/screens/1/tabs/10000/fields");
  assert.deepEqual(
    (result.body as { id: string }[]).map((field) => field.id),
    ["summary", "description", "status"],
  );
});
