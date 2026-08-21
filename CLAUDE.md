# Andean Scapes WhatsApp Sales Bot

Full architecture rules are in **AGENTS.md**. Follow that file strictly.

## Key commands

```bash
npm run typecheck && npm run lint && npm test && npm run build
npm run validate:skills && npm run validate:prompt
npm run simulate -- "Hola, cuanto vale el tour?"
npm run eval:conversations
# optional live quality (costs tokens):
npm run eval:conversations:llm-bot
```

## Docs map (for AI agents)

| Doc | Use |
|---|---|
| `AGENTS.md` | Invariants, phases, security, Phase 9 follow-up outbound table, eval-scenario authoring rules |
| `docs/bot-architecture.md` | Runtime, webhook, scoring, DB, media paths |
| `docs/skills-architecture.md` | Prompt assembly order, campaign segments, QUOTE LOCK, follow-up boundary, eval harness scope/cost |
| `docs/agent-workflows.md` | How to plan/implement/gate |
| `src/prompts/SKILLS-ASSEMBLY.md` | Prompt assembly rules (not sent to DeepSeek) |
| `src/prompts/LESSONS.md` | Prompt iteration log (not sent to DeepSeek) |
| `docs/meta-template-submission.local.md` | Meta templates: no-date **active**, rest archived |

## Non-negotiables (short)

- Business facts only from skill JSON / dynamic data via `product-registry.ts`
- System prompt only via `skills-prompt-assembly.ts`
- LLM owns reply text; no deterministic sales copy. One budget-gated corrective
  rewrite may fix a missing final question or a missing `[[FOTOS:…]]` marker; the
  engine validates shape and never authors copy
- QUOTE LOCK = authorized group plan total when people + settled plan known
- Photos ship only from a model-emitted `[[FOTOS:<theme>]]` marker; a photo request is
  the photo nouns **or** a visual imperative ("muéstrame", "show me"), and a repeat
  request needs the marker again
- Conversation = natural inbound only; automated outbound = 3 gated paths (post-24h template, consent ask, recurring template)
- Never log WhatsApp/DeepSeek/Telegram secrets; bind Fastify to `127.0.0.1`
- Live eval = 20 scenarios / ~$0.37. Deterministic pack = 31 scenarios. A live-only
  failure is often scenario fidelity, not the prompt
