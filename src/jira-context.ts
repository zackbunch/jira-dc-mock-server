import type { JiraIssue, JiraUser } from "./types.js";
import { JiraStore } from "./store.js";

export interface JiraAuthConfig {
  token: string;
  username: string;
  password: string;
}

export interface JiraContext {
  store: JiraStore;
  baseUrl: string;
  auth: JiraAuthConfig;
  currentUser(): JiraUser;
  findIssue(identity: string): JiraIssue | undefined;
}

export function createJiraContext(
  dataFile: string,
  baseUrl: string,
  auth: JiraAuthConfig,
): JiraContext {
  const store = new JiraStore(dataFile);
  return {
    store,
    baseUrl,
    auth,
    currentUser: () =>
      store.state.users.find((user) => user.name === auth.username) ?? store.state.users[0],
    findIssue: (identity) =>
      store.state.issues.find(
        (issue) => issue.id === identity || issue.key.toLowerCase() === identity.toLowerCase(),
      ),
  };
}

declare module "fastify" {
  interface FastifyInstance {
    jira: JiraContext;
  }
}
