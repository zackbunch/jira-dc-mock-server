import { getResourceState } from "../store.js";
import type { JiraStore } from "../store.js";

export interface StoredAttachment {
  id: string;
  issueId: string;
  filename: string;
  mimeType: string;
  size: number;
  created: string;
}

export interface StoredRemoteLink {
  id: string;
  issueId: string;
  globalId?: string;
  application?: Record<string, unknown>;
  relationship?: string;
  object: Record<string, unknown>;
}

export interface StoredWorklog {
  id: string;
  issueId: string;
  authorName: string;
  updateAuthorName: string;
  comment: string;
  created: string;
  updated: string;
  started: string;
  timeSpent: string;
  timeSpentSeconds: number;
  visibility?: { type: "group" | "role"; value: string };
}

export interface StoredNotification {
  issueId: string;
  subject: string;
  textBody?: string;
  htmlBody?: string;
  recipients: Record<string, unknown>;
}

export interface IssueChange {
  id: number;
  field: string;
  from: unknown;
  to: unknown;
  authorName: string;
  created: string;
}

export interface IssueCoreState {
  archivedIssueIds: string[];
  properties: Record<string, Record<string, unknown>>;
  votes: Record<string, string[]>;
  watchers: Record<string, string[]>;
  attachments: StoredAttachment[];
  remoteLinks: StoredRemoteLink[];
  worklogs: StoredWorklog[];
  pinnedComments: Record<string, Record<string, { pinnedBy: string; pinnedDate: string }>>;
  subtasks: Record<string, string[]>;
  parentBySubtask: Record<string, string>;
  notifications: StoredNotification[];
  changes: Record<string, IssueChange[]>;
  nextAttachmentId: number;
  nextRemoteLinkId: number;
  nextWorklogId: number;
  nextChangeId: number;
}

function defaultState(): IssueCoreState {
  return {
    archivedIssueIds: [],
    properties: {
      "10004": { "mock.delivery": { owner: "platform", tier: "gold" } },
    },
    votes: {},
    watchers: { "10004": ["frank.lillo"] },
    attachments: [],
    remoteLinks: [],
    worklogs: [],
    pinnedComments: {},
    subtasks: {},
    parentBySubtask: {},
    notifications: [],
    changes: {},
    nextAttachmentId: 20000,
    nextRemoteLinkId: 30000,
    nextWorklogId: 40000,
    nextChangeId: 1,
  };
}

export function issueCoreState(store: JiraStore): IssueCoreState {
  return getResourceState(store, "jira-api-2:issue-core", defaultState);
}
