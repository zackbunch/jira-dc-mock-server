# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Added a pinned Confluence Data Center 10.0.3 OpenAPI contract, checksum, and update command.
- Added a compact, responsive Jira data inspector at `/dashboard` with project navigation, issue search and filtering, issue details, comments, and raw API response inspection.
- Added browser-session bearer token handling, server health feedback, accessible keyboard controls, mobile issue inspection, and a guarded seed-data reset flow.
- Added dashboard route coverage, Docker packaging for the framework-free frontend assets, and product/design documentation for future UI work.

### Changed

- Replaced fictional seeded users with Software Factory team members Zack Bunch, Frank Lillo, and Michael Welnick.
- Expanded the seeded `T100ZB` backlog from 12 to 100 tickets, for 103 tickets across all projects.

## 0.1.0 - 2026-08-06

### Added

- Initial stateful Jira Data Center 10.3.5 mock server for local development and automated testing.
- Complete route coverage for all 383 `/api/2` operations in the pinned Jira Software Data Center 10.3 OpenAPI contract, exposed under `/rest/api/2`.
- Jira-compatible APIs for issues, projects, users, metadata, filters, dashboards, workflows, schemes, screens, priority schemes, project assets, system settings, monitoring, indexing, reindexing, clustering, zero-downtime upgrades, avatars, email templates, terminology, upgrades, and license validation.
- Synthetic seed data for multiple projects and a varied software-factory backlog.
- Deterministic JQL search with pagination, ordering, field selection, and Jira-shaped validation errors for unsupported expressions.
- Persistent mutations backed by namespaced resource state, including behavior across process and container restarts.
- Administrative reset endpoint at `POST /__admin/reset` for restoring deterministic seed data.
- Bearer-token and Basic authentication with Jira-shaped authorization failures.
- Interactive Swagger UI and generated JSON and YAML OpenAPI documentation.
- Docker Compose configuration with persistent storage and health checks.
- Endpoint inventory and machine-readable implementation manifest at `planning/endpoint-manifest.json`.
- Compatibility documentation for defects and ambiguities in Atlassian's generated specification.

### Changed

- Refactored route registration into independently loaded resource modules.
- Isolated persistent state by resource group to prevent unrelated API operations from overwriting one another.
- Standardized request parsing, Jira error responses, response serialization, pagination, filtering, expansion, and reference validation through shared route helpers.

### Verified

- Confirmed all 383 contract operations are registered, implemented, and covered by contract tests.
- Added schema validation for documented successful responses plus focused assertions where the upstream schemas are incomplete.
- Added mutation, persistence, restart, reset, authentication, reference-validation, and lifecycle coverage across resource groups.
- Verified the complete 34-test suite, TypeScript type-check, production build, Docker health check, and live container persistence/reset workflow.

### Known limitations

- The server is a deterministic mock rather than a full Jira runtime; it does not reproduce Jira's UI, plugin system, permission engine, workflow engine, or asynchronous infrastructure.
- JQL support is intentionally bounded to the operators and fields documented in the project README.
- Binary uploads, reindexing, clustering, zero-downtime upgrades, templates, and similar infrastructure-heavy behavior are simulated.
- Sixteen upstream OpenAPI defects or ambiguities require narrowly documented compatibility behavior; see `contracts/COMPATIBILITY.md`.
