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
  officialSpecification,
} from "./helpers/official-contract.js";

type Method = "GET" | "POST" | "PUT" | "DELETE";

const assignedOperations = new Set(
  Object.entries(
    (officialSpecification as unknown as {
      paths: Record<string, Record<string, { tags?: string[] }>>;
    }).paths,
  ).flatMap(([path, methods]) =>
    Object.entries(methods)
      .filter(([, operation]) => operation.tags?.some((tag) => tag === "workflow" || tag === "workflowscheme"))
      .map(([method]) => `${method.toUpperCase()} ${path}`),
  ),
);

test("workflow and workflow-scheme operations follow Jira 10.3 and persist", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "jira-workflow-schemes-"));
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
      status?: number;
      schema?: "exact" | "empty";
    } = {},
  ) => {
    visited.add(`${method} ${contractPath}`);
    const response = await app.inject({
      method,
      url,
      headers: {
        ...authorization,
        ...(options.payload === undefined ? {} : { "content-type": "application/json" }),
      },
      payload: options.payload as never,
    });
    const status = options.status ?? 200;
    assert.equal(response.statusCode, status, `${method} ${url}: ${response.body}`);
    if (options.schema === "empty") {
      assertEmptyResponseDocumented(contractPath, method, status);
      if (status === 204) assert.equal(response.body, "");
      return { response, body: response.body ? response.json() : undefined };
    }
    const body = response.json();
    assertMatchesResponse(contractPath, method, status, body);
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
    const { body } = await call("/api/2/workflow", "GET", "/rest/api/2/workflow?workflowName=Release%20Workflow", { schema: "empty" });
    assert.equal(body.length, 1);
    assert.equal(body[0].name, "Release Workflow");
    assert.ok(Array.isArray(body[0].steps));
    assert.equal(typeof body[0].active, "boolean");
  }

  const created = await call("/api/2/workflowscheme", "POST", "/rest/api/2/workflowscheme", {
    payload: {
      name: "Contract Workflow Scheme",
      description: "Persistent workflow-scheme contract fixture.",
      defaultWorkflow: "jira",
      issueTypeMappings: { "10001": "Release Workflow" },
    },
    status: 201,
    schema: "empty",
  });
  const id = created.body.id as number;
  assert.equal(typeof id, "number");
  assert.equal(created.body.draft, false);

  {
    const { body } = await call("/api/2/workflowscheme/{id}", "GET", `/rest/api/2/workflowscheme/${id}`);
    assert.equal(body.id, id);
    assert.equal(body.name, "Contract Workflow Scheme");
    assert.equal(body.issueTypeMappings["10001"], "Release Workflow");
  }
  {
    const { body } = await call("/api/2/workflowscheme/{id}", "PUT", `/rest/api/2/workflowscheme/${id}`, {
      payload: { name: "Contract Workflow Scheme Updated", description: "Updated and persisted." },
    });
    assert.equal(body.name, "Contract Workflow Scheme Updated");
  }
  await expectError("GET", "/rest/api/2/workflowscheme/999999", 404);
  await expectError("PUT", `/rest/api/2/workflowscheme/${id}`, 404, { defaultWorkflow: "Missing Workflow" });
  await expectError("DELETE", "/rest/api/2/workflowscheme/10000", 400);

  {
    const { body } = await call("/api/2/workflowscheme/{id}/default", "GET", `/rest/api/2/workflowscheme/${id}/default`);
    assert.equal(body.defaultWorkflow, "jira");
  }
  {
    const { body } = await call("/api/2/workflowscheme/{id}/default", "PUT", `/rest/api/2/workflowscheme/${id}/default`, {
      payload: { workflow: "Release Workflow", updateDraftIfNeeded: false },
    });
    assert.equal(body.defaultWorkflow, "Release Workflow");
  }
  {
    const { body } = await call("/api/2/workflowscheme/{id}/default", "DELETE", `/rest/api/2/workflowscheme/${id}/default?updateDraftIfNeeded=false`);
    assert.equal(body.defaultWorkflow, undefined);
  }
  await expectError("PUT", `/rest/api/2/workflowscheme/${id}/default`, 404, { workflow: "Missing Workflow" });

  {
    const { body } = await call("/api/2/workflowscheme/{id}/issuetype/{issueType}", "GET", `/rest/api/2/workflowscheme/${id}/issuetype/10001`);
    assert.deepEqual(body, { issueType: "10001", workflow: "Release Workflow", updateDraftIfNeeded: false });
  }
  {
    const { body } = await call("/api/2/workflowscheme/{id}/issuetype/{issueType}", "PUT", `/rest/api/2/workflowscheme/${id}/issuetype/10001`, {
      payload: { issueType: "ignored", workflow: "jira", updateDraftIfNeeded: false },
    });
    assert.equal(body.issueTypeMappings["10001"], "jira");
  }

  {
    const { body } = await call("/api/2/workflowscheme/{id}/workflow", "GET", `/rest/api/2/workflowscheme/${id}/workflow?workflowName=jira`);
    assert.deepEqual(body.issueTypeMappings, { "10001": "jira" });
  }
  {
    const { body } = await call("/api/2/workflowscheme/{id}/workflow", "PUT", `/rest/api/2/workflowscheme/${id}/workflow?workflowName=jira`, {
      payload: { workflow: "Release Workflow", issueTypes: ["10001", "10003"], defaultMapping: true, updateDraftIfNeeded: false },
    });
    assert.equal(body.defaultWorkflow, "Release Workflow");
    assert.equal(body.issueTypeMappings["10003"], "Release Workflow");
  }
  {
    const { body } = await call("/api/2/workflowscheme/{id}/workflow", "DELETE", `/rest/api/2/workflowscheme/${id}/workflow?workflowName=Release%20Workflow&updateDraftIfNeeded=false`);
    assert.equal(body.defaultWorkflow, undefined);
    assert.deepEqual(body.issueTypeMappings, {});
  }
  await expectError("PUT", `/rest/api/2/workflowscheme/${id}/workflow?workflowName=jira`, 404, { workflow: "jira", issueTypes: ["99999"] });

  await call("/api/2/workflowscheme/{id}/issuetype/{issueType}", "PUT", `/rest/api/2/workflowscheme/${id}/issuetype/10002`, {
    payload: { workflow: "jira", updateDraftIfNeeded: false },
  });
  {
    const { body } = await call("/api/2/workflowscheme/{id}/issuetype/{issueType}", "DELETE", `/rest/api/2/workflowscheme/${id}/issuetype/10002?updateDraftIfNeeded=false`);
    assert.equal(body.issueTypeMappings["10002"], undefined);
  }
  await expectError("GET", `/rest/api/2/workflowscheme/${id}/issuetype/99999`, 404);

  {
    const { body } = await call("/api/2/workflowscheme/{id}/createdraft", "POST", `/rest/api/2/workflowscheme/${id}/createdraft`, { status: 201 });
    assert.equal(body.draft, true);
    assert.deepEqual(body.originalIssueTypeMappings, {});
  }
  {
    const { body } = await call("/api/2/workflowscheme/{id}/draft", "GET", `/rest/api/2/workflowscheme/${id}/draft`);
    assert.equal(body.draft, true);
  }
  {
    const { body } = await call("/api/2/workflowscheme/{id}/draft", "PUT", `/rest/api/2/workflowscheme/${id}/draft`, {
      payload: { name: "Contract Workflow Scheme Draft", defaultWorkflow: "jira", issueTypeMappings: { "10002": "Release Workflow" } },
    });
    assert.equal(body.name, "Contract Workflow Scheme Draft");
    assert.equal(body.issueTypeMappings["10002"], "Release Workflow");
  }
  {
    const { body } = await call("/api/2/workflowscheme/{id}", "GET", `/rest/api/2/workflowscheme/${id}?returnDraftIfExists=true`);
    assert.equal(body.draft, true);
    assert.equal(body.name, "Contract Workflow Scheme Draft");
  }

  {
    const { body } = await call("/api/2/workflowscheme/{id}/draft/default", "GET", `/rest/api/2/workflowscheme/${id}/draft/default`);
    assert.equal(body.defaultWorkflow, "jira");
  }
  {
    const { body } = await call("/api/2/workflowscheme/{id}/draft/default", "PUT", `/rest/api/2/workflowscheme/${id}/draft/default`, {
      payload: { workflow: "Release Workflow" },
    });
    assert.equal(body.defaultWorkflow, "Release Workflow");
  }
  {
    const { body } = await call("/api/2/workflowscheme/{id}/draft/default", "DELETE", `/rest/api/2/workflowscheme/${id}/draft/default`);
    assert.equal(body.defaultWorkflow, undefined);
  }

  {
    const { body } = await call("/api/2/workflowscheme/{id}/draft/issuetype/{issueType}", "GET", `/rest/api/2/workflowscheme/${id}/draft/issuetype/10002`);
    assert.equal(body.workflow, "Release Workflow");
  }
  {
    const { body } = await call("/api/2/workflowscheme/{id}/draft/issuetype/{issueType}", "PUT", `/rest/api/2/workflowscheme/${id}/draft/issuetype/10002`, {
      payload: { issueType: "ignored", workflow: "jira" },
    });
    assert.equal(body.issueTypeMappings["10002"], "jira");
  }
  {
    const { body } = await call("/api/2/workflowscheme/{id}/draft/issuetype/{issueType}", "DELETE", `/rest/api/2/workflowscheme/${id}/draft/issuetype/10002`);
    assert.equal(body.issueTypeMappings["10002"], undefined);
  }

  {
    const { body } = await call("/api/2/workflowscheme/{id}/draft/workflow", "PUT", `/rest/api/2/workflowscheme/${id}/draft/workflow?workflowName=jira`, {
      payload: { workflow: "Release Workflow", issueTypes: ["10003"], defaultMapping: true },
    });
    assert.equal(body.defaultWorkflow, "Release Workflow");
    assert.equal(body.issueTypeMappings["10003"], "Release Workflow");
  }
  {
    const { body } = await call("/api/2/workflowscheme/{id}/draft/workflow", "GET", `/rest/api/2/workflowscheme/${id}/draft/workflow?workflowName=Release%20Workflow`);
    assert.deepEqual(body.issueTypeMappings, { "10003": "Release Workflow" });
  }
  {
    const { body } = await call("/api/2/workflowscheme/{id}/draft/workflow", "DELETE", `/rest/api/2/workflowscheme/${id}/draft/workflow?workflowName=Release%20Workflow`);
    assert.equal(body.defaultWorkflow, undefined);
    assert.deepEqual(body.issueTypeMappings, {});
  }

  {
    const { body } = await call("/api/2/workflowscheme/{id}/issuetype/{issueType}", "PUT", "/rest/api/2/workflowscheme/10000/issuetype/10001", {
      payload: { workflow: "Release Workflow", updateDraftIfNeeded: true },
    });
    assert.equal(body.draft, true, "active-scheme mutation creates a draft when requested");
    assert.equal(body.issueTypeMappings["10001"], "Release Workflow");
  }
  {
    const response = await app.inject({ method: "GET", url: "/rest/api/2/workflowscheme/10000?returnDraftIfExists=true", headers: authorization });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().draft, true);
  }

  await app.close();
  app = buildApp({ dataFile, baseUrl: "http://jira.test" });
  {
    const response = await app.inject({ method: "GET", url: `/rest/api/2/workflowscheme/${id}/draft`, headers: authorization });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().name, "Contract Workflow Scheme Draft");
  }
  {
    const response = await app.inject({ method: "GET", url: `/rest/api/2/workflowscheme/${id}`, headers: authorization });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().name, "Contract Workflow Scheme Updated");
  }

  await call("/api/2/workflowscheme/{id}/draft", "DELETE", `/rest/api/2/workflowscheme/${id}/draft`, { status: 204, schema: "empty" });
  await call("/api/2/workflowscheme/{id}", "DELETE", `/rest/api/2/workflowscheme/${id}`, { status: 204, schema: "empty" });
  await expectError("GET", `/rest/api/2/workflowscheme/${id}`, 404);
  await expectError("GET", `/rest/api/2/workflowscheme/${id}/draft`, 404);

  assert.deepEqual(
    [...visited].sort(),
    [...assignedOperations].sort(),
    "the focused test must call every workflow and workflow-scheme operation",
  );

  {
    const response = await app.inject({ method: "POST", url: "/__admin/reset", headers: authorization });
    assert.equal(response.statusCode, 204);
  }
  {
    const response = await app.inject({ method: "GET", url: "/rest/api/2/workflowscheme/10000", headers: authorization });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().name, "Software Development Workflow Scheme");
  }
  {
    const response = await app.inject({ method: "GET", url: "/rest/api/2/workflowscheme/10000/draft", headers: authorization });
    assert.equal(response.statusCode, 404, "first access after reset re-seeds state without stale drafts");
  }
  {
    const response = await app.inject({ method: "GET", url: `/rest/api/2/workflowscheme/${id}`, headers: authorization });
    assert.equal(response.statusCode, 404, "reset removes persisted user-created schemes");
  }
});
