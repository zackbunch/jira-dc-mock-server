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

test("cluster node and zero-downtime-upgrade operations enforce lifecycle rules", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "jira-cluster-"));
  const dataFile = join(directory, "state.json");
  let app = buildApp({ dataFile });
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const request = (method: "GET" | "POST" | "PUT" | "DELETE", url: string) =>
    app.inject({ method, url, headers: authorization });

  {
    const response = await request("GET", "/rest/api/2/cluster/nodes");
    assert.equal(response.statusCode, 200);
    const nodes = response.json();
    assert.ok(Array.isArray(nodes));
    assert.equal(nodes.length, 2);
    const schema = responseSchema("/api/2/cluster/nodes", "get", 200);
    for (const [index, node] of nodes.entries()) {
      assertMatchesSchema(schema, node, `GET /api/2/cluster/nodes[${index}]`);
      assert.equal(typeof node.nodeId, "string");
      assert.equal(node.nodeVersion, "10.3.5");
    }
  }

  {
    const snapshot = await request(
      "PUT",
      "/rest/api/2/cluster/index-snapshot/jira-mock-node-1",
    );
    assert.equal(snapshot.statusCode, 200);
    assert.equal(snapshot.body, "");
    const missing = await request("PUT", "/rest/api/2/cluster/index-snapshot/missing-node");
    assert.equal(missing.statusCode, 404);
    assert.ok(Array.isArray(missing.json().errorMessages));
  }

  {
    const liveNode = await request(
      "PUT",
      "/rest/api/2/cluster/node/jira-mock-node-1/offline",
    );
    assert.equal(liveNode.statusCode, 500);
    const offline = await request(
      "PUT",
      "/rest/api/2/cluster/node/jira-mock-node-2/offline",
    );
    assert.equal(offline.statusCode, 200);
    assert.equal(offline.body, "");
    const removed = await request("DELETE", "/rest/api/2/cluster/node/jira-mock-node-2");
    assert.equal(removed.statusCode, 204);
    assert.equal(removed.body, "");
    assertEmptyResponseDocumented("/api/2/cluster/node/{nodeId}", "delete", 204);
  }

  {
    const state = await request("GET", "/rest/api/2/cluster/zdu/state");
    assert.equal(state.statusCode, 200);
    assertMatchesResponse("/api/2/cluster/zdu/state", "get", 200, state.json());
    assert.equal(state.json().state, "STABLE");
    assert.equal(state.json().build.version, "10.3.5");

    const started = await request("POST", "/rest/api/2/cluster/zdu/start");
    assert.equal(started.statusCode, 201);
    assert.equal(started.body, "");
    const conflict = await request("POST", "/rest/api/2/cluster/zdu/start");
    assert.equal(conflict.statusCode, 409);
    const approved = await request("POST", "/rest/api/2/cluster/zdu/approve");
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.body, "");
    const failedState = await request("GET", "/rest/api/2/cluster/zdu/state");
    assert.equal(failedState.json().state, "UPGRADE_TASKS_FAILED");
    const retried = await request("POST", "/rest/api/2/cluster/zdu/retryUpgrade");
    assert.equal(retried.statusCode, 200);
    assert.equal(retried.body, "");
    const retryConflict = await request("POST", "/rest/api/2/cluster/zdu/retryUpgrade");
    assert.equal(retryConflict.statusCode, 409);
  }

  {
    const start = await request("POST", "/rest/api/2/cluster/zdu/start");
    assert.equal(start.statusCode, 201);
    await app.close();
    app = buildApp({ dataFile });
    const persisted = await request("GET", "/rest/api/2/cluster/zdu/state");
    assert.equal(persisted.json().state, "READY_TO_UPGRADE");
    const cancel = await request("POST", "/rest/api/2/cluster/zdu/cancel");
    assert.equal(cancel.statusCode, 201);
    assert.equal(cancel.body, "");
    const cancelConflict = await request("POST", "/rest/api/2/cluster/zdu/cancel");
    assert.equal(cancelConflict.statusCode, 409);
  }

  {
    const reset = await request("POST", "/__admin/reset");
    assert.equal(reset.statusCode, 204);
    const nodes = await request("GET", "/rest/api/2/cluster/nodes");
    assert.equal(nodes.json().length, 2);
    const state = await request("GET", "/rest/api/2/cluster/zdu/state");
    assert.equal(state.json().state, "STABLE");
  }
});
