import type { FastifyPluginAsync } from "fastify";
import { jiraError } from "../shared/errors.js";
import { getResourceState } from "../store.js";

type NodeState = "ACTIVE" | "PASSIVE" | "ACTIVATING" | "PASSIVATING" | "OFFLINE";
type UpgradeState =
  | "STABLE"
  | "READY_TO_UPGRADE"
  | "MIXED"
  | "READY_TO_RUN_UPGRADE_TASKS"
  | "RUNNING_UPGRADE_TASKS"
  | "UPGRADE_TASKS_FAILED";

interface ClusterNode {
  alive: boolean;
  cacheListenerPort: number;
  ip: string;
  lastStateChangeTimestamp: number;
  nodeBuildNumber: number;
  nodeId: string;
  nodeVersion: string;
  state: NodeState;
}

interface ClusterResourceState {
  nodes: ClusterNode[];
  upgradeState: UpgradeState;
  lastSnapshotNodeId: string | null;
}

function defaultClusterState(): ClusterResourceState {
  return {
    nodes: [
      {
        alive: true,
        cacheListenerPort: 40_001,
        ip: "192.0.2.10",
        lastStateChangeTimestamp: 1_788_192_000_000,
        nodeBuildNumber: 1_003_005,
        nodeId: "jira-mock-node-1",
        nodeVersion: "10.3.5",
        state: "ACTIVE",
      },
      {
        alive: false,
        cacheListenerPort: 40_002,
        ip: "192.0.2.11",
        lastStateChangeTimestamp: 1_788_192_000_000,
        nodeBuildNumber: 1_003_005,
        nodeId: "jira-mock-node-2",
        nodeVersion: "10.3.5",
        state: "ACTIVE",
      },
    ],
    upgradeState: "STABLE",
    lastSnapshotNodeId: null,
  };
}

const clusterRoutes: FastifyPluginAsync = async (app) => {
  const state = () => getResourceState(app.jira.store, "cluster", defaultClusterState);
  const findNode = (nodeId: string) =>
    state().nodes.find((candidate) => candidate.nodeId === nodeId);

  app.get("/rest/api/2/cluster/nodes", async () => structuredClone(state().nodes));

  app.put("/rest/api/2/cluster/index-snapshot/:nodeId", async (request, reply) => {
    const { nodeId } = request.params as { nodeId: string };
    const node = findNode(nodeId);
    if (!node) return reply.code(404).send(jiraError(["Cluster node was not found."]));
    if (!node.alive || node.state === "OFFLINE") {
      return reply.code(404).send(jiraError(["Cluster node is not available."]));
    }
    state().lastSnapshotNodeId = nodeId;
    app.jira.store.save();
    return reply.code(200).send();
  });

  app.put("/rest/api/2/cluster/node/:nodeId/offline", async (request, reply) => {
    const { nodeId } = request.params as { nodeId: string };
    const node = findNode(nodeId);
    if (!node) return reply.code(404).send(jiraError(["Cluster node was not found."]));
    if (node.alive) {
      return reply
        .code(500)
        .send(jiraError(["A live cluster node cannot be changed to offline."]));
    }
    node.state = "OFFLINE";
    node.lastStateChangeTimestamp = Date.now();
    app.jira.store.save();
    return reply.code(200).send();
  });

  app.delete("/rest/api/2/cluster/node/:nodeId", async (request, reply) => {
    const { nodeId } = request.params as { nodeId: string };
    const index = state().nodes.findIndex((candidate) => candidate.nodeId === nodeId);
    if (index < 0) return reply.code(404).send(jiraError(["Cluster node was not found."]));
    if (state().nodes[index].state !== "OFFLINE") {
      return reply.code(500).send(jiraError(["Only an offline cluster node can be deleted."]));
    }
    state().nodes.splice(index, 1);
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/cluster/zdu/state", async () => ({
    state: state().upgradeState,
    build: { buildNumber: 1_003_005, version: "10.3.5" },
  }));

  app.post("/rest/api/2/cluster/zdu/start", async (_request, reply) => {
    if (state().upgradeState !== "STABLE") {
      return reply.code(409).send(jiraError(["A cluster upgrade is already in progress."]));
    }
    state().upgradeState = "READY_TO_UPGRADE";
    app.jira.store.save();
    return reply.code(201).send();
  });

  app.post("/rest/api/2/cluster/zdu/approve", async (_request, reply) => {
    if (state().upgradeState !== "READY_TO_UPGRADE") {
      return reply.code(409).send(jiraError(["There is no cluster upgrade awaiting approval."]));
    }
    // The first synthetic task run fails deterministically so retryUpgrade has
    // a meaningful state transition that can be exercised by clients.
    state().upgradeState = "UPGRADE_TASKS_FAILED";
    app.jira.store.save();
    return reply.code(200).send();
  });

  app.post("/rest/api/2/cluster/zdu/retryUpgrade", async (_request, reply) => {
    if (state().upgradeState !== "UPGRADE_TASKS_FAILED") {
      return reply.code(409).send(jiraError(["There is no failed cluster upgrade to retry."]));
    }
    state().upgradeState = "STABLE";
    app.jira.store.save();
    return reply.code(200).send();
  });

  app.post("/rest/api/2/cluster/zdu/cancel", async (_request, reply) => {
    if (state().upgradeState === "STABLE") {
      return reply.code(409).send(jiraError(["There is no cluster upgrade to cancel."]));
    }
    state().upgradeState = "STABLE";
    app.jira.store.save();
    return reply.code(201).send();
  });
};

export default clusterRoutes;
