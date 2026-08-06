import { metadataState, systemFields, type MetadataField } from "./metadata/resources.js";
import { getResourceState, type JiraStore } from "./store.js";

export interface ScreenFieldPlacement {
  id: string;
  showWhenEmpty: boolean;
}

export interface ScreenTab {
  id: number;
  name: string;
  fields: ScreenFieldPlacement[];
}

export interface Screen {
  id: number;
  name: string;
  description: string;
  tabs: ScreenTab[];
}

export interface PriorityScheme {
  id: number;
  name: string;
  description: string;
  defaultOptionId: string;
  optionIds: string[];
  projectKeys: string[];
  defaultScheme: boolean;
}

export interface ScreensPriorityState {
  tabCounter: number;
  prioritySchemeCounter: number;
  screens: Screen[];
  prioritySchemes: PriorityScheme[];
}

function defaultState(): ScreensPriorityState {
  return {
    tabCounter: 10003,
    prioritySchemeCounter: 10001,
    screens: [
      {
        id: 1,
        name: "Default Screen",
        description: "Default issue screen used by synthetic projects.",
        tabs: [
          {
            id: 10000,
            name: "Field Tab",
            fields: [
              { id: "summary", showWhenEmpty: false },
              { id: "description", showWhenEmpty: true },
              { id: "status", showWhenEmpty: false },
            ],
          },
          {
            id: 10001,
            name: "People",
            fields: [{ id: "assignee", showWhenEmpty: true }],
          },
        ],
      },
      {
        id: 2,
        name: "Workflow Screen",
        description: "A compact workflow transition screen.",
        tabs: [
          {
            id: 10002,
            name: "Workflow",
            fields: [
              { id: "summary", showWhenEmpty: false },
              { id: "labels", showWhenEmpty: true },
            ],
          },
        ],
      },
    ],
    prioritySchemes: [
      {
        id: 0,
        name: "Default priority scheme",
        description: "The default priority scheme.",
        defaultOptionId: "3",
        optionIds: ["1", "2", "3", "4"],
        projectKeys: ["T101LIB", "T101OPS"],
        defaultScheme: true,
      },
      {
        id: 10000,
        name: "Software Factory Priorities",
        description: "Priority scheme for the software factory project.",
        defaultOptionId: "2",
        optionIds: ["1", "2", "3", "4"],
        projectKeys: ["T100ZB"],
        defaultScheme: false,
      },
    ],
  };
}

export function screensPriorityState(store: JiraStore): ScreensPriorityState {
  return getResourceState(store, "jira-api-2:screens-priorityschemes", defaultState);
}

export function screenFieldCatalog(store: JiraStore): MetadataField[] {
  return [...systemFields, ...metadataState(store).customFields];
}
