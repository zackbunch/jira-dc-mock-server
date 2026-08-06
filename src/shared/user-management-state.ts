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
      { name: "jira-software-users", members: ["developer", "frank.lillo", "michael.welnick"] },
      { name: "jira-users", members: ["developer", "frank.lillo", "michael.welnick"] },
    ],
    preferences: {
      developer: { "jira.user.locale": "en_US", "jira.user.timezone": "UTC" },
      "frank.lillo": { "jira.user.locale": "en_US", "jira.user.timezone": "UTC" },
      "michael.welnick": { "jira.user.locale": "en_US", "jira.user.timezone": "UTC" },
    },
    passwords: { developer: "developer", "frank.lillo": "frank.lillo", "michael.welnick": "michael.welnick" },
    applications: {
      developer: ["jira-software"],
      "frank.lillo": ["jira-software"],
      "michael.welnick": ["jira-software"],
    },
    properties: {
      developer: { department: "Software Factory" },
      "frank.lillo": { department: "Software Factory" },
      "michael.welnick": { department: "Software Factory" },
    },
    columns: {
      developer: ["issuetype", "key", "summary", "priority", "status"],
    },
    avatars: {
      developer: [
        { id: "10000", owner: "developer", selected: true, system: true },
        { id: "10001", owner: "developer", selected: false },
      ],
      "frank.lillo": [{ id: "10002", owner: "frank.lillo", selected: true, system: true }],
      "michael.welnick": [{ id: "10003", owner: "michael.welnick", selected: true, system: true }],
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
        remainingSeats: 497,
        userCount: 3,
        userCountDescription: "3 users",
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
        userCount: 3,
        userCountDescription: "3 users",
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
