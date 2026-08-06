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
  authorization,
  officialSpecification,
} from "./helpers/official-contract.js";

type Method = "GET" | "POST" | "PUT" | "DELETE";

const assignedTags = new Set([
  "user",
  "group",
  "groups",
  "groupuserpicker",
  "myself",
  "mypreferences",
  "password",
  "applicationrole",
]);

const assignedOperations = new Set(
  Object.entries(
    (officialSpecification as unknown as {
      paths: Record<string, Record<string, { tags?: string[] }>>;
    }).paths,
  ).flatMap(([path, methods]) =>
    Object.entries(methods)
      .filter(([, operation]) => operation.tags?.some((tag) => assignedTags.has(tag)))
      .map(([method]) => `${method.toUpperCase()} ${path}`),
  ),
);

test("user-management operations follow the pinned Jira 10.3 contract and persist", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "jira-users-contract-"));
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
      contentType?: string;
      status?: number;
      schema?: "exact" | "array-items" | "empty";
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
      return { response, body: response.body ? response.body : undefined };
    }
    const body = response.json();
    if (schema === "array-items") {
      assertArrayItemsMatchResponse(contractPath, method, status, body);
    } else {
      assertMatchesResponse(contractPath, method, status, body);
    }
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

  {
    const { body } = await call("/api/2/applicationrole", "GET", "/rest/api/2/applicationrole", { schema: "array-items" });
    assert.equal((body as Array<{ key: string }>)[0].key, "jira-software");
  }
  await call("/api/2/applicationrole/{key}", "GET", "/rest/api/2/applicationrole/jira-software");
  await call("/api/2/applicationrole/{key}", "PUT", "/rest/api/2/applicationrole/jira-software", {
    payload: { key: "ignored", name: "Ignored", groups: ["jira-software-users", "jira-users"], defaultGroups: ["jira-software-users"] },
  });
  await call("/api/2/applicationrole", "PUT", "/rest/api/2/applicationrole", {
    payload: { key: "jira-core", groups: ["jira-users"], defaultGroups: ["jira-users"] },
  });
  await expectError("GET", "/rest/api/2/applicationrole/missing", 404);
  await expectError("PUT", "/rest/api/2/applicationrole/jira-core?versionHash=stale", 412, { groups: [] });

  await call("/api/2/group", "POST", "/rest/api/2/group", { payload: { name: "contract-reviewers" }, status: 201 });
  await expectError("POST", "/rest/api/2/group", 400, { name: "contract-reviewers" });
  await call("/api/2/group/user", "POST", "/rest/api/2/group/user?groupname=contract-reviewers", { payload: { name: "frank.lillo" }, status: 201 });
  {
    const { body } = await call("/api/2/group/member", "GET", "/rest/api/2/group/member?groupname=contract-reviewers&startAt=0&maxResults=1&includeInactiveUsers=true");
    const page = body as { startAt: number; maxResults: number; total: number; values: Array<{ name: string }> };
    assert.equal(page.startAt, 0);
    assert.equal(page.maxResults, 1);
    assert.equal(page.total, 1);
    assert.equal(page.values[0].name, "frank.lillo");
  }
  {
    const { body } = await call("/api/2/groups/picker", "GET", "/rest/api/2/groups/picker?query=contract&maxResults=1");
    assert.deepEqual((body as { groups: Array<{ name: string }> }).groups.map((group) => group.name), ["contract-reviewers"]);
  }
  {
    const { body } = await call("/api/2/groupuserpicker", "GET", "/rest/api/2/groupuserpicker?query=frank&maxResults=1&showAvatar=true");
    assert.equal((body as { users: { users: Array<{ name: string }> } }).users.users[0].name, "frank.lillo");
  }
  await call("/api/2/group/user", "DELETE", "/rest/api/2/group/user?groupname=contract-reviewers&username=frank.lillo", { schema: "empty" });
  await expectError("GET", "/rest/api/2/group/member?groupname=missing", 404);

  await call("/api/2/mypreferences", "PUT", "/rest/api/2/mypreferences?key=contract.mode", { payload: "compact", status: 204, schema: "empty" });
  {
    const { body } = await call("/api/2/mypreferences", "GET", "/rest/api/2/mypreferences?key=contract.mode");
    assert.equal(body, "compact");
  }
  await call("/api/2/mypreferences", "DELETE", "/rest/api/2/mypreferences?key=contract.mode", { status: 204, schema: "empty" });
  await expectError("GET", "/rest/api/2/mypreferences?key=contract.mode", 404);

  await call("/api/2/myself", "GET", "/rest/api/2/myself");
  {
    const { body } = await call("/api/2/myself", "PUT", "/rest/api/2/myself", { payload: { displayName: "Contract Developer", emailAddress: "contract@example.test", password: "developer" } });
    assert.equal((body as { displayName: string }).displayName, "Contract Developer");
  }
  await expectError("PUT", "/rest/api/2/myself", 400, { displayName: "Nope", password: "wrong" });
  await call("/api/2/myself/password", "PUT", "/rest/api/2/myself/password", { payload: { currentPassword: "developer", password: "new-secret-123" }, status: 204, schema: "empty" });

  await call("/api/2/password/policy", "GET", "/rest/api/2/password/policy?hasOldPassword=true");
  await call("/api/2/password/policy/createUser", "POST", "/rest/api/2/password/policy/createUser", { payload: { username: "charlie", displayName: "Charlie Example", emailAddress: "charlie@example.test", password: "strong-secret" } });
  await expectError("POST", "/rest/api/2/password/policy/createUser", 400, { username: "charlie" });

  {
    const { body } = await call("/api/2/user", "POST", "/rest/api/2/user", { payload: { name: "charlie", key: "JIRAUSER10300", displayName: "Charlie Example", emailAddress: "charlie@example.test", password: "charlie-secret", applicationKeys: ["jira-software"] }, status: 201 });
    assert.equal((body as { name: string }).name, "charlie");
  }
  await expectError("POST", "/rest/api/2/user", 400, { name: "charlie", displayName: "Duplicate", emailAddress: "duplicate@example.test" });
  await call("/api/2/password/policy/updateUser", "POST", "/rest/api/2/password/policy/updateUser", { payload: { username: "charlie", oldPassword: "charlie-secret", newPassword: "another-strong-secret" } });
  await expectError("POST", "/rest/api/2/password/policy/updateUser", 404, { username: "missing", newPassword: "another-strong-secret" });
  {
    const { body } = await call("/api/2/user", "GET", "/rest/api/2/user?key=JIRAUSER10300");
    assert.equal((body as { name: string }).name, "charlie");
  }
  await call("/api/2/user", "PUT", "/rest/api/2/user?username=charlie", { payload: { displayName: "Charlie Contract", emailAddress: "charlie.contract@example.test", active: true } });
  await call("/api/2/user/password", "PUT", "/rest/api/2/user/password?username=charlie", { payload: { password: "admin-reset-secret" }, status: 204, schema: "empty" });

  {
    const { body } = await call("/api/2/user/a11y/personal-settings", "GET", "/rest/api/2/user/a11y/personal-settings", { schema: "array-items" });
    assert.equal(typeof (body as Array<{ enabled: boolean }>)[0].enabled, "boolean");
  }
  {
    const { body } = await call("/api/2/user/anonymization", "GET", "/rest/api/2/user/anonymization?userKey=JIRAUSER10300&expand=affectedEntities", { schema: "empty" });
    assert.match(String(body), /success/);
  }
  const scheduled = await call("/api/2/user/anonymization", "POST", "/rest/api/2/user/anonymization", { payload: { userKey: "JIRAUSER10300", newOwnerKey: "developer" }, status: 202, schema: "empty" });
  const taskId = JSON.parse(String(scheduled.body)).taskId as number;
  await call("/api/2/user/anonymization/progress", "GET", `/rest/api/2/user/anonymization/progress?taskId=${taskId}`, { schema: "empty" });
  await expectError("POST", "/rest/api/2/user/anonymization", 409, { userKey: "JIRAUSER10300" });
  await call("/api/2/user/anonymization/unlock", "DELETE", "/rest/api/2/user/anonymization/unlock", { status: 204, schema: "empty" });
  await call("/api/2/user/anonymization/rerun", "GET", "/rest/api/2/user/anonymization/rerun?userKey=JIRAUSER10300&oldUserKey=JIRAUSER10300&oldUserName=charlie&expand=affectedEntities");
  await call("/api/2/user/anonymization/rerun", "POST", "/rest/api/2/user/anonymization/rerun", { payload: { userKey: "JIRAUSER10300", oldUserKey: "JIRAUSER10300", oldUserName: "charlie", newOwnerKey: "developer" }, status: 202, schema: "empty" });

  await call("/api/2/user/application", "POST", "/rest/api/2/user/application?username=charlie&applicationKey=jira-core", { schema: "empty" });
  await call("/api/2/user/application", "DELETE", "/rest/api/2/user/application?username=charlie&applicationKey=jira-core", { status: 204, schema: "empty" });
  await expectError("POST", "/rest/api/2/user/application?username=missing&applicationKey=jira-core", 400);

  await call("/api/2/user/assignable/multiProjectSearch", "GET", "/rest/api/2/user/assignable/multiProjectSearch?projectKeys=T100ZB,T101LIB&username=char&maxResults=1", { schema: "array-items" });
  await call("/api/2/user/assignable/search", "GET", "/rest/api/2/user/assignable/search?issueKey=T100ZB-1&username=char&maxResults=1", { schema: "array-items" });
  await expectError("GET", "/rest/api/2/user/assignable/search?issueKey=MISSING-1", 404);

  const avatar = await call("/api/2/user/avatar", "POST", "/rest/api/2/user/avatar?username=charlie", { payload: { cropperOffsetX: 0, cropperOffsetY: 0, cropperWidth: 120, needsCropping: true, url: "http://jira.test/secure/temporaryavatar" }, status: 201 });
  const avatarId = (avatar.body as { id: string }).id;
  await call("/api/2/user/avatar", "PUT", "/rest/api/2/user/avatar?username=charlie", { payload: { id: avatarId, owner: "ignored", selected: true } });
  {
    const { body } = await call("/api/2/user/avatars", "GET", "/rest/api/2/user/avatars?username=charlie");
    assert.ok((body as { custom: unknown[] }).custom.length > 0);
  }
  await call("/api/2/user/avatar/temporary", "POST", "/rest/api/2/user/avatar/temporary?username=charlie", { payload: "--jira-boundary--\r\n", contentType: "multipart/form-data; boundary=jira-boundary", status: 201, schema: "empty" });
  await call("/api/2/user/avatar/{id}", "DELETE", `/rest/api/2/user/avatar/${avatarId}?username=charlie`, { status: 204, schema: "empty" });

  {
    const { body } = await call("/api/2/user/columns", "GET", "/rest/api/2/user/columns?username=charlie");
    assert.ok(Array.isArray((body as { columns: unknown[] }).columns));
  }
  await call("/api/2/user/columns", "PUT", "/rest/api/2/user/columns", { payload: "username=charlie&columns=key&columns=summary", contentType: "application/x-www-form-urlencoded", schema: "empty" });
  await call("/api/2/user/columns", "DELETE", "/rest/api/2/user/columns?username=charlie", { status: 204, schema: "empty" });

  await call("/api/2/user/duplicated/count", "GET", "/rest/api/2/user/duplicated/count?flush=true");
  await call("/api/2/user/duplicated/list", "GET", "/rest/api/2/user/duplicated/list?flush=true");
  {
    const { body } = await call("/api/2/user/list", "GET", "/rest/api/2/user/list?cursor=0&maxResults=1");
    const page = body as { maxResults: number; values: unknown[]; isLast: boolean; nextCursor?: string };
    assert.equal(page.maxResults, 1);
    assert.equal(page.values.length, 1);
    assert.equal(page.isLast, false);
    assert.equal(page.nextCursor, "1");
  }

  await call("/api/2/user/permission/search", "GET", "/rest/api/2/user/permission/search?projectKey=T100ZB&permissions=BROWSE_PROJECTS&username=char&startAt=0&maxResults=1", { schema: "array-items" });
  await expectError("GET", "/rest/api/2/user/permission/search?permissions=BROWSE_PROJECTS", 400);
  {
    const { body } = await call("/api/2/user/picker", "GET", "/rest/api/2/user/picker?query=char&showAvatar=true&maxResults=1");
    assert.equal((body as { users: Array<{ name: string }> }).users[0].name, "charlie");
  }

  {
    const { body } = await call("/api/2/user/properties", "GET", "/rest/api/2/user/properties?username=charlie", { schema: "empty" });
    assert.match(String(body), /keys/);
  }
  await call("/api/2/user/properties/{propertyKey}", "PUT", "/rest/api/2/user/properties/contract?username=charlie", { payload: "enabled", status: 201, schema: "empty" });
  {
    const { body } = await call("/api/2/user/properties/{propertyKey}", "GET", "/rest/api/2/user/properties/contract?username=charlie", { schema: "empty" });
    assert.match(String(body), /enabled/);
  }
  await call("/api/2/user/properties/{propertyKey}", "PUT", "/rest/api/2/user/properties/contract?username=charlie", { payload: "updated", status: 200, schema: "empty" });

  await call("/api/2/user/search", "GET", "/rest/api/2/user/search?username=char&includeActive=true&includeInactive=false&startAt=0&maxResults=1", { schema: "array-items" });
  await expectError("GET", "/rest/api/2/user/search?includeActive=false&includeInactive=false", 400);
  await call("/api/2/user/session/{username}", "DELETE", "/rest/api/2/user/session/charlie", { schema: "empty" });
  await call("/api/2/user/viewissue/search", "GET", "/rest/api/2/user/viewissue/search?issueKey=T100ZB-1&username=char&maxResults=1", { schema: "array-items" });
  await expectError("GET", "/rest/api/2/user/viewissue/search?username=char", 400);

  await app.close();
  app = buildApp({ dataFile, baseUrl: "http://jira.test" });
  {
    const response = await app.inject({ method: "GET", url: "/rest/api/2/user?username=charlie", headers: authorization });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().displayName, "Charlie Contract");
  }
  {
    const response = await app.inject({ method: "GET", url: "/rest/api/2/applicationrole/jira-software", headers: authorization });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().groups, ["jira-software-users", "jira-users"]);
  }
  {
    const response = await app.inject({ method: "GET", url: "/rest/api/2/groups/picker?query=contract-reviewers", headers: authorization });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().total, 1);
  }
  {
    const response = await app.inject({ method: "GET", url: "/rest/api/2/user/properties/contract?username=charlie", headers: authorization });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().value, "updated");
  }

  await call("/api/2/user/properties/{propertyKey}", "DELETE", "/rest/api/2/user/properties/contract?username=charlie", { status: 204, schema: "empty" });
  await call("/api/2/user", "DELETE", "/rest/api/2/user?username=charlie", { status: 204, schema: "empty" });
  await call("/api/2/group", "DELETE", "/rest/api/2/group?groupname=contract-reviewers", { schema: "empty" });
  await expectError("GET", "/rest/api/2/user?username=charlie", 404);

  assert.deepEqual(
    [...visited].sort(),
    [...assignedOperations].sort(),
    "the test must exercise every operation in the assigned OpenAPI tags",
  );

  {
    const response = await app.inject({ method: "POST", url: "/__admin/reset", headers: authorization });
    assert.equal(response.statusCode, 204);
  }
  {
    const response = await app.inject({ method: "GET", url: "/rest/api/2/user?username=frank.lillo", headers: authorization });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().displayName, "Frank Lillo");
  }
  {
    const response = await app.inject({ method: "GET", url: "/rest/api/2/groups/picker?query=jira-software-users", headers: authorization });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().total, 1, "first access after reset re-seeds namespaced resources");
  }
});
