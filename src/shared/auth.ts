import type { FastifyRequest } from "fastify";
import type { JiraAuthConfig } from "../jira-context.js";

export function isAuthenticated(request: FastifyRequest, auth: JiraAuthConfig): boolean {
  const authorization = request.headers.authorization;
  if (!authorization) return false;
  if (authorization === `Bearer ${auth.token}`) return true;
  if (!authorization.startsWith("Basic ")) return false;

  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    return decoded === `${auth.username}:${auth.password}`;
  } catch {
    return false;
  }
}
