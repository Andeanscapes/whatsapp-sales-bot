---
name: plan-detail
description: Generate compact implementation-ready plan optimized for junior devs or weak models. Read-only planning, no code edits. Use BEFORE implementation.
---

Generate an implementation-ready markdown plan for the requested feature or task.

## PRIMARY GOAL
Create a plan that a **junior developer or weak model can execute WITHOUT guessing**.
The plan MUST remove ambiguity, avoid interpretation, define exact actions, and prevent hallucination.

## LENGTH BUDGET
- Target 60–100 lines
- Hard max 120 lines
- Never produce more than 120 lines

## OUTPUT RULES
- Output ONLY markdown — no chat, no reasoning, no explanations
- Use short, direct phrases
- Prefer bullets and numbered steps
- No long paragraphs
- No code blocks longer than 8 lines
- Be minimal BUT complete

## CRITICAL PRINCIPLES
- Assume executor has **low reasoning ability**
- If something is not explicit → it will be done wrong
- Do NOT rely on "common sense"
- Do NOT skip steps
- Plan is READ-ONLY — do not edit any files

## REQUIRED STRUCTURE

```
# PLAN: <feature name>

## GOAL
<1–2 lines>

## SCOPE
IN:
- explicit features

OUT:
- excluded items

## REUSE (EXISTING ONLY)
- files involved: <exact paths>
- functions/services: <exact names from codebase>
- patterns: <description>

## HARD RULES (FROM PROJECT)
- reuse existing patterns — no new abstractions
- no invented APIs, fields, or routes
- no fake/mock data outside approved registries
- strict typing — no any
- respect i18n
- minimal diff
- no secret logging

## STEP-BY-STEP
1. file: <exact path> — <action>
...

## VALIDATION COMMANDS
npm run typecheck
npm run lint
npm test
npm run build
<if reply path: npm run simulate -- "...">

## ACCEPTANCE
- user can:
- system returns:
- no type errors
- no test regressions

## EDGE CASES
- empty input:
- invalid input:
- error state:

## FORBIDDEN
- do not create new endpoints unless in scope
- do not duplicate logic
- do not hardcode business facts
- do not invent fields
- do not modify unrelated files
- do not commit unless asked

## UNKNOWN
- missing info that blocks implementation
```

## QUALITY ENFORCEMENT
Reject plan if: vague steps, missing file paths, invented APIs, unclear scope, exceeds 120 lines, contains chat text.

## PROJECT-SPECIFIC RULES (ALWAYS APPLY)
- Read AGENTS.md for architecture invariants
- Business facts live in src/data/*.skill.json — never hardcode
- Use product-registry.ts for product data
- All DB access through src/db/repositories/
- Run: npm run typecheck && npm run lint && npm test && npm run build
- Reply path changes: also npm run simulate -- "Hola, cuanto vale el tour?"
- Never log WHATSAPP_ACCESS_TOKEN, DEEPSEEK_API_KEY, WHATSAPP_APP_SECRET, TELEGRAM_BOT_TOKEN
- Never use any
- Minimal diffs only

## PROCESS
1. Analyze the codebase to find existing services, patterns, files
2. Read AGENTS.md for invariants
3. Fill plan using ONLY real code references
4. Output the completed plan — nothing else
