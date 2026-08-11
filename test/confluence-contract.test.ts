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
    new URL("../contracts/confluence-dc-10.0.3-openapi.json", import.meta.url),
    "utf8",
  ),
) as OpenApiSpecification;

test("pins the official Confluence Data Center 10.0.3 OpenAPI contract", () => {
  assert.equal(specification.openapi, "3.0.1");
  assert.equal(specification.info.title, "Confluence Data Center");
  assert.equal(specification.info.version, "10.0.3");
  assert.equal(specification.servers[0].url, "http://{baseurl}/confluence");
  assert.ok(specification.paths["/rest/api/content/{id}"]?.get);
  assert.ok(Object.keys(specification.paths).length >= 130);
  assert.ok(Object.keys(specification.components?.schemas ?? {}).length >= 120);
});
