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
  const directory = mkdtempSync(join(tmpdir(), "jira-schemes-contract-"));
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

async function request(app: ReturnType<typeof buildApp>, method: Method, url: string, payload?: Record<string, unknown>) {
  const response = await app.inject({ method, url, headers: authorization, ...(payload === undefined ? {} : { payload }) });
  return { response, body: response.body.length ? response.json() : undefined };
}

test("scheme and security read operations match official response schemas", async (t) => {
  const app = fixture(t).open();

  const securitySchemes = await request(app, "GET", "/rest/api/2/issuesecurityschemes");
  assert.equal(securitySchemes.response.statusCode, 200);
  assertMatchesResponse("/api/2/issuesecurityschemes", "get", 200, securitySchemes.body);
  const securityItems = (securitySchemes.body as { issueSecuritySchemes: { id: number; levels: unknown[] }[] }).issueSecuritySchemes;
  assert.ok(securityItems.length > 0);
  assert.ok(securityItems[0].levels.length > 0);

  const securityScheme = await request(app, "GET", `/rest/api/2/issuesecurityschemes/${securityItems[0].id}`);
  assertMatchesResponse("/api/2/issuesecurityschemes/{id}", "get", 200, securityScheme.body);
  const securityLevel = await request(app, "GET", "/rest/api/2/securitylevel/10000");
  assertMatchesResponse("/api/2/securitylevel/{id}", "get", 200, securityLevel.body);
  assert.equal((securityLevel.body as { name: string }).name, "Internal");

  const issueTypeSchemes = await request(app, "GET", "/rest/api/2/issuetypescheme");
  assertMatchesResponse("/api/2/issuetypescheme", "get", 200, issueTypeSchemes.body);
  assert.ok((issueTypeSchemes.body as { schemes: { issueTypes: unknown[] }[] }).schemes[0].issueTypes.length > 0);
  const issueTypeScheme = await request(app, "GET", "/rest/api/2/issuetypescheme/10000");
  assertMatchesResponse("/api/2/issuetypescheme/{schemeId}", "get", 200, issueTypeScheme.body);
  const associations = await request(app, "GET", "/rest/api/2/issuetypescheme/10000/associations?expand=lead");
  assertArrayItemsMatchResponse("/api/2/issuetypescheme/{schemeId}/associations", "get", 200, associations.body);

  const notifications = await request(app, "GET", "/rest/api/2/notificationscheme?expand=notificationSchemeEvents&startAt=0&maxResults=1");
  assertMatchesResponse("/api/2/notificationscheme", "get", 200, notifications.body);
  const notificationPage = notifications.body as { startAt: number; maxResults: number; total: number; values: { id: number }[]; isLast: boolean };
  assert.equal(notificationPage.values.length, 1);
  assert.equal(notificationPage.total, 2);
  assert.equal(notificationPage.isLast, false);
  const notification = await request(app, "GET", `/rest/api/2/notificationscheme/${notificationPage.values[0].id}?expand=notificationSchemeEvents`);
  assertMatchesResponse("/api/2/notificationscheme/{id}", "get", 200, notification.body);

  const permissionSchemes = await request(app, "GET", "/rest/api/2/permissionscheme?expand=permissions");
  assertMatchesResponse("/api/2/permissionscheme", "get", 200, permissionSchemes.body);
  assert.ok((permissionSchemes.body as { permissionSchemes: { permissions: unknown[] }[] }).permissionSchemes[0].permissions.length > 0);
  const permissionScheme = await request(app, "GET", "/rest/api/2/permissionscheme/10000?expand=permissions");
  assertMatchesResponse("/api/2/permissionscheme/{schemeId}", "get", 200, permissionScheme.body);
  const grants = await request(app, "GET", "/rest/api/2/permissionscheme/10000/permission?expand=holder");
  assertMatchesResponse("/api/2/permissionscheme/{schemeId}/permission", "get", 200, grants.body);
  const grantId = (grants.body as { permissions: { id: number }[] }).permissions[0].id;
  const grant = await request(app, "GET", `/rest/api/2/permissionscheme/10000/permission/${grantId}?expand=holder`);
  assertMatchesResponse("/api/2/permissionscheme/{schemeId}/permission/{permissionId}", "get", 200, grant.body);
  const attribute = await request(app, "GET", "/rest/api/2/permissionscheme/10000/attribute/scope");
  assertMatchesResponse("/api/2/permissionscheme/{permissionSchemeId}/attribute/{attributeKey}", "get", 200, attribute.body);
  assert.equal((attribute.body as { value: string }).value, "default");
});

test("scheme mutations validate references and return documented response bodies", async (t) => {
  const app = fixture(t).open();

  const createdTypeScheme = await request(app, "POST", "/rest/api/2/issuetypescheme", {
    name: "Agent Scheme", description: "Synthetic test scheme", defaultIssueTypeId: "10001", issueTypeIds: ["10001", "10002"],
  });
  assert.equal(createdTypeScheme.response.statusCode, 200);
  assertMatchesResponse("/api/2/issuetypescheme", "post", 200, createdTypeScheme.body);
  const typeSchemeId = (createdTypeScheme.body as { id: string }).id;

  const updatedTypeScheme = await request(app, "PUT", `/rest/api/2/issuetypescheme/${typeSchemeId}`, {
    name: "Agent Delivery Scheme", description: "Updated", defaultIssueTypeId: "10002", issueTypeIDs: ["10001", "10002", "10003"],
  });
  assertMatchesResponse("/api/2/issuetypescheme/{schemeId}", "put", 200, updatedTypeScheme.body);
  assert.equal((updatedTypeScheme.body as { name: string }).name, "Agent Delivery Scheme");

  const setAssociations = await request(app, "PUT", `/rest/api/2/issuetypescheme/${typeSchemeId}/associations`, { idsOrKeys: ["T100ZB", "10001"] });
  assert.equal(setAssociations.response.statusCode, 200);
  assert.equal(setAssociations.response.body, "");
  assertEmptyResponseDocumented("/api/2/issuetypescheme/{schemeId}/associations", "put", 200);
  const removeAssociation = await request(app, "DELETE", `/rest/api/2/issuetypescheme/${typeSchemeId}/associations/T100ZB`);
  assert.equal(removeAssociation.response.statusCode, 204);
  assertEmptyResponseDocumented("/api/2/issuetypescheme/{schemeId}/associations/{projIdOrKey}", "delete", 204);
  const addAssociation = await request(app, "POST", `/rest/api/2/issuetypescheme/${typeSchemeId}/associations`, { idsOrKeys: ["T100ZB"] });
  assert.equal(addAssociation.response.statusCode, 200);
  assertEmptyResponseDocumented("/api/2/issuetypescheme/{schemeId}/associations", "post", 200);
  const removeAssociations = await request(app, "DELETE", `/rest/api/2/issuetypescheme/${typeSchemeId}/associations`);
  assert.equal(removeAssociations.response.statusCode, 204);
  assertEmptyResponseDocumented("/api/2/issuetypescheme/{schemeId}/associations", "delete", 204);
  const deleteTypeScheme = await request(app, "DELETE", `/rest/api/2/issuetypescheme/${typeSchemeId}`);
  assert.equal(deleteTypeScheme.response.statusCode, 204);
  assert.equal(deleteTypeScheme.response.body, "");
  assertEmptyResponseDocumented("/api/2/issuetypescheme/{schemeId}", "delete", 204);

  const createdPermissionScheme = await request(app, "POST", "/rest/api/2/permissionscheme?expand=permissions", {
    name: "Agent Permissions", description: "Synthetic permission scheme", permissions: [{ permission: "BROWSE_PROJECTS", holder: { type: "user", parameter: "developer" } }],
  });
  assert.equal(createdPermissionScheme.response.statusCode, 201);
  assertMatchesResponse("/api/2/permissionscheme", "post", 201, createdPermissionScheme.body);
  const permissionSchemeId = (createdPermissionScheme.body as { id: number }).id;

  const updatedPermissionScheme = await request(app, "PUT", `/rest/api/2/permissionscheme/${permissionSchemeId}?expand=permissions`, { name: "Agent Permissions Updated", description: "Updated scheme" });
  assertMatchesResponse("/api/2/permissionscheme/{schemeId}", "put", 200, updatedPermissionScheme.body);
  const setAttribute = await app.inject({ method: "PUT", url: `/rest/api/2/permissionscheme/${permissionSchemeId}/attribute/environment`, headers: { ...authorization, "content-type": "text/plain" }, payload: "test" });
  assert.equal(setAttribute.statusCode, 204);
  assert.equal(setAttribute.body, "");
  assertEmptyResponseDocumented("/api/2/permissionscheme/{permissionSchemeId}/attribute/{key}", "put", 204);

  const createdGrant = await request(app, "POST", `/rest/api/2/permissionscheme/${permissionSchemeId}/permission?expand=holder`, { permission: "CREATE_ISSUES", holder: { type: "group", parameter: "jira-software-users" } });
  assert.equal(createdGrant.response.statusCode, 201);
  assertMatchesResponse("/api/2/permissionscheme/{schemeId}/permission", "post", 201, createdGrant.body);
  const grantId = (createdGrant.body as { id: number }).id;
  const deletedGrant = await request(app, "DELETE", `/rest/api/2/permissionscheme/${permissionSchemeId}/permission/${grantId}`);
  assert.equal(deletedGrant.response.statusCode, 204);
  assert.equal(deletedGrant.response.body, "");
  assertEmptyResponseDocumented("/api/2/permissionscheme/{schemeId}/permission/{permissionId}", "delete", 204);

  const deletePermissionScheme = await request(app, "DELETE", `/rest/api/2/permissionscheme/${permissionSchemeId}`);
  assert.equal(deletePermissionScheme.response.statusCode, 204);
  assert.equal(deletePermissionScheme.response.body, "");
  assertEmptyResponseDocumented("/api/2/permissionscheme/{schemeId}", "delete", 204);

  const badIssueType = await request(app, "POST", "/rest/api/2/issuetypescheme", { name: "Invalid", defaultIssueTypeId: "99999", issueTypeIds: ["99999"] });
  assert.equal(badIssueType.response.statusCode, 400);
  assert.ok((badIssueType.body as { errors: Record<string, string> }).errors.issueTypeIds);
  const badProject = await request(app, "PUT", "/rest/api/2/issuetypescheme/10000/associations", { idsOrKeys: ["MISSING"] });
  assert.equal(badProject.response.statusCode, 400);
  const badUser = await request(app, "POST", "/rest/api/2/permissionscheme/10000/permission", { permission: "BROWSE_PROJECTS", holder: { type: "user", parameter: "missing" } });
  assert.equal(badUser.response.statusCode, 400);
  const missing = await request(app, "GET", "/rest/api/2/securitylevel/99999");
  assert.equal(missing.response.statusCode, 404);
  assert.deepEqual(Object.keys(missing.body as object).sort(), ["errorMessages", "errors"]);
  const badPage = await request(app, "GET", "/rest/api/2/notificationscheme?startAt=-1");
  assert.equal(badPage.response.statusCode, 400);
});

test("scheme state survives restart and reset restores deterministic seeds", async (t) => {
  const { open } = fixture(t);
  const first = open();
  const created = await request(first, "POST", "/rest/api/2/permissionscheme", { name: "Persistent Scheme", description: "Survives restart" });
  const id = (created.body as { id: number }).id;
  const association = await request(first, "POST", "/rest/api/2/issuetypescheme/10001/associations", { idsOrKeys: ["T101LIB"] });
  assert.equal(association.response.statusCode, 200);
  await first.close();

  const second = open();
  const persisted = await request(second, "GET", `/rest/api/2/permissionscheme/${id}`);
  assert.equal(persisted.response.statusCode, 200);
  assert.equal((persisted.body as { name: string }).name, "Persistent Scheme");
  const projects = await request(second, "GET", "/rest/api/2/issuetypescheme/10001/associations");
  assert.ok((projects.body as { key: string }[]).some((project) => project.key === "T101LIB"));

  const reset = await request(second, "POST", "/__admin/reset");
  assert.equal(reset.response.statusCode, 204);
  const afterReset = await request(second, "GET", `/rest/api/2/permissionscheme/${id}`);
  assert.equal(afterReset.response.statusCode, 404);
  const seeded = await request(second, "GET", "/rest/api/2/permissionscheme/10000");
  assert.equal((seeded.body as { name: string }).name, "Default Permission Scheme");
});
