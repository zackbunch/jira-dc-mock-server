# Screens and priority-schemes contract notes

The pinned Jira Data Center 10.3 OpenAPI document has three narrow generated-document defects relevant to this implementation:

- `GET /api/2/screens` is described as a read operation but carries copy/pasted add-to-default text, status `201`, and no response schema. The mock preserves the pinned `201` status and returns the searchable, paginated screen collection needed by the operation's documented query parameters.
- The screen tabs, tab fields, and available-fields collection responses reference their item bean rather than an array of that bean. Tests therefore validate every returned array item against the referenced official schema.
- The priority-scheme list description documents `expand=schemes.projectKeys`, but the generated parameter list omits `expand`. The mock accepts that precisely documented expansion without adding other undocumented filters.

No global schema relaxation is used for these defects.
