import { getResourceState } from "../store.js";
import type { JiraStore } from "../store.js";

export interface ManagedGroup {
  name: string;
  members: string[];
}

export interface ApplicationRole {
  key: string;
  name: string;
  groups: string[];
  defaultGroups: string[];
  selectedByDefault: boolean;
  defined: boolean;
  numberOfSeats: number;
  remainingSeats: number;
  userCount: number;
  userCountDescription: string;
  hasUnlimitedSeats: boolean;
  platform: boolean;
}

export interface ManagedAvatar {
  id: string;
  owner: string;
  selected: boolean;
  system?: boolean;
}

export interface AnonymizationTask {
  id: number;
  userKey: string;
  status: "COMPLETE" | "IN_PROGRESS";
  progress: number;
  submittedAt: string;
}

export interface UserManagementState {
  groups: ManagedGroup[];
  preferences: Record<string, Record<string, string>>;
  passwords: Record<string, string>;
  applications: Record<string, string[]>;
  properties: Record<string, Record<string, unknown>>;
  columns: Record<string, string[]>;
  avatars: Record<string, ManagedAvatar[]>;
  roles: ApplicationRole[];
  anonymizationTasks: AnonymizationTask[];
  nextAvatarId: number;
  nextTaskId: number;
}

function defaultState(): UserManagementState {
  return {
    groups: [
      { name: "jira-administrators", members: ["developer"] },
      { name: "jira-software-users", members: ["developer", "alex"] },
      { name: "jira-users", members: ["developer", "alex"] },
    ],
    preferences: {
      developer: { "jira.user.locale": "en_US", "jira.user.timezone": "UTC" },
    },
    passwords: { developer: "developer", alex: "alex" },
    applications: { developer: ["jira-software"], alex: ["jira-software"] },
    properties: { developer: { department: "Engineering" } },
    columns: {
      developer: ["issuetype", "key", "summary", "priority", "status"],
    },
    avatars: {
      developer: [
        { id: "10000", owner: "developer", selected: true, system: true },
        { id: "10001", owner: "developer", selected: false },
      ],
      alex: [{ id: "10002", owner: "alex", selected: true, system: true }],
    },
    roles: [
      {
        key: "jira-software",
        name: "Jira Software",
        groups: ["jira-software-users"],
        defaultGroups: ["jira-software-users"],
        selectedByDefault: true,
        defined: true,
        numberOfSeats: 500,
        remainingSeats: 498,
        userCount: 2,
        userCountDescription: "2 users",
        hasUnlimitedSeats: false,
        platform: false,
      },
      {
        key: "jira-core",
        name: "Jira Core",
        groups: ["jira-users"],
        defaultGroups: ["jira-users"],
        selectedByDefault: false,
        defined: true,
        numberOfSeats: 0,
        remainingSeats: 0,
        userCount: 2,
        userCountDescription: "2 users",
        hasUnlimitedSeats: true,
        platform: true,
      },
    ],
    anonymizationTasks: [],
    nextAvatarId: 11000,
    nextTaskId: 1,
  };
}

export function userManagementState(store: JiraStore): UserManagementState {
  return getResourceState(store, "jira-api-2:user-management", defaultState);
}
