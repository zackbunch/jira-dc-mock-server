import type { JiraStore } from "./store.js";
import { getResourceState } from "./store.js";

export interface PermissionHolder {
  type: string;
  parameter?: string;
}

export interface PermissionGrant {
  id: number;
  permission: string;
  holder: PermissionHolder;
}

export interface PermissionScheme {
  id: number;
  name: string;
  description: string;
  permissions: PermissionGrant[];
}

export interface IssueTypeScheme {
  id: string;
  name: string;
  description: string;
  defaultIssueTypeId: string;
  issueTypeIds: string[];
}

export interface NotificationScheme {
  id: number;
  name: string;
  description: string;
  notificationSchemeEvents: Record<string, unknown>;
}

export interface SecurityLevel {
  id: string;
  name: string;
  description: string;
}

export interface IssueSecurityScheme {
  id: number;
  name: string;
  description: string;
  defaultSecurityLevelId: number;
  levels: SecurityLevel[];
}

export interface SchemesState {
  permissionSchemeCounter: number;
  permissionGrantCounter: number;
  issueTypeSchemeCounter: number;
  permissionSchemes: PermissionScheme[];
  permissionSchemeAttributes: Record<string, Record<string, string>>;
  issueTypeSchemes: IssueTypeScheme[];
  issueTypeProjectAssociations: Record<string, string[]>;
  notificationSchemes: NotificationScheme[];
  issueSecuritySchemes: IssueSecurityScheme[];
}

function createDefaultState(): SchemesState {
  return {
    permissionSchemeCounter: 10002,
    permissionGrantCounter: 11004,
    issueTypeSchemeCounter: 10002,
    permissionSchemes: [
      {
        id: 10000,
        name: "Default Permission Scheme",
        description: "Default permissions for synthetic Jira projects.",
        permissions: [
          { id: 11000, permission: "BROWSE_PROJECTS", holder: { type: "group", parameter: "jira-software-users" } },
          { id: 11001, permission: "CREATE_ISSUES", holder: { type: "group", parameter: "jira-software-users" } },
        ],
      },
      {
        id: 10001,
        name: "Engineering Permission Scheme",
        description: "Permissions for engineering delivery projects.",
        permissions: [
          { id: 11002, permission: "BROWSE_PROJECTS", holder: { type: "anyone" } },
          { id: 11003, permission: "ADMINISTER_PROJECTS", holder: { type: "user", parameter: "developer" } },
        ],
      },
    ],
    permissionSchemeAttributes: {
      "10000": { scope: "default" },
    },
    issueTypeSchemes: [
      {
        id: "10000",
        name: "Default Issue Type Scheme",
        description: "Default synthetic issue type scheme.",
        defaultIssueTypeId: "10003",
        issueTypeIds: ["10001", "10002", "10003"],
      },
      {
        id: "10001",
        name: "Software Delivery Issue Type Scheme",
        description: "Issue types for software delivery projects.",
        defaultIssueTypeId: "10001",
        issueTypeIds: ["10001", "10002", "10003"],
      },
    ],
    issueTypeProjectAssociations: {
      "10000": ["10000", "10001"],
      "10001": ["10002"],
    },
    notificationSchemes: [
      { id: 10000, name: "Default Notification Scheme", description: "Default synthetic notifications.", notificationSchemeEvents: { "1": [{ type: "Current_Assignee" }] } },
      { id: 10001, name: "Engineering Notifications", description: "Engineering project notifications.", notificationSchemeEvents: { "1": [{ type: "Project_Lead" }], "2": [{ type: "Reporter" }] } },
    ],
    issueSecuritySchemes: [
      {
        id: 10000,
        name: "Engineering Issue Security",
        description: "Synthetic issue visibility controls.",
        defaultSecurityLevelId: 10000,
        levels: [
          { id: "10000", name: "Internal", description: "Visible to authenticated engineering users." },
          { id: "10001", name: "Restricted", description: "Visible only to explicitly approved users." },
        ],
      },
    ],
  };
}

export function getSchemesState(store: JiraStore): SchemesState {
  return getResourceState(store, "jira-api-2:schemes", createDefaultState);
}
