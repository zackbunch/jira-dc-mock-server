---
name: jira-agent
description: Operate Jira Data Center from an agent through the jira-agent CLI. Use whenever a task requires inspecting, searching, creating, editing, transitioning, commenting on, or deleting Jira issues or projects; calling Jira Data Center REST endpoints; checking the local Jira mock; or resetting mock data. Prefer this CLI over hand-written curl because it provides stable JSON output, encoded query parameters, authentication, and useful exit codes.
compatibility: Requires the jira-agent binary on PATH and network access to the target Jira Data Center server.
---

# Jira Agent CLI

Use `jira-agent` for Jira Data Center operations. It prints successful JSON responses to stdout and machine-readable JSON errors to stderr.

## Configure

Use environment variables so credentials do not appear repeatedly in shell history:

```bash
export JIRA_BASE_URL="http://localhost:8080"
export JIRA_TOKEN="local-test-token"
```

The CLI also supports `JIRA_USERNAME` and `JIRA_PASSWORD` for Basic Auth. A local mock at `http://localhost:8080` defaults to token `local-test-token` when no credentials are configured.

Start by checking connectivity and identity:

```bash
jira-agent health
jira-agent myself
jira-agent server-info
```

Do not print, log, or commit credentials. Prefer environment variables to global `--token` and `--password` flags.

## Workflow

1. Inspect before mutating. Search for the issue or fetch it by key instead of assuming its current state.
2. Use a focused command when one exists. Use `request` for the rest of the Jira Data Center API.
3. Discover transition IDs with `transition list`; never infer an ID from a status name.
4. After a write, fetch the changed resource when the write response does not contain enough state to verify the result.
5. Report the affected issue or project keys and summarize the resulting state.
6. Treat `issue delete` and `reset --confirm` as destructive. Run them only when the user clearly requested that action. `reset` applies to the local mock, not normal Jira administration.

## Common commands

```bash
# Projects and issues
jira-agent project list
jira-agent project get T100ZB
jira-agent issue get T100ZB-2 --fields summary,status,assignee,description
jira-agent issue search \
  --jql 'project = T100ZB AND status = "To Do" ORDER BY updated DESC' \
  --fields key,summary,status,assignee \
  --max-results 25

# Create an issue
jira-agent issue create \
  --project T100ZB \
  --type Task \
  --summary "Document release rollback" \
  --description "Add and verify the rollback procedure." \
  --labels documentation,release

# Add arbitrary create fields
jira-agent issue create \
  --project T100ZB --type Task --summary "Review deployment" \
  --fields-json '{"customfield_10100":"platform"}'

# Edit safely using stdin, avoiding shell-escaping problems
jira-agent issue edit T100ZB-2 --data @- <<'JSON'
{"fields":{"summary":"Updated summary","labels":["platform","reviewed"]}}
JSON

# Comments and workflow transitions
jira-agent comment list T100ZB-2
jira-agent comment add T100ZB-2 --body "Validated in the local environment."
jira-agent transition list T100ZB-2
jira-agent transition perform T100ZB-2 21

# Explicit destructive operations
jira-agent issue delete T100ZB-2
jira-agent reset --confirm
```

Flags for a subcommand follow its positional arguments. Global flags such as `--base-url`, `--compact`, and `--raw` must appear before the command.

## Generic REST access

Call endpoints not covered by focused commands with `request`:

```bash
jira-agent request GET /rest/api/2/field
jira-agent request GET /rest/api/2/user/search --query username=zack
jira-agent request POST /rest/api/2/issue/T100ZB-2/worklog --data @- <<'JSON'
{"timeSpentSeconds":1800,"comment":"Investigated the failing build."}
JSON
```

Repeat `--query` or `--header` for multiple values. `--data` accepts inline content, `@path/to/file.json`, or `@-` for stdin. Relative endpoint paths are resolved under `JIRA_BASE_URL`; absolute URLs are accepted only when they have the same origin, preventing credentials from being sent elsewhere.

Use `--raw` only for a known non-JSON endpoint. Normal commands validate and pretty-print JSON; `--compact` emits one JSON object per result.

## Failures

Interpret exit codes before deciding whether to retry:

- `0`: success
- `1`: network, timeout, or response decoding failure
- `2`: invalid command, flags, or configuration; correct the invocation rather than retrying
- `3`: Jira returned a non-2xx response; inspect `status` and `response` in stderr

A Jira error resembles:

```json
{"error":"http","message":"Jira returned HTTP 404","response":{"errorMessages":["missing"]},"status":404}
```

Do not blindly retry authentication, authorization, validation, or not-found errors. A transient `429` or `5xx` may be retried with bounded backoff if the operation is safe to repeat.
