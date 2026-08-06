import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { JqlError, searchWithJql } from "../jql.js";
import { jiraError } from "../shared/errors.js";
import { parseInteger } from "../shared/parameters.js";
import { serializeIssue } from "../shared/serialization.js";

interface SearchInput {
  jql?: string;
  startAt?: number | string;
  maxResults?: number | string;
  fields?: string | string[];
  expand?: string | string[];
  validateQuery?: boolean;
}

const searchRoutes: FastifyPluginAsync = async (app) => {
  const runSearch = async (input: SearchInput, reply: FastifyReply) => {
    try {
      const matches = searchWithJql(app.jira.store.state.issues, input.jql, {
        currentUsername: app.jira.currentUser().name,
      });
      const startAt = parseInteger(input.startAt, 0);
      const maxResults = parseInteger(input.maxResults, 50, 100);
      const page = matches.slice(startAt, startAt + maxResults);
      return {
        expand: "schema,names",
        startAt,
        maxResults,
        total: matches.length,
        issues: page.map((issue) => serializeIssue(issue, app.jira.baseUrl, input.fields)),
      };
    } catch (error) {
      if (error instanceof JqlError) {
        return reply.code(400).send(jiraError([error.message]));
      }
      throw error;
    }
  };

  app.get("/rest/api/2/search", async (request, reply) =>
    runSearch(request.query as SearchInput, reply),
  );
  app.post("/rest/api/2/search", async (request, reply) =>
    runSearch((request.body ?? {}) as SearchInput, reply),
  );
};

export default searchRoutes;
