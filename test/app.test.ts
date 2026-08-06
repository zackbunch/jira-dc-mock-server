import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { buildApp } from "../src/app.js";

const authorization = { authorization: "Bearer local-test-token" };

function testApp(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "jira-mock-"));
  const app = buildApp({
    dataFile: join(directory, "state.json"),
    baseUrl: "http://jira.test",
  });
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return app;
}

test("serves Swagger UI and an OpenAPI document", async (t) => {
  const app = testApp(t);
  const uiResponse = await app.inject({ method: "GET", url: "/documentation/" });
  const specificationResponse = await app.inject({
    method: "GET",
    url: "/documentation/json",
  });

  assert.equal(uiResponse.statusCode, 200);
  assert.match(uiResponse.headers["content-type"] ?? "", /text\/html/);
  assert.equal(specificationResponse.statusCode, 200);
  const specification = specificationResponse.json();
  assert.equal(specification.info.title, "Jira Data Center 10.3.5 Mock API");
  assert.ok(specification.paths["/rest/api/2/search"].post);
  assert.ok(specification.paths["/rest/api/2/issue/{issueIdOrKey}/transitions"].post);
});

test("requires Jira authentication", async (t) => {
  const app = testApp(t);
  const response = await app.inject({ method: "GET", url: "/rest/api/2/myself" });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), {
    errorMessages: ["Client must be authenticated to access this resource."],
    errors: {},
  });
});

test("reports Jira Data Center 10.3.5 server information", async (t) => {
  const app = testApp(t);
  const response = await app.inject({
    method: "GET",
    url: "/rest/api/2/serverInfo",
    headers: authorization,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().version, "10.3.5");
  assert.equal(response.json().deploymentType, "Data Center");
  assert.equal("healthChecks" in response.json(), false);
});

test("searches seeded issues with JQL and pagination", async (t) => {
  const app = testApp(t);
  const response = await app.inject({
    method: "POST",
    url: "/rest/api/2/search",
    headers: authorization,
    payload: {
      jql: 'project = T101LIB AND status = "To Do" ORDER BY created DESC',
      fields: ["summary", "status"],
      maxResults: 10,
    },
  });

  assert.equal(response.statusCode, 200);
  const result = response.json();
  assert.equal(result.total, 1);
  assert.equal(result.issues[0].key, "T101LIB-2");
  assert.deepEqual(Object.keys(result.issues[0].fields).sort(), ["status", "summary"]);
});

test("seeds a varied software factory backlog", async (t) => {
  const app = testApp(t);
  const response = await app.inject({
    method: "POST",
    url: "/rest/api/2/search",
    headers: authorization,
    payload: {
      jql: "project = T100ZB ORDER BY key ASC",
      fields: ["summary", "status", "priority", "labels"],
      maxResults: 50,
    },
  });

  assert.equal(response.statusCode, 200);
  const result = response.json();
  assert.equal(result.total, 12);
  assert.equal(result.issues[0].key, "T100ZB-1");
  assert.equal(result.issues.at(-1).key, "T100ZB-12");
  assert.deepEqual(
    new Set(result.issues.map((issue: { fields: { status: { name: string } } }) => issue.fields.status.name)),
    new Set(["To Do", "In Progress", "Done"]),
  );
});

test("creates, edits, comments on, and transitions an issue", async (t) => {
  const app = testApp(t);
  const createdResponse = await app.inject({
    method: "POST",
    url: "/rest/api/2/issue",
    headers: authorization,
    payload: {
      fields: {
        project: { key: "T100ZB" },
        issuetype: { name: "Bug" },
        summary: "Agent-created issue",
        description: "Created during a local integration test.",
        labels: ["agent"],
      },
    },
  });
  assert.equal(createdResponse.statusCode, 201);
  const created = createdResponse.json();
  assert.equal(created.key, "T100ZB-13");

  const editResponse = await app.inject({
    method: "PUT",
    url: `/rest/api/2/issue/${created.key}`,
    headers: authorization,
    payload: { fields: { assignee: { name: "alex" }, customfield_10002: 8 } },
  });
  assert.equal(editResponse.statusCode, 204);

  const commentResponse = await app.inject({
    method: "POST",
    url: `/rest/api/2/issue/${created.key}/comment`,
    headers: authorization,
    payload: { body: "Investigating this issue." },
  });
  assert.equal(commentResponse.statusCode, 201);
  assert.equal(commentResponse.json().body, "Investigating this issue.");

  const transitionsResponse = await app.inject({
    method: "GET",
    url: `/rest/api/2/issue/${created.key}/transitions`,
    headers: authorization,
  });
  assert.equal(transitionsResponse.statusCode, 200);
  assert.equal(transitionsResponse.json().transitions[0].id, "21");

  const transitionResponse = await app.inject({
    method: "POST",
    url: `/rest/api/2/issue/${created.key}/transitions`,
    headers: authorization,
    payload: { transition: { id: "21" } },
  });
  assert.equal(transitionResponse.statusCode, 204);

  const issueResponse = await app.inject({
    method: "GET",
    url: `/rest/api/2/issue/${created.key}`,
    headers: authorization,
  });
  const issue = issueResponse.json();
  assert.equal(issue.fields.assignee.name, "alex");
  assert.equal(issue.fields.status.name, "In Progress");
  assert.equal(issue.fields.customfield_10002, 8);
  assert.equal(issue.fields.comment.total, 1);
});

test("returns Jira-shaped validation errors", async (t) => {
  const app = testApp(t);
  const response = await app.inject({
    method: "POST",
    url: "/rest/api/2/issue",
    headers: authorization,
    payload: { fields: { project: { key: "MISSING" } } },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().errors.project, "project is required and must identify a visible project");
  assert.ok(response.json().errors.summary);
});
