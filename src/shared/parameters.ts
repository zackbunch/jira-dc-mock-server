import type { JiraNamedResource, JiraUser } from "../types.js";

export function parseInteger(
  value: number | string | undefined,
  fallback: number,
  maximum?: number,
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return maximum === undefined ? parsed : Math.min(parsed, maximum);
}

export function findByIdOrName<T extends JiraNamedResource>(
  source: T[],
  input: unknown,
): T | undefined {
  if (typeof input === "string") {
    return source.find(
      (entry) => entry.id === input || entry.name.toLowerCase() === input.toLowerCase(),
    );
  }
  if (input && typeof input === "object") {
    const candidate = input as { id?: unknown; name?: unknown };
    return source.find(
      (entry) =>
        (typeof candidate.id === "string" && entry.id === candidate.id) ||
        (typeof candidate.name === "string" &&
          entry.name.toLowerCase() === candidate.name.toLowerCase()),
    );
  }
  return undefined;
}

export function findUser(users: JiraUser[], input: unknown): JiraUser | null | undefined {
  if (input === null) return null;
  if (typeof input === "string") {
    return users.find(
      (user) => user.name.toLowerCase() === input.toLowerCase() || user.key === input,
    );
  }
  if (input && typeof input === "object") {
    const candidate = input as { name?: unknown; key?: unknown };
    const identity = typeof candidate.name === "string" ? candidate.name : candidate.key;
    if (typeof identity === "string") return findUser(users, identity);
  }
  return undefined;
}
