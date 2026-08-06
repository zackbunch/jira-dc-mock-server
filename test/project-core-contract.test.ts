import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { buildApp } from "../src/app.js";
import { assertArrayItemsMatchResponse, assertEmptyResponseDocumented, assertMatchesResponse, assertMatchesSchema, authorization, operation, type OpenApiSchema } from "./helpers/official-contract.js";

type Method = "GET" | "POST" | "PUT" | "DELETE";
function fixture(t: TestContext) { const directory = mkdtempSync(join(tmpdir(), "jira-project-core-")); const dataFile = join(directory, "state.json"); const apps: ReturnType<typeof buildApp>[] = []; const open = () => { const app = buildApp({ dataFile, baseUrl: "http://jira.test" }); apps.push(app); return app; }; t.after(async () => { await Promise.all(apps.map(async (app) => app.close())); rmSync(directory, { recursive: true, force: true }); }); return { open }; }
async function req(app: ReturnType<typeof buildApp>, method: Method, url: string, payload?: Record<string, unknown>) { const response = await app.inject({ method, url, headers: authorization, ...(payload === undefined ? {} : { payload }) }); return { response, body: response.body.length ? response.json() : undefined }; }
function empty(path: string, method: string, status: number, result: Awaited<ReturnType<typeof req>>) { assert.equal(result.response.statusCode, status); assert.equal(result.response.body, ""); assertEmptyResponseDocumented(path, method, status); }

test("all project-core read operations follow Jira 10.3 response schemas", async (t) => {
  const app = fixture(t).open();
  const permissions = await req(app, "GET", "/rest/api/2/permissions");
  assertMatchesResponse("/api/2/permissions", "get", 200, permissions.body);
  assert.ok((permissions.body as { permissions: Record<string, unknown> }).permissions.BROWSE_PROJECTS);
  const mine = await req(app, "GET", "/rest/api/2/mypermissions?projectKey=T100ZB&issueKey=T100ZB-1");
  assertMatchesResponse("/api/2/mypermissions", "get", 200, mine.body);

  const types = await req(app, "GET", "/rest/api/2/project/type");
  assertArrayItemsMatchResponse("/api/2/project/type", "get", 200, types.body);
  for (const path of ["/rest/api/2/project/type/software", "/rest/api/2/project/type/software/accessible"]) {
    const result = await req(app, "GET", path);
    assertMatchesResponse(path.endsWith("accessible") ? "/api/2/project/type/{projectTypeKey}/accessible" : "/api/2/project/type/{projectTypeKey}", "get", 200, result.body);
  }

  const avatars = await req(app, "GET", "/rest/api/2/project/T100ZB/avatars");
  assertArrayItemsMatchResponse("/api/2/project/{projectIdOrKey}/avatars", "get", 200, avatars.body);
  const components = await req(app, "GET", "/rest/api/2/project/T100ZB/components");
  assertArrayItemsMatchResponse("/api/2/project/{projectIdOrKey}/components", "get", 200, components.body);
  const propertyKeys = await req(app, "GET", "/rest/api/2/project/T100ZB/properties");
  assertMatchesResponse("/api/2/project/{projectIdOrKey}/properties", "get", 200, propertyKeys.body);
  const roleMap = await req(app, "GET", "/rest/api/2/project/T100ZB/role");
  assert.equal(roleMap.response.statusCode, 200);
  assert.match((roleMap.body as Record<string, string>).Developers, /\/role\/10001$/);
  const projectRole = await req(app, "GET", "/rest/api/2/project/T100ZB/role/10001");
  assertMatchesResponse("/api/2/project/{projectIdOrKey}/role/{id}", "get", 200, projectRole.body);
  const statuses = await req(app, "GET", "/rest/api/2/project/T100ZB/statuses");
  assertArrayItemsMatchResponse("/api/2/project/{projectIdOrKey}/statuses", "get", 200, statuses.body);
  const versions = await req(app, "GET", "/rest/api/2/project/T100ZB/versions?expand=operations");
  assertArrayItemsMatchResponse("/api/2/project/{projectIdOrKey}/versions", "get", 200, versions.body);
  const versionPage = await req(app, "GET", "/rest/api/2/project/T100ZB/version?startAt=0&maxResults=1&orderBy=-name");
  assertMatchesResponse("/api/2/project/{projectIdOrKey}/version", "get", 200, versionPage.body);
  assert.equal((versionPage.body as { values: unknown[] }).values.length, 1);

  const securityScheme = await req(app, "GET", "/rest/api/2/project/T100ZB/issuesecuritylevelscheme");
  assertMatchesResponse("/api/2/project/{projectKeyOrId}/issuesecuritylevelscheme", "get", 200, securityScheme.body);
  const notificationScheme = await req(app, "GET", "/rest/api/2/project/T100ZB/notificationscheme?expand=notificationSchemeEvents");
  assertMatchesResponse("/api/2/project/{projectKeyOrId}/notificationscheme", "get", 200, notificationScheme.body);
  const permissionScheme = await req(app, "GET", "/rest/api/2/project/T100ZB/permissionscheme?expand=permissions");
  assertMatchesResponse("/api/2/project/{projectKeyOrId}/permissionscheme", "get", 200, permissionScheme.body);
  const priorityScheme = await req(app, "GET", "/rest/api/2/project/T100ZB/priorityscheme");
  assertMatchesResponse("/api/2/project/{projectKeyOrId}/priorityscheme", "get", 200, priorityScheme.body);
  const securityLevels = await req(app, "GET", "/rest/api/2/project/T100ZB/securitylevel");
  assertMatchesResponse("/api/2/project/{projectKeyOrId}/securitylevel", "get", 200, securityLevels.body);
  const workflowScheme = await req(app, "GET", "/rest/api/2/project/T100ZB/workflowscheme");
  assertMatchesResponse("/api/2/project/{projectKeyOrId}/workflowscheme", "get", 200, workflowScheme.body);

  const picker = await req(app, "GET", "/rest/api/2/projects/picker?query=software&maxResults=2&allowEmptyQuery=false");
  assertMatchesResponse("/api/2/projects/picker", "get", 200, picker.body);
  assert.ok((picker.body as { total: number }).total > 0);
  const validation = await req(app, "GET", "/rest/api/2/projectvalidate/key?key=AVAILABLE");
  assertMatchesResponse("/api/2/projectvalidate/key", "get", 200, validation.body);
  assert.deepEqual((validation.body as { errors: object }).errors, {});

  const roles = await req(app, "GET", "/rest/api/2/role");
  assertArrayItemsMatchResponse("/api/2/role", "get", 200, roles.body);
  const role = await req(app, "GET", "/rest/api/2/role/10001");
  assertMatchesResponse("/api/2/role/{id}", "get", 200, role.body);
  const actors = await req(app, "GET", "/rest/api/2/role/10001/actors");
  assertMatchesResponse("/api/2/role/{id}/actors", "get", 200, actors.body);
});

test("all project and role mutations are persistent, validated, and schema-valid", async (t) => {
  const app = fixture(t).open();
  const created = await req(app, "POST", "/rest/api/2/project", { key: "AGENT", name: "Agent Project", description: "Created by contract test", lead: "developer", projectTypeKey: "software", permissionScheme: 10000, notificationScheme: 10000, issueSecurityScheme: 10000 });
  assert.equal(created.response.statusCode, 201);
  assertMatchesResponse("/api/2/project", "post", 201, created.body);
  const projectId = String((created.body as { id: number }).id);
  const updated = await req(app, "PUT", `/rest/api/2/project/${projectId}`, { key: "AGENT", name: "Agent Project Updated", lead: "alex", description: "Updated" });
  assertMatchesResponse("/api/2/project/{projectIdOrKey}", "put", 200, updated.body);
  const type = await req(app, "PUT", `/rest/api/2/project/${projectId}/type/business`);
  assertMatchesResponse("/api/2/project/{projectIdOrKey}/type/{newProjectTypeKey}", "put", 200, type.body);
  empty("/api/2/project/{projectIdOrKey}/archive", "put", 204, await req(app, "PUT", `/rest/api/2/project/${projectId}/archive`));
  empty("/api/2/project/{projectIdOrKey}/restore", "put", 202, await req(app, "PUT", `/rest/api/2/project/${projectId}/restore`));

  const setProperty = await req(app, "PUT", `/rest/api/2/project/${projectId}/properties/agent.config`, { value: "{\"enabled\":true}" });
  empty("/api/2/project/{projectIdOrKey}/properties/{propertyKey}", "put", 201, setProperty);
  const property = await req(app, "GET", `/rest/api/2/project/${projectId}/properties/agent.config`);
  assertMatchesResponse("/api/2/project/{projectIdOrKey}/properties/{propertyKey}", "get", 200, property.body);
  empty("/api/2/project/{projectIdOrKey}/properties/{propertyKey}", "put", 200, await req(app, "PUT", `/rest/api/2/project/${projectId}/properties/agent.config`, { value: "updated" }));
  empty("/api/2/project/{projectIdOrKey}/properties/{propertyKey}", "delete", 204, await req(app, "DELETE", `/rest/api/2/project/${projectId}/properties/agent.config`));

  const boundary = "project-avatar-boundary";
  const multipart = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\nsynthetic\r\n--${boundary}--\r\n`;
  const temporaryResponse = await app.inject({ method: "POST", url: `/rest/api/2/project/${projectId}/avatar/temporary`, headers: { ...authorization, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: multipart });
  assert.equal(temporaryResponse.statusCode, 201);
  const temporarySchema = (operation("/api/2/project/{projectIdOrKey}/avatar/temporary", "post").responses["201"] as unknown as { content: { "text/html": { schema: OpenApiSchema } } }).content["text/html"].schema;
  assertMatchesSchema(temporarySchema, JSON.parse(temporaryResponse.body), "POST project temporary avatar");
  const avatar = await req(app, "POST", `/rest/api/2/project/${projectId}/avatar`, { cropperOffsetX: 0, cropperOffsetY: 0, cropperWidth: 128, needsCropping: true });
  assertMatchesResponse("/api/2/project/{projectIdOrKey}/avatar", "post", 201, avatar.body);
  const avatarId = (avatar.body as { id: string }).id;
  empty("/api/2/project/{projectIdOrKey}/avatar", "put", 204, await req(app, "PUT", `/rest/api/2/project/${projectId}/avatar`, { id: "10000" }));
  empty("/api/2/project/{projectIdOrKey}/avatar/{id}", "delete", 204, await req(app, "DELETE", `/rest/api/2/project/${projectId}/avatar/${avatarId}`));

  const putRole = await req(app, "PUT", `/rest/api/2/project/${projectId}/role/10001`, { categorisedActors: { "atlassian-user-role-actor": ["developer"], "atlassian-group-role-actor": ["jira-software-users"] } });
  assertMatchesResponse("/api/2/project/{projectIdOrKey}/role/{id}", "put", 200, putRole.body);
  const postRole = await req(app, "POST", `/rest/api/2/project/${projectId}/role/10001`, { user: ["alex"], group: [] });
  assertMatchesResponse("/api/2/project/{projectIdOrKey}/role/{id}", "post", 200, postRole.body);
  empty("/api/2/project/{projectIdOrKey}/role/{id}", "delete", 204, await req(app, "DELETE", `/rest/api/2/project/${projectId}/role/10001?user=alex`));

  const assignedPermission = await req(app, "PUT", `/rest/api/2/project/${projectId}/permissionscheme`, { id: 10001 });
  assertMatchesResponse("/api/2/project/{projectKeyOrId}/permissionscheme", "put", 200, assignedPermission.body);
  const assignedPriority = await req(app, "PUT", `/rest/api/2/project/${projectId}/priorityscheme`, { id: 10000 });
  assertMatchesResponse("/api/2/project/{projectKeyOrId}/priorityscheme", "put", 200, assignedPriority.body);
  const unassignedPriority = await req(app, "DELETE", `/rest/api/2/project/${projectId}/priorityscheme/10000`);
  assertMatchesResponse("/api/2/project/{projectKeyOrId}/priorityscheme/{schemeId}", "delete", 200, unassignedPriority.body);

  const createdRole = await req(app, "POST", "/rest/api/2/role", { name: "Reviewers", description: "Review role" });
  assertMatchesResponse("/api/2/role", "post", 200, createdRole.body);
  const roleId = (createdRole.body as { id: number }).id;
  const fullRole = await req(app, "PUT", `/rest/api/2/role/${roleId}`, { name: "Release Reviewers", description: "Updated" });
  assertMatchesResponse("/api/2/role/{id}", "put", 200, fullRole.body);
  const partialRole = await req(app, "POST", `/rest/api/2/role/${roleId}`, { description: "Partially updated" });
  assertMatchesResponse("/api/2/role/{id}", "post", 200, partialRole.body);
  const addedActors = await req(app, "POST", `/rest/api/2/role/${roleId}/actors`, { user: ["developer"], group: ["jira-software-users"] });
  assertMatchesResponse("/api/2/role/{id}/actors", "post", 200, addedActors.body);
  const deletedActors = await req(app, "DELETE", `/rest/api/2/role/${roleId}/actors?user=developer&group=jira-software-users`);
  assertMatchesResponse("/api/2/role/{id}/actors", "delete", 200, deletedActors.body);
  empty("/api/2/role/{id}", "delete", 204, await req(app, "DELETE", `/rest/api/2/role/${roleId}`));

  const badLead = await req(app, "PUT", `/rest/api/2/project/${projectId}`, { lead: "missing" });
  assert.equal(badLead.response.statusCode, 400);
  const badScheme = await req(app, "PUT", `/rest/api/2/project/${projectId}/permissionscheme`, { id: 99999 });
  assert.equal(badScheme.response.statusCode, 404);
  const badPermissionContext = await req(app, "GET", "/rest/api/2/mypermissions?projectKey=MISSING");
  assert.equal(badPermissionContext.response.statusCode, 404);
  const duplicateKey = await req(app, "GET", "/rest/api/2/projectvalidate/key?key=T100ZB");
  assert.ok((duplicateKey.body as { errors: Record<string, string> }).errors.key);

  empty("/api/2/project/{projectIdOrKey}", "delete", 204, await req(app, "DELETE", `/rest/api/2/project/${projectId}`));
});

test("project state survives restart and reset restores core seeds", async (t) => {
  const { open } = fixture(t); const first = open();
  const created = await req(first, "POST", "/rest/api/2/project", { key: "PERSIST", name: "Persistent Project", lead: "developer", projectTypeKey: "software" });
  const id = String((created.body as { id: number }).id);
  await req(first, "PUT", `/rest/api/2/project/${id}/properties/persisted`, { value: "yes" });
  await first.close();
  const second = open();
  const persisted = await req(second, "GET", `/rest/api/2/project/${id}`);
  assert.equal(persisted.response.statusCode, 200);
  const property = await req(second, "GET", `/rest/api/2/project/${id}/properties/persisted`);
  assert.equal((property.body as { value: string }).value, "yes");
  const reset = await req(second, "POST", "/__admin/reset");
  assert.equal(reset.response.statusCode, 204);
  assert.equal(reset.response.body, "");
  assert.equal((await req(second, "GET", `/rest/api/2/project/${id}`)).response.statusCode, 404);
  assert.equal((await req(second, "GET", "/rest/api/2/project/T100ZB")).response.statusCode, 200);
});
