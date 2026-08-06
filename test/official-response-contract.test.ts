import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ErrorObject } from "ajv";
import { buildApp } from "../src/app.js";

interface AjvValidator {
  (value: unknown): boolean;
  errors?: ErrorObject[] | null;
}

const require = createRequire(import.meta.url);
const Ajv = require("ajv") as new (options: {
  allErrors: boolean;
  strict: boolean;
  validateFormats: boolean;
}) => {
  addSchema(schema: unknown, key: string): void;
  compile(schema: unknown): AjvValidator;
};

interface OpenApiSchema {
  $ref?: string;
  [key: string]: unknown;
}

interface OpenApiSpecification {
  components: { schemas: Record<string, OpenApiSchema> };
  paths: Record<
    string,
    Record<
      string,
      {
        responses: Record<
          string,
          { content?: { "application/json"?: { schema?: OpenApiSchema } } }
        >;
      }
    >
  >;
}

const officialSpecification = JSON.parse(
  readFileSync(
    new URL("../contracts/jira-software-dc-10.3-openapi.json", import.meta.url),
    "utf8",
  ),
) as OpenApiSpecification;

// Jira issue fields are dynamic and can be strings, arrays, numbers, or objects.
// The generated 10.3 OpenAPI document incorrectly declares every field value as
// an object, despite its own example containing strings and arrays. Relax only
// that generated constraint while retaining the rest of IssueBean validation.
const validationSpecification = structuredClone(officialSpecification);
const issueFieldsSchema = validationSpecification.components.schemas.IssueBean
  .properties as { fields: { additionalProperties: unknown } };
issueFieldsSchema.fields.additionalProperties = true;

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  validateFormats: false,
});
ajv.addSchema(validationSpecification, "jira-dc-10.3");

function responseSchema(path: string, method: string, status: number): OpenApiSchema {
  const schema =
    officialSpecification.paths[path]?.[method]?.responses[String(status)]?.content?.[
      "application/json"
    ]?.schema;
  assert.ok(schema, `No official response schema for ${method.toUpperCase()} ${path} (${status})`);
  return schema;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

function assertMatchesSchema(schema: OpenApiSchema, value: unknown, label: string): void {
  const reference = schema.$ref;
  const validator = ajv.compile(
    reference ? { $ref: `jira-dc-10.3${reference}` } : schema,
  );
  assert.equal(validator(value), true, `${label}: ${formatErrors(validator.errors)}`);
}

function assertMatchesResponse(
  path: string,
  method: string,
  status: number,
  value: unknown,
): void {
  assertMatchesSchema(
    responseSchema(path, method, status),
    value,
    `${method.toUpperCase()} ${path}`,
  );
}

function assertListItemsMatchResponse(
  path: string,
  method: string,
  status: number,
  value: unknown,
): void {
  assert.ok(Array.isArray(value), `${method.toUpperCase()} ${path} must return an array`);
  assert.ok(value.length > 0, `${method.toUpperCase()} ${path} must return seeded values`);
  const schema = responseSchema(path, method, status);
  for (const [index, item] of value.entries()) {
    assertMatchesSchema(schema, item, `${method.toUpperCase()} ${path}[${index}]`);
    assert.equal(typeof item.id, "string");
    assert.equal(typeof item.name, "string");
  }
}

function assertEmptyResponseDocumented(path: string, method: string, status: number): void {
  const contractResponse =
    officialSpecification.paths[path]?.[method]?.responses[String(status)];
  assert.ok(
    contractResponse,
    `No official response for ${method.toUpperCase()} ${path} (${status})`,
  );
  assert.equal(contractResponse.content?.["application/json"], undefined);
}

const authorization = { authorization: "Bearer local-test-token" };

test("mocked Jira success responses follow the official 10.3 contract", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "jira-contract-"));
  const app = buildApp({
    dataFile: join(directory, "state.json"),
    baseUrl: "http://jira.test",
  });
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const jsonRequest = async (
    method: "GET" | "POST" | "PUT",
    url: string,
    payload?: Record<string, unknown>,
  ) => {
    const response = await app.inject({
      method,
      url,
      headers: {
        ...authorization,
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      payload,
    });
    return { response, body: response.body ? response.json() : undefined };
  };

  {
    const basicAuthorization = Buffer.from("developer:developer").toString("base64");
    const response = await app.inject({
      method: "GET",
      url: "/rest/api/2/serverInfo",
      headers: { authorization: `Basic ${basicAuthorization}` },
    });
    const body = response.json();
    assert.equal(response.statusCode, 200);
    assertMatchesResponse("/api/2/serverInfo", "get", 200, body);
    assert.equal(typeof body.version, "string");
    assert.ok(Array.isArray(body.versionNumbers));
  }

  {
    const { response, body } = await jsonRequest("GET", "/rest/api/2/myself");
    assert.equal(response.statusCode, 200);
    assertMatchesResponse("/api/2/myself", "get", 200, body);
    assert.equal(typeof body.name, "string");
    assert.equal(typeof body.active, "boolean");
  }

  for (const [url, contractPath] of [
    ["/rest/api/2/project", "/api/2/project"],
    ["/rest/api/2/field", "/api/2/field"],
    ["/rest/api/2/issuetype", "/api/2/issuetype"],
    ["/rest/api/2/priority", "/api/2/priority"],
    ["/rest/api/2/status", "/api/2/status"],
  ] as const) {
    const { response, body } = await jsonRequest("GET", url);
    assert.equal(response.statusCode, 200);
    // These Jira endpoints return arrays, but the generated Atlassian OpenAPI
    // document references the item schema rather than wrapping it in an array.
    assertListItemsMatchResponse(contractPath, "get", 200, body);
  }

  {
    const { response, body } = await jsonRequest(
      "GET",
      "/rest/api/2/project/T100ZB",
    );
    assert.equal(response.statusCode, 200);
    assertMatchesResponse("/api/2/project/{projectIdOrKey}", "get", 200, body);
    assert.equal(body.key, "T100ZB");
    assert.equal(typeof body.id, "string");
  }

  {
    const { response, body } = await jsonRequest("GET", "/rest/api/2/search?jql=project%20%3D%20T100ZB&fields=summary,status,project&maxResults=5");
    assert.equal(response.statusCode, 200);
    assertMatchesResponse("/api/2/search", "get", 200, body);
    assert.ok(Array.isArray(body.issues));
    assert.equal(body.issues.length, 5);
    assert.equal(typeof body.startAt, "number");
    assert.equal(typeof body.maxResults, "number");
    assert.equal(typeof body.total, "number");
    assert.ok(body.issues.every((issue: { key?: unknown }) => typeof issue.key === "string"));
  }

  {
    const { response, body } = await jsonRequest("POST", "/rest/api/2/search", {
      jql: "project = T100ZB ORDER BY key ASC",
      fields: ["summary", "status", "project"],
      expand: ["names", "schema"],
      validateQuery: true,
      maxResults: 5,
    });
    assert.equal(response.statusCode, 200);
    assertMatchesResponse("/api/2/search", "post", 200, body);
    assert.ok(Array.isArray(body.issues));
    assert.equal(body.issues.length, 5);
    assert.ok(body.issues.every((issue: { key?: unknown }) => typeof issue.key === "string"));
  }

  {
    const { response, body } = await jsonRequest(
      "GET",
      "/rest/api/2/issue/T100ZB-1",
    );
    assert.equal(response.statusCode, 200);
    assertMatchesResponse("/api/2/issue/{issueIdOrKey}", "get", 200, body);
    assert.equal(body.key, "T100ZB-1");
  }

  {
    const { response, body } = await jsonRequest(
      "GET",
      "/rest/api/2/issue/T100ZB-1/comment",
    );
    assert.equal(response.statusCode, 200);
    assertMatchesResponse(
      "/api/2/issue/{issueIdOrKey}/comment",
      "get",
      200,
      body,
    );
  }

  {
    const { response, body } = await jsonRequest(
      "GET",
      "/rest/api/2/issue/T100ZB-2/transitions",
    );
    assert.equal(response.statusCode, 200);
    assertMatchesResponse(
      "/api/2/issue/{issueIdOrKey}/transitions",
      "get",
      200,
      body,
    );
    assert.ok(Array.isArray(body.transitions));
    assert.ok(body.transitions.length > 0);
    assert.equal(typeof body.transitions[0].id, "string");
    assert.equal(typeof body.transitions[0].name, "string");
    assert.equal(typeof body.transitions[0].to?.id, "string");
  }

  let createdIssueKey: string;
  {
    const { response, body } = await jsonRequest("POST", "/rest/api/2/issue", {
      fields: {
        project: { key: "T100ZB" },
        issuetype: { name: "Bug" },
        summary: "Contract validation issue",
      },
    });
    assert.equal(response.statusCode, 201);
    assertMatchesResponse("/api/2/issue", "post", 201, body);
    assert.equal(typeof body.id, "string");
    assert.equal(typeof body.key, "string");
    assert.equal(typeof body.self, "string");
    createdIssueKey = body.key;
  }

  {
    const { response } = await jsonRequest(
      "PUT",
      `/rest/api/2/issue/${createdIssueKey}`,
      { fields: { labels: ["contract-tested"] } },
    );
    assert.equal(response.statusCode, 204);
    assert.equal(response.body, "");
    assertEmptyResponseDocumented("/api/2/issue/{issueIdOrKey}", "put", 204);
  }

  {
    const { response, body } = await jsonRequest(
      "POST",
      `/rest/api/2/issue/${createdIssueKey}/comment`,
      { body: "Contract-tested comment" },
    );
    assert.equal(response.statusCode, 201);
    assertMatchesResponse(
      "/api/2/issue/{issueIdOrKey}/comment",
      "post",
      201,
      body,
    );
    assert.equal(typeof body.id, "string");
    assert.equal(body.body, "Contract-tested comment");
    assert.equal(typeof body.author?.name, "string");
  }

  {
    const { response } = await jsonRequest(
      "POST",
      `/rest/api/2/issue/${createdIssueKey}/transitions`,
      { transition: { id: "21" } },
    );
    assert.equal(response.statusCode, 204);
    assert.equal(response.body, "");
    assertEmptyResponseDocumented(
      "/api/2/issue/{issueIdOrKey}/transitions",
      "post",
      204,
    );
  }
});
