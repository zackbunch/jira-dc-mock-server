import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../src/app.js";
import {
  assertEmptyResponseDocumented,
  assertMatchesResponse,
  authorization,
} from "./helpers/official-contract.js";

test("system configuration, settings, read-only mode, and monitoring follow the contract", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "jira-system-settings-"));
  const dataFile = join(directory, "state.json");
  let app = buildApp({ dataFile, baseUrl: "http://jira.test" });

  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const request = async (
    method: "GET" | "POST" | "PUT",
    url: string,
    options: { payload?: string | Record<string, unknown>; contentType?: string } = {},
  ) =>
    app.inject({
      method,
      url,
      headers: {
        ...authorization,
        ...(options.contentType ? { "content-type": options.contentType } : {}),
      },
      payload: options.payload,
    });

  {
    const response = await request("GET", "/rest/api/2/configuration");
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assertMatchesResponse("/api/2/configuration", "get", 200, body);
    assert.equal(body.attachmentsEnabled, true);
    assert.equal(body.timeTrackingConfiguration.workingHoursPerDay, 8);
  }

  {
    const response = await request(
      "GET",
      "/rest/api/2/application-properties?permissionLevel=SYSADMIN&key=jira.clone.prefix",
    );
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assertMatchesResponse("/api/2/application-properties", "get", 200, body);
    assert.equal(body.key, "jira.clone.prefix");
    assert.equal(typeof body.value, "string");
  }

  {
    const response = await request(
      "GET",
      "/rest/api/2/application-properties/advanced-settings",
    );
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assertMatchesResponse(
      "/api/2/application-properties/advanced-settings",
      "get",
      200,
      body,
    );
    assert.equal(typeof body.key, "string");
    assert.equal(typeof body.value, "string");
  }

  {
    const response = await request(
      "PUT",
      "/rest/api/2/application-properties/jira.clone.prefix",
      {
        payload: { value: "COPY - " },
        contentType: "application/json",
      },
    );
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assertMatchesResponse("/api/2/application-properties/{id}", "put", 200, body);
    assert.equal(body.value, "COPY - ");
  }

  {
    const response = await request("PUT", "/rest/api/2/settings/baseUrl", {
      payload: JSON.stringify("https://jira.example.test/"),
      contentType: "application/json",
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, "");
  }

  {
    const response = await request("GET", "/rest/api/2/settings/columns");
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assertMatchesResponse("/api/2/settings/columns", "get", 200, body);
    assert.ok(Array.isArray(body.columns));
    assert.ok(body.columns.includes("summary"));
  }

  {
    const response = await request("PUT", "/rest/api/2/settings/columns", {
      payload: "columns=key&columns=summary&columns=priority",
      contentType: "application/x-www-form-urlencoded",
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, "");
  }

  {
    const response = await request("GET", "/rest/api/2/readonly-mode");
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assertMatchesResponse("/api/2/readonly-mode", "get", 200, body);
    assert.equal(body.enabled, false);
    assert.equal(typeof body.message, "string");
  }

  {
    const response = await request("PUT", "/rest/api/2/readonly-mode", {
      payload: {
        enabled: true,
        endTime: "2026-08-06T18:00",
        message: "Synthetic maintenance window",
        timeZone: "America/Phoenix",
      },
      contentType: "application/json",
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, "");
  }

  for (const [name, contractPath] of [
    ["app", "/api/2/monitoring/app"],
    ["ipd", "/api/2/monitoring/ipd"],
  ] as const) {
    const getResponse = await request("GET", `/rest/api/2/monitoring/${name}`);
    assert.equal(getResponse.statusCode, 200);
    const body = getResponse.json();
    assertMatchesResponse(contractPath, "get", 200, body);
    assert.equal(typeof body.enabled, "boolean");

    const postResponse = await request("POST", `/rest/api/2/monitoring/${name}`, {
      payload: { enabled: false },
      contentType: "application/json",
    });
    assert.equal(postResponse.statusCode, 204);
    assert.equal(postResponse.body, "");
    assertEmptyResponseDocumented(contractPath, "post", 204);
  }

  {
    const response = await request("GET", "/rest/api/2/monitoring/jmx/areMetricsExposed");
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assertMatchesResponse(
      "/api/2/monitoring/jmx/areMetricsExposed",
      "get",
      200,
      body,
    );
    assert.equal(body, false);
  }

  {
    const response = await request("GET", "/rest/api/2/monitoring/jmx/getAvailableMetrics");
    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"] ?? "", /^application\/json/);
    const body = response.json();
    assertMatchesResponse(
      "/api/2/monitoring/jmx/getAvailableMetrics",
      "get",
      200,
      body,
    );
    assert.match(body, /issues\.total/);
  }

  {
    const start = await request("POST", "/rest/api/2/monitoring/jmx/startExposing");
    assert.equal(start.statusCode, 200);
    assert.equal(start.body, "");
    const enabled = await request("GET", "/rest/api/2/monitoring/jmx/areMetricsExposed");
    assert.equal(enabled.json(), true);
    const stop = await request("POST", "/rest/api/2/monitoring/jmx/stopExposing");
    assert.equal(stop.statusCode, 200);
    assert.equal(stop.body, "");
  }

  {
    const missingQuery = await request("GET", "/rest/api/2/application-properties");
    assert.equal(missingQuery.statusCode, 400);
    assert.ok(Array.isArray(missingQuery.json().errorMessages));
    assert.deepEqual(missingQuery.json().errors, {});

    const missingProperty = await request(
      "GET",
      "/rest/api/2/application-properties?permissionLevel=SYSADMIN&key=missing.property",
    );
    assert.equal(missingProperty.statusCode, 404);
    assert.ok(Array.isArray(missingProperty.json().errorMessages));
  }

  await app.close();
  app = buildApp({ dataFile, baseUrl: "http://jira.test" });

  {
    const property = await request(
      "GET",
      "/rest/api/2/application-properties?permissionLevel=SYSADMIN&key=jira.clone.prefix",
    );
    assert.equal(property.json().value, "COPY - ");
    const columns = await request("GET", "/rest/api/2/settings/columns");
    assert.deepEqual(columns.json().columns, ["key", "summary", "priority"]);
    const readOnly = await request("GET", "/rest/api/2/readonly-mode");
    assert.equal(readOnly.json().enabled, true);
    const appMonitoring = await request("GET", "/rest/api/2/monitoring/app");
    assert.equal(appMonitoring.json().enabled, false);
  }

  {
    const reset = await request("POST", "/__admin/reset");
    assert.equal(reset.statusCode, 204);
    assert.equal(reset.body, "");
    const property = await request(
      "GET",
      "/rest/api/2/application-properties?permissionLevel=SYSADMIN&key=jira.clone.prefix",
    );
    assert.equal(property.json().value, "CLONE - ");
    const readOnly = await request("GET", "/rest/api/2/readonly-mode");
    assert.equal(readOnly.json().enabled, false);
  }
});
