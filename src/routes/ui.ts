import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyPluginAsync } from "fastify";

function dashboardAsset(fileName: string): string {
  return readFileSync(resolve(process.cwd(), "public", "dashboard", fileName), "utf8");
}

const dashboardHtml = dashboardAsset("index.html");
const dashboardCss = dashboardAsset("styles.css");
const dashboardJs = dashboardAsset("app.js");

const uiRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/",
    { schema: { hide: true, security: [] } },
    async (_request, reply) => reply.redirect("/dashboard"),
  );

  app.get(
    "/dashboard",
    { schema: { hide: true, security: [] } },
    async (_request, reply) =>
      reply
        .header("Cache-Control", "no-store")
        .type("text/html; charset=utf-8")
        .send(dashboardHtml),
  );

  app.get(
    "/dashboard/styles.css",
    { schema: { hide: true, security: [] } },
    async (_request, reply) =>
      reply
        .header("Cache-Control", "no-cache")
        .type("text/css; charset=utf-8")
        .send(dashboardCss),
  );

  app.get(
    "/dashboard/app.js",
    { schema: { hide: true, security: [] } },
    async (_request, reply) =>
      reply
        .header("Cache-Control", "no-cache")
        .type("application/javascript; charset=utf-8")
        .send(dashboardJs),
  );
};

export default uiRoutes;
