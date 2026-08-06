# Jira 10.3 user-management contract notes

The pinned `10.3.24` OpenAPI document has the following generated-contract defects in this operation group. Tests retain official validation wherever a response schema exists and do not relax these schemas.

- Several endpoints documented as returning collections reference the item schema directly rather than an array schema: application roles, accessibility settings, and user search/assignability/permission results.
- The password-policy descriptions specify JSON arrays of messages, while all three `200` response schemas declare a single string.
- User-property responses and the user-anonymization validation/progress/scheduling responses omit JSON content schemas even though their operation descriptions promise response representations.
- `GET /api/2/user/avatars` documents a map of system and custom avatar lists but references one `AvatarBean`; the columns schema is an unconstrained object despite documenting a list of columns.
- The duplicated-user count and mapping endpoints respectively reference `UserBean` and `AvatarBean`, which do not describe a count or a directory mapping.
