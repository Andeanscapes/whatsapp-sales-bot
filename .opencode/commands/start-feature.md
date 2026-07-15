---
description: Initialize feature development with full context analysis and structured planning
agent: build
---

If the "caveman" skill is available, use it for compact communication during deep reasoning or complex analysis. If unavailable, continue normally.

Before coding, follow this workflow:

## 1. Context Discovery
- Analyze only the relevant codebase areas for the task.
- Identify services, components, patterns, and tests involved.
- **Read all project documentation files** — especially `docs/bot-architecture.md` and `docs/agent-workflows.md` — to fully understand the system before making changes.
- Review project instruction files (AGENTS.md, CLAUDE.md, .cursorrules, CONTRIBUTING.md, .github/copilot-instructions.md).
- Check package.json (or equivalent) for available commands: lint, test, build, typecheck, simulate, validate.
- Understand existing code patterns and architecture. Cross-reference with architecture docs.

## 2. Pattern Alignment
Output max 3 bullets:
- Current pattern being followed
- Where the change fits within existing architecture
- Critical risks or constraints (including convention alignment)

## 3. Plan (mandatory before coding)
Output max 5 bullets:
- Implementation steps
- Files affected
- Data flow changes (if applicable)
- i18n impact (if applicable)
- Test impact

## 4. Implementation
- Produce minimal, safe diffs.
- Reuse existing helpers, utilities, and components.
- Prefer existing patterns over new abstractions.
- Do NOT touch unrelated code.
- Apply changes only in targeted locations (avoid global side effects).

## 5. Validation
Output only:
- Commands to run (use project's own lint/test/build scripts)
- Manual checks needed
- Edge risks (only if critical)

Rules:
- Compact output only.
- No assumptions — verify before acting.
- No fake or mock data.
- No `any` types.
- Preserve existing service patterns, i18n, and architecture.
- Avoid regressions (especially edge cases).
- Apply accessibility best practices (ARIA, labels, keyboard, focus states).
- Ensure performance optimization (lazy loading, code splitting, minimal JS).
- Follow Lighthouse best practices (performance, accessibility, SEO).
- Ensure SEO fundamentals (semantic HTML, metadata, alt text, structure).
- Stop when the task is complete.

$ARGUMENTS
