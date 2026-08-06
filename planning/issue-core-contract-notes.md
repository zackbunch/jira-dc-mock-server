# Jira 10.3 issue-core contract notes

The pinned `10.3.24` OpenAPI document has these narrow generated-contract defects in the missing issue operations. Tests do not relax any official response schema.

- Both create-metadata endpoints document pagination but reference a single `CreateMetaIssueTypeBean` or `FieldMetaBean` instead of the returned page wrapper.
- Attachment upload, pinned comments, remote-link listing, and subtask listing document collections but each success response references only the collection item schema.
- Bulk archive declares a `text/plain` response whose schema type is `object`; the mock returns the documented text media type containing a JSON object and validates the decoded object against that schema.
- Adding a vote documents a returned vote count, but the `200` response declares no content schema.
