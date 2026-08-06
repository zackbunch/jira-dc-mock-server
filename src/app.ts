import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import { createJiraContext } from "./jira-context.js";
import { enrichRouteSchema } from "./route-schema.js";
import { isAuthenticated } from "./shared/auth.js";
import { jiraError } from "./shared/errors.js";

export interface AppOptions {
  dataFile: string;
  baseUrl?: string;
  requireAuth?: boolean;
  token?: string;
  username?: string;
  password?: string;
  logger?: boolean;
}

interface RouteModule {
  default: FastifyPluginAsync;
}

function routeModuleFiles(): string[] {
  const directory = join(dirname(fileURLToPath(import.meta.url)), "routes");
  return readdirSync(directory)
    .filter((file) =>
      (file.endsWith(".js") || file.endsWith(".ts")) && !file.endsWith(".d.ts"),
    )
    .sort()
    .map((file) => join(directory, file));
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const baseUrl = (options.baseUrl ?? "http://localhost:8080").replace(/\/$/, "");
  const auth = {
    token: options.token ?? "local-test-token",
    username: options.username ?? "developer",
    password: options.password ?? "developer",
  };
  const requireAuth = options.requireAuth ?? true;

  app.decorate("jira", createJiraContext(options.dataFile, baseUrl, auth));
  app.addHook("onRoute", enrichRouteSchema);

  app.register(swagger, {
    openapi: {
      info: {
        title: "Jira Data Center 10.3.5 Mock API",
        description:
          "Stateful local REST API mock for Jira-agent development. This implements a curated subset of Jira Data Center, not the full product.",
        version: "0.1.0",
      },
      servers: [{ url: baseUrl, description: "Local mock server" }],
      tags: [
        { name: "System" },
        { name: "Metadata" },
        { name: "Projects" },
        { name: "Search" },
        { name: "Issues" },
        { name: "Comments" },
        { name: "Transitions" },
        { name: "Administration" },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "PAT" },
          basicAuth: { type: "http", scheme: "basic" },
        },
      },
    },
  });
  app.register(swaggerUi, {
    routePrefix: "/documentation",
    staticCSP: true,
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
      persistAuthorization: true,
    },
  });

  app.addHook("onRequest", async (request, reply) => {
    const protectedPath =
      request.url.startsWith("/rest/") || request.url.startsWith("/__admin/");
    if (requireAuth && protectedPath && !isAuthenticated(request, auth)) {
      reply.header("WWW-Authenticate", 'Basic realm="Jira"');
      return reply
        .code(401)
        .send(jiraError(["Client must be authenticated to access this resource."]));
    }
  });

  app.register(async (routeScope) => {
    for (const file of routeModuleFiles()) {
      const routeModule = (await import(pathToFileURL(file).href)) as RouteModule;
      routeScope.register(routeModule.default);
    }
  });

  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send(jiraError(["The requested resource does not exist."])),
  );

  return app;
}
