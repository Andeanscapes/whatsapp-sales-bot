---
name: review
description: Strict senior review of current git changes against repo architecture rules. Use AFTER making code changes.
---

Review current git changes as a strict senior reviewer. Be concise and critical.

Check against:
- Project instruction files (AGENTS.md, CLAUDE.md, .cursorrules, CONTRIBUTING.md)
- package.json (validate commands: lint, test, build, typecheck)
- Relevant project docs and architecture decisions

Focus on:
- Service-layer patterns: fetch → validate → transform → return
- Architecture boundaries (server/client separation, provider topology, module scope)
- No hardcoded copy — respect i18n patterns if present
- Reuse existing primitives, helpers, utilities, and components
- No fake or mock data outside approved registries
- No invented APIs, fields, or routes
- Strict TypeScript (no any)
- Security (validation, XSS, unsafe URLs, secrets exposure)
- Minimal safe diff (no unrelated refactors, no touching files outside scope)
- Avoid duplication — reuse helpers and utilities
- Changes limited to targeted areas (no global side effects)
- Regression risk (edge cases, shared components, cross-feature impact)
- Alignment with documented future architecture (no conflicting patterns)

Output (compact):

## Summary
- What changed + score (1–10)

## Blocking Issues
- Only critical violations

## Improvements
- Optional, high-impact only

## Suggested Tests
- Targeted commands (from package.json) + key cases

## Final Decision
- APPROVE | REQUEST CHANGES | REJECT
