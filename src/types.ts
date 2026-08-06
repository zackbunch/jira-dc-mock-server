export interface JiraUser {
  self?: string;
  key: string;
  name: string;
  emailAddress: string;
  avatarUrls: Record<string, string>;
  displayName: string;
  active: boolean;
  deleted?: boolean;
  timeZone: string;
  locale: string;
}

export interface JiraProject {
  self?: string;
  id: string;
  key: string;
  name: string;
  projectTypeKey: "software" | "business" | "service_desk";
  simplified: boolean;
  archived: boolean;
  lead: JiraUser;
  avatarUrls: Record<string, string>;
}

export interface JiraNamedResource {
  self?: string;
  id: string;
  name: string;
  description?: string;
  iconUrl?: string;
  subtask?: boolean;
}

export interface JiraStatus extends JiraNamedResource {
  statusCategory: {
    self?: string;
    id: number;
    key: "new" | "indeterminate" | "done";
    colorName: string;
    name: string;
  };
}

export interface JiraComment {
  self?: string;
  id: string;
  author: JiraUser;
  body: string;
  updateAuthor: JiraUser;
  created: string;
  updated: string;
}

export interface JiraIssueFields {
  project: JiraProject;
  issuetype: JiraNamedResource;
  summary: string;
  description: string | null;
  status: JiraStatus;
  priority: JiraNamedResource;
  assignee: JiraUser | null;
  reporter: JiraUser;
  labels: string[];
  created: string;
  updated: string;
  comment: {
    comments: JiraComment[];
    maxResults: number;
    total: number;
    startAt: number;
  };
  [fieldId: string]: unknown;
}

export interface JiraIssue {
  expand: string;
  id: string;
  self?: string;
  key: string;
  fields: JiraIssueFields;
}

export interface JiraState {
  issueCounter: number;
  commentCounter: number;
  resources: Record<string, unknown>;
  users: JiraUser[];
  projects: JiraProject[];
  issueTypes: JiraNamedResource[];
  priorities: JiraNamedResource[];
  statuses: JiraStatus[];
  issues: JiraIssue[];
}

export interface JiraError {
  errorMessages: string[];
  errors: Record<string, string>;
}
