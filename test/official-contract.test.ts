import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

interface OpenApiSpecification {
  openapi: string;
  info: { title: string; version: string };
  servers: Array<{ url: string }>;
  paths: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
}

const specification = JSON.parse(
  readFileSync(
    new URL("../contracts/jira-software-dc-10.3-openapi.json", import.meta.url),
    "utf8",
  ),
) as OpenApiSpecification;

test("pins the official Jira Data Center 10.3 OpenAPI contract", () => {
  assert.equal(specification.openapi, "3.0.1");
  assert.equal(specification.info.title, "Jira Software Data Center REST API Reference");
  assert.match(specification.info.version, /^10\.3\./);
  assert.equal(specification.servers[0].url, "http://{baseurl}/rest");
  assert.ok(Object.keys(specification.paths).length >= 250);
  assert.ok(Object.keys(specification.components?.schemas ?? {}).length >= 300);
});

test("official contract covers every Jira route implemented by the mock", () => {
  const implementedOperations: Array<[string, string]> = [
    ["get", "/api/2/serverInfo"],
    ["get", "/api/2/myself"],
    ["get", "/api/2/project"],
    ["get", "/api/2/project/{projectIdOrKey}"],
    ["get", "/api/2/field"],
    ["get", "/api/2/issuetype"],
    ["get", "/api/2/priority"],
    ["get", "/api/2/status"],
    ["get", "/api/2/search"],
    ["post", "/api/2/search"],
    ["post", "/api/2/issue"],
    ["get", "/api/2/issue/{issueIdOrKey}"],
    ["put", "/api/2/issue/{issueIdOrKey}"],
    ["get", "/api/2/issue/{issueIdOrKey}/comment"],
    ["post", "/api/2/issue/{issueIdOrKey}/comment"],
    ["get", "/api/2/issue/{issueIdOrKey}/transitions"],
    ["post", "/api/2/issue/{issueIdOrKey}/transitions"],
  ];

  for (const [method, path] of implementedOperations) {
    assert.ok(
      specification.paths[path]?.[method],
      `Official Jira contract is missing ${method.toUpperCase()} ${path}`,
    );
  }
});
