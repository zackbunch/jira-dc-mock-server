import { getResourceState, type JiraStore } from "./store.js";

export interface ArchiveEntry {
  entryIndex: number;
  name: string;
  abbreviatedName: string;
  size: number;
  mediaType: string;
}

export interface AttachmentRecord {
  id: string;
  issueId: string;
  filename: string;
  authorName: string;
  created: string;
  size: number;
  mimeType: string;
  temporaryUploadId: string;
  archiveEntries: ArchiveEntry[];
}

export interface WorklogRecord {
  id: number;
  issueId: string;
  authorName: string;
  comment: string;
  created: string;
  updated: string;
  started: string;
  timeSpent: string;
  timeSpentSeconds: number;
  updatedTime: number;
}

export interface IssueLinkRecord {
  id: string;
  typeId: string;
  inwardIssueId: string;
  outwardIssueId: string;
}

export interface IssueAdjunctsState {
  issueLinkCounter: number;
  attachments: AttachmentRecord[];
  temporaryUploads: Record<string, { filename: string; size: number; mimeType: string }>;
  commentProperties: Record<string, Record<string, string>>;
  worklogs: WorklogRecord[];
  deletedWorklogs: Array<{ worklogId: number; updatedTime: number }>;
  issueLinks: IssueLinkRecord[];
}

function defaultState(): IssueAdjunctsState {
  return {
    issueLinkCounter: 50001,
    attachments: [
      {
        id: "30000",
        issueId: "10004",
        filename: "platform-diagnostics.zip",
        authorName: "developer",
        created: "2026-02-02T09:00:00.000+0000",
        size: 24576,
        mimeType: "application/zip",
        temporaryUploadId: "temporary-30000",
        archiveEntries: [
          {
            entryIndex: 0,
            name: "diagnostics/build.log",
            abbreviatedName: "build.log",
            size: 16384,
            mediaType: "text/plain",
          },
          {
            entryIndex: 1,
            name: "diagnostics/environment.json",
            abbreviatedName: "environment.json",
            size: 8192,
            mediaType: "application/json",
          },
        ],
      },
      {
        id: "30001",
        issueId: "10002",
        filename: "rotation-notes.txt",
        authorName: "alex",
        created: "2026-01-12T15:00:00.000+0000",
        size: 2048,
        mimeType: "text/plain",
        temporaryUploadId: "temporary-30001",
        archiveEntries: [],
      },
    ],
    temporaryUploads: {
      "temporary-30000": {
        filename: "platform-diagnostics.zip",
        size: 24576,
        mimeType: "application/zip",
      },
      "temporary-30001": {
        filename: "rotation-notes.txt",
        size: 2048,
        mimeType: "text/plain",
      },
    },
    commentProperties: {},
    worklogs: [
      {
        id: 40000,
        issueId: "10004",
        authorName: "developer",
        comment: "Implemented the first service template workflow.",
        created: "2026-02-02T10:00:00.000+0000",
        updated: "2026-02-02T10:30:00.000+0000",
        started: "2026-02-02T08:00:00.000+0000",
        timeSpent: "2h",
        timeSpentSeconds: 7200,
        updatedTime: 1760000001000,
      },
      {
        id: 40001,
        issueId: "10005",
        authorName: "alex",
        comment: "Reproduced the intermittent integration failure.",
        created: "2026-02-04T14:00:00.000+0000",
        updated: "2026-02-04T14:15:00.000+0000",
        started: "2026-02-04T13:00:00.000+0000",
        timeSpent: "1h",
        timeSpentSeconds: 3600,
        updatedTime: 1760000002000,
      },
      {
        id: 40002,
        issueId: "10006",
        authorName: "developer",
        comment: "Evaluated dependency scanning tools.",
        created: "2026-02-06T11:00:00.000+0000",
        updated: "2026-02-06T12:00:00.000+0000",
        started: "2026-02-06T10:00:00.000+0000",
        timeSpent: "2h",
        timeSpentSeconds: 7200,
        updatedTime: 1760000003000,
      },
    ],
    deletedWorklogs: [{ worklogId: 40003, updatedTime: 1760000004000 }],
    issueLinks: [
      {
        id: "50000",
        typeId: "10000",
        inwardIssueId: "10005",
        outwardIssueId: "10006",
      },
    ],
  };
}

export function issueAdjunctsState(store: JiraStore): IssueAdjunctsState {
  return getResourceState(store, "jira-api-2:issue-adjuncts", defaultState);
}
