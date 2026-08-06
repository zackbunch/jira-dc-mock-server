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

## Fidelity boundary

Passing these tests means the implemented subset follows the standard Jira 10.3 route, status, and response shapes. It does not reproduce instance-specific custom fields, workflow screens, permissions, plugins, or exact error wording. Those require sanitized fixtures from the target Jira 10.3.5 installation.
