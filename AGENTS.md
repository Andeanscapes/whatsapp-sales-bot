# Andean Scapes WhatsApp Sales Bot — Agent Instructions

## Repo

- Remote: `git@github.com:andeanscapes01/whatsapp-sales-bot.git`
- Branch: `main` (no `origin/main` yet — first push creates it)
- Token/prod env file: `/etc/andean-whatsapp-bot.env` (never commit)
- SQLite runtime path: `/var/lib/andean-whatsapp-bot/bot.sqlite`

## Architecture

```
Mini PC (Fedora 44) → Node 24 + Fastify → Cloudflare Tunnel → WhatsApp Cloud API
                     ↓
         Repositories (SQLite via better-sqlite3)
                     ↓
           JSON skill files (business source of truth)
                     ↓
           Product Registry (typed access to experiences/plans)
```

### Architecture Invariants (do NOT violate)

1. **Single source of truth:** CDN `bot-dynamic.json` (local: `scripts/bot-dynamic-dev.json`, CI: `scripts/bot-dynamic.ci.json`) is the sole source of product catalog facts (experiences, sites, plans, pricing, route, availability, FAQs) **and of campaign segment copy** (`sites.*.entrySegments`: `valueHook`, `diagnosisQuestion`, `planMatch`). `andean-scapes.skill.json` is brand-only (`experiences: []`). Never hardcode business reply text in TypeScript or in a skill MD file.
2. **Product registry:** Always access experience data via `src/services/product-registry.ts`. Never access `skills.andeanScapes.experiences[0]` directly.
3. **Repository seam:** All database access goes through `src/db/repositories/` interfaces. Never write raw `db.prepare(...)` SQL in service or route files.
4. **No MySQL:** The bot uses SQLite via `better-sqlite3`. There is no MySQL/Postgres dependency. A future DB swap requires writing a new repository implementation.
5. **Fully typed skills:** Skill JSON is validated with strict zod schemas (no `.passthrough()`). The compiler enforces the contract between JSON and code.

### Skills v2 Architecture Invariants (do NOT violate)

6. **Prompt skills = how-to-sell source:** `seller-personality.skill.md`, `entry-strategy.skill.md`, `cold-info-handler.skill.md`, `whatsapp-sales.skill.md`, `andean-scapes.skill.md`, and the validated anonymous packs in `src/data/skills/referents/` define sales methodology and catalog protocol. They contain NO prices, dates, plan names, durations, destinations, percentages, payment method names, phone numbers, or referent attribution metadata. `npm run validate:prompt` enforces this.
7. **Assembly is the only prompt builder:** `skills-prompt-assembly.ts` is the sole source of the system prompt. Never bypass it. Block order is fixed and asserted by tests: personality → entry-strategy → cold-info-handler → whatsapp-sales → andean-scapes → referent strategies → CATALOGO/DATOS → RUNTIME. `entry-strategy` must precede `cold-info-handler`.
8. **LLM owns reply text:** The engine must not rewrite, prepend, append, or gate LLM output with deterministic sales copy. Only ops/safety guards (opt-out, pause, booked, handoff, rate limits, budget, stale-data, large-group, follow-up consent yes/no bookkeeping) may intercept pre-LLM. Only leak/strip guards may run post-LLM. The follow-up consent classifier records state and then lets the message reach the LLM unchanged; it never produces copy.
   One budget-gated corrective LLM rewrite may run on an active inbound turn when
   the model omits the mandatory final question. The engine supplies no customer
   copy; it validates shape, retries at most once, then sends the model output unchanged.
9. **No deterministic sales copy:** Pre-LLM intercepts that generate brochure dumps, plan lists, price teasers, quote templates, partner-consult summaries, form CTAs, or close templates are forbidden. If you need a new one, you're doing it wrong — the skill MD files should handle it.
10. **Automated outbound is limited to three explicitly-gated paths, all in `followup-service.ts`.** Conversational replies remain natural-inbound only. Never add a fourth without a fresh design.

    | Path | Switch | Timing | Channel | Consent |
    |---|---|---|---|---|
    | One-shot post-24h template | `ALLOW_FOLLOWUP_TEMPLATE` | `FOLLOWUP_HOURS_AFTER_INBOUND` | approved template | operator `/followupgrant` **OR** customer said yes |
    | Consent ask | `FOLLOWUP_CONSENT_ASK_ENABLED` | `FOLLOWUP_CONSENT_HOURS_AFTER_INBOUND` (max 23) | free-form, LLM-written | none needed (inside window) |
    | Recurring template | `FOLLOWUP_RECURRING_ENABLED` | production gaps multiply by 3 from `FOLLOWUP_RECURRING_INTERVAL_MONTHS` (1×, 3×, 9×…); dev uses fixed `FOLLOWUP_DEV_RECURRING_SECONDS`; capped by `FOLLOWUP_MAX_RECURRING_SENDS` | approved template | customer said yes |

    The three switches are **independent**. Never alias them: each authorises a
    different outbound. Dev overrides (`FOLLOWUP_DEV_*`) fail startup in production.

    Consent lifecycle lives in `followup_subscriptions`
    (`unasked → pending → active | declined`, any state `→ revoked`); per-stage
    dispatch in `followup_subscription_events`.

    **Permission is one predicate over two provenances.** The one-shot template needs
    an operator grant (`followup_consent`, written only by `/followupgrant`) **OR** an
    `active` customer subscription. `listFollowupCandidates` and the post-claim
    re-check must read the SAME predicate — before this, the one-shot INNER JOINed
    `followup_consent`, so a customer "sí" unlocked the recurring cadence but never
    the 7-day template, and with no operator grant in production the path was
    unreachable for its entire life. Do not duplicate consent into both tables:
    provenance must stay legible in `/followupstatus`.

    **A `declined` subscription outranks BOTH provenances.** An operator grant is a
    presumption of consent; a customer "no" is the answer to the question we asked.
    `decline()` writes only `followup_subscriptions` and deliberately does not revoke
    the operator row (provenance must survive), so the OR predicate on its own
    re-enabled every declined lead that still carried an older `/followupgrant` and
    shipped a marketing template **after a recorded refusal**. Three places must agree
    and are asserted: the SQL clause (`COALESCE(fs.status,'') <> 'declined'`),
    `hasFollowupPermission`, and `/followupstatus` — which must call the predicate
    rather than re-deriving the OR, or the diagnostic contradicts the sender. Do not
    "fix" this by revoking the operator grant on decline: that erases who authorised
    what. `/followupgrant` refuses on a `declined` subscription instead of writing a
    grant the predicate would ignore. The pre-existing declined/revoked test passed
    throughout because it seeded **no** operator grant — the regression test must seed
    both.

    **The consent classifier's contact continuation is vetoed by a commercial object.**
    `CONSENT_CONTACT_CONTINUATION` matches `mand|envi` unanchored, which also matches
    the *sales* senses of mandar/enviar: "si quiero enviar el anticipo", "dale mandame
    la cuenta para pagar" and "si me mandas la cotizacion" all recorded durable
    marketing consent from a payment message. Worse, a consent-answer turn freezes
    `lead_score` and clears `isHot`, so the highest-intent turn in the funnel also
    produced **no owner alert**. `COMMERCIAL_OBJECT_VETO` keys on the object (pago,
    anticipo, cotizacion, reserva, comprobante…), not the verb, so the legitimate
    channel-naming forms ("mandame las promos", "mandame mensajes", "avisame") stay
    affirms. Never widen the continuation verbs without extending the veto.

    **Every permission change appends to `followup_consent_grants`** (append-only:
    `affirm`/`decline`/`grant`/`revoke` × `customer_reply`/`operator_grant`/
    `operator_revoke`/`customer_opt_out`). The live row is mutable and was previously
    wiped on the next inbound, which is why "when was permission granted?" is
    unanswerable for pre-ledger leads. Readers must NOT infer "no permission" from an
    empty history — rows before 2026-09-03 simply do not exist.
    All **five** writers append: webhook affirm/decline, `/followupgrant`,
    `/followuprevoke`, `/block`, and the first customer opt-out. `/block` was the one
    that did not, so the single action meant to be permanent was also the only one
    with no provenance. `followup-consent-ledger.test.ts` asserts the callers, not the
    repository — testing `record()` directly proved the table worked and nothing about
    whether anything used it. An ambiguous reply is not a decision and must never
    appear. Customer decisions store the consent `cycle_key`; operator actions store
    the concrete `telegram:<chatId>` actor. Append-only means ordinary operation — the
    explicit customer-data deletion path must erase these PII-bearing rows. Rules:
    - **Silence is not consent.** An unanswered ask stays `pending` and never
      receives a recurring send. If the customer keeps talking instead of answering,
      the pending ask may be deferred to `unasked` exactly once per consent session;
      after the continued conversation goes silent, one final ask (`c2`) is allowed.
      Ambiguity after that leaves `c2` pending forever.
      The deferral must NOT require sales content: `scoreMessage` returns zero
      signals for a bare answer to our own question ("juan", "2 personas", "ok"),
      and gating on sales keywords left those subscriptions `pending` forever — no
      `c2`, no recurring template, follow-up silently dead. Any substantive inbound
      re-arms the ask; only an explicit farewell, a soft close and a job enquiry
      are excluded (`isConsentAskContinuation`).
      If the customer opts out, then later initiates a new conversation,
      `customer_opt_out` may reopen to `unasked`; a fresh silence may produce a new
      ask (`c2`, `c3`…). Operator revocations never reopen automatically.
    - **Consent is durable until explicitly ended** (changed 2026-09-03; was
      session-scoped). An `active` subscription survives ordinary conversation
      turns. It ends ONLY on an explicit decline, a customer opt-out, or an operator
      `/followuprevoke`. `closeCycleOnCustomerInbound()` is **deleted** — do not
      reintroduce it.
      Session-scoping was removed because it destroyed the permission it was
      protecting: `activated_at` was NULLed on the next inbound, so **7 of 10** real
      production affirmations lost consent before any template could become due, and
      those leads were then asked for permission a second time. The rule also made
      the 1-month recurring cadence unreachable in principle — a lead had to say yes
      and then never speak again for a month.
      What replaces it: a template still cannot interrupt a live chat, because the
      **dormancy floor is independent of consent** (next bullet). Permission
      authorises writing later; dormancy decides when.
      Consequence to keep in mind: a consent cycle now lives until revoked, so
      `FOLLOWUP_MAX_RECURRING_SENDS` (scoped by `activated_at`) is a **per-consent**
      cap, no longer a per-conversation one. Reducing total sends means lowering that
      cap or lengthening the cadence, not relying on chat activity to reset it.
    - A recurring template only goes to a **dormant** customer: the last message in
      the thread must be ours **and** the customer must have been silent for
      `FOLLOWUP_RECURRING_MIN_SILENCE_HOURS`, re-checked after the claim. That floor
      is deliberately **independent of the cadence interval**: coupling them lets a
      short (or dev-accelerated) cadence interleave templates with a live
      conversation. Consent authorises writing later, never interrupting a chat.
    - The consent ask is scheduled from the **customer's last inbound**, because
      Meta measures the 24h free-form window from their message, not ours. Anchoring
      on our outbound can push the send outside the window.
    - The LLM writes the ask (`whatsapp-sales.skill.md` §PERMISO-SEGUIMIENTO) and the
      acceptance acknowledgment (§PERMISO-CONCEDIDO). The engine may only validate
      and strip `[[FOLLOWUP_CONSENT]]`, never repair or substitute copy.
    - **`[[FOLLOWUP_CONSENT]]` stays the contract, with one bounded fallback.** A
      markerless draft is accepted only when its own **question sentence** contains
      both a permission frame ("¿puedo…", "te parece…", "can i…") and a
      future-contact object ("escribirte", "avisarte", "message you", "send you").
      Both signals must sit in the question, not anywhere in the draft: a
      whole-draft keyword match accepted "Te escribo el itinerario mañana,
      ¿cuántos van a viajar?" as a permission ask, which would have burned the one
      free-form message the 24h window allows and let a bare "sí" to that *sales*
      question activate marketing consent. The matcher is deliberately unanchored
      (WhatsApp drafts drop the opening `¿`) and offer frames ("¿te interesa…",
      "would you like…") are excluded because they introduce a product, not a
      request to write later. A draft still carrying any other `[[…]]` marker is
      rejected (`residual_marker`) — only the consent marker is ever stripped.
    - **An exhausted consent cycle is recovered by an operator, never automatically.**
      Three failed attempts leave the cycle permanently unclaimable, so the lead is
      unreachable until a new session mints a fresh `cycle_key`. `/followupretry`
      resets attempts for a `status = 'failed'` cycle only: `accepted`, `delivered`
      and `uncertain` all mean Meta may hold the message, so replaying them could
      double-send. An automatic reset is forbidden — a persistently malformed draft
      would loop on the provider's bill forever.
    - A yes/no is classified **only** while status is `pending`; anything ambiguous
      flows through the normal sales path untouched. `consentAcceptedThisTurn` tells
      the model the "sí" is permission, not a booking confirmation.
    - **A bare leading "no" is not a refusal.** "no tengo fecha", "no todavía",
      "no sé aún" and "no entendí tu pregunta" are sales answers whose first token
      happens to be a negation; classifying them as `decline` recorded a refusal the
      customer never gave, and `declined` never auto-reopens, so the lead could
      never be asked again. Refusals are matched as explicit phrases
      (`DECLINE_ANYWHERE`, e.g. "no quiero", "no me escribas") wherever they appear,
      which still makes "sí, pero no quiero mensajes" a decline. Never restore a
      blanket `\bno\b` negation test.
    - **A permission answer is not buying behaviour.** On a consent-answer turn
      (`consentAnswerTurn`: the webhook classified yes/no, or the subscription is
      `pending` and the message is a bare yes/no) the engine freezes `lead_score`,
      clears `isHot`, skips `setLeadIntent`, and blocks close/bridge inference. The
      lead analyzer reports `ready_to_book`/`strong` for a bare "Ok", which used to
      push the score to 100 and page the operator; a "No" to the same question used
      to be scored as a sales objection. Real interest still scores normally on the
      next turn — e.g. when the customer answers a template asking about dates —
      because a message with sales content classifies as `ambiguous`.
      **A leading affirmative does not make the rest of the message disappear.** Both
      the one- and two-word affirmative prefixes must validate the remainder against
      `CONSENT_CONTINUATION`. The two-word prefix used to short-circuit to `affirm`,
      routing around that check: "si claro un ritmo tranquilo" and "de acuerdo para
      diciembre" recorded consent from a plain sales answer, and the same shortcut
      froze the lead score on a booking reply ("si quiero reservar para el 14"),
      which is now `ambiguous` and takes the normal sales path. A real yes must ask
      what is coming ("si cuales?") or name the contact being authorised ("si claro
      escribeme"). Bare-emoji assent is `👍 👌 ✅` only: 🙏, 💪, 👏 and ❤️ are
      reactions, not permission to market.
    - Consent-ask `cycle_key` is a session sequence (`c1`, `c2`…); recurring
      `cycle_key` is consent-scoped (`c1-r1`, `c2-r1`…), never `YYYY-MM` — a
      calendar key silently caps sends at one per month.
    - Opt-out revokes the subscription **and** the operator grant
      (`followup_consent`) in the same transaction as `opt_out_at`, and records
      `last_opt_out_at`, which is never cleared — it is the compliance evidence.
      Reopening clears only the active `opt_out_at` flag.
    - An opted-out customer receives **no** bot reply. The single exception is a
      customer returning after **their own** stop request (`revoke_source =
      'customer_opt_out'`); operator `/block` and any unattributable opt-out stay
      silent forever.
    - **An operator revocation is immutable except by another operator action.**
      `revoke()` preserves an existing `operator` provenance, and an operator-blocked
      customer stays silent even when they send a stop phrase. Both are required:
      without them a blocked customer could unblock themselves by sending "no me
      escribas mas" (downgrading the source to `customer_opt_out`) and then writing
      again to trigger the reopen path.

    Free-form nudges, the old multi-track/cold-loop template stack, and any
    deterministic sales copy in these paths stay removed.

    `followup-digest.ts` is **not** a fourth path. It reads state and reports to the
    owner's Telegram chat on its own wall-clock interval; it never calls the Graph
    API. It reuses the three candidate queries (pure reads) plus the sender's timing
    functions rather than re-implementing the gates, omits a consent ask whose 24h
    window already shut, derives "answered" from `getLastInboundAt` because no table
    records it, and claims its once-per-day slot in `bot_config` before sending.

11. **Photos are model-requested and model-captioned.** The only way a customer
    receives gallery photos is the LLM emitting `[[FOTOS:<theme>]]`; the engine
    strips the marker, resolves the theme through `product-registry.ts`, and sends.
    The deterministic gallery path (`galleryIntro` / `galleryFollowUp` copy and the
    `gallery_nudged_at` nudge) was deleted for violating invariant 9 — do not
    reintroduce bot-authored copy around media. Rules:
    - **Ops state cancels the photos, never the reply.** Images off or a bridge
      takeover strips the marker and sends the model's text verbatim. Failing the
      turn there would make `SEND_IMAGES_ENABLED` a silent reply-suppression switch.
      `media_marker_unhonoured` is only for a marker with no text left or no
      resolvable photos.
    - **`hardSafetyFail` is evaluated first and outranks every marker reason.** A
      marker problem must never downgrade an echo-risk leak (`prompt_leak`,
      `payment_detail_leak`) from suppression to a curated fallback send.
    - **Any new media guard must run before the unhonoured check**, or explicitly
      mark the marker unhonoured. A guard that empties the delivery list afterwards
      makes the bot promise photos and ship none, silently — this shipped once.
    - **Explicitly requested photos are exempt from the handoff / soft-unsafe
      suppressions.** Those guards target unsolicited sales media. The automatic
      contextual image keeps them.
    - **The last successfully claimed photo captions the reply.** Not the last array
      element: if that claim is refused the caption is lost and the reply falls back
      to a trailing text, which WhatsApp can deliver *above* the photos.
    - The engine may only strip the marker and log. It never adds a marker, invents
      photos, appends the question, or edits the copy — `diagnosticMediaReply` is
      log-only by design. Reply shape is owned by `whatsapp-sales.skill.md` §GALERIA,
      where a photo request is a **modifier on the active turn, not a phase**.
    - The model emits one proactive gallery on the first concrete plan selection,
      using only a clearly matching RUNTIME theme. It never repeats that gallery on
      later confirmations. This remains an inbound reply path, not automated outbound.
    - If an inbound explicitly requests photos and the model omits the marker, the
      engine may use the same single budget-gated corrective LLM call with a
      RUNTIME instruction. It must never add the marker, rewrite the reply, or retry
      more than once; a persistent miss is log/owner-alert only.
    - **A photo request is not only the word "foto".** `isGalleryRequest` also matches
      visual imperatives ("muéstrame", "enséñame", "show me"), because "muéstrame el
      hospedaje" is a request that used to get no theme cue and no corrective retry.
      Widening is safe only because every consumer is additionally gated by theme
      resolution: a visual verb aimed at something with no gallery type yields zero
      themes and changes nothing.
    - **A repeat request is a full request.** "otra vez", "de nuevo", "las de antes"
      require the marker again; resending the same theme is allowed. The promise
      detector therefore also matches the proclitic form ("te las mando de nuevo"),
      where the pronoun precedes the verb and the noun is elided — that shape
      promised a resend and shipped nothing without tripping any guard.

12. **Two media ledgers, never merged.** `media_sends` is the rate-limit ledger
    (claim/release, 72h budget, derived id only — never a url). `outbound_media` is
    the operator-replay ledger (url, exact caption, theme, `carried_reply`), written
    by `recordOutboundMedia()` at the seven delivery sites after a send succeeds or
    is uncertain. Rules:
    - **A ledger write must never break delivery.** Every call is wrapped; a failure
      is logged and the row is lost. Nothing on the reply path reads `outbound_media`,
      so it cannot influence what a customer receives.
    - **Record only what actually shipped.** No row when the send failed — otherwise a
      replay shows the operator a photo the customer never saw.
    - **`carried_reply = 1`** identifies the photo whose caption is the reply, matched
      back to the text row by exact string equality. Do not approximate this with
      timestamps.
    - **Inbound photos live on `messages.media_id`**, not in `outbound_media`. The bot
      path persists non-text inbound, which advances `getLastInboundAt` on purpose
      (Meta measures the 24h window from any customer message). This can only move
      follow-ups later and can only suppress a recurring template, never trigger one.
    - **Operator replay is Telegram-only and read-only.** It never re-sends to the
      customer and adds no copy: bot photos carry the caption already recorded, and
      pre-ledger turns render a bare glyph rather than inventing an explanation.
    - Telegram delivery hands a url to Telegram **exactly once** per photo before
      falling back to a byte upload — `sendPhoto` can time out on a send Telegram
      accepted, and retrying the url double-posts. Server-side fetches are pinned to
      `CDN_MEDIA_HOST`.
    - A Telegram **album carries at most one caption**. Telegram renders a group
      caption only when a single item has one and shows none when several do, so
      batching two reply-carrying photos hid both bot texts in the replay. A
      captioned photo therefore closes the album run in `planSendUnits`; the
      carrier is the last photo of its turn, so a gallery still ships as one call.

13. **A command name must be dispatchable, and unparsed `/` text must never reach the
    customer.** `parseCommand` accepts `[a-zA-Z0-9_]+` only, so a hyphenated name
    (`/followup-grant`) never matched, fell through to the bridge plain-text relay and
    **sent the literal text — including another lead's phone — to the customer**. Two
    rules, both enforced by tests in `telegram-auth.test.ts`: every registered name must
    satisfy `parseCommand`, and any text starting with `/` that fails to parse is answered
    with "Comando no reconocido" instead of being relayed. Never register a name with a
    character the parser rejects; widening the parser is not a substitute for the relay
    guard.

### Multi-Agent Guardrails

- One phase per PR. Never combine phases.
- Run `npm run typecheck && npm run lint && npm test && npm run build` after each change. Stop on red.
- The existing tests in `src/tests/` are the regression safety net. Never weaken them.
- Simulate snapshot at `npm run simulate -- "Hola, cuanto vale el tour?"` must produce identical output unless explicitly noted.
- Never use `any`. Never weaken existing zod/HMAC/pino-redact configs.
- Never log `WHATSAPP_ACCESS_TOKEN`, `DEEPSEEK_API_KEY`, `ADMIN_SECRET`, `WHATSAPP_APP_SECRET`, or `TELEGRAM_BOT_TOKEN`.
- Bind Fastify to `127.0.0.1` only. No external port binding.

## Implementation phases (do in order)

### Phase 1 — Local skeleton

1. Init a Node 24 + TypeScript project in this directory (NOT in a subdirectory).
2. `package.json`: type `module`, scripts (`build`, `start`, `dev`, `typecheck`, `lint`, `test`, `simulate`), deps: `fastify`, `better-sqlite3`, `zod`, `pino`, `dotenv`.
3. `tsconfig.json`: strict, `target=ES2024`, `module=NodeNext`, `outDir=dist`, `rootDir=src`. Vitest/esbuild transform overrides to ES2022 only (Vitest 2 does not recognize ES2024 yet); production `tsc` still emits ES2024.
4. `src/config/env.ts`: zod schema for ALL env vars from the plan (sections 9, 6.3). Export typed `env` object loaded at startup.
5. `src/server.ts`: create Fastify, register pino, register health route, start on `127.0.0.1:PORT`.
6. `src/routes/health.route.ts`: `GET /health` returns `{ok: true, uptime: process.uptime()}`.
7. `src/db/schema.sql`: all tables from section 13 (conversations, messages, processed_webhook_messages, ai_cache, ai_usage, owner_alerts, media_sends).
8. `src/db/migrate.ts`: read `schema.sql`, create SQLite DB at `SQLITE_PATH` env using `better-sqlite3`, run the DDL.
9. Call `migrate()` at server startup before `fastify.listen()`.
10. `.env.example`: exact copy of section 9 env vars.
11. `npm run build` works; `npm start` boots Fastify and `/health` returns ok.

### Phase 2 — Skill files + validation

1. Create `src/data/andean-scapes.skill.json` — exact copy from section 10.
2. Create `src/data/sales-strategy.skill.json` — exact copy from section 11.
3. Create `src/data/media.skill.json` — exact copy from section 12.
4. Create `src/data/fallback-replies.json`:
   ```json
   {
     "es": {
       "optOutConfirmation": "Entendido. No enviaremos mas mensajes automaticos. Si necesitas ayuda mas adelante, puedes escribirnos de nuevo."
     },
     "en": {
       "optOutConfirmation": "Understood. We won't send more automated messages. If you need help later, you can message us again."
     }
   }
   ```
5. Create `src/services/skill-loader.ts`: reads all JSON skill files at startup, validates with zod schemas, exports typed objects. Crash startup if any file fails validation.
6. `src/scripts/validate-skill.ts`: CLI script that runs skill-loader only (no server). Used to validate skill files in CI.

### Phase 3 — Deterministic bot (no AI, no WhatsApp)

> **Note:** All customer replies come from DeepSeek via skills v2 assembly. No deterministic FAQ path.

1. `src/services/lead-scoring.ts`: match against signals/negativeSignals from sales-strategy.
2. `src/services/response-engine.ts`: orchestrates flow (opt-out → store → language → scoring → limits → budget → DeepSeek → reply → alert). DeepSeek is the sole reply source.
3. `src/services/opt-out-service.ts`: check/set opt_out_at in SQLite.
4. `src/services/conversation-store.ts`: CRUD for conversations + messages tables.
5. `src/services/time-window-policy.ts`: check message limits per hour/day per customer; check 24h window.
6. `src/services/media-service.ts`: check media send limits per customer per 72h.
7. `src/services/budget-guard.ts`: stub (returns `{ aiAllowed: false }` until Phase 6).
8. `src/services/alert-service.ts`: stub (logs alert intent, does not send until Phase 7).
9. `src/scripts/simulate-message.ts`:
    - Takes `--message "..."` arg.
    - Runs full response engine.
    - Prints: `reply=...`, `lead_score=...`, `used_ai=false`, `should_alert_owner=...`, `should_send_image=...`.
    - Works offline (no WhatsApp, no AI).
10. Add `npm run simulate` that calls the simulate script.
11. Tests for `lead-scoring`, `response-engine`, `budget-guard`, `skills-prompt-assembly` in `src/tests/`.

### Phase 4 — WhatsApp webhook

1. `src/routes/whatsapp-webhook.route.ts`:
   - `GET /webhooks/whatsapp` — Meta verification (hub.mode, hub.verify_token, hub.challenge).
   - `POST /webhooks/whatsapp` — receive message events, return 200 immediately, process async.
2. `src/services/dedupe-service.ts`: check `processed_webhook_messages` table before processing.
3. `src/services/whatsapp-client.ts`: send text messages via WhatsApp Business Cloud API (POST to graph API).
4. Wire webhook → dedupe → store → response-engine → send reply → store outbound → score → alert.

Rules:
- Ignore statuses and read receipts.
- Always return 200 for valid WhatsApp events.
- Never crash on unexpected payload shape.

### Phase 5 — Cost guards

- `src/services/budget-guard.ts` — real implementation:
  - Daily AI budget (USD).
  - Monthly AI budget (USD).
  - AI calls per customer per day.
  - AI calls global per day.
  - AI cache with TTL.
- `src/services/time-window-policy.ts` — enforce all limits.
- `src/services/media-service.ts` — enforce 1 image per customer per 72h.

### Phase 6 — DeepSeek fallback

1. `src/prompts/seller-personality.skill.md`, `entry-strategy.skill.md`, `cold-info-handler.skill.md`, `whatsapp-sales.skill.md`, `andean-scapes.skill.md`, `dynamic-context.template.md` — skills prompt files. Any new file here must also be copied by the `build` script in `package.json`.
2. `src/services/skills-prompt-assembly.ts` — renders CATALOGO + DATOS + assembles system prompt.
3. `src/services/deepseek-client.ts`:
   - POST to DeepSeek API with system prompt + customer message + conversation history.
   - Parse + validate response with zod.
   - Track usage in `ai_usage` table.
4. Wire into `response-engine.ts`: DeepSeek is the PRIMARY reply source for all customer messages (not a fallback). Called when AI budget allows. LLM owns reply text.

### Phase 7 — Owner alerts

1. `src/services/alert-service.ts` — real:
   - Log channel: write to `owner_alerts` table + log line.
   - Telegram channel: send via `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`.
   - WhatsApp channel: send via `whatsapp-client.ts`.
   - Enforce: 1 WhatsApp alert per customer per day; no images in alerts.
2. Alert template from sales-strategy `ownerAlertTemplate`.

### Phase 8 — Deployment

1. `deploy/andean-whatsapp-bot.service` — systemd unit (section 20.4).
2. `deploy/cloudflared-config.yml` — tunnel config (section 19).
3. `deploy/install-fedora.sh` — install script: user, dirs, deps, build, systemd, cloudflared.
4. `deploy/update-app.sh` — git pull, npm ci, npm run build, systemctl restart.

### Phase 9 — Consent-gated follow-up outbound

The complete architecture is invariant 10 above: exactly three independently
switched paths, all implemented in `followup-service.ts`. The old free-form sales
nudges and score-band/date/cold-loop template stack stay deleted.

1. **One-shot post-24h template:** operator `/followupgrant` consent; one
   delivered-or-uncertain template per customer. Body variable and header image
   resolve through `product-registry.ts`; missing assets skip rather than invent.
2. **Consent ask:** model-written through `skills-prompt-assembly.ts`, inside the
   24h window. Engine validates and strips `[[FOLLOWUP_CONSENT]]`; it never repairs
   or substitutes text. A yes/no only records state and still reaches the LLM.
3. **Recurring template:** requires explicit customer consent, a dormant thread,
   and the consent-scoped exponential cadence (`c1-r1`, `c1-r2`…). Exact due
   filtering runs before the per-tick batch limit so non-due rows cannot starve due
   customers.

All paths use repository claims, post-claim state/dormancy re-checks, and terminal
`uncertain` status when Meta may have accepted a send. All `FOLLOWUP_DEV_*`
overrides and a non-empty dev allowlist fail startup in production.

**Deploy:** `migrate()` still runs `DROP TABLE IF EXISTS follow_up_events` — that
is the RETIRED table from the old feature, not the new `followup_events`. Export
it before deploy if the old audit history is needed. Orphan `conversations`
columns from the old feature remain in place and are ignored.

## Testing

- `npm test` — unit tests in `src/tests/`.
- `npm run test:ci` — the same suite with **no env file**, which is what CI actually
  runs. `env.ts` does `dotenv.config({ path: process.env.ENV_FILE ?? '.env.dev' })`,
  so a local `npm test` silently inherits `.env.dev` while CI resolves the zod
  defaults. Three media tests asserted a 3-photo gallery because `.env.dev` sets
  `MAX_GALLERY_IMAGES_PER_SEND=3`; the default is 5, so they were green locally and
  red in CI. **A test must pin any env value it asserts on** — run this before
  pushing.
- `npm run eval:conversations` — deterministic conversation-eval pack (31 scenarios).
- `npm run eval:conversations:llm-bot` — live LLM quality suite (20 `live`-tagged
  scenarios, ~$0.37 per pass; costs tokens).
- `npm run simulate -- "text"` — offline bot test.
- `npm run typecheck` — must pass clean.
- `npm run lint` — must pass.
- `npm run validate:prompt` — no business literals in skill MD files.
- `npm run validate:skills` — skill JSON schema valid.
- `npm run build` — must produce `dist/`.

Live eval hotspots after skill changes: `group-of-5-math` (QUOTE LOCK total),
`entry-retarget-R01-with-history` (no brochure on return), `plan-selection-gallery`
(plan choice must quote AND demo), `consecutive-gallery-requests` (repeat and
"show me" photo requests), `vacation-motive-discovery-baredate` (bare-day T3b close).
Any change to the QUOTE LOCK cue must re-run the quote scenarios (`group-of-5-math`,
`group-then-plan-quote`, `date-pick-*`) — they all read that cue. See `src/prompts/LESSONS.md`.

### Writing conversation-eval scenarios

The harness is a regression net, so a scenario that fails for its own reasons is worse
than no scenario. Three rules, each learned from a false failure:

- **Assert marker leaks with marker syntax, never the bare word.** Patterns compile
  with the `i` flag, so `FOTOS|marcador` also matches the ordinary Spanish word
  "fotos" and fails every correct reply that mentions photos. Match `\[\[\s*FOTOS`.
- **Never assert exact photo counts in a `live` scenario.** The live pass reads the
  real CDN feed while the deterministic pass reads the CI fixture, so counts differ
  without any defect. `shouldSendGalleryImages` is `requestedGalleryImageUrls.length > 0`,
  so it already covers the "marker resolved to zero photos" case.
- **Seed only state the visible history justifies.** Seeding `priceGiven` on a thread
  whose turns never quote makes the model correctly deliver the total instead of
  closing, which reads as a prompt bug for as long as the scenario lives. Earn the
  state in an earlier turn instead.

### Never trust a piped gate

`npm run validate:prompt | tail -1` reports **tail's** exit code, not npm's — a failing
gate looks green. Run gates bare, or capture the status explicitly:

```bash
for c in typecheck lint validate:prompt validate:skills build; do
  npm run "$c" >/dev/null 2>&1; echo "$c EXIT=$?"
done
npm test >/dev/null 2>&1; echo "test EXIT=$?"
```

Alternatively `set -o pipefail` before any piped run. Never report a gate as passing
without having seen a real exit code.

## Acceptance checklist (all must pass)

```
[x] Fastify runs locally on 127.0.0.1:3000
[x] /health returns ok
[x] SQLite stores conversations and messages
[x] Bot answers via DeepSeek with skill facts as context
[x] Bot never invents unavailable data
[x] Max 1 same plan/owner image per customer per 72h; gallery sends capped by MAX_GALLERY_IMAGES_PER_SEND (hard-capped at 5)
[x] Lead scoring works
[x] Opt-out works
[x] All tests pass
[x] Skills v2 assembly builds system prompt per SKILLS-ASSEMBLY.md
[x] Dynamic price change reflected in simulate without editing md skills
[x] No payment phone/link in system prompt
[x] Explicit and first-plan-selection galleries ship only via `[[FOTOS:<theme>]]`; owner intro image still disabled pending sales strategy review
[x] Requested photos survive handoff/soft-unsafe turns; hardSafetyFail outranks marker reasons
[x] A photo request is the photo nouns OR a visual imperative; a repeat request re-requires the marker
[x] Every delivered outbound image is recorded in `outbound_media`; a ledger failure never breaks the send
[x] `/lead`, `/chat`, `/customer` replay real photos with the caption the customer saw; pre-ledger turns show a bare glyph
[ ] Operator replay verified live against Telegram (album batching + byte-upload fallback)
[x] Opt-out honoured for the bare standalone phrases, including "no mas porfa"
[ ] Plan-selection turn quotes AND demos, and a repeat photo request re-marks
    FAILING as of the 2026-08-24 live rerun. The plan-choice turn quotes correctly but
    emits no `[[FOTOS:...]]` (`plan-selection-gallery` 67, 0/2 — unchanged by the
    2026-08-20 §GALERIA fix). A repeat request still ships zero photos AFTER promising
    them ("aquí van de nuevo las de la mina"), a shape `PHOTO_PROMISE` does not match.
    Needs its own PR; see LESSONS.md 2026-08-24.
[ ] Bare-day acceptance closes with anticipo instead of re-quoting
    FAILING as of the 2026-08-24 live rerun (`vacation-motive-discovery-baredate` 78,
    0/2). The 2026-08-20 QUOTE LOCK `!priceGiven` tail did not produce a T3b close.
[x] HMAC SHA-256 webhook signature verification (X-Hub-Signature-256)
[x] Meta webhook verification works (verified live 2026-08-04)
[x] WhatsApp POST webhook receives messages (verified live 2026-08-04, dev tunnel)
[x] Opt-out honoured for usted + tú/vos phrasings, accent-insensitive, even for booked leads
[x] Opt-out silences the bot; only the customer's own later inbound reopens the conversation (never consent); `/block` is permanent; `last_opt_out_at` is never cleared
[x] Conversational replies are natural-inbound only (no sales nudges)
[x] One-shot post-24h approved template, operator-consent gated, one delivered send per customer
[x] Consent ask is model-written via prompt assembly, validated + marker-stripped, never repaired
[x] Recurring template only after an explicit yes; silence is never consent
[ ] Post-24h template verified live against Meta (requires approved template + live run)
    NOTE: this path has never executed in ANY environment. `grantConsent()` has a single
    caller (`followup-grant.command.ts`) and its command name was undispatchable until the
    `/followupgrant` rename, so `hasConsent()` was always false and every one-shot died as
    `consent_revoked`. The unit tests above pass, but no run has ever reached Meta. Verify in
    dev (`FOLLOWUP_DEV_MINUTES`, dev allowlist) before trusting it in production.
[ ] Consent ask + recurring template verified live against Meta (requires approved template + live run)
[ ] Duplicate messages ignored (requires live webhook)
[ ] AI budget guard works (requires AI usage data)
[ ] Owner alert fires on AI failure, budget block, or score >= 85 (requires live run)
[ ] systemd starts bot after reboot (requires Fedora deploy)
[ ] Logs do not expose secrets (manual audit before prod)
```

## Security rules

- Never commit `.env` values.
- Never log `WHATSAPP_ACCESS_TOKEN` or `DEEPSEEK_API_KEY`.
- Bind Fastify to `127.0.0.1` only.
- Use systemd hardening (`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full`).
- Set `/etc/andean-whatsapp-bot.env` permissions to `600`.
- **Every Colombian mobile in the repo uses the `300` operator prefix.** The
  operator's real number (also the Nequi channel) was committed in six files,
  including the payment-leak guard tests — whose assertions work identically with a
  placeholder. `secretlint`'s recommended preset has no national-format phone rule,
  so `no-real-phone-numbers.test.ts` enforces the prefix convention instead. A bare
  10-digit secretlint pattern was rejected: it flags timestamps, ids and the
  placeholders themselves, and needs a dependency that is not installed.
  **Note:** the real number remains in git history (**10** commits, `ab8bde9` →
  `af83536`, verified 2026-08-26 — the count grows with every new commit that touches
  a file still containing it, so re-check rather than trusting this number).
  Scrubbing the working tree does not remove it; making this repo public without a
  `git filter-repo` pass still exposes it. HEAD itself is clean. Re-verify with:
  ```bash
  git log -p --all | grep -ohE '\b3[0-9]{9}\b' | sort -u   # any non-300 prefix = leak
  ```
  **This is the one hard blocker on making the repo public.** `secretlint`'s
  recommended preset does not flag national-format phone numbers, so neither
  `npx secretlint` nor `no-real-phone-numbers.test.ts` (working tree only) will
  catch it.
- **Any command that writes to a customer goes through `sendBridgeReply` /
  `sendBridgeMedia`.** They are the only senders that enforce pause, opt-out and the
  24h service window *and* persist the outbound. `/send` in single-line mode used a
  raw `sendText`, so it could message a customer who had asked us to stop and left
  no row in `messages`, silently holing the transcript and the replay.
- **Command args that are phone numbers go through `normalizeCommandPhone`.**
  Args are split on whitespace, so `/block +57 300 990 0001` used to reach
  `setOptOut` as `+57` and insert a phantom opted-out conversation that never
  matched the real digits-only row — a block that confirmed success and blocked
  nothing.
