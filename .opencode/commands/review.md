---
description: Review current changes with strict compact review against repo architecture rules
agent: build
---

Review current git changes as a strict senior reviewer. Be concise and critical.

Check against:
- Project instruction files (AGENTS.md, CLAUDE.md, .cursorrules, CONTRIBUTING.md, .github/copilot-instructions.md)
- package.json (validate commands exist and pass: lint, test, build, typecheck)
- Relevant project docs and architecture decisions
- IDE/personalized instruction files

Focus on:
- Service-layer patterns: fetch → validate → transform → return
- Architecture boundaries (server/client separation, provider topology, module scope)
- No hardcoded copy — respect i18n patterns if present
- Reuse existing primitives, helpers, utilities, and components
- No fake or mock data outside approved registries
- No invented APIs, fields, or routes
- Strict TypeScript (no `any`)
- Security (validation, XSS, unsafe URLs, secrets exposure)
- Minimal safe diff (no unrelated refactors, no touching files outside scope)
- Avoid duplication — reuse helpers and utilities
- Changes limited to targeted areas (no global side effects)
- Regression risk (edge cases, shared components, cross-feature impact)
- Performance (lazy loading, code splitting, avoid unnecessary JS)
- Accessibility (ARIA, labels, keyboard, focus states)
- SEO (semantic HTML, metadata, alt text, structure)
- Lighthouse impact (performance, accessibility, SEO)
- Alignment with documented future architecture (no conflicting patterns)

Output (compact):

## Summary
- What changed + score (1–10)

## Blocking Issues
- Only critical violations (include future-architecture conflicts)

## Improvements
- Optional, high-impact only

## Suggested Tests
- Targeted commands (from package.json) + key cases

## Final Decision
- APPROVE | REQUEST CHANGES | REJECT
