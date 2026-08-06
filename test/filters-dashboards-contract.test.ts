import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../src/app.js";
import {
  assertEmptyResponseDocumented,
  assertMatchesResponse,
  assertMatchesSchema,
  authorization,
  responseSchema,
} from "./helpers/official-contract.js";

test("filters and dashboards cover every success operation with persistent state", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "jira-filters-dashboards-"));
  const dataFile = join(directory, "state.json");
  let app = buildApp({ dataFile, baseUrl: "http://jira.test" });
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const request = (
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    app.inject({
      method,
      url,
      headers: {
        ...authorization,
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      payload,
    });

  {
    const response = await request("GET", "/rest/api/2/dashboard?filter=system&maxResults=1");
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assertMatchesResponse("/api/2/dashboard", "get", 200, body);
    assert.equal(body.dashboards.length, 1);
    assert.equal(body.dashboards[0].id, "10000");

    const single = await request("GET", "/rest/api/2/dashboard/10000");
    assert.equal(single.statusCode, 200);
    assertMatchesResponse("/api/2/dashboard/{id}", "get", 200, single.json());
    assert.equal(single.json().name, "System Dashboard");
  }

  {
    const keys = await request(
      "GET",
      "/rest/api/2/dashboard/10000/items/20000/properties",
    );
    assert.equal(keys.statusCode, 200);
    assertMatchesResponse(
      "/api/2/dashboard/{dashboardId}/items/{itemId}/properties",
      "get",
      200,
      keys.json(),
    );
    assert.equal(keys.json().keys[0].key, "mock.display.mode");

    const existing = await request(
      "GET",
      "/rest/api/2/dashboard/10000/items/20000/properties/mock.display.mode",
    );
    assert.equal(existing.statusCode, 200);
    assertMatchesResponse(
      "/api/2/dashboard/{dashboardId}/items/{itemId}/properties/{propertyKey}",
      "get",
      200,
      existing.json(),
    );
    assert.equal(existing.json().key, "mock.display.mode");

    const update = await request(
      "PUT",
      "/rest/api/2/dashboard/10000/items/20000/properties/mock.display.mode",
      { layout: "wide" },
    );
    assert.equal(update.statusCode, 200);
    assert.equal(update.body, "");
    const create = await request(
      "PUT",
      "/rest/api/2/dashboard/10000/items/20000/properties/mock.refresh",
      { minutes: 5 },
    );
    assert.equal(create.statusCode, 201);
    assert.equal(create.body, "");
  }

  {
    const scope = await request("GET", "/rest/api/2/filter/defaultShareScope");
    assert.equal(scope.statusCode, 200);
    assertMatchesResponse("/api/2/filter/defaultShareScope", "get", 200, scope.json());
    assert.equal(scope.json().scope, "PRIVATE");
    const changed = await request("PUT", "/rest/api/2/filter/defaultShareScope", {
      scope: "AUTHENTICATED",
    });
    assert.equal(changed.statusCode, 200);
    assertMatchesResponse("/api/2/filter/defaultShareScope", "put", 200, changed.json());
    assert.equal(changed.json().scope, "AUTHENTICATED");
  }

  {
    const favourite = await request("GET", "/rest/api/2/filter/favourite?expand=owner");
    assert.equal(favourite.statusCode, 200);
    const values = favourite.json();
    assert.ok(Array.isArray(values));
    assert.ok(values.length > 0);
    const schema = responseSchema("/api/2/filter/favourite", "get", 200);
    for (const [index, value] of values.entries()) {
      assertMatchesSchema(schema, value, `GET /api/2/filter/favourite[${index}]`);
      assert.equal(value.favourite, true);
    }
  }

  {
    const filter = await request("GET", "/rest/api/2/filter/12000?expand=sharePermissions");
    assert.equal(filter.statusCode, 200);
    assertMatchesResponse("/api/2/filter/{id}", "get", 200, filter.json());
    assert.equal(filter.json().id, "12000");

    const columns = await request("GET", "/rest/api/2/filter/12000/columns");
    assert.equal(columns.statusCode, 200);
    assertMatchesResponse("/api/2/filter/{id}/columns", "get", 200, columns.json());
    assert.ok(columns.json().columns.includes("summary"));
    const setColumns = await request("PUT", "/rest/api/2/filter/12000/columns", {
      columns: ["key", "summary", "priority"],
    });
    assert.equal(setColumns.statusCode, 200);
    assert.equal(setColumns.body, "");
  }

  let permissionId: number;
  {
    const permissions = await request("GET", "/rest/api/2/filter/12000/permission");
    assert.equal(permissions.statusCode, 200);
    const values = permissions.json();
    assert.ok(Array.isArray(values));
    const schema = responseSchema("/api/2/filter/{id}/permission", "get", 200);
    for (const [index, value] of values.entries()) {
      assertMatchesSchema(schema, value, `GET /api/2/filter/{id}/permission[${index}]`);
    }

    const added = await request("POST", "/rest/api/2/filter/12000/permission", {
      type: "project",
      projectId: "T100ZB",
      view: true,
    });
    assert.equal(added.statusCode, 201);
    assertMatchesResponse("/api/2/filter/{id}/permission", "post", 201, added.json());
    assert.equal(added.json().project.key, "T100ZB");
    permissionId = added.json().id;

    const single = await request(
      "GET",
      `/rest/api/2/filter/12000/permission/${permissionId}`,
    );
    assert.equal(single.statusCode, 200);
    assertMatchesResponse(
      "/api/2/filter/{id}/permission/{permissionId}",
      "get",
      200,
      single.json(),
    );
    assert.equal(single.json().id, permissionId);
  }

  let createdFilterId: string;
  {
    const created = await request("POST", "/rest/api/2/filter?expand=owner", {
      name: "Persistent T100 Work",
      description: "Created by contract test",
      jql: "project = T100ZB ORDER BY key ASC",
      favourite: true,
    });
    assert.equal(created.statusCode, 200);
    assertMatchesResponse("/api/2/filter", "post", 200, created.json());
    assert.equal(typeof created.json().id, "string");
    createdFilterId = created.json().id;

    const edited = await request("PUT", `/rest/api/2/filter/${createdFilterId}`, {
      name: "Persistent T100 Bugs",
      description: "Updated by contract test",
      jql: "project = T100ZB AND issuetype = Bug",
      favourite: true,
    });
    assert.equal(edited.statusCode, 200);
    assertMatchesResponse("/api/2/filter/{id}", "put", 200, edited.json());
    assert.equal(edited.json().name, "Persistent T100 Bugs");
  }

  {
    const invalid = await request("POST", "/rest/api/2/filter", {
      name: "Invalid",
      jql: "unknownfield = value",
    });
    assert.equal(invalid.statusCode, 400);
    assert.ok(Array.isArray(invalid.json().errorMessages));
    const missing = await request("GET", "/rest/api/2/filter/999999");
    assert.equal(missing.statusCode, 404);
    assert.deepEqual(missing.json().errors, {});
  }

  await app.close();
  app = buildApp({ dataFile, baseUrl: "http://jira.test" });

  {
    const persistedFilter = await request("GET", `/rest/api/2/filter/${createdFilterId}`);
    assert.equal(persistedFilter.json().name, "Persistent T100 Bugs");
    const persistedProperty = await request(
      "GET",
      "/rest/api/2/dashboard/10000/items/20000/properties/mock.refresh",
    );
    assert.equal(persistedProperty.statusCode, 200);
    assert.match(persistedProperty.json().value, /5/);
  }

  {
    const removePermission = await request(
      "DELETE",
      `/rest/api/2/filter/12000/permission/${permissionId}`,
    );
    assert.equal(removePermission.statusCode, 204);
    assert.equal(removePermission.body, "");
    assertEmptyResponseDocumented(
      "/api/2/filter/{id}/permission/{permission-id}",
      "delete",
      204,
    );

    const resetColumns = await request("DELETE", "/rest/api/2/filter/12000/columns");
    assert.equal(resetColumns.statusCode, 204);
    assert.equal(resetColumns.body, "");
    assertEmptyResponseDocumented("/api/2/filter/{id}/columns", "delete", 204);

    const removeProperty = await request(
      "DELETE",
      "/rest/api/2/dashboard/10000/items/20000/properties/mock.refresh",
    );
    assert.equal(removeProperty.statusCode, 204);
    assertEmptyResponseDocumented(
      "/api/2/dashboard/{dashboardId}/items/{itemId}/properties/{propertyKey}",
      "delete",
      204,
    );

    const removeFilter = await request("DELETE", `/rest/api/2/filter/${createdFilterId}`);
    assert.equal(removeFilter.statusCode, 204);
    assertEmptyResponseDocumented("/api/2/filter/{id}", "delete", 204);
  }

  {
    const reset = await request("POST", "/__admin/reset");
    assert.equal(reset.statusCode, 204);
    const scope = await request("GET", "/rest/api/2/filter/defaultShareScope");
    assert.equal(scope.json().scope, "PRIVATE");
    const filters = await request("GET", "/rest/api/2/filter/favourite");
    assert.equal(filters.json()[0].id, "12000");
  }
});
