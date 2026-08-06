import type { FastifyPluginAsync } from "fastify";

const adminRoutes: FastifyPluginAsync = async (app) => {
  app.post("/__admin/reset", async (_request, reply) => {
    app.jira.store.reset();
    return reply.code(204).send();
  });
};

export default adminRoutes;
