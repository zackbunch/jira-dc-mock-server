import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { assertMatchesResponse, authorization } from "./helpers/official-contract.js";

test("index snapshots and reindex requests are deterministic, persistent, and schema-valid", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "jira-indexing-"));
  const dataFile = join(directory, "state.json");
  let app = buildApp({ dataFile, baseUrl: "http://jira.test" });
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const request = (method: "GET" | "POST", url: string) =>
    app.inject({ method, url, headers: authorization });

  {
    const response = await request("GET", "/rest/api/2/index/summary");
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assertMatchesResponse("/api/2/index/summary", "get", 200, body);
    assert.equal(body.nodeId, "jira-mock-node-1");
    assert.equal(body.issueIndex.countInIndex, body.issueIndex.countInDatabase);
  }

  let snapshotPath: string;
  {
    const before = await request("GET", "/rest/api/2/index-snapshot");
    assert.equal(before.statusCode, 200);
    assertMatchesResponse("/api/2/index-snapshot", "get", 200, before.json());
    assert.match(before.json().absolutePath, /^\/mock\/jira\//);

    const create = await request("POST", "/rest/api/2/index-snapshot");
    assert.equal(create.statusCode, 202);
    const body = create.json();
    assertMatchesResponse("/api/2/index-snapshot", "post", 202, body);
    assert.match(body.futureAbsolutePath, /^\/mock\/jira\//);
    snapshotPath = body.futureAbsolutePath;

    const conflict = await request("POST", "/rest/api/2/index-snapshot");
    assert.equal(conflict.statusCode, 409);
    assert.ok(Array.isArray(conflict.json().errorMessages));

    const running = await request("GET", "/rest/api/2/index-snapshot/isRunning");
    assert.equal(running.statusCode, 200);
    assertMatchesResponse("/api/2/index-snapshot/isRunning", "get", 200, running.json());
    assert.equal(running.json().running, true);

    const completed = await request("GET", "/rest/api/2/index-snapshot/isRunning");
    assert.equal(completed.json().running, false);
    const after = await request("GET", "/rest/api/2/index-snapshot");
    assert.equal(after.json().absolutePath, snapshotPath);
  }

  {
    const absent = await request("GET", "/rest/api/2/reindex");
    assert.equal(absent.statusCode, 404);
    assert.ok(Array.isArray(absent.json().errorMessages));
  }

  {
    const response = await request(
      "POST",
      "/rest/api/2/reindex?type=background_preferred&indexComments=true",
    );
    assert.equal(response.statusCode, 202);
    const body = response.json();
    assertMatchesResponse("/api/2/reindex", "post", 202, body);
    assert.equal(body.success, true);
    assert.equal(body.currentProgress, 100);
    assert.equal(body.type, "BACKGROUND_PREFERRED");

    const latest = await request("GET", "/rest/api/2/reindex");
    assert.equal(latest.statusCode, 200);
    assertMatchesResponse("/api/2/reindex", "get", 200, latest.json());
    assert.equal(latest.json().success, true);

    const progress = await request("GET", "/rest/api/2/reindex/progress");
    assert.equal(progress.statusCode, 200);
    assertMatchesResponse("/api/2/reindex/progress", "get", 200, progress.json());
    assert.equal(progress.json().currentProgress, 100);
  }

  {
    const response = await request(
      "POST",
      "/rest/api/2/reindex/issue?issueId=T100ZB-1&issueId=T100ZB-2&indexComments=true",
    );
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assertMatchesResponse("/api/2/reindex/issue", "post", 200, body);
    assert.equal(body.success, true);
    assert.match(body.currentSubTask, /2 issues/);
  }

  let requestId: number;
  {
    const response = await request("POST", "/rest/api/2/reindex/request");
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assertMatchesResponse("/api/2/reindex/request", "post", 200, body);
    assert.equal(typeof body, "number");
    requestId = body;
  }

  {
    const bulk = await request(
      "GET",
      `/rest/api/2/reindex/request/bulk?requestId=${requestId}`,
    );
    assert.equal(bulk.statusCode, 200);
    assertMatchesResponse("/api/2/reindex/request/bulk", "get", 200, bulk.json());
    assert.equal(bulk.json().id, requestId);
    assert.equal(bulk.json().status, "COMPLETE");

    const single = await request("GET", `/rest/api/2/reindex/request/${requestId}`);
    assert.equal(single.statusCode, 200);
    assertMatchesResponse("/api/2/reindex/request/{requestId}", "get", 200, single.json());
    assert.equal(single.json().id, requestId);
  }

  await app.close();
  app = buildApp({ dataFile, baseUrl: "http://jira.test" });
  {
    const snapshot = await request("GET", "/rest/api/2/index-snapshot");
    assert.equal(snapshot.json().absolutePath, snapshotPath);
    const persistedRequest = await request("GET", `/rest/api/2/reindex/request/${requestId}`);
    assert.equal(persistedRequest.json().status, "COMPLETE");
  }

  {
    const reset = await request("POST", "/__admin/reset");
    assert.equal(reset.statusCode, 204);
    const snapshot = await request("GET", "/rest/api/2/index-snapshot");
    assert.match(snapshot.json().absolutePath, /IndexSnapshot_seed/);
    const missingRequest = await request("GET", `/rest/api/2/reindex/request/${requestId}`);
    assert.equal(missingRequest.statusCode, 404);
  }
});
