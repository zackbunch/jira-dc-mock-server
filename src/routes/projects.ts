import type { FastifyPluginAsync } from "fastify";
import { jiraError } from "../shared/errors.js";
import { serializeProject } from "../shared/serialization.js";

const projectRoutes: FastifyPluginAsync = async (app) => {
  app.get("/rest/api/2/project", async (request) => {
    const query = request.query as { includeArchived?: string | boolean };
    const includeArchived = String(query.includeArchived ?? "false") === "true";
    return app.jira.store.state.projects
      .filter((project) => includeArchived || !project.archived)
      .map((project) => serializeProject(project, app.jira.baseUrl));
  });

  app.get("/rest/api/2/project/:projectIdOrKey", async (request, reply) => {
    const { projectIdOrKey } = request.params as { projectIdOrKey: string };
    const project = app.jira.store.state.projects.find(
      (candidate) =>
        candidate.id === projectIdOrKey ||
        candidate.key.toLowerCase() === projectIdOrKey.toLowerCase(),
    );
    if (!project) {
      return reply.code(404).send(jiraError(["No project could be found with key or id."]));
    }
    return serializeProject(project, app.jira.baseUrl);
  });
};

export default projectRoutes;
