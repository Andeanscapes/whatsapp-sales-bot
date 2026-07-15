---
name: start-feature
description: Initialize feature development with full context analysis and structured planning. Use BEFORE writing any code.
---

Before coding, follow this workflow:

## 1. Context Discovery
- Analyze only the relevant codebase areas for the task.
- Identify services, components, patterns, and tests involved.
- **Read all project documentation files** — especially `docs/bot-architecture.md` and `docs/agent-workflows.md` — to fully understand the system before making changes.
- Review project instruction files (AGENTS.md, CLAUDE.md, .cursorrules, CONTRIBUTING.md, .github/copilot-instructions.md).
- Check package.json for available commands: lint, test, build, typecheck, simulate, validate.
- Understand existing patterns and architecture from the codebase. Cross-reference with architecture docs.

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

## Project-specific rules (always follow)
- Read AGENTS.md for architecture invariants
- Business facts live in src/data/*.skill.json — never hardcode
- Run: npm run typecheck && npm run lint && npm test && npm run build
- For reply path changes: also run npm run simulate -- "Hola, cuanto vale el tour?"
- Never log WHATSAPP_ACCESS_TOKEN, DEEPSEEK_API_KEY, WHATSAPP_APP_SECRET, TELEGRAM_BOT_TOKEN
- Never use any
- Minimal diffs only
