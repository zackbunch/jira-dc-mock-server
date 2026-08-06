import type {
  JiraComment,
  JiraIssue,
  JiraNamedResource,
  JiraProject,
  JiraStatus,
  JiraUser,
} from "../types.js";

export function jiraDate(date = new Date()): string {
  return date.toISOString().replace("Z", "+0000");
}

function absoluteUrl(baseUrl: string, value: string): string {
  return value.startsWith("http") ? value : `${baseUrl}${value}`;
}

export function serializeUser(user: JiraUser, baseUrl: string): JiraUser {
  return {
    ...structuredClone(user),
    self: `${baseUrl}/rest/api/2/user?username=${encodeURIComponent(user.name)}`,
    avatarUrls: Object.fromEntries(
      Object.entries(user.avatarUrls).map(([size, url]) => [size, absoluteUrl(baseUrl, url)]),
    ),
  };
}

export function serializeNamedResource(
  resource: JiraNamedResource,
  baseUrl: string,
  group: "issuetype" | "priority",
): JiraNamedResource {
  return {
    ...structuredClone(resource),
    self: `${baseUrl}/rest/api/2/${group}/${resource.id}`,
  };
}

export function serializeStatus(status: JiraStatus, baseUrl: string): JiraStatus {
  return {
    ...structuredClone(status),
    self: `${baseUrl}/rest/api/2/status/${status.id}`,
    statusCategory: {
      ...structuredClone(status.statusCategory),
      self: `${baseUrl}/rest/api/2/statuscategory/${status.statusCategory.id}`,
    },
  };
}

export function serializeProject(project: JiraProject, baseUrl: string): JiraProject {
  return {
    ...structuredClone(project),
    self: `${baseUrl}/rest/api/2/project/${project.id}`,
    lead: serializeUser(project.lead, baseUrl),
    avatarUrls: Object.fromEntries(
      Object.entries(project.avatarUrls).map(([size, url]) => [size, absoluteUrl(baseUrl, url)]),
    ),
  };
}

function requestedFields(input: string | string[] | undefined): Set<string> | undefined {
  if (input === undefined) return undefined;
  const values = (Array.isArray(input) ? input : [input])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.includes("*all") || values.includes("*navigable")) return undefined;
  return new Set(values.filter((value) => !value.startsWith("-")));
}

export function serializeIssue(
  issue: JiraIssue,
  baseUrl: string,
  fieldsSelection?: string | string[],
): JiraIssue {
  const result = structuredClone(issue);
  result.self = `${baseUrl}/rest/api/2/issue/${issue.id}`;
  result.fields.project = serializeProject(issue.fields.project, baseUrl);
  result.fields.issuetype = serializeNamedResource(issue.fields.issuetype, baseUrl, "issuetype");
  result.fields.priority = serializeNamedResource(issue.fields.priority, baseUrl, "priority");
  result.fields.status = serializeStatus(issue.fields.status, baseUrl);
  result.fields.reporter = serializeUser(issue.fields.reporter, baseUrl);
  result.fields.assignee = issue.fields.assignee
    ? serializeUser(issue.fields.assignee, baseUrl)
    : null;
  result.fields.comment.comments = issue.fields.comment.comments.map((comment) =>
    serializeComment(comment, issue, baseUrl),
  );

  const selected = requestedFields(fieldsSelection);
  if (selected) {
    result.fields = Object.fromEntries(
      Object.entries(result.fields).filter(([field]) => selected.has(field)),
    ) as typeof result.fields;
  }
  return result;
}

export function serializeComment(
  comment: JiraComment,
  issue: JiraIssue,
  baseUrl: string,
): JiraComment {
  return {
    ...structuredClone(comment),
    self: `${baseUrl}/rest/api/2/issue/${issue.id}/comment/${comment.id}`,
    author: serializeUser(comment.author, baseUrl),
    updateAuthor: serializeUser(comment.updateAuthor, baseUrl),
  };
}
