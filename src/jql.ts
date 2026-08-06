import type { JiraIssue } from "./types.js";

export class JqlError extends Error {}

interface SearchOptions {
  currentUsername: string;
}

const fieldAliases: Record<string, (issue: JiraIssue) => unknown> = {
  key: (issue) => issue.key,
  issuekey: (issue) => issue.key,
  project: (issue) => issue.fields.project.key,
  status: (issue) => issue.fields.status.name,
  assignee: (issue) => issue.fields.assignee?.name ?? null,
  reporter: (issue) => issue.fields.reporter.name,
  issuetype: (issue) => issue.fields.issuetype.name,
  type: (issue) => issue.fields.issuetype.name,
  priority: (issue) => issue.fields.priority.name,
  labels: (issue) => issue.fields.labels,
  summary: (issue) => issue.fields.summary,
  text: (issue) => `${issue.fields.summary} ${issue.fields.description ?? ""}`,
  created: (issue) => issue.fields.created,
  updated: (issue) => issue.fields.updated,
};

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replace(/\\([\\"'])/g, "$1");
  }
  return trimmed;
}

function normalizeValue(value: string, currentUsername: string): string {
  if (/^currentUser\(\)$/i.test(value.trim())) return currentUsername;
  return unquote(value);
}

function valuesEqual(actual: unknown, expected: string): boolean {
  if (Array.isArray(actual)) {
    return actual.some((value) => String(value).toLowerCase() === expected.toLowerCase());
  }
  if (actual === null || actual === undefined) return expected.toLowerCase() === "empty";
  return String(actual).toLowerCase() === expected.toLowerCase();
}

function splitValues(input: string, currentUsername: string): string[] {
  return input
    .split(/,(?=(?:[^"']|"[^"]*"|'[^']*')*$)/)
    .map((value) => normalizeValue(value, currentUsername));
}

function matchesClause(issue: JiraIssue, clause: string, options: SearchOptions): boolean {
  const match = clause.match(
    /^([A-Za-z][A-Za-z0-9_]*)\s+(NOT\s+IN|IN|!=|=|!~|~)\s*(.+)$/i,
  );
  if (!match) throw new JqlError(`Unsupported JQL clause: ${clause}`);

  const [, rawField, rawOperator, rawOperand] = match;
  const field = rawField.toLowerCase();
  const accessor = fieldAliases[field];
  if (!accessor) throw new JqlError(`Unsupported JQL field: ${rawField}`);

  const operator = rawOperator.toUpperCase().replace(/\s+/g, " ");
  const actual = accessor(issue);

  if (operator === "IN" || operator === "NOT IN") {
    const listMatch = rawOperand.trim().match(/^\((.*)\)$/s);
    if (!listMatch) throw new JqlError(`${operator} requires a parenthesized value list`);
    const found = splitValues(listMatch[1], options.currentUsername).some((expected) =>
      valuesEqual(actual, expected),
    );
    return operator === "IN" ? found : !found;
  }

  const expected = normalizeValue(rawOperand, options.currentUsername);
  if (operator === "=") return valuesEqual(actual, expected);
  if (operator === "!=") return !valuesEqual(actual, expected);

  const haystack = Array.isArray(actual) ? actual.join(" ") : String(actual ?? "");
  const contains = haystack.toLowerCase().includes(expected.toLowerCase());
  return operator === "~" ? contains : !contains;
}

export function searchWithJql(
  source: JiraIssue[],
  jql: string | undefined,
  options: SearchOptions,
): JiraIssue[] {
  const expression = (jql ?? "").trim();
  if (!expression) return [...source];
  if (/\s+OR\s+/i.test(expression)) {
    throw new JqlError("OR expressions are not supported by this mock yet");
  }

  const orderMatch = expression.match(/\s+ORDER\s+BY\s+([A-Za-z][A-Za-z0-9_]*)\s*(ASC|DESC)?\s*$/i);
  const filterExpression = orderMatch
    ? expression.slice(0, orderMatch.index).trim()
    : expression;
  const clauses = filterExpression
    ? filterExpression.split(/\s+AND\s+/i).map((clause) => clause.trim())
    : [];

  const results = source.filter((issue) =>
    clauses.every((clause) => matchesClause(issue, clause, options)),
  );

  if (orderMatch) {
    const fieldName = orderMatch[1].toLowerCase();
    const accessor = fieldAliases[fieldName];
    if (!accessor) throw new JqlError(`Unsupported ORDER BY field: ${orderMatch[1]}`);
    const direction = (orderMatch[2] ?? "ASC").toUpperCase() === "DESC" ? -1 : 1;
    results.sort((left, right) =>
      String(accessor(left) ?? "").localeCompare(String(accessor(right) ?? ""), undefined, {
        numeric: true,
      }) * direction,
    );
  }

  return results;
}
