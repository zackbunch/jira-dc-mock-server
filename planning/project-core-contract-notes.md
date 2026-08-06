# Project core contract notes

The project-core routes use narrow accommodations for generated Jira 10.3 contract defects:

- Project types, avatars, components, versions, statuses, and global project roles are collections in Jira, but their operations reference an item schema. Tests validate every collection item against that referenced schema.
- `GET /project/{projectIdOrKey}/role` documents a successful JSON response without a schema. The mock returns Jira's role-name-to-URL map and asserts its essential mapping fields.
- Project avatar upload is a deterministic multipart simulation. It accepts the documented multipart body and returns the documented cropping and avatar schemas without storing image bytes.

Project features are represented by deterministic project type, archive, assignment, and permission capabilities because the pinned 10.3 contract contains no `/project/.../feature` operation.
