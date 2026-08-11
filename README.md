# Jira Data Center 10.3 Mock Server

A small, stateful Jira Data Center REST API mock for local Jira-agent development. It reproduces a useful subset of Jira Data Center 10.3.5 behavior; it is not a complete Jira replacement.

## Start with Docker

```bash
docker compose up --build -d
docker compose ps
curl http://localhost:8080/health
```

Open the interactive Swagger UI at:

```text
http://localhost:8080/documentation
```

Open the compact data inspector at:

```text
http://localhost:8080/dashboard
```

The dashboard shows server health, projects, searchable and filterable issues, issue details, comments, and raw API responses. It uses the same Jira REST endpoints and authentication as other clients. The default bearer token is `local-test-token`; the token field keeps any replacement only for the current browser tab. The reset action asks for confirmation before restoring the deterministic seed data.

The generated OpenAPI documents are available at:

```text
http://localhost:8080/documentation/json
http://localhost:8080/documentation/yaml
```

Use Swagger UI's **Authorize** button with bearer token `local-test-token` to try protected endpoints.

Authenticated Jira request:

```bash
curl --fail --silent --show-error \
  -H 'Authorization: Bearer local-test-token' \
  -H 'Accept: application/json' \
  http://localhost:8080/rest/api/2/myself | jq
```

Basic Auth is also available with `developer:developer`.

Stop the server without deleting its Jira state:

```bash
docker compose down
```

Delete the volume to restore seed data on the next start:

```bash
docker compose down -v
docker compose up --build -d
```

Or reset a running server:

```bash
curl -X POST \
  -H 'Authorization: Bearer local-test-token' \
  http://localhost:8080/__admin/reset
```

## Seed data

The mock starts with three projects, 103 synthetic issues, and the Software Factory team of Zack Bunch, Frank Lillo, and Michael Welnick. Data is organized by tenant-style Jira project keys:

- `T100ZB` belongs to the T100 Software Factory tenant. It contains 100 issues assigned across the three-person team and distributed across To Do, In Progress, and Done. Topics include CI pipelines, golden-path templates, ephemeral environments, artifact governance, software supply-chain security, build runners, SBOMs, DORA metrics, platform observability, incident response, and cloud cost visibility.
- `T101LIB` and `T101OPS` belong to the shared T101 tenant. Their common libraries and reusable delivery automation are intended to be accessible to every tenant.

Reset the server at any time with `POST /__admin/reset` to restore this dataset.

## Implemented API subset

| Operation | Endpoint |
| --- | --- |
| Server information | `GET /rest/api/2/serverInfo` |
| Current user | `GET /rest/api/2/myself` |
| List/get projects | `GET /rest/api/2/project[/KEY]` |
| Field metadata | `GET /rest/api/2/field` |
| Issue types, priorities, statuses | `GET /rest/api/2/{issuetype,priority,status}` |
| JQL search | `GET` or `POST /rest/api/2/search` |
| Create/get/edit issue | `POST /rest/api/2/issue`, `GET` or `PUT /rest/api/2/issue/{key}` |
| List/add comments | `GET` or `POST /rest/api/2/issue/{key}/comment` |
| List/perform transitions | `GET` or `POST /rest/api/2/issue/{key}/transitions` |

The JQL mock supports `AND`, `=`, `!=`, `~`, `!~`, `IN`, `NOT IN`, `currentUser()`, and `ORDER BY` for these fields:

- `key` / `issuekey`
- `project`
- `status`
- `assignee`
- `reporter`
- `issuetype` / `type`
- `priority`
- `labels`
- `summary` / `text`
- `created` / `updated`

Unsupported JQL returns a Jira-shaped `400` response instead of silently producing incorrect results.

## Example agent workflow

```bash
# Search
curl -sS -X POST http://localhost:8080/rest/api/2/search \
  -H 'Authorization: Bearer local-test-token' \
  -H 'Content-Type: application/json' \
  -d '{"jql":"project = T100ZB AND status = \"To Do\"","fields":["summary","status"]}' | jq

# Discover valid transitions
curl -sS http://localhost:8080/rest/api/2/issue/T100ZB-2/transitions \
  -H 'Authorization: Bearer local-test-token' | jq

# Perform transition 21 (Start Progress)
curl -sS -X POST http://localhost:8080/rest/api/2/issue/T100ZB-2/transitions \
  -H 'Authorization: Bearer local-test-token' \
  -H 'Content-Type: application/json' \
  -d '{"transition":{"id":"21"}}'
```

## Agent CLI

The repository includes `jira-agent`, a Go CLI designed for deterministic agent use. It writes successful JSON to stdout, structured errors to stderr, and supports both focused Jira workflows and arbitrary REST requests.

Download a prebuilt Linux, macOS, or Windows archive from the [latest GitHub release](https://github.com/zackbunch/jira-dc-mock-server/releases/latest). Each release includes amd64 and arm64 builds plus `SHA256SUMS`.

```bash
# Build for the current machine
make cli
./bin/jira-agent health

# Or run directly during development
go run ./cmd/jira-agent issue search \
  --jql 'project = T100ZB AND status = "To Do"' \
  --fields key,summary,status
```

Configure a different server with `JIRA_BASE_URL` and `JIRA_TOKEN`, or use `JIRA_USERNAME` and `JIRA_PASSWORD` for Basic Auth. Run `jira-agent --help` for all commands. The bundled agent skill is at `.agents/skills/jira-agent/SKILL.md`.

Build release archives for Linux, Windows, and macOS on both amd64 and arm64:

```bash
make cli-release VERSION=v0.2.0
# Artifacts and SHA256SUMS are written under dist/cli.
```

The release builder uses only the Go toolchain and can also be run on Windows:

```text
go run ./scripts/build-cli.go --version v0.2.0
```

## Local development

The server requires Node.js 22 or newer. The CLI requires Go 1.22 or newer.

```bash
npm install
npm test
npm run dev
```

Persistent state is written atomically to `data/state.json`. Configuration is documented in `.env.example`.

The dashboard is served by the same Fastify process. Its framework-free assets live in `public/dashboard`, so there is no separate frontend server or build command.

## Intentional limitations

- This implements a curated REST API subset, not Jira's UI, plugins, webhooks, or every API group.
- JQL support is intentionally limited and reports unsupported syntax.
- Permissions are reduced to valid/invalid authentication.
- Destructive and administrative Jira endpoints are not exposed.
- Seed data is synthetic and safe to use for tests.
