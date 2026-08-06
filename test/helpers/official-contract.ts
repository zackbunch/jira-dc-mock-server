import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { ErrorObject } from "ajv";

interface AjvValidator {
  (value: unknown): boolean;
  errors?: ErrorObject[] | null;
}

export interface OpenApiSchema {
  $ref?: string;
  [key: string]: unknown;
}

export interface OpenApiOperation {
  parameters?: unknown[];
  requestBody?: unknown;
  responses: Record<
    string,
    { content?: { "application/json"?: { schema?: OpenApiSchema } } }
  >;
}

interface OpenApiSpecification {
  components: { schemas: Record<string, OpenApiSchema> };
  paths: Record<string, Record<string, OpenApiOperation>>;
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

export const officialSpecification = JSON.parse(
  readFileSync(
    new URL("../../contracts/jira-software-dc-10.3-openapi.json", import.meta.url),
    "utf8",
  ),
) as OpenApiSpecification;

// COMPATIBILITY.md documents this single generated-contract defect. Keep the
// adapter local to IssueBean instead of weakening validation globally.
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

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

export function operation(path: string, method: string): OpenApiOperation {
  const result = officialSpecification.paths[path]?.[method.toLowerCase()];
  assert.ok(result, `No official operation for ${method.toUpperCase()} ${path}`);
  return result;
}

export function responseSchema(path: string, method: string, status: number): OpenApiSchema {
  const schema =
    operation(path, method).responses[String(status)]?.content?.["application/json"]?.schema;
  assert.ok(schema, `No official response schema for ${method.toUpperCase()} ${path} (${status})`);
  return schema;
}

export function assertMatchesSchema(
  schema: OpenApiSchema,
  value: unknown,
  label: string,
): void {
  const reference = schema.$ref;
  const validator = ajv.compile(
    reference ? { $ref: `jira-dc-10.3${reference}` } : schema,
  );
  assert.equal(validator(value), true, `${label}: ${formatErrors(validator.errors)}`);
}

export function assertMatchesResponse(
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

export function assertArrayItemsMatchResponse(
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
  }
}

export function assertEmptyResponseDocumented(
  path: string,
  method: string,
  status: number,
): void {
  const contractResponse = operation(path, method).responses[String(status)];
  assert.ok(contractResponse, `No official response for ${method.toUpperCase()} ${path} (${status})`);
  assert.equal(contractResponse.content?.["application/json"], undefined);
}

export const authorization = { authorization: "Bearer local-test-token" };
