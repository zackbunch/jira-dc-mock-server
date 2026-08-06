# Jira Data Center REST contract

`jira-software-dc-10.3-openapi.json` is the official Atlassian OpenAPI 3 specification for the Jira Data Center 10.3 release line.

Source:

```text
https://dac-static.atlassian.com/server/jira/platform/jira_software_dc_10003_swagger.v3.json
```

Atlassian updates the specification for the supported 10.3 release line. At the time this copy was downloaded, its `info.version` was `10.3.24`. Our target deployment is 10.3.5, so this is the best official machine-readable baseline, but it may contain additive endpoints or fields introduced in later 10.3 patch releases.

The specification uses a server base URL ending in `/rest`, while its paths begin with `/api/2` or `/agile/1.0`. The effective Jira routes therefore begin with `/rest/api/2` and `/rest/agile/1.0`.

Update the pinned copy and checksum with:

```bash
npm run contracts:update
```

The contract establishes standard Jira response shapes. Custom fields, workflows, permissions, plugin data, and screen configuration still need sanitized snapshots from the target Jira instance.

See [COMPATIBILITY.md](COMPATIBILITY.md) for validation coverage and known defects in Atlassian's generated specification.
