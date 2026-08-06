# Jira 10.3 contract compatibility

The test suite validates every Jira route implemented by this mock against Atlassian's pinned 10.3 OpenAPI document.

## Covered operations

- Server information and current user
- Project list and project lookup
- Field, issue type, priority, and status metadata
- GET and POST JQL search
- Issue creation, retrieval, and update
- Comment listing and creation
- Transition listing and execution
- Jira `200`/`201` JSON response schemas and `204` empty responses
- Basic authentication from the official contract, plus the mock's PAT bearer-token support

Run only the contract checks with:

```bash
npm run contracts:test
```

## Known defects in Atlassian's generated specification

The tests use narrow, documented workarounds for these upstream issues rather than changing the mock to reproduce an invalid schema:

1. `GET /project`, `/field`, `/issuetype`, `/priority`, and `/status` return arrays in Jira, but the generated OpenAPI operation references the item schema instead of an array schema. Tests validate every returned item against that official item schema.
2. `IssueBean.fields` is dynamic, but the generated schema declares every field value as an object even though Jira's own examples include strings, arrays, numbers, and nulls. Tests relax only `fields.additionalProperties` and retain the rest of `IssueBean` validation.
3. Several schemas, including `ServerInfoBean`, define no required properties. The tests add focused assertions for important identifiers and collection structure so an empty object cannot pass unnoticed.
4. `GET /application-properties/advanced-settings` describes and exemplifies an array of properties, but its generated response schema is a single `Property`. The mock returns one deterministic advanced property to follow the pinned response schema; this is intentionally less complete than Jira's real advanced-settings listing.
5. `POST /reindex/request` describes an array of request IDs but declares a single integer response, and `GET /reindex/request/bulk` describes an array of results but declares one `ReindexRequestBean`. The mock follows those pinned schemas by returning one deterministic ID or request object per call.
6. `GET /index-snapshot` describes a list but declares one `IndexSnapshotBean`. The mock returns the newest available snapshot so the response remains schema-valid.
7. `GET /cluster/nodes` describes a list of nodes but declares the item schema `NodeBean`. Tests validate each node in the returned array against that schema, matching Jira's documented collection behavior.
8. The paginated issue type, priority, status, resolution, and custom-field operations reference an item bean (and, for resolutions, an empty bean) instead of a page schema. Tests validate every value against the referenced item schema and separately assert the Jira page envelope and pagination fields.
9. `DELETE /issuetype/{id}` declares `alternativeIssueTypeId` as a required path parameter even though it is absent from the path template. The mock accepts it as the query parameter used to select a migration target.
10. The temporary issue-type avatar upload declares an object schema under `text/html`. The mock's deterministic multipart simulation returns the schema-valid JSON representation with that documented media type.
11. `GET /filter/favourite` and `GET /filter/{id}/permission` describe collections but reference their item schemas. Tests validate every returned array item against the pinned schema and assert non-empty collection structure.
12. `DELETE /filter/{id}/permission/{permission-id}` uses a hyphenated template variable while also declaring inconsistent `permissionId` and `permission-id` parameters. Route coverage normalizes the template name to `permission_id` internally while preserving the documented external URL.
13. `GET /avatar/{type}/system` and `GET /universal_avatar/type/{type}/owner/{owningObjectId}` describe collections but declare a single `AvatarBean`. The mock returns the selected matching avatar to follow the pinned response schema.
14. `POST /avatar/{type}/temporaryCrop` declares only `400` and `500` responses, omitting every success response. The mock returns `201` with the neighboring avatar-create operation's `AvatarBean` schema after a valid persistent crop.
15. `GET /terminology/entries` describes a collection but declares one `TerminologyResponseBean`, while `POST /terminology/entries` omits every success response. Tests validate each returned entry against the item schema; a valid persistent update returns an empty `204`.
16. The email-template download, upload, apply, revert, and types operations define successful statuses without content schemas. Tests assert their documented media/empty-body behavior directly: a valid ZIP download/upload, empty mutation bodies, and a deterministic text type listing.

## Fidelity boundary

Passing these tests means the implemented subset follows the standard Jira 10.3 route, status, and response shapes. It does not reproduce instance-specific custom fields, workflow screens, permissions, plugins, or exact error wording. Those require sanitized fixtures from the target Jira 10.3.5 installation.
