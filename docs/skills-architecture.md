# Skills v2 Architecture — Andean Scapes WhatsApp Bot

Authoritative contract for LLM prompt assembly and reply flow. AI coding agents: read before modifying any file in the reply path.

## Assembly order (system prompt)

```
0. seller-personality.skill.md  → Seller voice, identity, humor, fixed trust vignettes
1. entry-strategy.skill.md       → How to read a campaign segment marker
                                   (MUST precede cold-info-handler)
2. cold-info-handler.skill.md    → First-turn structure for cold "info / precio" leads
3. whatsapp-sales.skill.md       → How to sell (methodology, no product hardcodes)
4. andean-scapes.skill.md        → Brand + catalog protocol + multi-experience rules
5. REFERENT STRATEGIES (JSON)    → Anonymous weighted strategy points from data/skills/referents/
                                   (names/weights are metadata only — never rendered)
6. CATALOGO (rendered)           → Product narratives (site-scoped)
7. DATOS DEL NEGOCIO (rendered)  → Live dynamic data (prices, dates, payment methods, rules)
                                   + ENTRY_SEGMENT <code> for the detected marker only
 8. RUNTIME (per request)         → LO QUE YA SABEMOS, sales phase, selectedExperienceId,
                                   PLAN ACTIVO, ENTRADA/SEGMENT_DETECTED/CONTEXTO PREVIO,
                                   QUOTE LOCK, pain suffix
```

Order is asserted by `skills-prompt-assembly.test.ts`. `cold-info-handler` depends on the
segment contract established by `entry-strategy`; swapping them degrades first contact
without failing any type check.

Implementation: `src/services/skills-prompt-assembly.ts` — sole prompt builder. `buildSystemPrompt` in `deepseek-client.ts` delegates to it. There is **no** separate follow-up prompt builder.

## Conflict resolution

| Topic | Winner |
|---|---|
| Experience/site/plan lifecycle, names, includes, route, safety, difficulty, plan copy, prices, dates, slots, deposit %, payment methods, reservationPolicy | **CDN `bot-dynamic.json`** (authoritative catalog). Local SSoT copies: `scripts/bot-dynamic-dev.json` / `scripts/bot-dynamic.ci.json`. |
| **Plan total for this customer (N people + plan)** | **QUOTE LOCK** in RUNTIME (precomputed). Beats manual arithmetic from individual/couple rows. |
| Brand-only identity (name, intro, social links) | Static `andean-scapes.skill.json` (`experiences: []`) |
| How to sell (tone, rhythm, qualification, closing, brevity, trust detail) | `whatsapp-sales.skill.md` + referent strategies |
| Campaign hook / diagnosis question / plan match and automatic media allowlist per entry marker | **CDN feed** `experiences.*.sites.*.entrySegments.<code>` — copy is rendered as `ENTRY_SEGMENT`; `contextualMediaTypes` narrows reply-matched media at runtime only |
| First-turn structure for a cold lead (3 blocks, ≤400 chars, 1 question) | `cold-info-handler.skill.md` |
| Marker-vs-behaviour conflict (marker is a hint, not a script) | `entry-strategy.skill.md` |
| Early funnel: group → plan choice → price gate | `whatsapp-sales.skill.md` §4/§5/§7: ≥2 plans → must ask plan before quoting |
| Retarget return with qualified history | `whatsapp-sales.skill.md` entrada campaña + `referent.h` — recall group+plan only, then diagnosis; no brochure/price |
| Voice, identity, humor, fixed trust vignettes | `seller-personality.skill.md` |
| Catalog reading rules | `andean-scapes.skill.md` |

## Hard rules (non-negotiable)

1. **LLM owns reply text.** The engine must not rewrite, prepend, append, or gate LLM output with deterministic sales copy.
2. **No pre-LLM sales intercepts.** Only ops/safety guards (opt-out, pause, booked, handoff, rate limits, budget, stale-data, large-group) may block the LLM. The follow-up consent yes/no classifier is bookkeeping, not an intercept: it records the decision and lets the message reach the LLM unchanged (see the whitelist below).
3. **No payment phone/link/instructions in the prompt.** LLM sees only method *names*, deposit %, and confirmation message. Payment detail release is deterministic runtime.
4. **Business facts via registry only.** Access via `product-registry.ts` + `dynamicData`; never hardcode prices, dates, or plan names in TypeScript.
5. **Prompt skills carry no commercial literals.** `npm run validate:prompt` enforces zero prices/phones/experience-ids in skill MD files and referent packs.
6. **Skills JSON is the single source of truth.** Edit `andean-scapes.skill.json` or `dynamic.json` for facts; never the TypeScript prompt builder.
7. **Conversational replies are natural-inbound only.** Automated outbound is limited to the three gated paths in `followup-service.ts` (see AGENTS.md for the switch/timing/consent table):
   - **One-shot post-24h template** and **recurring template** — Meta-approved bodies, no LLM. They do not touch prompt assembly.
   - **Consent ask** — free-form, sent inside the 24h window, and the **only** outbound whose text the model writes. It goes through `assembleSystemPrompt({ proactiveMode: 'consent_ask' })`, so the copy still lives in `whatsapp-sales.skill.md` (§PERMISO-SEGUIMIENTO) and never in TypeScript. The engine may only validate the draft and strip `[[FOLLOWUP_CONSENT]]`; it must never repair, prepend or substitute copy.

   Free-form sales nudges, score-band/date/cold-loop template tracks, and the old multi-track stack stay removed. Never add a fourth outbound path without a fresh design.
8. **QUOTE LOCK for group totals.** When people + settled plan are known, assembly injects the authorized plan total. Skills must copy it; never rebuild totals from unit rates or 3/4-person patterns for 5+.

## Whitelist: legitimate deterministic interceptors

These functions in `response-engine.ts` are allowed to run before or after the LLM call. Everything else was deleted in P3.

### Pre-LLM (block or redirect)
- Opt-out detection → compliance stop
- Bot pause → silence
- Booked lead → silence
- Handoff/bridge → routed reply
- Ad noise → silence
- Past date detection → fixed reply
- Wrong service nature → soft-close
- Organizer contact share → alert
- Large group (>maxGroupSizePerDate) → escalate
- Payment methods question in human_pending mode → public facts reply
- Soft-close message detection → IG soft-close
- Child suitability boundary
- Price-depends-on-group regex
- Rate limits → limit reply or silence
- AI budget exhausted → holding reply
- Stale dynamic data + price/date intent → guard reply
- Follow-up consent yes/no classification (`whatsapp-webhook.route.ts`, only while the
  subscription is `pending`) → records the decision, then lets the message flow to the
  LLM unchanged. It produces no copy; anything ambiguous is left untouched.

### Post-LLM (LLM owns reply text — no copy injection)
The engine sends the LLM's reply **byte-for-byte** after a successful call. All
post-LLM text mutation was removed; that behavior now lives in the skills prompt
(`whatsapp-sales.skill.md` §4b) plus RUNTIME flags. Safety-critical FAQ answers
(`physical_recovery`, `reservation_lead_time`) are rendered into CATALOGO as
`SAFETY_FAQ` so the model answers them from validated copy rather than the engine
swapping its output.

The only post-LLM actions are:

| Situation | Outcome |
|---|---|
| Empty reply | Deterministic fallback (`llmFailureWarm` / `aiFailureQualified`) |
| `hardSafetyFail` → `prompt_leak`, `payment_detail_leak` | **Suppress** (`shouldSendReply: false`) + owner alert. No substitute — echo risk. |
| `hardSafetyFail` → `false_reservation_claim`, `template_token_leak`, `internal_sentinel_leak` | Non-echoing `aiFailureQualified` + owner alert. Customer is not left silent. |
| `hardSafetyFail` → `price_without_pricing` | Curated `priceUnavailable` + alert (CDN-outage path too; static skill has no prices). |
| Soft unsafe phrasing only (`containsUnsafeReservationClaim` without hard fail) | Reply **kept**; **automatic** media suppressed + logged. Explicitly requested photos still ship. Covers FP on "te confirmo disponibilidad". |
| Truncation | Log only; never edits the reply. |
| Valid `[[FOTOS:<theme>]]` marker | Strip the internal marker and send gallery media selected from the validated product registry; the last successfully claimed photo carries the unchanged reply as its caption so the question renders under the images. Explicitly requested photos are **not** suppressed by the handoff / soft-unsafe guards — those cover unsolicited media only. Images off or a bridge takeover strips the marker and sends the text unchanged. `media_marker_unhonoured` is reserved for a marker with no reply text left or no resolvable photos; malformed syntax surviving the strip fails as `media_marker_malformed`. **`hardSafetyFail` is evaluated first and always outranks both marker reasons** — a marker problem must never downgrade an echo-risk leak from suppression to a fallback send. |
| `diagnosticMediaReply` | Log-only after the single bounded correction opportunity. Photos shipping → flags 0 or 2+ questions, URLs, per-image enumeration (the question is the model's job; the engine never appends one). No photos shipping → flags a reply that promises photos anyway. Active replies missing their mandatory final question and explicit photo requests missing a marker share at most one budget-gated LLM rewrite. Persistent question misses are sent unchanged and logged; persistent media misses also alert the owner. |
| Ops state | `price_given_at`, `human_pending`, phase progression, media flags — state writes only. |

Payment leak detector covers COL mobiles (`3xx`), pay hosts (`mpago.la`, Mercado Pago, `wa.me`, bit.ly), transfer language, and "te paso/envío datos|link|número".

`hardSafetyFail()` is exported from `response-engine.ts` and unit-tested; add new
suppression rules there rather than inline in `processMessageCore`.

## Source files

| File | Role |
|---|---|
| `src/prompts/seller-personality.skill.md` | Seller voice, identity, humor, compact emoji rules (allowlist + bans), trust vignettes. |
| `src/prompts/entry-strategy.skill.md` | How to consume `ENTRY_SEGMENT` / `SEGMENT_DETECTED`. No segment copy of its own. |
| `src/prompts/cold-info-handler.skill.md` | First-turn structure only (3 blocks, ≤400 chars, 1 question). No hooks, dates, or prices. |
| `src/prompts/whatsapp-sales.skill.md` | Sales methodology. Never contains prices, dates, plan names, or referent names. |
| `src/prompts/andean-scapes.skill.md` | Brand + catalog protocol. Multi-experience. Never contains prices. |
| `src/prompts/dynamic-context.template.md` | `{{CATALOG}}` / `{{BUSINESS_DATA}}` template. Stripped before sending. |
| `src/prompts/SKILLS-ASSEMBLY.md` | Assembly rules for coding agents. NOT sent to DeepSeek. |
| `src/services/skills-prompt-assembly.ts` | `renderCatalog()`, `renderBusinessData()`, `assembleSystemPrompt()`. |
| `src/services/sales-composition.ts` | Loads weighted JSON referent packs and renders anonymous strategy guidance. |
| `src/services/deepseek-client.ts` | `buildSystemPrompt()` delegates to assembly. |
| `src/services/response-engine.ts` | `processMessage()` — guards → state → LLM → safety post-processing. |
| `src/services/skill-loader.ts` | Loads + validates JSON skills. Merges dynamic into static. |
| `src/data/andean-scapes.skill.json` | Brand-only facts (`experiences: []`). Product catalog lives in dynamic JSON. |
| `src/data/sales-strategy.skill.json` | Scoring signals, sales tactics, alert templates. |
| `src/data/skills/profile.andean-scapes-co.json` | Profile version, referent weights, prompt budget. |
| `src/data/skills/referents/*.json` | One validated referent pack per file; anonymous ids + role labels only. `referent.h` = retarget rhythm. |
| `referentAttribution` in remote dynamic JSON | Remote `packId → sourceLabel` metadata. Validated and retained for ops only; never loaded into prompt. |
| `src/data/fallback-replies.json` | Guard/fallback replies in es + en. |
| `src/prompts/LESSONS.md` | Append-only prompt iteration log. **Not** sent to DeepSeek. |
| `DYNAMIC_SKILL_URL` env var | Live pricing, availability, payment, and referent attribution metadata from CDN. |

### Referent identity layers (public repo + future skill platform)

Keep three layers separate:

1. **Pack content (public, prompt-safe):** `referent.a`… strategy text only. `displayName` is a role label (`Cold open`), never a person.
2. **Profile mix (public, prompt-safe):** weights / entry mixes by `packId`.
3. **Attribution (metadata, never prompt):** `referentAttribution` in remote dynamic JSON maps `packId → sourceLabel`.
   It is validated and retained for future ops/admin reporting, but deliberately excluded from DATOS and prompt assembly.
   Future multi-tenant platform can move this block to an authenticated admin store without changing pack ids.

## How to add a new experience

1. Add full entry under `experiences.<id>` in CDN `bot-dynamic.json` (narrative, sites, plans, prices, availability, media).
2. Mirror into `scripts/bot-dynamic-dev.json` / update `scripts/bot-dynamic.ci.json` for CI.
3. Do NOT put product facts in `andean-scapes.skill.json` (brand-only).
4. Do NOT edit any skill MD file — all five are experience-agnostic and gated by `npm run validate:prompt`.
5. Run `npm run validate:dynamic -- <file>` + acceptance tests with the new experience id.

## How to add or retune a campaign segment

1. Add/edit `experiences.<id>.sites.<siteId>.entrySegments.<CODE>` in the CDN feed
   (`label`, `description`, `valueHook`, `diagnosisQuestion`, `planMatch`, optional
   `contextualMediaTypes`). Every contextual type must exist in the site's
   `media.types`, have at least one `media.typeKeywords` entry, and have at least
   one typed gallery image.
2. Mirror into `scripts/bot-dynamic-dev.json` and `scripts/bot-dynamic.ci.json`.
3. Nothing else. The code is generic: `parseEntryMarker` accepts `^[CHR]\d{2}`, the
   marker is persisted on `conversations.entry_marker`, and `renderBusinessData` emits
   the matching block. Adding `C05` requires **no** code or prompt change.
4. `description` is internal targeting metadata and is never rendered — safe for notes.
5. Retiring a segment: delete the key. Leads already tagged with it fall back to the
   generic first-contact path (no `SEGMENT_DETECTED` is emitted).

## Prompt size budget

The assembled system prompt is sent on **every** turn, plus recent history and the latest inbound,
so skill and JSON-pack growth is a recurring per-message cost. `DeepSeekLlmClient` keeps the newest
complete history messages within both `DEEPSEEK_HISTORY_MAX_CHARS` and the configured model context
window; it never slices a message. `npm run measure:prompt` reserves history, current-message, and
output tokens and fails if their projected sum exceeds `DEEPSEEK_CONTEXT_WINDOW_TOKENS`
(~3 chars/token, calibrated against DeepSeek). Largest contributors: `whatsapp-sales.skill.md`,
referent packs, CATALOGO/`SAFETY_FAQ`, personality. `SAFETY_FAQ` + personality (incl. compact emoji
rules) ground health/booking answers and voice in the prompt instead of rewriting model output.
Before adding a section, rewrite an existing one first. Gate fails when the system-prompt ceiling or
projected model context is exceeded. `finish_reason=length` is rejected and retried/fallbacked instead
of sending partial WhatsApp copy. Model token prices come from `DEEPSEEK_*_COST_PER_MILLION_USD` so
the SQLite usage ledger and dollar guards can be updated without code changes.
`LESSONS.md` is never injected.

**Emoji:** `seller-personality` §EMOJIS — optional and semantic, with sets for warmth,
nature, family, safety, and topic-scoped themes. Never use one as punctuation or repeat
the same default across turns; omit it when none fits. Hard ban next to price/payment and hype.
Log-only `logEmojiStyle` on count>1 or price/payment context. Never edits LLM text.

**Known exception (single-tenant):** thematic glyphs (💎⛏️🐝🍯🐄…) are product-flavored for the
current mining/farm experience. They are **not** experience-agnostic. When a second experience
ships without those motifs, move them to dynamic/catalog media captions or per-experience voice
overlay — do not grow more product nouns into the shared personality skill.

## Eval harness

The conversation eval suite contains 31 golden scenarios grounded in the full
conversation export. Deterministic runs validate state, flags, pricing math,
known-field continuity, safety boundaries, and leak suppression without provider
cost. Twenty scenarios are tagged `live` and carry `minLiveScore` plus
copy-quality criteria for bounded real-LLM runs.

| Command | Scope | Approx cost |
|---|---|---|
| `npm run eval:conversations` | all 31, deterministic | $0 |
| `npm run eval:conversations:llm-bot` | 20 `live`-tagged only | ~$0.37 |
| `npm run eval:conversations:llm-bot -- --all` | all 31 message scenarios | ~$0.55 |
| `npm run eval:conversations:llm-bot -- --scenario <id>` | one scenario | ~$0.02 |

Costs scale with `liveRuns`: variance hotspots run 2–5 times and `aggregateRuns`
keeps the worst run, so `0/2 passed` means both runs failed while the report shows
only one representative transcript.

Only `live`-tagged scenarios are sent by default (`partitionLiveScenarios`); `--all`
or an explicit `--scenario` overrides that. `EVAL_MAX_COST_USD` (default `0.50`)
aborts a runaway pass — raise it before running `--all`. Do not treat deterministic
mock replies as proof of LLM copy quality: mock replies are authored to satisfy the
criteria, so copy criteria only bite in live mode. Conversely, a `live`-only failure
is often scenario fidelity (feed-dependent counts, seeded state with no visible
history) rather than a prompt defect — see AGENTS.md "Writing conversation-eval
scenarios" before changing any prompt.

## Validation commands

```bash
npm run typecheck && npm run lint && npm test && npm run build
npm run validate:skills      # JSON skill files
npm run validate:prompt      # Business-literal guard on skill MD files + referent packs
npm run eval:conversations   # Harness + compliance canary
npm run measure:prompt       # Deterministic prompt-size gate using the CI fixture
npm run report:iteration -- <day-summary.json>
```
