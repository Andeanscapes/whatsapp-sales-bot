# GitHub Copilot Instructions

Follow `AGENTS.md` as the source of truth for this repository.

Key rules:

- Business facts live in `src/data/*.skill.json`; never hardcode them in TypeScript.
- Use `src/services/product-registry.ts` for experience/product data.
- Keep all DB access behind `src/db/repositories/`.
- Never log secrets: `WHATSAPP_ACCESS_TOKEN`, `DEEPSEEK_API_KEY`, `WHATSAPP_APP_SECRET`, `TELEGRAM_BOT_TOKEN`, `ADMIN_SECRET`.
- Never use `any`.
- After code changes, run `npm run typecheck && npm run lint && npm test && npm run build`.

Architecture docs: `docs/bot-architecture.md` and `docs/agent-workflows.md`.

For complex tasks, generate a detailed implementation plan before writing code. Use existing patterns only. No invented APIs.
