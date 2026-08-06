import type {
  JiraIssue,
  JiraNamedResource,
  JiraProject,
  JiraState,
  JiraStatus,
  JiraUser,
} from "./types.js";

const avatarUrls = {
  "16x16": "/secure/useravatar?size=xsmall",
  "24x24": "/secure/useravatar?size=small",
  "32x32": "/secure/useravatar?size=medium",
  "48x48": "/secure/useravatar?size=large",
};

const developer: JiraUser = {
  key: "developer",
  name: "developer",
  emailAddress: "developer@example.test",
  avatarUrls,
  displayName: "Local Developer",
  active: true,
  timeZone: "UTC",
  locale: "en_US",
};

const alex: JiraUser = {
  key: "alex",
  name: "alex",
  emailAddress: "alex@example.test",
  avatarUrls,
  displayName: "Alex Example",
  active: true,
  timeZone: "UTC",
  locale: "en_US",
};

const projects: JiraProject[] = [
  {
    id: "10000",
    key: "ENG",
    name: "Engineering",
    projectTypeKey: "software",
    simplified: false,
    archived: false,
    lead: developer,
    avatarUrls,
  },
  {
    id: "10001",
    key: "OPS",
    name: "Operations",
    projectTypeKey: "software",
    simplified: false,
    archived: false,
    lead: alex,
    avatarUrls,
  },
];

const issueTypes: JiraNamedResource[] = [
  { id: "10001", name: "Story", description: "A user story", subtask: false },
  { id: "10002", name: "Bug", description: "A software defect", subtask: false },
  { id: "10003", name: "Task", description: "A task that needs to be done", subtask: false },
];

const priorities: JiraNamedResource[] = [
  { id: "1", name: "Highest" },
  { id: "2", name: "High" },
  { id: "3", name: "Medium" },
  { id: "4", name: "Low" },
];

const statuses: JiraStatus[] = [
  {
    id: "10000",
    name: "To Do",
    description: "Work has not started",
    statusCategory: { id: 2, key: "new", colorName: "blue-gray", name: "To Do" },
  },
  {
    id: "3",
    name: "In Progress",
    description: "Work is in progress",
    statusCategory: { id: 4, key: "indeterminate", colorName: "yellow", name: "In Progress" },
  },
  {
    id: "10001",
    name: "Done",
    description: "Work is complete",
    statusCategory: { id: 3, key: "done", colorName: "green", name: "Done" },
  },
];

function issue(
  id: string,
  key: string,
  project: JiraProject,
  issueType: JiraNamedResource,
  summary: string,
  description: string,
  status: JiraStatus,
  priority: JiraNamedResource,
  assignee: JiraUser | null,
  created: string,
  labels: string[],
  storyPoints?: number,
): JiraIssue {
  return {
    expand: "renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations",
    id,
    key,
    fields: {
      project,
      issuetype: issueType,
      summary,
      description,
      status,
      priority,
      assignee,
      reporter: developer,
      labels,
      created,
      updated: created,
      comment: { comments: [], maxResults: 0, total: 0, startAt: 0 },
      ...(storyPoints === undefined ? {} : { customfield_10002: storyPoints }),
    },
  };
}

export function createDefaultState(): JiraState {
  const initial: JiraState = {
    issueCounter: 10004,
    commentCounter: 1,
    users: [developer, alex],
    projects,
    issueTypes,
    priorities,
    statuses,
    issues: [
      issue(
        "10001",
        "ENG-1",
        projects[0],
        issueTypes[0],
        "Add local development environment",
        "Create a reproducible environment for agent development.",
        statuses[2],
        priorities[2],
        developer,
        "2026-01-05T09:00:00.000+0000",
        ["developer-experience"],
        3,
      ),
      issue(
        "10002",
        "ENG-2",
        projects[0],
        issueTypes[1],
        "Login fails after session timeout",
        "Users receive an unexpected error after their session expires.",
        statuses[0],
        priorities[1],
        alex,
        "2026-01-12T14:30:00.000+0000",
        ["authentication", "agent-training"],
        5,
      ),
      issue(
        "10003",
        "OPS-1",
        projects[1],
        issueTypes[2],
        "Document deployment rollback procedure",
        "Write and verify the rollback runbook.",
        statuses[1],
        priorities[2],
        developer,
        "2026-01-20T11:15:00.000+0000",
        ["documentation"],
      ),
    ],
  };

  return structuredClone(initial);
}
