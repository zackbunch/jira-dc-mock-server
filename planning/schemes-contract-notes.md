# Scheme API contract notes

The scheme routes follow the pinned Jira Data Center 10.3 OpenAPI document with two narrow generated-contract accommodations:

- `GET /issuetypescheme/{schemeId}/associations` references one `ProjectBean`, although Jira returns a project collection. Tests validate each returned project against that bean.
- `IssueTypeSchemeCreateUpdateBean` exposes both `issueTypeIDs` and `issueTypeIds`. The mock accepts either spelling, serializes the canonical `issueTypes` resource collection, and rejects invalid issue-type references.

Synthetic notification events, permission holders, security levels, and scheme associations are deterministic. They model the documented resource shapes and persistence behavior without reproducing instance-specific plugins or directory data.
