# Issue-adjunct contract notes

The pinned Jira Data Center 10.3 OpenAPI document has four narrow generated-schema defects relevant to these endpoints:

- `AttachmentBean` is an empty object schema, so tests validate it and separately assert the documented attachment metadata, issue reference, content URI, and simulated temporary-upload lifecycle fields.
- `POST /api/2/worklog/list` returns an array in Jira, but the generated response references the single `worklog` item schema. Tests validate every returned item against that official schema.
- `AutoCompleteResponseBean` declares its field and function arrays as strings while its own examples contain structured objects. The autocomplete-data response uses the declared string representation; the suggestions operation supplies the richer value/display-name records.
- `AutoCompleteResultWrapper` is an empty object schema. Tests retain official validation and separately assert deterministic filtering, lookup, pagination, and result properties.

No global schema relaxation is used.
