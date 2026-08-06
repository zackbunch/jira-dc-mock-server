import { getResourceState } from "../store.js";
import type { JiraStore } from "../store.js";

export interface WorkflowDefinition {
  name: string;
  description: string;
  default: boolean;
  active: boolean;
  steps: Array<{ id: number; name: string; statusIds: string[] }>;
}

export interface StoredWorkflowScheme {
  id: number;
  name: string;
  description: string;
  defaultWorkflow?: string;
  issueTypeMappings: Record<string, string>;
  projectIds: string[];
  revision: number;
  draft: boolean;
  originalDefaultWorkflow?: string;
  originalIssueTypeMappings?: Record<string, string>;
}

export interface WorkflowSchemesState {
  workflows: WorkflowDefinition[];
  schemes: StoredWorkflowScheme[];
  drafts: Record<string, StoredWorkflowScheme>;
  nextSchemeId: number;
}

function defaultState(): WorkflowSchemesState {
  return {
    workflows: [
      {
        name: "jira",
        description: "The default Jira workflow.",
        default: true,
        active: true,
        steps: [
          { id: 1, name: "Open", statusIds: ["10000"] },
          { id: 2, name: "In Progress", statusIds: ["3"] },
          { id: 3, name: "Done", statusIds: ["10001"] },
        ],
      },
      {
        name: "Software Simplified Workflow",
        description: "A lightweight workflow for software projects.",
        default: false,
        active: true,
        steps: [
          { id: 10, name: "To Do", statusIds: ["10000"] },
          { id: 11, name: "In Progress", statusIds: ["3"] },
          { id: 12, name: "Done", statusIds: ["10001"] },
        ],
      },
      {
        name: "Release Workflow",
        description: "A workflow for release-oriented work.",
        default: false,
        active: false,
        steps: [
          { id: 20, name: "Planned", statusIds: ["10000"] },
          { id: 21, name: "Delivering", statusIds: ["3"] },
          { id: 22, name: "Released", statusIds: ["10001"] },
        ],
      },
    ],
    schemes: [
      {
        id: 10000,
        name: "Software Development Workflow Scheme",
        description: "Active workflow scheme used by the seeded software projects.",
        defaultWorkflow: "Software Simplified Workflow",
        issueTypeMappings: {
          "10002": "jira",
          "10003": "Release Workflow",
        },
        projectIds: ["10000", "10001", "10002"],
        revision: 1,
        draft: false,
      },
      {
        id: 10001,
        name: "Unassociated Workflow Scheme",
        description: "An editable workflow scheme with no project associations.",
        defaultWorkflow: "jira",
        issueTypeMappings: {},
        projectIds: [],
        revision: 1,
        draft: false,
      },
    ],
    drafts: {},
    nextSchemeId: 11000,
  };
}

export function workflowSchemesState(store: JiraStore): WorkflowSchemesState {
  return getResourceState(store, "jira-api-2:workflow-schemes", defaultState);
}
