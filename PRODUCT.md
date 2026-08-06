# Product

## Register

product

## Users

Developers running the Jira Data Center mock locally while building and testing Jira integrations or agents. They need to understand the mock's current state quickly without reading JSON responses, querying the API manually, or navigating a full Jira-style interface.

## Product Purpose

Provide a faithful, stateful Jira Data Center REST API mock and a compact visual inspector for its current data. Success means a developer can confirm server health, browse projects and issues, inspect issue details, and intentionally restore seed data within seconds.

## Brand Personality

Compact, dependable, and direct. The product should feel like a focused developer utility: calm under dense information, explicit about state, and free of unnecessary ceremony.

## Anti-references

Do not recreate Jira's full product interface, imitate a generic enterprise admin dashboard, or turn the inspector into a monitoring wall of decorative metrics. Avoid novelty interactions, ornamental data visualizations, excessive cards, and hidden destructive actions.

## Design Principles

- Put current state before configuration or explanation.
- Make dense information easy to scan without making it feel cramped.
- Keep actions explicit, predictable, and close to their consequences.
- Preserve the mock server's single-process, low-maintenance character.
- Reveal API-shaped detail progressively instead of flattening everything into the main view.

## Accessibility & Inclusion

Target WCAG 2.2 AA. Support complete keyboard navigation, visible focus states, semantic structure, reduced motion, readable contrast, and status communication that does not depend on color alone.
