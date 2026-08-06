import { getResourceState, type JiraStore } from "./store.js";

export interface ProjectRole { id: number; name: string; description: string }
export interface ActorSet { users: string[]; groups: string[] }
export interface ProjectAvatar { id: string; owner: string; selected: boolean; system: boolean }
export interface ProjectDetails {
  description: string;
  url: string;
  assigneeType: "PROJECT_LEAD" | "UNASSIGNED";
  avatarId: string;
  properties: Record<string, unknown>;
  avatars: ProjectAvatar[];
  temporaryAvatar?: { size: number };
  components: Array<{ id: string; name: string; description: string }>;
  versions: Array<{ id: string; name: string; description: string; released: boolean; archived: boolean; releaseDate?: string }>;
  permissionSchemeId: number;
  notificationSchemeId: number;
  issueSecuritySchemeId: number;
  prioritySchemeId: number;
}

export interface ProjectCoreState {
  projectCounter: number;
  avatarCounter: number;
  roleCounter: number;
  roles: ProjectRole[];
  defaultRoleActors: Record<string, ActorSet>;
  projectRoleActors: Record<string, Record<string, ActorSet>>;
  projects: Record<string, ProjectDetails>;
}

function details(id: string, key: string): ProjectDetails {
  return {
    description: `Synthetic project configuration for ${key}.`,
    url: `https://example.test/projects/${key.toLowerCase()}`,
    assigneeType: "PROJECT_LEAD",
    avatarId: `11${id.slice(-3)}`,
    properties: {},
    avatars: [{ id: `11${id.slice(-3)}`, owner: "developer", selected: true, system: true }],
    components: [{ id: `20${id.slice(-3)}`, name: "Platform", description: "Shared platform component." }],
    versions: [
      { id: `30${id.slice(-3)}`, name: "1.0.0", description: "Initial synthetic release.", released: true, archived: false, releaseDate: "2026-01-31T00:00:00.000Z" },
      { id: `31${id.slice(-3)}`, name: "2.0.0", description: "Upcoming synthetic release.", released: false, archived: false },
    ],
    permissionSchemeId: key === "T100ZB" ? 10001 : 10000,
    notificationSchemeId: key === "T100ZB" ? 10001 : 10000,
    issueSecuritySchemeId: 10000,
    prioritySchemeId: key === "T100ZB" ? 10000 : 0,
  };
}

function defaultState(): ProjectCoreState {
  return {
    projectCounter: 10003,
    avatarCounter: 12000,
    roleCounter: 10003,
    roles: [
      { id: 10000, name: "Administrators", description: "Project administrators." },
      { id: 10001, name: "Developers", description: "Project developers." },
      { id: 10002, name: "Users", description: "Project users." },
    ],
    defaultRoleActors: {
      "10000": { users: ["developer"], groups: [] },
      "10001": { users: ["developer", "alex"], groups: ["jira-software-users"] },
      "10002": { users: [], groups: ["jira-software-users"] },
    },
    projectRoleActors: {},
    projects: {
      "10000": details("10000", "T101LIB"),
      "10001": details("10001", "T101OPS"),
      "10002": details("10002", "T100ZB"),
    },
  };
}

export function projectCoreState(store: JiraStore): ProjectCoreState {
  return getResourceState(store, "jira-api-2:project-core", defaultState);
}
