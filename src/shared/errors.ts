import type { JiraError } from "../types.js";

export function jiraError(
  errorMessages: string[] = [],
  errors: Record<string, string> = {},
): JiraError {
  return { errorMessages, errors };
}
