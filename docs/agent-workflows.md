# Agent Workflows

Team-wide AI coding agent workflows for the Andean Scapes WhatsApp Sales Bot.

These workflows are committed to the repo so every developer using an AI coding assistant follows the same structured process.

## Setup

The repo contains agent configuration for multiple tools:

| Tool | Configuration location | Auto-loaded? |
| --- | --- | --- |
| **OpenCode** | `.opencode/commands/` + `AGENTS.md` | Yes |
| **Claude Code** | `.claude/skills/` + `AGENTS.md` | Yes (skills) |
| **Cursor** | `.cursor/rules/00-core.mdc` + `AGENTS.md` | Yes (rules) |
| **Any tool** | `AGENTS.md` + manual prompts below | Manual |

## Shared workflows

### Planning before implementing (`/plan-detail` or `/plan` or manual)

Use for complex tasks. Generates a detailed implementation plan BEFORE writing code. No code edits.

1. Run `/plan-detail <task>` or `/plan <task>`
2. The planner agent analyzes real code and outputs a markdown plan.
3. Review the plan. Verify file paths, function names, scope.
4. Hand the plan to any developer or weaker model for implementation.

**If your tool has no slash commands**, paste this prompt:

```
Generate an implementation-ready plan for: <task>

Create a plan a junior dev or weak model can execute without guessing. Remove all ambiguity.

Output ONLY markdown. Target 60-100 lines, hard max 120. No chat, no reasoning.

Structure:
- GOAL (1-2 lines)
- SCOPE (IN/OUT)
- REUSE (exact file paths, functions, patterns from codebase)
- HARD RULES (no any, no invented APIs, no hardcoded business facts, minimal diffs)
- STEP-BY-STEP (numbered, each with exact file path and action)
- VALIDATION COMMANDS (exact npm run ... commands)
- ACCEPTANCE (testable criteria)
- EDGE CASES
- FORBIDDEN ACTIONS
- UNKNOWN (missing info)

Rules: reuse existing patterns, no invented APIs, no any, follow i18n, minimal diff.
```

### Starting a feature (`/start-feature` or manual)

1. Read `AGENTS.md` for architecture invariants.
2. Explore only the relevant code areas.
3. Output pattern alignment (max 3 bullets).
4. Output implementation plan (max 5 bullets).
5. Implement with minimal, safe diffs.
6. Validate and output commands to run.

**If your tool has no slash commands**, paste this prompt:

```
Before coding, follow this workflow:

1. Context Discovery: Analyze only the relevant codebase areas. Review AGENTS.md, check package.json commands. Understand existing patterns.

2. Pattern Alignment (max 3 bullets): current pattern, where change fits, critical risks.

3. Plan (max 5 bullets): steps, files, data flow, i18n, tests.

4. Implementation: minimal diffs, reuse helpers, no unrelated changes.

5. Validation: commands to run, manual checks, edge risks.

Rules: no any, no fake data, preserve i18n, avoid regressions.
```

### Reviewing changes (`/review` or manual)

1. Run `git diff` to see current changes.
2. Check against `AGENTS.md` invariants.
3. Run `npm run typecheck && npm run lint && npm test && npm run build`.
4. Output structured review with score, issues, decision.

**If your tool has no slash commands**, paste this prompt:

```
Review current git changes as a strict senior reviewer.

Check against: AGENTS.md, package.json commands, project docs.

Focus on: service patterns, architecture boundaries, i18n, no any, security, minimal diff, no duplication, regression risk.

Output: Summary + score, Blocking issues, Improvements, Suggested tests, Final decision (APPROVE|REQUEST CHANGES|REJECT).
```

## After any code change

Always run:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

For changes touching the reply path, also run:

```bash
npm run validate:skills
npm run simulate -- "Hola, cuanto vale el tour?"
```

## Architecture rules quick card

- Business facts live in `src/data/*.skill.json` — never hardcode in TypeScript
- Use `product-registry.ts` to access product data
- All DB access through `src/db/repositories/`
- DeepSeek is live reply source; deterministic code handles safety/guards
- Never log: `WHATSAPP_ACCESS_TOKEN`, `DEEPSEEK_API_KEY`, `WHATSAPP_APP_SECRET`, `TELEGRAM_BOT_TOKEN`
- Bind Fastify to `127.0.0.1`
- Never use `any`
- One concern per PR

## Full docs

See `docs/bot-architecture.md` for complete architecture guide with diagrams.
