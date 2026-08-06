import type { JiraStore } from "./store.js";
import { getResourceState } from "./store.js";

export type ComponentAssigneeType =
  | "PROJECT_DEFAULT"
  | "COMPONENT_LEAD"
  | "PROJECT_LEAD"
  | "UNASSIGNED";

export interface ProjectComponent {
  id: string;
  name: string;
  description?: string;
  projectId: string;
  leadUserName?: string;
  assigneeType: ComponentAssigneeType;
  archived: boolean;
  deleted: boolean;
  issueIds: string[];
}

export interface ProjectCategory {
  id: string;
  name: string;
  description?: string;
}

export interface ProjectVersion {
  id: string;
  name: string;
  description?: string;
  projectId: string;
  archived: boolean;
  released: boolean;
  releaseDate?: string;
  startDate?: string;
  fixedIssueIds: string[];
  affectedIssueIds: string[];
}

export interface RemoteVersionLink {
  versionId: string;
  globalId: string;
  name?: string;
  link?: string;
  self?: string;
}

export interface ProjectAssetsState {
  componentCounter: number;
  categoryCounter: number;
  versionCounter: number;
  remoteLinkCounter: number;
  components: ProjectComponent[];
  categories: ProjectCategory[];
  versions: ProjectVersion[];
  remoteLinks: RemoteVersionLink[];
}

const RESOURCE_KEY = "project-assets/v1";

function createDefaultProjectAssetsState(): ProjectAssetsState {
  return {
    componentCounter: 11003,
    categoryCounter: 11002,
    versionCounter: 12005,
    remoteLinkCounter: 2,
    components: [
      {
        id: "11000",
        name: "Shared libraries",
        description: "Reusable application libraries",
        projectId: "10000",
        leadUserName: "developer",
        assigneeType: "COMPONENT_LEAD",
        archived: false,
        deleted: false,
        issueIds: ["10001", "10002"],
      },
      {
        id: "11001",
        name: "Delivery automation",
        description: "Common delivery automation",
        projectId: "10001",
        leadUserName: "alex",
        assigneeType: "PROJECT_LEAD",
        archived: false,
        deleted: false,
        issueIds: ["10003"],
      },
      {
        id: "11002",
        name: "Platform engineering",
        description: "Software factory platform capabilities",
        projectId: "10002",
        leadUserName: "developer",
        assigneeType: "PROJECT_DEFAULT",
        archived: false,
        deleted: false,
        issueIds: ["10004", "10005", "10006"],
      },
    ],
    categories: [
      { id: "11000", name: "Shared Services", description: "Shared enterprise services" },
      { id: "11001", name: "Software Factory", description: "Developer platform projects" },
    ],
    versions: [
      {
        id: "12000",
        name: "1.0.0",
        description: "Initial shared library release",
        projectId: "10000",
        archived: false,
        released: true,
        releaseDate: "2026-01-31T00:00:00.000Z",
        startDate: "2026-01-01T00:00:00.000Z",
        fixedIssueIds: ["10001"],
        affectedIssueIds: ["10002"],
      },
      {
        id: "12001",
        name: "1.1.0",
        description: "Authentication maintenance release",
        projectId: "10000",
        archived: false,
        released: false,
        startDate: "2026-02-01T00:00:00.000Z",
        fixedIssueIds: ["10002"],
        affectedIssueIds: [],
      },
      {
        id: "12002",
        name: "2026.1",
        description: "Delivery operations baseline",
        projectId: "10001",
        archived: false,
        released: false,
        fixedIssueIds: ["10003"],
        affectedIssueIds: [],
      },
      {
        id: "12003",
        name: "Platform Alpha",
        description: "Software factory alpha milestone",
        projectId: "10002",
        archived: false,
        released: true,
        releaseDate: "2026-02-15T00:00:00.000Z",
        fixedIssueIds: ["10004", "10010"],
        affectedIssueIds: ["10005"],
      },
      {
        id: "12004",
        name: "Platform Beta",
        description: "Software factory beta milestone",
        projectId: "10002",
        archived: false,
        released: false,
        startDate: "2026-02-16T00:00:00.000Z",
        fixedIssueIds: ["10005", "10006", "10007"],
        affectedIssueIds: ["10008"],
      },
    ],
    remoteLinks: [
      {
        versionId: "12004",
        globalId: "build-platform-beta",
        name: "Platform Beta build",
        link: JSON.stringify({ rel: "build", url: "https://ci.example.test/builds/12004" }),
      },
    ],
  };
}

export function getProjectAssetsState(store: JiraStore): ProjectAssetsState {
  return getResourceState(store, RESOURCE_KEY, createDefaultProjectAssetsState);
}

export function uniqueIssueIds(issueIds: string[]): string[] {
  return [...new Set(issueIds)];
}
