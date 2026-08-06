import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app.js";

const HTTP_METHODS = new Set(["delete", "get", "head", "options", "patch", "post", "put"]);

interface OpenApiOperation {
  operationId?: string;
  tags?: string[];
  parameters?: unknown[];
  requestBody?: unknown;
  responses?: Record<string, OpenApiResponse>;
}

interface OpenApiResponse {
  $ref?: string;
  content?: Record<string, { schema?: unknown }>;
}

interface OpenApiPathItem {
  parameters?: unknown[];
  [key: string]: OpenApiOperation | unknown[] | undefined;
}

interface OpenApiSpecification {
  info: { version: string };
  paths: Record<string, OpenApiPathItem>;
}

interface ExistingTracking {
  assignedAgent?: string | null;
  notes?: string[];
  contractExceptions?: string[];
  testStatus?: string;
}

interface ExistingManifest {
  operations?: Array<ExistingTracking & { key: string }>;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const contractFile = join(repositoryRoot, "contracts/jira-software-dc-10.3-openapi.json");
const manifestFile = join(repositoryRoot, "planning/endpoint-manifest.json");

const specification = JSON.parse(readFileSync(contractFile, "utf8")) as OpenApiSpecification;
const existing = existsSync(manifestFile)
  ? (JSON.parse(readFileSync(manifestFile, "utf8")) as ExistingManifest)
  : undefined;
const existingByKey = new Map((existing?.operations ?? []).map((operation) => [operation.key, operation]));

// These operations have both behavior assertions and official response-schema
// validation in test/official-response-contract.test.ts. The coordinator updates
// this list only after verifying new operation fixtures.
const VERIFIED_OPERATIONS = new Set([
  "GET /api/2/application-properties",
  "GET /api/2/application-properties/advanced-settings",
  "PUT /api/2/application-properties/{id}",
  "GET /api/2/configuration",
  "GET /api/2/field",
  "POST /api/2/issue",
  "GET /api/2/issue/{issueIdOrKey}",
  "PUT /api/2/issue/{issueIdOrKey}",
  "GET /api/2/issue/{issueIdOrKey}/comment",
  "POST /api/2/issue/{issueIdOrKey}/comment",
  "GET /api/2/issue/{issueIdOrKey}/transitions",
  "POST /api/2/issue/{issueIdOrKey}/transitions",
  "GET /api/2/issuetype",
  "GET /api/2/myself",
  "GET /api/2/monitoring/app",
  "POST /api/2/monitoring/app",
  "GET /api/2/monitoring/ipd",
  "POST /api/2/monitoring/ipd",
  "GET /api/2/monitoring/jmx/areMetricsExposed",
  "GET /api/2/monitoring/jmx/getAvailableMetrics",
  "POST /api/2/monitoring/jmx/startExposing",
  "POST /api/2/monitoring/jmx/stopExposing",
  "GET /api/2/priority",
  "GET /api/2/project",
  "GET /api/2/project/{projectIdOrKey}",
  "GET /api/2/search",
  "POST /api/2/search",
  "GET /api/2/serverInfo",
  "PUT /api/2/settings/baseUrl",
  "GET /api/2/settings/columns",
  "PUT /api/2/settings/columns",
  "GET /api/2/readonly-mode",
  "PUT /api/2/readonly-mode",
  "GET /api/2/status",
]);

function mockPath(contractPath: string): string {
  return `/rest${contractPath}`;
}

function fastifyPath(contractPath: string): string {
  return mockPath(contractPath).replaceAll(/\{([^}]+)\}/g, ":$1");
}

function successStatuses(responses: Record<string, OpenApiResponse> | undefined): string[] {
  return Object.keys(responses ?? {}).filter((status) => /^2(?:\d\d|XX)$/i.test(status));
}

function responseSchemas(
  responses: Record<string, OpenApiResponse> | undefined,
  statuses: string[],
): Record<string, unknown> {
  return Object.fromEntries(
    statuses.map((status) => {
      const response = responses?.[status];
      if (response?.$ref) return [status, { $ref: response.$ref }];
      const schemas = Object.fromEntries(
        Object.entries(response?.content ?? {}).map(([contentType, media]) => [
          contentType,
          media.schema ?? null,
        ]),
      );
      return [status, Object.keys(schemas).length > 0 ? schemas : null];
    }),
  );
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), "jira-manifest-"));
const app = buildApp({
  dataFile: join(temporaryDirectory, "state.json"),
  requireAuth: false,
});

try {
  await app.ready();

  const operations = Object.entries(specification.paths)
    .filter(([path]) => path === "/api/2" || path.startsWith("/api/2/"))
    .flatMap(([path, pathItem]) =>
      Object.entries(pathItem)
        .filter(([method]) => HTTP_METHODS.has(method.toLowerCase()))
        .map(([method, rawOperation]) => {
          const operation = rawOperation as OpenApiOperation;
          const normalizedMethod = method.toUpperCase();
          const key = `${normalizedMethod} ${path}`;
          const previous = existingByKey.get(key);
          const statuses = successStatuses(operation.responses);
          const implemented = app.hasRoute({
            method: normalizedMethod as "GET",
            url: fastifyPath(path),
          });

          return {
            key,
            path,
            mockPath: mockPath(path),
            method: normalizedMethod,
            operationId: operation.operationId ?? null,
            tags: operation.tags ?? [],
            resourceGroup: operation.tags?.[0] ?? "untagged",
            successStatuses: statuses,
            requestSchema: {
              parameters: [
                ...((pathItem.parameters as unknown[] | undefined) ?? []),
                ...(operation.parameters ?? []),
              ],
              requestBody: operation.requestBody ?? null,
            },
            responseSchemas: responseSchemas(operation.responses, statuses),
            implementationStatus: implemented ? "implemented" : "missing",
            testStatus: VERIFIED_OPERATIONS.has(key)
              ? "schema-and-behavior-tested"
              : previous?.testStatus ?? "not-tested",
            assignedAgent: previous?.assignedAgent ?? null,
            notes: previous?.notes ?? [],
            contractExceptions: previous?.contractExceptions ?? [],
          };
        }),
    )
    .sort((left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method));

  const groups = Object.values(
    operations.reduce<Record<string, { tag: string; total: number; implemented: number; tested: number }>>(
      (result, operation) => {
        const group = (result[operation.resourceGroup] ??= {
          tag: operation.resourceGroup,
          total: 0,
          implemented: 0,
          tested: 0,
        });
        group.total += 1;
        if (operation.implementationStatus === "implemented") group.implemented += 1;
        if (operation.testStatus === "schema-and-behavior-tested") group.tested += 1;
        return result;
      },
      {},
    ),
  ).sort((left, right) => right.total - left.total || left.tag.localeCompare(right.tag));

  const manifest = {
    generatedAt: new Date().toISOString(),
    contract: "contracts/jira-software-dc-10.3-openapi.json",
    contractVersion: specification.info.version,
    scope: "OpenAPI operations whose path is /api/2 or begins with /api/2/",
    routePrefix: "/rest/api/2",
    summary: {
      totalOperations: operations.length,
      implementedOperations: operations.filter(
        (operation) => operation.implementationStatus === "implemented",
      ).length,
      testedOperations: operations.filter(
        (operation) => operation.testStatus === "schema-and-behavior-tested",
      ).length,
      missingOperations: operations.filter(
        (operation) => operation.implementationStatus === "missing",
      ).length,
    },
    groups,
    operations,
  };

  mkdirSync(dirname(manifestFile), { recursive: true });
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(manifest.summary)}\n`);
} finally {
  await app.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
