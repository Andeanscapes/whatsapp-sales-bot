---
description: Alias for /plan-detail — generate compact implementation-ready plan for weak/junior executors
agent: plan
subtask: true
---

Generate an implementation-ready markdown plan for: $ARGUMENTS

## PRIMARY GOAL
Create a `.md` plan that a **junior developer or weak model can execute WITHOUT guessing**.
The plan MUST remove ambiguity, avoid interpretation, define exact actions, and prevent hallucination.

## LENGTH BUDGET
- Target 60–100 lines
- Hard max 120 lines
- If exceeding, cut scope notes and collapse similar steps
- Never produce more than 120 lines

## OUTPUT RULES
- Output ONLY markdown — no chat, no reasoning, no explanations
- Use short, direct phrases (caveman style)
- Prefer bullets and numbered steps
- No long paragraphs
- No code blocks longer than 8 lines
- Be minimal BUT complete

## CRITICAL PRINCIPLES
- Assume executor has **low reasoning ability**
- If something is not explicit → it will be done wrong
- Do NOT rely on "common sense"
- Do NOT skip steps
- Do NOT imply behavior → STATE it
- Plan is READ-ONLY — do not edit any files

## REQUIRED STRUCTURE

````md
# PLAN: <feature name>

## GOAL
<1–2 lines, clear outcome>

## SCOPE
IN:
- explicit features included

OUT:
- explicitly excluded items

## REUSE (EXISTING ONLY)
- files involved: <exact paths>
- functions/services to call: <exact names>
- patterns to follow: <description from codebase>

## HARD RULES (FROM PROJECT CONVENTIONS)
- reuse existing patterns — no new abstractions
- no invented APIs, fields, or routes
- no fake or mock data outside approved registries
- strict typing — no `any`
- respect i18n — no hardcoded text unless in fallback JSON
- minimal diff — no unrelated refactors
- no secret logging (WHATSAPP_ACCESS_TOKEN, DEEPSEEK_API_KEY, etc.)

## STEP-BY-STEP IMPLEMENTATION
<numbered steps, each with exact file path and action>
1. create/update file: <exact path> — <what to add/change>
2. import: <exact module paths>
3. call existing service/function: <exact name>
4. validate input: <exact zod schema or method>
5. transform/map: <how>
6. persist/write: <exact repository method>
7. route/register: <if needed, which route or handler>
8. error handling: <which pattern>
9. test: <exact test command and what it must pass>

## VALIDATION COMMANDS
```bash
npm run typecheck
npm run lint
npm test
npm run build
```
<for reply-path changes only: npm run simulate -- "..." >

## ACCEPTANCE CRITERIA (TESTABLE)
- user can: ...
- system returns: ...
- no type errors
- no test regressions
- snapshot unchanged (if simulate needed)

## EDGE CASES
- empty input:
- invalid input:
- error state:
- missing data:

## FORBIDDEN ACTIONS
- do not create new endpoints unless explicitly in scope
- do not duplicate existing logic
- do not hardcode business facts (use skill JSON or approved data)
- do not invent fields
- do not modify unrelated files
- do not commit unless asked

## UNKNOWN (IF ANY)
- list missing info that would block implementation
````

## QUALITY ENFORCEMENT
Reject plan output if:
- vague steps ("handle data", "process response", "call API")
- missing file paths
- missing function/service names
- invented APIs or fields
- unclear scope
- exceeds 120 lines
- contains chat text or explanations outside plan

## STYLE EXAMPLES
GOOD:
- "edit `src/services/response-engine.ts:642` — add guard check before LLM call"
- "call existing `checkBudget(repos, phone)` from `budget-guard.ts`"
- "persist via `repos.conversation.upsert(phone, { new_field: value })`"
- "validate with zod schema `mySchema` defined in same file"
- "test: `npm test -- src/tests/response-engine.test.ts`"

BAD:
- "handle the data"
- "call the API"
- "process the response"
- "add error handling"
- "update the service"

## FINAL CHECK
Before output, ensure:
- a weak model can execute step-by-step without guessing
- no decision is left to interpretation
- all dependencies are explicit
- exact file paths and function names from real codebase
- length under 120 lines

## PROCESS
1. Analyze the codebase to find existing services, components, patterns related to: $ARGUMENTS
2. Read relevant project instruction files (AGENTS.md if present)
3. Fill the plan structure using ONLY real code references (no invented APIs or fields)
4. Output the completed plan — nothing else
