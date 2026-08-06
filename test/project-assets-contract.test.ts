import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import {
  assertArrayItemsMatchResponse,
  assertEmptyResponseDocumented,
  assertMatchesResponse,
  authorization,
} from "./helpers/official-contract.js";

type Method = "GET" | "POST" | "PUT" | "DELETE";

async function request(
  app: FastifyInstance,
  method: Method,
  url: string,
  payload?: Record<string, unknown>,
) {
  return app.inject({
    method,
    url,
    headers: {
      ...authorization,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    payload,
  });
}

function json(response: Awaited<ReturnType<typeof request>>): Record<string, any> {
  return response.json() as Record<string, any>;
}

test("all project asset success operations follow the pinned Jira contract", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "jira-project-assets-contract-"));
  const app = buildApp({ dataFile: join(directory, "state.json"), baseUrl: "http://jira.test" });
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  let response = await request(app, "GET", "/rest/api/2/component/11000");
  assert.equal(response.statusCode, 200);
  let body = json(response);
  assertMatchesResponse("/api/2/component/{id}", "get", 200, body);
  assert.equal(body.project, "T101LIB");
  assert.equal(body.name, "Shared libraries");

  response = await request(app, "GET", "/rest/api/2/component/11000/relatedIssueCounts");
  assert.equal(response.statusCode, 200);
  body = json(response);
  assertMatchesResponse("/api/2/component/{id}/relatedIssueCounts", "get", 200, body);
  assert.equal(body.issueCount, 2);

  response = await request(
    app,
    "GET",
    "/rest/api/2/component/page?projectIds=10000&query=shared&startAt=0&maxResults=1",
  );
  assert.equal(response.statusCode, 200);
  body = json(response);
  assertMatchesResponse("/api/2/component/page", "get", 200, body);
  assert.equal(body.total, 1);
  assert.equal(body.values.length, 1);
  assert.equal(body.values[0].id, "11000");

  response = await request(app, "POST", "/rest/api/2/component", {
    name: "API gateway",
    description: "Gateway integration",
    project: "T101LIB",
    leadUserName: "developer",
    assigneeType: "COMPONENT_LEAD",
  });
  assert.equal(response.statusCode, 201);
  const createdComponent = json(response);
  assertMatchesResponse("/api/2/component", "post", 201, createdComponent);
  assert.equal(createdComponent.id, "11003");

  response = await request(app, "PUT", `/rest/api/2/component/${createdComponent.id}`, {
    name: "Edge gateway",
    description: "Updated gateway integration",
    assigneeType: "PROJECT_LEAD",
  });
  assert.equal(response.statusCode, 200);
  body = json(response);
  assertMatchesResponse("/api/2/component/{id}", "put", 200, body);
  assert.equal(body.name, "Edge gateway");

  response = await request(
    app,
    "DELETE",
    `/rest/api/2/component/11000?moveIssuesTo=${createdComponent.id}`,
  );
  assert.equal(response.statusCode, 204);
  assert.equal(response.body, "");
  assertEmptyResponseDocumented("/api/2/component/{id}", "delete", 204);

  response = await request(
    app,
    "GET",
    `/rest/api/2/component/${createdComponent.id}/relatedIssueCounts`,
  );
  assert.equal(response.statusCode, 200);
  assert.equal(json(response).issueCount, 2);

  response = await request(app, "GET", "/rest/api/2/projectCategory");
  assert.equal(response.statusCode, 200);
  const categories = response.json() as unknown;
  // The generated contract references the item schema for this list operation.
  assertArrayItemsMatchResponse("/api/2/projectCategory", "get", 200, categories);

  response = await request(app, "POST", "/rest/api/2/projectCategory", {
    name: "Developer Experience",
    description: "Developer experience projects",
  });
  assert.equal(response.statusCode, 201);
  const createdCategory = json(response);
  assertMatchesResponse("/api/2/projectCategory", "post", 201, createdCategory);

  response = await request(app, "GET", `/rest/api/2/projectCategory/${createdCategory.id}`);
  assert.equal(response.statusCode, 200);
  body = json(response);
  assertMatchesResponse("/api/2/projectCategory/{id}", "get", 200, body);
  assert.equal(body.name, "Developer Experience");

  response = await request(app, "PUT", `/rest/api/2/projectCategory/${createdCategory.id}`, {
    name: "Engineering Experience",
    description: "Updated category",
  });
  assert.equal(response.statusCode, 200);
  body = json(response);
  assertMatchesResponse("/api/2/projectCategory/{id}", "put", 200, body);
  assert.equal(body.name, "Engineering Experience");

  response = await request(app, "DELETE", `/rest/api/2/projectCategory/${createdCategory.id}`);
  assert.equal(response.statusCode, 204);
  assert.equal(response.body, "");
  assertEmptyResponseDocumented("/api/2/projectCategory/{id}", "delete", 204);

  response = await request(
    app,
    "GET",
    "/rest/api/2/version?projectIds=10002&query=platform&startAt=0&maxResults=1",
  );
  assert.equal(response.statusCode, 200);
  body = json(response);
  // The generated contract references VersionBean instead of the returned page.
  assertMatchesResponse("/api/2/version", "get", 200, body);
  assert.equal(body.total, 2);
  assert.equal(body.values.length, 1);
  assert.equal(body.isLast, false);

  response = await request(app, "POST", "/rest/api/2/version", {
    name: "Platform GA",
    description: "General availability",
    projectId: 10002,
    startDate: "2026-03-01",
    releaseDate: "2026-04-01",
  });
  assert.equal(response.statusCode, 201);
  const createdVersion = json(response);
  assertMatchesResponse("/api/2/version", "post", 201, createdVersion);
  assert.equal(createdVersion.project, "T100ZB");

  response = await request(app, "GET", `/rest/api/2/version/${createdVersion.id}?expand=operations`);
  assert.equal(response.statusCode, 200);
  body = json(response);
  assertMatchesResponse("/api/2/version/{id}", "get", 200, body);
  assert.equal(body.expand, "operations");

  response = await request(app, "PUT", `/rest/api/2/version/${createdVersion.id}`, {
    name: "Platform 2.0",
    released: true,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, "");
  assertEmptyResponseDocumented("/api/2/version/{id}", "put", 200);

  response = await request(app, "POST", "/rest/api/2/version/12004/move", {
    position: "First",
  });
  assert.equal(response.statusCode, 200);
  body = json(response);
  assertMatchesResponse("/api/2/version/{id}/move", "post", 200, body);
  assert.equal(body.id, "12004");

  response = await request(app, "POST", `/rest/api/2/version/${createdVersion.id}/move`, {
    after: "http://jira.test/rest/api/2/version/12004",
  });
  assert.equal(response.statusCode, 200);
  assertMatchesResponse("/api/2/version/{id}/move", "post", 200, json(response));

  response = await request(app, "GET", "/rest/api/2/version?projectIds=10002&maxResults=10");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    json(response).values.slice(0, 2).map((version: { id: string }) => version.id),
    ["12004", createdVersion.id],
  );

  response = await request(app, "GET", "/rest/api/2/version/12004/relatedIssueCounts");
  assert.equal(response.statusCode, 200);
  body = json(response);
  assertMatchesResponse("/api/2/version/{id}/relatedIssueCounts", "get", 200, body);
  assert.equal(body.issuesFixedCount, 3);

  response = await request(app, "GET", "/rest/api/2/version/12004/unresolvedIssueCount");
  assert.equal(response.statusCode, 200);
  body = json(response);
  assertMatchesResponse("/api/2/version/{id}/unresolvedIssueCount", "get", 200, body);
  assert.equal(body.issuesUnresolvedCount, 3);

  response = await request(
    app,
    "GET",
    "/rest/api/2/version/remotelink?globalId=build-platform-beta",
  );
  assert.equal(response.statusCode, 200);
  body = json(response);
  assertMatchesResponse("/api/2/version/remotelink", "get", 200, body);
  assert.equal(body.links.length, 1);

  response = await request(app, "GET", "/rest/api/2/version/12004/remotelink");
  assert.equal(response.statusCode, 200);
  body = json(response);
  assertMatchesResponse("/api/2/version/{versionId}/remotelink", "get", 200, body);
  assert.equal(body.links.length, 1);

  response = await request(
    app,
    "GET",
    "/rest/api/2/version/12004/remotelink/build-platform-beta",
  );
  assert.equal(response.statusCode, 200);
  body = json(response);
  assertMatchesResponse(
    "/api/2/version/{versionId}/remotelink/{globalId}",
    "get",
    200,
    body,
  );
  assert.equal(body.name, "Platform Beta build");

  response = await request(
    app,
    "POST",
    "/rest/api/2/version/12004/remotelink/deployment-platform-beta",
    {
      name: "Platform Beta deployment",
      link: JSON.stringify({ rel: "deployment", url: "https://deploy.example.test/12004" }),
    },
  );
  assert.equal(response.statusCode, 201);
  assert.equal(response.body, "");
  assertEmptyResponseDocumented(
    "/api/2/version/{versionId}/remotelink/{globalId}",
    "post",
    201,
  );

  response = await request(
    app,
    "DELETE",
    "/rest/api/2/version/12004/remotelink/deployment-platform-beta",
  );
  assert.equal(response.statusCode, 204);
  assert.equal(response.body, "");
  assertEmptyResponseDocumented(
    "/api/2/version/{versionId}/remotelink/{globalId}",
    "delete",
    204,
  );

  response = await request(app, "POST", "/rest/api/2/version/12004/remotelink", {
    name: "Release notes",
    link: JSON.stringify({ rel: "release-notes", url: "https://docs.example.test/beta" }),
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.body, "");
  assertEmptyResponseDocumented("/api/2/version/{versionId}/remotelink", "post", 201);

  response = await request(app, "DELETE", "/rest/api/2/version/12004/remotelink");
  assert.equal(response.statusCode, 204);
  assert.equal(response.body, "");
  assertEmptyResponseDocumented("/api/2/version/{versionId}/remotelink", "delete", 204);

  response = await request(app, "GET", "/rest/api/2/version/12004/remotelink");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(json(response).links, []);

  response = await request(app, "PUT", "/rest/api/2/version/12000/mergeto/12001");
  assert.equal(response.statusCode, 204);
  assert.equal(response.body, "");
  assertEmptyResponseDocumented("/api/2/version/{id}/mergeto/{moveIssuesTo}", "put", 204);

  response = await request(app, "GET", "/rest/api/2/version/12001/relatedIssueCounts");
  assert.equal(response.statusCode, 200);
  assert.equal(json(response).issuesFixedCount, 2);
  assert.equal(json(response).issuesAffectedCount, 1);

  response = await request(app, "POST", "/rest/api/2/version/12003/removeAndSwap", {
    moveFixIssuesTo: 12004,
    moveAffectedIssuesTo: 12004,
    customFieldReplacementList: [],
  });
  assert.equal(response.statusCode, 204);
  assert.equal(response.body, "");
  assertEmptyResponseDocumented("/api/2/version/{id}/removeAndSwap", "post", 204);

  response = await request(app, "GET", "/rest/api/2/version/12004/relatedIssueCounts");
  assert.equal(response.statusCode, 200);
  assert.equal(json(response).issuesFixedCount, 5);
  assert.equal(json(response).issuesAffectedCount, 2);
});

test("project assets reject bad references and persist across restart and reset", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "jira-project-assets-state-"));
  const dataFile = join(directory, "state.json");
  let app = buildApp({ dataFile, baseUrl: "http://jira.test" });
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  let response = await request(app, "POST", "/rest/api/2/component", {
    name: "Invalid component",
    project: "MISSING",
  });
  assert.equal(response.statusCode, 404);
  assert.ok(Array.isArray(json(response).errorMessages));

  response = await request(app, "POST", "/rest/api/2/version", {
    name: "Invalid version",
    projectId: 99999,
  });
  assert.equal(response.statusCode, 404);

  response = await request(app, "POST", "/rest/api/2/projectCategory", {
    name: "Shared Services",
  });
  assert.equal(response.statusCode, 409);

  response = await request(app, "POST", "/rest/api/2/version/12004/remotelink/bad-json", {
    name: "Malformed link",
    link: "not-json",
  });
  assert.equal(response.statusCode, 400);

  response = await request(app, "POST", "/rest/api/2/version/12004/removeAndSwap", {
    moveFixIssuesTo: 99999,
  });
  assert.equal(response.statusCode, 400);

  response = await request(app, "POST", "/rest/api/2/component", {
    name: "Persistent component",
    project: "T100ZB",
  });
  assert.equal(response.statusCode, 201);
  const componentId = json(response).id as string;

  response = await request(app, "POST", "/rest/api/2/projectCategory", {
    name: "Persistent category",
  });
  assert.equal(response.statusCode, 201);
  const categoryId = json(response).id as string;

  response = await request(app, "POST", "/rest/api/2/version", {
    name: "Persistent version",
    project: "T100ZB",
  });
  assert.equal(response.statusCode, 201);
  const versionId = json(response).id as string;

  response = await request(
    app,
    "POST",
    `/rest/api/2/version/${versionId}/remotelink/persistent-link`,
    { name: "Persistent link", link: "{}" },
  );
  assert.equal(response.statusCode, 201);

  await app.close();
  app = buildApp({ dataFile, baseUrl: "http://jira.test" });

  for (const url of [
    `/rest/api/2/component/${componentId}`,
    `/rest/api/2/projectCategory/${categoryId}`,
    `/rest/api/2/version/${versionId}`,
    `/rest/api/2/version/${versionId}/remotelink/persistent-link`,
  ]) {
    response = await request(app, "GET", url);
    assert.equal(response.statusCode, 200, url);
  }

  response = await request(app, "POST", "/__admin/reset");
  assert.equal(response.statusCode, 204);

  for (const url of [
    `/rest/api/2/component/${componentId}`,
    `/rest/api/2/projectCategory/${categoryId}`,
    `/rest/api/2/version/${versionId}`,
  ]) {
    response = await request(app, "GET", url);
    assert.equal(response.statusCode, 404, url);
  }

  response = await request(app, "GET", "/rest/api/2/component/11000");
  assert.equal(response.statusCode, 200);
  response = await request(app, "GET", "/rest/api/2/version/12004/remotelink/build-platform-beta");
  assert.equal(response.statusCode, 200);
});
