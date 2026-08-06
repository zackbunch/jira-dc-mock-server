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
  "PUT /api/2/cluster/index-snapshot/{nodeId}",
  "DELETE /api/2/cluster/node/{nodeId}",
  "PUT /api/2/cluster/node/{nodeId}/offline",
  "GET /api/2/cluster/nodes",
  "POST /api/2/cluster/zdu/approve",
  "POST /api/2/cluster/zdu/cancel",
  "POST /api/2/cluster/zdu/retryUpgrade",
  "POST /api/2/cluster/zdu/start",
  "GET /api/2/cluster/zdu/state",
  "GET /api/2/field",
  "GET /api/2/index/summary",
  "GET /api/2/index-snapshot",
  "POST /api/2/index-snapshot",
  "GET /api/2/index-snapshot/isRunning",
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
  "GET /api/2/reindex",
  "POST /api/2/reindex",
  "POST /api/2/reindex/issue",
  "GET /api/2/reindex/progress",
  "POST /api/2/reindex/request",
  "GET /api/2/reindex/request/bulk",
  "GET /api/2/reindex/request/{requestId}",
  "GET /api/2/status",
]);

const VERIFIED_TAGS = new Set([
  "application-properties",
  "applicationrole",
  "cluster",
  "component",
  "configuration",
  "customFieldOption",
  "customFields",
  "dashboard",
  "field",
  "filter",
  "group",
  "groups",
  "groupuserpicker",
  "index",
  "index-snapshot",
  "issueLinkType",
  "issuetype",
  "issuesecurityschemes",
  "issuetypescheme",
  "monitoring",
  "myself",
  "mypreferences",
  "password",
  "permissionscheme",
  "priority",
  "priorityschemes",
  "projectCategory",
  "readonly-mode",
  "reindex",
  "resolution",
  "screens",
  "securitylevel",
  "settings",
  "status",
  "statuscategory",
  "user",
  "version",
  "workflow",
  "workflowscheme",
  "notificationscheme",
]);

const TAG_OWNERS: Record<string, string> = {
  applicationrole: "user-management",
  group: "user-management",
  groups: "user-management",
  groupuserpicker: "user-management",
  myself: "user-management",
  mypreferences: "user-management",
  password: "user-management",
  user: "user-management",
  component: "project-assets",
  projectCategory: "project-assets",
  version: "project-assets",
  customFieldOption: "issue-metadata",
  customFields: "issue-metadata",
  dashboard: "coordinator",
  field: "issue-metadata",
  filter: "coordinator",
  issueLinkType: "issue-metadata",
  issuetype: "issue-metadata",
  issuesecurityschemes: "schemes",
  issuetypescheme: "schemes",
  notificationscheme: "schemes",
  permissionscheme: "schemes",
  priority: "issue-metadata",
  priorityschemes: "screens-priority-schemes",
  resolution: "issue-metadata",
  screens: "screens-priority-schemes",
  securitylevel: "schemes",
  status: "issue-metadata",
  statuscategory: "issue-metadata",
  workflow: "workflow-schemes",
  workflowscheme: "workflow-schemes",
  "application-properties": "coordinator",
  cluster: "coordinator",
  configuration: "coordinator",
  index: "coordinator",
  "index-snapshot": "coordinator",
  monitoring: "coordinator",
  "readonly-mode": "coordinator",
  reindex: "coordinator",
  settings: "coordinator",
};

const OPERATION_OWNERS: Record<string, string> = Object.fromEntries(
  [...VERIFIED_OPERATIONS].map((key) => [key, "coordinator"]),
);

const TAG_CONTRACT_EXCEPTIONS: Record<string, string[]> = {
  "application-properties": ["See contracts/COMPATIBILITY.md item 4."],
  cluster: ["See contracts/COMPATIBILITY.md item 7."],
  customFields: ["See contracts/COMPATIBILITY.md item 8."],
  filter: ["See contracts/COMPATIBILITY.md items 11-12."],
  issuesecurityschemes: ["See planning/schemes-contract-notes.md."],
  issuetypescheme: ["See planning/schemes-contract-notes.md."],
  issuetype: ["See contracts/COMPATIBILITY.md items 8-10."],
  priority: ["See contracts/COMPATIBILITY.md item 8."],
  priorityschemes: ["See planning/screens-priorityschemes-compatibility.md."],
  projectCategory: ["Generated list response references the item schema; tests validate each item."],
  reindex: ["See contracts/COMPATIBILITY.md item 5."],
  resolution: ["See contracts/COMPATIBILITY.md item 8."],
  screens: ["See planning/screens-priorityschemes-compatibility.md."],
  status: ["See contracts/COMPATIBILITY.md item 8."],
  user: ["See planning/user-management-contract-notes.md."],
  version: ["Generated paginated response references VersionBean; page envelope is asserted separately."],
  workflow: ["See planning/workflow-schemes-contract-notes.md."],
  workflowscheme: ["See planning/workflow-schemes-contract-notes.md."],
};

function mockPath(contractPath: string): string {
  return `/rest${contractPath}`;
}

function fastifyPath(contractPath: string): string {
  return mockPath(contractPath).replaceAll(
    /\{([^}]+)\}/g,
    (_match, name: string) => `:${name.replaceAll(/[^A-Za-z0-9_]/g, "_")}`,
  );
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
            testStatus:
              VERIFIED_OPERATIONS.has(key) ||
              (operation.tags ?? []).some((tag) => VERIFIED_TAGS.has(tag))
              ? "schema-and-behavior-tested"
              : previous?.testStatus ?? "not-tested",
            assignedAgent:
              previous?.assignedAgent ??
              OPERATION_OWNERS[key] ??
              (operation.tags ?? []).map((tag) => TAG_OWNERS[tag]).find(Boolean) ??
              null,
            notes: previous?.notes ?? [],
            contractExceptions:
              previous?.contractExceptions && previous.contractExceptions.length > 0
                ? previous.contractExceptions
                : (operation.tags ?? []).flatMap(
                    (tag) => TAG_CONTRACT_EXCEPTIONS[tag] ?? [],
                  ),
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
