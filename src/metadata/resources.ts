import type { JiraStore } from "../store.js";
import { getResourceState } from "../store.js";

export interface MetadataField {
  id: string;
  name: string;
  description?: string;
  custom: boolean;
  orderable: boolean;
  navigable: boolean;
  searchable: boolean;
  clauseNames?: string[];
  schema: Record<string, unknown>;
  type?: string;
  searcherKey?: string;
  projectIds?: number[];
  issueTypeIds?: string[];
  screenIds?: number[];
  lastValueUpdate?: string;
}

export interface CustomFieldOption {
  id: number;
  value: string;
  disabled: boolean;
  childrenIds: number[];
  customFieldId: string;
}

export interface IssueLinkType {
  id: string;
  name: string;
  inward: string;
  outward: string;
}

export interface Resolution {
  id: string;
  name: string;
  description: string;
}

export interface AvatarRecord {
  id: string;
  issueTypeId: string;
  owner: string;
  selected: boolean;
}

export interface MetadataResourceState {
  customFieldCounter: number;
  optionCounter: number;
  issueLinkTypeCounter: number;
  issueTypeCounter: number;
  avatarCounter: number;
  customFields: MetadataField[];
  customFieldOptions: CustomFieldOption[];
  issueLinkTypes: IssueLinkType[];
  resolutions: Resolution[];
  issueTypeProperties: Record<string, Record<string, unknown>>;
  temporaryAvatars: Record<string, { size: number; contentType: string }>;
  avatars: AvatarRecord[];
}

function defaultState(): MetadataResourceState {
  return {
    customFieldCounter: 10004,
    optionCounter: 20003,
    issueLinkTypeCounter: 10003,
    issueTypeCounter: 10004,
    avatarCounter: 11000,
    customFields: [
      {
        id: "customfield_10002",
        name: "Story Points",
        description: "Estimated delivery effort.",
        custom: true,
        orderable: true,
        navigable: true,
        searchable: true,
        clauseNames: ["Story Points", "cf[10002]"],
        schema: {
          type: "number",
          custom: "com.atlassian.jira.plugin.system.customfieldtypes:float",
          customId: 10002,
        },
        type: "com.atlassian.jira.plugin.system.customfieldtypes:float",
        searcherKey: "com.atlassian.jira.plugin.system.customfieldtypes:exactnumber",
        projectIds: [],
        issueTypeIds: [],
        screenIds: [1],
        lastValueUpdate: "2026-02-05T00:00:00.000Z",
      },
      {
        id: "customfield_10003",
        name: "Delivery Region",
        description: "Synthetic regional delivery selector.",
        custom: true,
        orderable: true,
        navigable: true,
        searchable: true,
        clauseNames: ["Delivery Region", "cf[10003]"],
        schema: {
          type: "option",
          custom: "com.atlassian.jira.plugin.system.customfieldtypes:select",
          customId: 10003,
        },
        type: "com.atlassian.jira.plugin.system.customfieldtypes:select",
        searcherKey: "com.atlassian.jira.plugin.system.customfieldtypes:multiselectsearcher",
        projectIds: [10002],
        issueTypeIds: ["10001", "10002", "10003"],
        screenIds: [1],
        lastValueUpdate: "2026-02-05T00:00:00.000Z",
      },
    ],
    customFieldOptions: [
      { id: 20001, value: "US West", disabled: false, childrenIds: [], customFieldId: "customfield_10003" },
      { id: 20002, value: "US East", disabled: false, childrenIds: [], customFieldId: "customfield_10003" },
    ],
    issueLinkTypes: [
      { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" },
      { id: "10001", name: "Duplicate", inward: "is duplicated by", outward: "duplicates" },
      { id: "10002", name: "Relates", inward: "relates to", outward: "relates to" },
    ],
    resolutions: [
      { id: "1", name: "Fixed", description: "A fix for this issue is checked in and tested." },
      { id: "2", name: "Won't Fix", description: "This issue will not be fixed." },
      { id: "3", name: "Duplicate", description: "The problem is a duplicate of an existing issue." },
    ],
    issueTypeProperties: {},
    temporaryAvatars: {},
    avatars: [],
  };
}

export function metadataState(store: JiraStore): MetadataResourceState {
  return getResourceState(store, "metadata.v1", defaultState);
}

export const systemFields: MetadataField[] = [
  { id: "summary", name: "Summary", custom: false, orderable: true, navigable: true, searchable: true, clauseNames: ["summary"], schema: { type: "string", system: "summary" } },
  { id: "description", name: "Description", custom: false, orderable: true, navigable: true, searchable: true, clauseNames: ["description"], schema: { type: "string", system: "description" } },
  { id: "status", name: "Status", custom: false, orderable: true, navigable: true, searchable: true, clauseNames: ["status"], schema: { type: "status", system: "status" } },
  { id: "assignee", name: "Assignee", custom: false, orderable: true, navigable: true, searchable: true, clauseNames: ["assignee"], schema: { type: "user", system: "assignee" } },
  { id: "labels", name: "Labels", custom: false, orderable: true, navigable: true, searchable: true, clauseNames: ["labels"], schema: { type: "array", items: "string", system: "labels" } },
];
