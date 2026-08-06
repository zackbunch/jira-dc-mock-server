# Jira 10.3 workflow contract notes

The pinned `10.3.24` OpenAPI document has two narrow generated-contract omissions in this operation group. Tests keep official validation unchanged for every success response that has a schema.

- `GET /api/2/workflow` documents a full representation of every workflow but its `200` response has no content or schema. Jira returns a JSON workflow collection.
- `POST /api/2/workflowscheme` documents the newly created scheme but its `201` response has no content or schema. Jira returns the created workflow-scheme representation.
