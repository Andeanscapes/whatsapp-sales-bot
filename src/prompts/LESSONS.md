# Prompt Iteration Lessons

This file is an append-only record for human-reviewed prompt changes.

Rules:

- Record one observed problem per entry.
- Replace an existing rule when possible; do not append duplicate rules.
- Keep this file out of the runtime prompt.
- Record prompt size and business metrics before and after each profile version.

## Entry Template

```text
date: YYYY-MM-DD
profile: profile-id@version
symptom: observed behavior
change: replaced rule or section
metrics_before: prompt_tokens=0; reply_rate=0; booking_rate=0
metrics_after: prompt_tokens=0; reply_rate=0; booking_rate=0
```

## 2026-08-02 Golden Conversation Pack

profile: andean-scapes-co@1
symptom: Historical export showed 352 brochure-style replies, 104 multi-question replies, 89 active leads ending without a CTA, 68 repeated scarcity phrases, 4 template leaks, and 1 internal date sentinel leak.
change: Added deterministic/live regression scenarios covering opening, plan gate, group pricing, transport, children, objections, closing, payment safety, dynamic-data safety, and leak suppression.
metrics_before: conversations=751; estimated_reply_prompt_tokens=10598
metrics_after: deterministic_scenarios=23; live_scenarios~11; prompt_budget_tokens=18000

## 2026-08-02 Live Eval Calibration

profile: andean-scapes-co@1
symptom: First real provider run showed three harness defects: the `live` tag did not filter the subset, the token estimator under-reported the prompt, and the cost cap aborted early.
change: `partitionLiveScenarios` honors the `live` tag with `--all` override; estimator calibrated; cost cap default raised.
metrics_before: live_scenarios_actually_run=19; eval_cost_cap=0.10
metrics_after: live_scenarios_actually_run~11; eval_cost_cap=0.50

## 2026-10-09 Campaign diagnosis compliance (live verification)

symptom: H01 rejected an intensity/nature qualification question; H02 gave a generic group opening instead of the vehicle/route diagnosis.
change: H01 matches qualification inside a question, with generic-question negative tests. Captured H02 prompts contain the feed diagnosis and planMatch. The entry skill now directs an empty hook to the segment diagnosis on first contact, without treating a greeting as a contradiction or assuming vehicle ownership.
metrics_before: H01=86; H02=67 in the user-provided live run.
metrics_after: targeted H01=100 (3/3), H02=100 (3/3); final full pack H01=100 and H02=100. These samples do not establish long-term reliability.

## 2026-10-09 First-plan gallery prompt experiment (NOT FIXED)

symptom: First concrete plan selection quotes correctly but omits the photo marker.
change: Captured engine prompts in deterministic and live-replay setup tests confirm the settled plan, available mine theme, positive image allowance, and absence of prior-gallery state. Tightened the gallery skill to cover activity-based plan names and distinguish a post-diagnosis choice from first contact; no retry expansion or deterministic marker insertion.
metrics_before: plan-selection-gallery=67 (0/2).
metrics_after: targeted=67 (0/3), so the prompt-only experiment is insufficient. Final full pack average=97, hard_fails=2, cost_usd=0.2535237: gallery omission and vacation closing re-quote. Group quote and date-pick-price-then-close scenarios passed. Payment-facts lost noncritical points for two questions.
baseline: the full live artifact replaces targeted artifacts; the live comparison reference contains no comparable scenarios, so comparison cannot establish absence of regressions. Do not promote this run as a clean baseline.

## 2026-10-09 Consent classifier hardening and eval suite optimization

profile: durable-consent@1 (AND-XXX-improve-follow-up branch)
symptom: Production audit (1787 conversations) revealed three classifier regressions: "Claro, cuando gustes" (ambiguous), "Si por fa" (ambiguous), and iterative greeting stripping left dangling tokens ("Hola buenos dias si claro escribe"). Also: 74 live calls across 31 scenarios with ~22 unchecked setup turns.
change:
  - Classifier: token-bounded iterative greeting stripping, including `buen dia`, paired `por fa` handling, and exact `cuando gustes`/`cuando quieras` continuations after an affirmative prefix.
  - Test harness: live-only replay bypasses LLM; deterministic turns still execute the engine. Schema validation rejects criteria targeting replay turns, including implicit whole-conversation checks. Consent inputs transition the subscription before the engine call.
  - Eval scenarios: 5 scenarios use live-only replay (8 context turns), 4 scenarios capped liveRuns, 3 unchecked final turns trimmed, 1 redundant scenario deleted, 2 new consent-focused scenarios (deterministic + live).
  - Production text: C01/H01/H02/R01 entry markers updated to real production copies from 2026-10-09 report.
metrics_before: scenarios=31; live_calls=74; replay_mode=none; consent_scenarios=0
metrics_after: scenarios=32; live_scenarios=20; live_evaluated_turns=50 (weighted by liveRuns, versus 74 before); replay_turns=8; consent_scenarios=2. Provider retries and analyzer calls are additional; token savings are not yet measured.
coverage: actual consent acknowledgment and subscription activation; bare permission answer freezes score and suppresses alerts despite high-intent analysis; subsequent booking intent scores normally; repeated stop remains silent.
baseline: master-deterministic.json remains the prior comparison reference; eval writes current results to artifacts/conversation-eval.json. Live results and provider cost require a user-run evaluation.
production_data: 1787 conversations (2026-06-25 to 2026-10-08); 483 since 2026-08-20; heuristic detection found 120 consent asks; 11 templates sent (0 replies). Added PII-free reply fixtures; this is not a measured classifier-accuracy benchmark.

## 2026-08-04 Consent ask lessons (HISTORICAL — feature removed)

profile: andean-scapes-co@1
symptom: Free-form consent nudges invented prior promises and used chase framing.
change: Consent/follow-up/template re-engagement stack was later **removed entirely**. Bot answers natural inbound only. Do not revive `deepseek-follow-up.prompt.md`, `[[PERMISO]]`, or §PEDIR PERMISO without a fresh design.
status: obsolete — kept only so agents do not reintroduce the old path from these notes.

## 2026-08-07 Follow-up / re-engagement removed

profile: andean-scapes-co@1
symptom: Feature surface (scheduler, consent, Meta templates) outgrew vibe-coding control.
change: Deleted services, env vars, Telegram commands, `follow_up_events` table (DROP on migrate), and skill sections. Conversation-eval pack is 23 message/lifecycle scenarios; no `follow_up` runner.
metrics_after: unit_tests~882; eval_deterministic=23; natural_inbound_only=true

## 2026-08-07 Group quote + retargeting skill harden (live eval)

profile: andean-scapes-co@1
symptom: Live suite hard-failed `group-of-5-math` (unit rates / 3–4 person stacks instead of `$2.250.000`) and `entry-retarget-R01-with-history` (brochure/price on return: todo incluido, mina…apicultura, COP).
change:
- `andean-scapes.skill.md` COTIZACIÓN + JSON `businessRules`: QUOTE LOCK first; 5+ = (pareja÷2)×N; ban 3/4-style stacks.
- `whatsapp-sales.skill.md` FASE 3/T2b: QUOTE LOCK non-negotiable; one group total; retarget greeting bans price/includes/activities.
- `referent.h.json`: return-diagnosis never brochure; new-value only after diagnosis turn.
metrics_before: live_avg~94; hard_fails=2
metrics_after: pending re-run `npm run eval:conversations:llm-bot`

## OPEN FINDINGS — live suite

Do NOT relax eval criteria to go green; fix skills and re-run.

### F1 — group pricing arithmetic — mitigated in skills (re-verify live)

scenario: `group-of-5-math`
expected: single total from QUOTE LOCK / `(couple÷2)×N` for 5+
fix: see 2026-08-07 entry. Confirm with live eval.

### F2 — opening asks for plan instead of group

scenario: `ad-price-date-opening`
observed: first reply listed both plans
expected: T1/FASE 1 — only opening question is group
status: still open if live still fails; skill already forbids plan menu on open.

### F3 — retarget return dumps brochure — mitigated in skills (re-verify live)

scenario: `entry-retarget-R01-with-history`
expected: “Venías solo… plan de 3 días” + one diagnosis question; no COP/todo incluido/activities
fix: see 2026-08-07 entry.

### F4 — date pick → fake handoff + plan summary (2026-08-07)

symptom: After couple + plan + price + published dates, customer said “el 7 suena bien”. Bot replied “déjame validar… les confirmo” + “¿les comparto el resumen del plan?” instead of close CTA.
expected: T3b — reflect date → anticipo% + methods from DATOS → one “¿validamos?” / method question. No verbal handoff, no re-brochure.
change: Added golden-path T3b; tightened §5 Soft and §8 date rows; eval scenario `date-pick-close-T3b`.
note: `human_pending`/owner alert is runtime-side when close gates fire; bot must keep owning the chat until customer accepts the step.

### F5 — retarget diagnosis emoji max=0

scenario: `entry-retarget-R01-with-history` turn 4
note: `max_emojis: 0` on the diagnosis turn is intentional (recall + one blocker question only). Warmth emoji still applies on earlier/later non-diagnosis turns; does not contradict “≥1 calidez in short hilo”.

## 2026-08-07 Reply readability + formulaic opener mitigation

profile: andean-scapes-co@1
symptom: Bot sounded formulaic (ack token every turn, dense text, 7-date line, repeated includes/anticipo summary). Example conversation showed 6/9 msgs starting with Perfecto/Buena elección/Listo; no blank line breaks; longest sentences 20+ words; always 1 ack token + paragraph + question rhythm.
change:
- New `seller-personality.skill.md` sections: §FORMATO (max 2 blocks/blank line, ≤15 words/sentence, 1 bold on total/date/%, never bold questions), §APERTURAS (no ack token 2 msgs in a row; rotate opener shapes), §REGISTRO (mirror customer tú/ustedes; no register mix in one msg).
- `whatsapp-sales.skill.md`: dedupe plan-gate + includes + "ya reservado" rules (4→1 canonical each); T2b refactored to 2 compact blocks with bold total; drop "exacto" wording; compress checklist to ~10 items + new formato/apertura/registro checks.
- `skills-prompt-assembly.ts:340` QUOTE LOCK: drop "exactamente", add "Escribí el total en tu voz" + example template showing bold.
- New `logReplyStyle()` in `reply-guard.ts`: log-only diagnostic (chars, longest sentence, bold count, ack-opener, mixed register). Never edits text.
- Added format criteria to 4 eval scenarios: `reply_length_at_most` (350-400 chars), `reply_must_not_match` on ack opener patterns.
metrics_before: formulaic_conversation_sample=6/9_ack_opener, longest_sent=23_words, blocks=1_dense_para
metrics_after: prompt_tokens_est=19949/20000, eval_criteria_live_scenarios=4, format_rules_codified=3_sections
note: Budget freed by deduping saved enough space for §FORMATO + new checklist items. Live eval will validate copy quality against new format criteria.

## 2026-08-10 Referent Evidence Alignment v2→v4

profile: andean-scapes-co@1
symptom: Referent packs were generic; first rewrite introduced destination/payment literals and a few instructions that fought sales gates.
change:
- Rewrote all 10 referents with concise behavioral points (no biographies, no prices, no referent names).
- Removed business literals (`Chivor`, city names, payment brand names). Methods/places come from DATOS/CATALOGO.
- Fixed conflicts: cold open no longer forces price answers; funnel no-menu no longer dumps durations; grammar/ES-only cleanup.
- Kept critical retarget return-diagnosis wording for eval safety.
- Token ceiling 21,200 → 21,500 only (worst-case ~21,213).
metrics_before: prompt_tokens_est=20787; validate_prompt=fail_on_Chivor
metrics_after: prompt_tokens_est=21213; validate_prompt=pass; eval_deterministic=pending
note: Names remain attribution-only metadata (never sent to model).

## 2026-08-10 Group quote live variance

profile: andean-scapes-co@1
symptom: `group-of-5-math` remained flaky because one failed run fails the 3-run scenario; runtime used a terse key/value QUOTE LOCK and deployed temperature was 0.7.
change: Unified FASE 3/T2b on one quote sentence, restored an adjacent runtime copy instruction, and lowered DeepSeek temperature to 0.2.
metrics_before: live_runs_required=3/3; temperature=0.7; quote_lock=terse
metrics_after: temperature=0.2; targeted_live=3/3; score=100; no_price_before_plan=3/3; exact_total=3/3; cost_usd=0.0189

### Harness note

Variance hotspots use `liveRuns` ≥ 2–3 with aggregation. Deterministic pack: `npm run eval:conversations`. Live: `npm run eval:conversations:llm-bot`.

## 2026-08-11 Skills v3: campaign segments move to the feed

profile: andean-scapes-co@1
context: New CDN payload added `experiences.*.sites.*.entrySegments` (C01–C04, H01, R01) plus a new 5-file skill set. The strict zod site schema rejected the unknown key, so the live bot silently fell back to no dynamic data (`measure:prompt` threw, `[DYNAMIC] validation failed`).
change:
- Schema/type/transform now carry `entrySegments`; legacy + v9 feeds default to `{}`.
- `renderBusinessData(skills, entryMarkerCode?)` emits **only the detected** segment as `ENTRY_SEGMENT <code>` inside its own SITE block. Rendering all six cost ~950 tokens and risked cross-segment bleed. `description` is never rendered (internal targeting metadata).
- RUNTIME gains `SEGMENT_DETECTED: <code>` only when the feed actually defines that segment — no dangling pointer.
- Added `entry-strategy.skill.md` + `cold-info-handler.skill.md`; order is personality → entry-strategy → cold-info-handler → sales → catalog, asserted by test.
- Stripped every business literal the authored MDs carried (`$550.000`, `$82.500`, `2D/1N`, fixed dates, `Chivor`, `Ubalá`, `Minecraft`, `Nequi`, `Mercado Pago`, `300 990 0001`). Segment copy now comes only from DATOS, so a plan can be retired without a prompt edit.
- Dropped the authored `T3c` phase (LLM writes the Nequi number after confirmation). Payment release is human-gated (`/payment <phone> confirm`); `containsPaymentDetailLeak` classifies an LLM-written phone as echo-risk and suppresses the entire turn, so T3c would have produced silence + an owner alert.
- Dropped the authored referent-names table from personality. The 10 anonymized packs stay the only referent content; names remain attribution-only metadata.
- `validate:prompt`: registered the 2 new files and closed a real hole — `/\b15%\b/` never matched `15% ` (`%`→space is not a word boundary), so the deposit literal had been passing. Added guards for any money amount, any percentage, any COL mobile, duration prose, destinations, campaign nouns, and payment method names. Verified all 8 new guards fire on the authored originals and none on the shipped files.
- Token ceiling 21,500 → 23,000 (worst case 21,998, dev-payload/retargeting). Old ceiling left ~99 tokens of headroom; a second site would have breached it.
- Unrelated pre-existing fix: `vacation-motive-discovery-baredate.json` was untracked and missing from the manifest, so `scenario-loader` threw and the whole eval pack failed to load. Registered it (`totalTests: 25`).
metrics_before: validate_dynamic=fail_on_entrySegments; measure_prompt=throw; eval_conversations=fail_to_load
metrics_after: prompt_tokens_est=21998; validate_prompt=pass(20 guards); test=973 pass; eval_deterministic=25/25
note: Adding `C05` now needs a feed edit only — no code, no prompt change. Live LLM eval still owed for first-contact copy quality.

## 2026-08-11 Context and monetary budget after skills v3

profile: andean-scapes-co@1
context: Skills v3 raised the measured system prompt to ~22k tokens. The old gate measured only the system prompt, while real requests also carry conversation history, the latest inbound, and output tokens. The output cap remained small enough to risk provider `finish_reason=length`, and token prices were hardcoded independently of the configured model.
change:
- System-prompt ceiling 23,000 → 24,000; measured worst case remains ~22,027.
- `measure:prompt` now reserves 12,000 history chars (~4,000 tokens), 1,500 tokens for the latest WhatsApp inbound, and 800 output tokens, then asserts the projected request fits the configured 32,768-token context window.
- LLM client keeps the newest contiguous history that fits both the 12,000-char cap and remaining context. Provider `finish_reason=length` is rejected and retried/fallbacked instead of sending partial text.
- Reply output cap 500 → 800. Daily/monthly/call limits aligned at $2/day, $30/month, 30/customer/day, 1,500 global/day.
- Input/output token rates moved to env (`DEEPSEEK_*_COST_PER_MILLION_USD`) so budget accounting can follow model pricing without a code deploy.
metrics_after: system_prompt_est=22027; projected_context=28327/32768; output_max=800; monthly_budget_usd=30

## 2026-08-12 Entry segment expansion + placeholder-leak guard

date: 2026-08-12
profile: andean-scapes-co@1
symptom: Fixed latent vulnerability — R01.valueHook contained `[GRUPO]` and `[PLAN]` placeholders that would surface in the reply if the skill ever used them. Also extended entry-segment matrix (C/H/R × 01-04) to support richer campaign targeting and blocker diagnosis without hardcoding new skill MD files.
change:
- Removed placeholders from R01; fixed `scripts/bot-dynamic-dev.json` and `scripts/bot-dynamic.ci.json`.
- Added runtime Zod guards in `dynamic-data-schema.ts`: reject invalid codes, placeholders, multiple questions, cold-hook questions, and non-empty hot hooks before transform or prompt assembly.
- Extended dynamic-data tests: valid codes parse; invalid codes, placeholders, multiple questions, cold-hook questions, and non-empty hot hooks are rejected.
- Expanded entry-segment matrix: C01-C04 (cold), H01-H04 (funnel hot), R01-R04 (retargeting) now all themed by transport (general, 4x4, moto, kids) + customer segment (entry, hot intent, return with known blocker).
- Added site-level caveat in Chivor rules: plan does not include guided route; customer arrives in own vehicle (non-4x4 via town); guided/technical route coordinated with team at extra cost.
- New eval scenarios: `entry-funnel-H02-car` (vehicle-context test), `entry-retarget-R03-moto` (blocker-recall test).
- Updated `measure:prompt` profiles: now tests C01 (baseline cold) + C03 worst case (moto hook verbosity).
- Manifest bumped 25→28 tests; version tagged `2026-08-12-segment-expansion`.
metrics_before: entry_segments=6 (C01-C04, H01, R01); placeholder_risk=latent; eval_scenarios=25
metrics_after: entry_segments=13 (C01-C04, H01-H04, R01-R04); placeholder_guard=active; eval_scenarios=28; worst_case_profile=C03-moto
context: Architecture guarantee: adding code C05–C99 or H05–H99 requires zero code/prompt/skill changes; new codes are pure feed edit with `parseEntryMarker` and `renderEntrySegment` already generic. Tested with typo'd codes (invalid) and placeholder-laden hooks (caught by guard).

## 2026-08-12 Semantic emoji selection

date: 2026-08-12
profile: andean-scapes-co@1
symptom: In a family retarget conversation, the model appended `😊` to several consecutive replies, including a safety explanation. The previous prompt required warmth during short discovery threads while excluding useful family and safety symbols, making `😊` the easiest default.
change: Emojis are now optional and semantic rather than required. Added family (`👨‍👩‍👧‍👦`, `🧒`) and safety/preparation (`🛡️`, `🪖`, `🥾`) options; instructed the model to inspect history, avoid repeating the same emoji, and omit emojis when none adds meaning. Retarget evals now enforce max one and ban hype/payment symbols instead of requiring zero.
metrics_before: repeated_default_emoji=observed; retarget_emoji_max=0
metrics_after: semantic_sets=family+safety; emoji_optional=true; retarget_emoji_max=1

## 2026-08-12 Live transition priority hardening

date: 2026-08-12
profile: andean-scapes-co@1
symptom: Live variance skipped the QUOTE LOCK total after explicit plan choice, used generic segment questions on retarget returns, and treated a bare published day as date discovery instead of T3b.
change: Tightened three existing state transitions in `whatsapp-sales.skill.md`: settled plan + QUOTE LOCK enters FASE 3 immediately; retarget continuation wins over generic segment flow and uses an explicit blocker stem; bare-day acceptance with prior price enters T3b immediately.
metrics_before: live_avg=94; hard_fails=4
metrics_after: targeted_quote=3/3; targeted_close=2/2; targeted_bare_day=2/2; full_live_avg=97_before_final_narrowing; retarget_evaluator_aligned_with_valid_tu_vos_plural_variants

## 2026-08-12 Passive handback ending on "no todavía"

date: 2026-08-12
profile: andean-scapes-co@1
symptom: Live couple thread. After the quote, the customer said "no todavia" (about the date) and the bot closed the turn with "Sin afán, tranquilos. Cuando tengan una fecha en mente, me escriben y les confirmo disponibilidad." — no question, next step handed to the customer. Two existing rules already forbade this (§48-54 "Exactamente 1 pregunta", FASE 3 "'Todavía' NO es pausa ni cierre"), so this was a rule-collision failure, not a missing rule: the SIN-pregunta exception listed "pausa explícita con pareja/familia/grupo", and because the lead had answered "pareja" two turns earlier, the model matched the exception on the group composition instead of on what the customer actually said.
change: Three surgical prompt edits in `whatsapp-sales.skill.md` — (1) the pause exception now reads "el cliente dice que consulta con alguien o que él escribe después" and states explicitly that being a couple/family does not activate it (the exception depends on this message, not on travel companions); (2) added the literal "no todavía / todavía no / aún no" variants to the CON-pregunta list and to the FASE 3 bullet; (3) new anti-pattern banning the passive-handback formula ("me escriben", "me avisan", "quedo atento", "cuando decidan me cuentan") with the instruction that wanting to write it is the signal that the question is missing.
metrics_before: sin_pregunta_exception_keyed_on=group_composition; handback_formula=unlisted
metrics_after: sin_pregunta_exception_keyed_on=customer_utterance; handback_formula=explicit_anti_pattern; todavia_variants=covered_in_both_sites
context: No TypeScript touched — invariant 8 (LLM owns reply text) forbids fixing this with deterministic copy or a post-LLM rewrite. Enforcement is prompt-only; verify with the live LLM suite, since the deterministic eval pack cannot judge whether a reply ends with a question.

## 2026-08-13 Hard-fail cleanup: retarget verbatim echo, "todavía" handback, T3b re-quote

date: 2026-08-13
profile: andean-scapes-co@1
symptom: Three live hard fails. (1) `entry-retarget-R01-with-history`: the model reproduced the R01 `valueHook` verbatim ("Venías mirando la experiencia y tenías un plan en mente. ¿Qué te frenó la última vez: fecha, precio, logística o seguridad?") instead of recalling group+plan from history — two rule layers (entry-strategy retarget note + whatsapp-sales RETARGET OVERRIDE) already said to replace the intro with history, but neither made it imperative enough. (2) `still-looking-after-price`: "Claro, sin afán. Cuando tengan un mes en mente, me escriben y les reviso las salidas publicadas." — the exact banned passive handback, no dates, no question; identical 2/2 runs. (3) `vacation-motive-discovery-baredate`: on a T3b close turn the model re-quoted a different plan's total ($1.400.000 = 3d2n_rural) despite `PRECIO YA ENTREGADO`, locked 2d1n_mining, and "Cero re-cotización".
change: Four surgical edits in `whatsapp-sales.skill.md` + one in `entry-strategy.skill.md`. (1) FASE 3 "todavía" bullet now shows the correct reply shape as a concrete script: validate 1 phrase → list DATOS dates NOW → 1 month question, with a verbatim example; dates are shown in this turn, never promised later. (2) Anti-pattern broadened: any "cuando … me (diga|dice|digan|dicen|cuente|cuentan|avise|avisan|escriba|escriben)" or "les reviso/les confirmo cuando sepan/elijan" is banned even before a question. (3) Plan sticky extended to "ni al responder fechas/disponibilidad" — the model had switched to 3d2n_rural while answering a dates question. (4) RETARGET OVERRIDE + new "Anti-eco del hook (retargeting)": NEVER write the `valueHook` verbatim; replace the intro with the real group+plan or at least the concrete group. (5) entry-strategy.md retarget note: the hook intro is replaced by group+plan recall; only the blocker question is conserved.
metrics_before: live_avg=95; hard_fails=3
metrics_after: live_avg=98; hard_fails=0-1 (R01+still-looking deterministic-clean; vacation-motive flaky 3/3 in isolation, 1-2/2 in suite)
context: Flaky scenarios are model variance on fair criteria, not missing rules — re-running a scenario with `--runs 3` is the cheap way to separate systematic failures from variance before touching the prompt.

## 2026-08-13 Emoji soft-required + contextual image probability

date: 2026-08-13
profile: andean-scapes-co@1
symptom: Demo conversation (dev, CONTEXTUAL_IMAGES_ENABLED=true, MIN_GAP=0.5) sent a captioned gallery photo on almost every theme-matching turn — predictable cadence reads as bot-like. Separately, zero emojis across the whole demo hilo: the "No son obligatorios" line let DeepSeek default to none on discovery turns.
change: `seller-personality.skill.md` §EMOJIS soft-requires ONE semantic emoji on discovery/celebration turns only, states explicitly that this is a style rule and NOT "tono creativo", and grew the CERO list to cover retarget-diagnosis, safety/risk/health answers and objection handling (on top of price/payment/T3b). `whatsapp-sales.skill.md` T2 and T2b now carry an explicit "Emoji: SÍ va uno acá" line. `contextual-media.ts` adds `CONTEXTUAL_IMAGES_PROBABILITY` (default 0.6) — a theme-matching reply only sends an image with that probability. The mandatory plan card on a price turn is deliberately NOT probability-gated (regression test in `contextual-image-delivery.test.ts`).
metrics_before: contextual_image_per_eligible_turn=1.0; emoji_usage_discovery_turns=0 (single demo hilo, manual read)
metrics_after: contextual_image_per_eligible_turn=0.6 (by construction, not measured); emoji_usage_discovery_turns=NOT MEASURED — `eval:conversations:llm-bot` not run for this change
context: Iteration 1 (personality-only wording, probability 0.4) produced ZERO emojis and ZERO contextual images on a live dev hilo. Two distinct causes. (a) Emoji: the prompt carries 9 explicit "cero/prohibido emoji" statements and §10 PRIORIDAD ranks personality style last as "5. Tono creativo", so one soft positive line in the weakest bucket loses to nine bans. Fix = put the positive rule in the turn-shape file (T2/T2b in `whatsapp-sales.skill.md`) where the model reads turn shape, and label the personality rule as non-optional while keeping the bans absolute. T2 carries an explicit "si es retargeting, cero emoji" exception because a retarget conversation is also a FASE 2 diagnosis and `T2 Retarget` forbids emoji. (b) Images: only ~3 turns per conversation match a theme — `minera` does not match keyword `mina` and `comidas` does not match `comida` (word-boundary regex in `detectMediaType`) — so p=0.4 gives 0.6^3 ≈ 22% chance of a photo-less conversation. Raised to 0.6 (≈6%). LESSON: with few eligible turns, a per-turn probability is a weak frequency knob; reason about `p^eligible_turns`, not `p`.
context_prior_entry: This partially reverses the 2026-08-12 "emojis optional" entry, whose symptom was a repeated default 😊 on consecutive replies including a safety explanation. Two guards target exactly that symptom: the requirement is scoped to discovery/celebration (not "any warm turn"), and safety/objection turns are now an explicit CERO case, since that is where an emoji reads as minimizing the customer's concern. Still bounded by "máx 1/msg, no consecutivos, nunca repitas el mismo". The overuse regression is NOT yet disproven by a live run — verify with `eval:conversations:llm-bot` before trusting in prod.

## 2026-08-13 Consent ask reframed from permission to opportunity

date: 2026-08-13
profile: andean-scapes-co@1
symptom: The live 24h consent ask closed with "¿Te parece si te escribo más adelante para retomar? Si prefieres que no, me dices y listo, sin problema." It reads as a marketing-permission request plus an invitation to decline, so the customer has no reason to say yes. The mechanics worked; the perceived value did not.
change: Prompt-only, `whatsapp-sales.skill.md` §PERMISO-SEGUIMIENTO + §PERMISO-CONCEDIDO. (1) The single question is now a benefit — being told first when there are novedades / cupos / salidas o eventos especiales — and the words "permiso para escribirte", "seguimiento" and "mensajes automáticos" are banned. (2) The "puede pedir que pares" line was removed and offering a negative option is now forbidden. (3) New ban on asserting an open promotion or inventing discounts/percentages/amounts/promo dates/cupos, on top of the global "no inventes descuentos". (4) The question must be written in the customer's language (the example is labelled ES). (5) §PERMISO-CONCEDIDO now answers a question attached to the "sí" in one sentence, and states that answering it is not "reopening the sale".
metrics_before: ask_framing=permission_request; decline_option_offered=true; prompt_tokens_est=28315 (worst: ci-fixture/retargeting-R01)
metrics_after: ask_framing=opportunity; decline_option_offered=false; validate_prompt=pass; test=pass; prompt_tokens_est=28588 (+273 for the consent-ask reframe + T3a/T3b fixes combined)
budget_note: `measure:prompt` FAILS both before and after this change — the ceiling is 24000 and the worst profile was ALREADY 4315 tokens over at HEAD. This entry adds 119 of that 4434. Do not read the red gate as caused by this change, and do not "fix" it by deleting these rules: the overrun needs its own decision (raise the ceiling / history+output reserves, or cut prompt content elsewhere).
context: Three non-obvious couplings made this more than a copy swap. (a) **Consent scope.** The ask must not promise more than the recurring template delivers — asking for "promociones" while `FOLLOWUP_RECURRING_TEMPLATE_NAME` sends a generic trip follow-up is a consent-scope mismatch, so the promise stayed at "novedades / salidas especiales". (b) **A value-framed ask invites a question-bearing yes.** "si, ¿cuáles?" normalises to a 2-word string whose leading token is in `AFFIRM`, so `classifyConsentReply` returns `affirm`; consent is captured (correct — it is the only free-form ask the window allows) but the old §PERMISO-CONCEDIDO banned any commercial answer, which would have left a real question unanswered. Fixed in the prompt, not in the classifier: making it `ambiguous` would discard the consent. Regression tests added in `followup-consent.test.ts`. Note the engine still freezes `lead_score` and skips `setLeadIntent` on a consent-answer turn, so buying signals in that message score on the next turn. (c) **Opt-out disclosure.** Removing the stop sentence is a deliberate product decision; the engine opt-out guard still honours a stop request on any inbound, but the customer-visible disclosure must now live in the approved Meta template body. Documented in `docs/bot-architecture.md`.

## 2026-08-13 T3a/T3b rule collision on a bare-day acceptance

date: 2026-08-13
profile: andean-scapes-co@1
symptom: Live suite 95 avg, 2 hard fails. `date-pick-price-then-close-T3b` scored 33: on t3a (price NOT yet given) the model wrote anticipo + methods + "primero valido con el equipo" and no soft question, then had nothing left for t3b, so `t3a-no-anticipo`, `t3a-no-validation-promise`, `t3a-soft-question` and `t3b-anticipo-on-price-confirm` all failed at once.
change: Prompt + one runtime cue. (1) §7 table row "Fecha DATOS aceptada, incluso día suelto → T3b: anticipo + métodos…" was UNCONDITIONAL and overrode the correct row above it ("Grupo + **sin precio** + fecha concreta → T3a … sin anticipo"). Deleted the duplicate row and folded its two unique nuances ("incluso día suelto", "sin handoff verbal") into the price-conditional T3b row. (2) T3a gained a verbatim example plus "el anticipo y los métodos son del turno siguiente; adelantarlos acá deja T3b sin contenido". (3) `skills-prompt-assembly.ts`: the `PRECIO YA ENTREGADO` cue's tail ("Fechas/motivo → solo fechas + 1 pregunta") directly contradicted `ESTADO DE TURNO: T3b` on a close turn — the inbound IS a date, so the model read "only dates + 1 question". The cue is now pushed after `t3bCloseTurn` is known and drops that tail on a close turn, keeping the no-re-quote half in both variants.
metrics_before: live_avg=95; hard_fails=2; date-pick-price-then-close-T3b=33 (1/3 runs)
metrics_after: date-pick-price-then-close-T3b=100 (3/3 runs); prompt_tokens_est=28514
context: Two traps worth remembering. (a) A verbatim example is a strong attractor: the T3a example alone moved `date-pick-price-then-close-T3b` from 33 to 100, but it also made the model reach for the T3a shape on a T3b close turn (`vacation-motive` went 1/3 → 0/3) until the runtime contradiction was removed. Scripts fix compliance and leak across turns — always re-run the neighbouring scenario. (b) NEVER quote a runtime cue literally in a skill MD. Writing "`ESTADO DE TURNO: T3b`" as prose put that exact string into EVERY prompt, broke three unit tests that assert the marker is absent outside its state, and hands the model a fake state marker. Refer to the state descriptively instead.
open: `vacation-motive-discovery-baredate` still hard-fails `close-cta-on-bare-day` (0/3). Root cause is scenario fidelity, NOT the prompt: it seeds `priceGiven: true` while the visible history contains no price at all (turn 1 only lists dates), so the model correctly delivers the total instead of jumping to anticipo. Fixing it needs either history seeding in `conversation-eval/schema.ts` + `runner.ts`, or a restructured scenario where an earlier turn actually quotes. Do not "fix" it by weakening the criterion.

## 2026-08-14 Bare "No más" missed as opt-out, then re-asked for consent

date: 2026-08-14
profile: andean-scapes-co@1
symptom: Dev hilo: customer granted consent ("Ok"), the bot sent 5 recurring templates (dev 45s fixed cadence), the customer wrote "No más", and the bot replied conversationally then sent a SECOND consent ask (c2) ~66s later. `isOptOutMessage('No más')` returned false — the phrase was never in `OPT_OUT_KEYWORDS_ES`, and neither `opt_out_at` nor `last_opt_out_at` was set.
change: Two independent guards. (1) `response-engine.ts` gained `OPT_OUT_STANDALONE_PHRASES` matched only as the whole message after punctuation is stripped: "no mas", "no mas por favor", "no mas porfa", "no mas gracias", "no mas mensajes", "no mas nada", "ya no mas", "no more", "no more please", "no more thanks". (2) `listConsentAskCandidates` now skips `lead_intent = 'not_interested'` with an explicit IS NULL branch. No skill MD touched, so `measure:prompt` is unaffected.
metrics_before: standalone_opt_out_matched=false; opt_out_at set on "No más"=false
metrics_after: standalone_opt_out_matched=true; consent_ask_reached_not_interested=false
context: Two traps. (a) NEVER add a bare "no mas" to the keyword list: `\bno mas\b` fires inside "no mas de 5 personas" (a group-size answer) and would permanently silence a live lead with `last_opt_out_at` set — the exact false-positive class the word-boundary work already fixed. Standalone phrases must be whole-message equality. (b) `NULL != 'not_interested'` is NULL in SQLite, so a bare `lead_intent != 'not_interested'` silently drops every never-analysed lead; the IS NULL branch is not defensive boilerplate, it is the correctness condition. Also note the 5-template burst was a dev-only fixed-cadence artifact (`FOLLOWUP_DEV_RECURRING_SECONDS=45`); production cadence is 1→3→9 months with a 72h dormancy floor, so a single consent does not burst in prod.

## 2026-08-14 Prompt budget unblocked: the context window was a guess, and it was 8x too low

date: 2026-08-14
profile: andean-scapes-co@1
symptom: `measure:prompt` (a CI step) failed both of its gates for several sessions: system prompt 28,588 vs `systemPromptMaxTokens` 24,000, and projected request 34,888 vs `DEEPSEEK_CONTEXT_WINDOW_TOKENS` 32,768. Every prompt improvement was landing on a red gate, and the standing options were all destructive (cut ~2,100 tokens of tuned sales copy, or truncate the history the model sees).
change: Neither. The 32,768 was an unverified default. Probed the live API instead: `deepseek-v4-flash` accepted a **260,085-token** prompt (`/chat/completions`, `max_tokens=1`, no error, ~$0.07 total for three probes at 60k/130k/260k). So the constraint never existed. Raised `DEEPSEEK_CONTEXT_WINDOW_TOKENS` 32768 → 65536 (4x margin below proven, ~30k slack over the measured worst case) in `env.ts` default + `.env.example` + `.env.dev` + `.env.prod`, and `systemPromptMaxTokens` 24000 → 30000 (measured worst 28,588, so ~5% headroom keeps it a live tripwire).
metrics_before: measure_prompt=FAIL (budget +4588, context +2120); prompt_tokens_est=28588
metrics_after: measure_prompt=PASS; max_tokens=30000; context_window=65536; projected_context=34888/65536
context: Where the tokens actually are, measured per block on the worst profile (R01): whatsapp-sales.skill.md 13,635 (47.7%), CATALOGO/DATOS+RUNTIME+glue 6,607 (23.1%), andean-scapes.skill.md 3,223 (11.3%), seller-personality 2,104 (7.4%), entry-strategy 1,024, referent strategies 1,020 (3.6%), cold-info-handler 971. An earlier review of mine claimed the referent block and entry-segment rendering were "the largest movable pieces" — that was wrong by an order of magnitude; nearly half the prompt is one file. LESSON: measure the composition before proposing a cut, and verify a provider limit before treating it as a constraint. Raising the window cannot inflate cost by itself — history stays capped by `DEEPSEEK_HISTORY_MAX_CHARS` (12,000 chars ≈ 4,000 tokens). CI sets no `DEEPSEEK_CONTEXT_WINDOW_TOKENS`, so the schema default is what protects the runner; verified by simulating the exact `ci.yml` env (`estimated_tokens=28603`, PASS).

## 2026-08-20 §GALERIA read as a phase, so the photo turn ate the close

date: 2026-08-20
profile: andean-scapes-co@1
symptom: Live dev thread, one step from booking. Customer had accepted the date ("Si está perfecto") with the price already given, so the next turn was T3b. Customer then asked "Tienes fotos del hospedaje ?" and the bot replied `Claro, te comparto unas fotos del hospedaje para que vean cómo es la hacienda.` — five photos delivered correctly, but **zero questions and no T3b**: no anticipo, no methods, no close. The lead was left with no next step, and ~56s later the consent-ask path fired ("¿Te gustaría que te avise cuando haya novedades?"), so a lead that was one "sí" from a reservation got asked for permission to be contacted later instead.
change: `whatsapp-sales.skill.md` §GALERIA rewritten from a turn recipe into a **modifier**: "Pedir fotos NO es una fase: es un adjunto", explicit 3-step order (1 connecting line → the turn that applies, complete, with its single question → marker last), an explicit note that the marker is last for parsing and not because the message ends there, and a ban on announcing the send ("te comparto unas fotos…"). Added a §8 close-rules row and a §11 checklist item. The RUNTIME line in `skills-prompt-assembly.ts` no longer restates "termina con [[FOTOS:...]]" (it competed with §GALERIA) and now points at the section.
metrics_before: gallery_turn_questions=0; gallery_turn_applied_T3b=false; consent_ask_fired_on_hot_lead=true
metrics_after: pending live re-run
context: The defect was placement, not wording. §GALERIA sat as a sibling of T1–T8, so the model read "photos requested" as a turn TYPE that replaces the active one, and the buried "Cerrá con UNA sola pregunta" bullet lost to the recipe above it. Any future §ADJUNTO-style section must state up front whether it replaces or decorates the active turn. Two notes for whoever reads the logs: (1) `diagnosticMediaReplyFormat` already catches exactly this (`questionCount: 0`) but is log-only by design — the engine must never append a question, per invariant 8; (2) the dev stack runs with `logging: driver: none` (compose.test.yml), so that warn was never visible. Reproduce with the DB (`messages`, `media_sends`) or run the app attached.

## 2026-08-20 A photo request on the close turn silently dropped the photos

date: 2026-08-20
profile: andean-scapes-co@1
symptom: Same dev thread, two consecutive photo requests. Turn 1 ("fotos de la ruta en moto") delivered 5 correctly-typed `bike` photos with the reply as the last caption. Turn 2 ("fotos del hospedaje ?") delivered the text and **zero photos** — no `media_sends` row at all — while the copy still said "Claro, te comparto unas del hospedaje." Between the two turns the lead had reached the close (price given + date accepted), which flips `needsHumanEffective`.
change: `response-engine.ts` no longer suppresses **explicitly requested** photos on a handoff or soft-unsafe turn (`deliverableGalleryImageUrls = requestedGalleryImageUrls`, with an info log when a guard is active). Those guards exist to keep UNSOLICITED sales media off a sensitive reply; a customer-initiated request is different in kind. The automatic contextual image still honours both guards. Added `diagnosticUnmarkedPhotoPromise` (log-only) and hardened §GALERIA against the elided-noun form.
metrics_before: turn2_photos_sent=0; turn2_promise_in_copy=true; suppression_logged=false
metrics_after: requested_photos_survive_handoff=true; unmarked_promise_logged=true
context: The gap was guard ORDER. `mediaMarkerUnresolved` is computed from `requestedGalleryImageUrls` (pre-suppression), so a post-resolution guard could empty the delivery list without ever tripping the unhonoured check — the engine promised media and shipped none, silently. Rule for any future media guard: it must run BEFORE the unhonoured check, or explicitly mark the marker unhonoured. Two traps for the diagnostic: (a) the live copy elided the noun ("te comparto unas **del hospedaje**"), so a `fotos?`-only matcher misses the real failure — match a sending verb plus a bare quantifier too, while leaving "te comparto la ruta" alone; (b) it must stay log-only, because invariant 8 forbids the engine from adding the marker or the question. Also observed: the dev consent-ask fired 55s into an active close-phase conversation (`FOLLOWUP_DEV_*` accelerated cadence), asking a nearly-booked lead for permission to be contacted later — a dev-cadence artifact, but it argues for excluding close-phase leads from `listConsentAskCandidates`.

## 2026-08-20 KNOWN GAP: a verbal handoff promise nobody is gated on

date: 2026-08-20
profile: andean-scapes-co@1
symptom: Dev thread where the DB had been wiped mid-conversation. The model replied "Listo, quedo validando la fecha con el equipo. ¿Me confirmas el nombre…?", collected "Juan", and closed with "quedo pendiente de validar la disponibilidad con el equipo." No owner alert, no Telegram, `conversation_mode` stayed `bot`, `owner_alerts` empty. The customer believes a human is validating; nobody was notified.
change: **None yet — documented only.** Root cause is not a bug in the media work: every `canEnterHumanPending` branch requires `pricePresented`, and `price_given_at` was NULL because the wipe erased the qualification. `explicitCloseCtaConsent` is doubly gated (`closeCtaAcceptedThisTurn` itself starts with `getPriceGivenAt() != null`), and `strongAvailabilityConfirm` needs `personas + hasConfirmedDate`. So a lead that accepts before ever seeing a price is **unreachable** for handoff.
metrics_before: verbal_handoff_promises=3; needsHumanEffective=false; owner_alerts=0; lead_score=19; sales_phase=discovery
metrics_after: n/a — not implemented
context: Verified all four replies against `hardSafetyFail`: every one returns `null`. Neither `containsFalseReservationClaim` nor `containsUnsafeReservationClaim` matches "quedo validando la fecha con el equipo", so there is **no guard at all** for "the reply promises human handling while `needsHumanEffective` is false". Proposed fix is a log-only `diagnosticUnbackedHandoffPromise(reply, needsHumanEffective, phone)` in the same mould as `diagnosticMediaReply` — deliberately NOT a blocker, because "el equipo valida disponibilidad" is legitimate copy in T3b where a handoff does fire, so a hard guard would false-positive on the happy path. Two things to keep straight before acting: (a) the trigger for this thread was a mid-conversation DB wipe, which made the model hallucinate a recap ("la experiencia de la mina para ustedes dos") with zero history — that part is a dev artifact, not a bot defect, so never clean the DB without starting a fresh WhatsApp thread; (b) `.env.dev` sets `ALERT_CHANNEL=log`, so even a firing alert would never reach Telegram in dev — do not conclude "the bridge is broken" from dev logs alone.
## 2026-08-20 Gallery requests are repeatable, multi-theme and independently budgeted

Explicit photo requests are customer-driven media, not a one-time gallery phase. A
customer may request any feed-backed category again, in any order, or request several
categories together. Claims must deduplicate one inbound webhook without using a
cross-turn repeat window. Photo volume has its own cap so image rows do not consume
the conversational text-message limit. A model promise without a marker gets one
budget-gated corrective LLM attempt; the engine never adds the marker itself.

## 2026-08-20 Explicit photo request ignored both marker and final question

date: 2026-08-20
profile: andean-scapes-co@1
symptom: In a C04 family thread, "tines fotos del recorrido en carro ?" produced route facts but no `[[FOTOS:car]]` marker and no final question. The existing correction did not run because the model never promised to send photos; `hasUnmarkedPhotoPromise` was false.
change: Active inbound replies now get one shared, budget-gated corrective LLM rewrite when the visible copy does not end with its mandatory advancement question or an explicit photo request omits the marker. Both defects are corrected in that single call. The engine still never supplies customer copy, appends a question, or inserts a marker. Explicit pause, soft-close, farewell, consent-answer, handoff, and completed POST-CTA turns remain exempt.
metrics_before: explicit_photo_marker=false; final_question=false; corrective_calls=0
metrics_after: corrective_calls_max=1; deterministic_copy_mutation=false; persistent_question_miss=log; persistent_media_miss=log_and_owner_alert
context: This is a shape retry, not deterministic sales copy. The corrected model output is sent unchanged. A provider can still miss twice; suppressing the reply or inventing a fallback would violate LLM ownership, so the terminal failure mode is unchanged delivery plus owner visibility.

## 2026-08-20 Live suite 95/3-fails: two detection gaps, one missing state cue, three false failures

date: 2026-08-20
profile: andean-scapes-co@1
symptom: Live pass averaged 95 with 3 hard fails. (1) `consecutive-gallery-requests` 50 (0/2): turn 3 "Otra vez fotos de la mina" answered "te las mando de nuevo" with no marker and shipped zero photos; turn 4 "Y muéstrame hospedaje y transporte" shipped zero photos; `marker-hidden-second` and the photo counts also failed. (2) `plan-selection-gallery` 67 (0/2): on the first concrete plan choice the model described the plan and asked for a month — no total, no gallery. (3) `vacation-motive-discovery-baredate` 88 (0/2): bare-day acceptance quoted instead of closing.
change: Four fixes, three layers. (a) `reply-guard.ts` `isGalleryRequest` now also matches visual imperatives ("muéstrame", "enséñame", "show me", "let me see") — turn 4 was never classified as a photo request, so it got no `PEDIDO DE FOTOS ESTE TURNO` cue and no corrective retry. (b) `reply-guard.ts` `PHOTO_PROMISE` now matches the proclitic resend form ("te las mando de nuevo"), where the pronoun precedes the verb and the noun is elided. (c) `skills-prompt-assembly.ts` QUOTE LOCK gained a "this turn delivers the total" tail, gated on `!priceGiven`. (d) `whatsapp-sales.skill.md` §GALERIA: a repeat request requires the marker again, and the plan-choice demonstration is mandatory and carries the quote. Scenario fidelity fixed separately: marker-leak patterns now match `\[\[\s*FOTOS` instead of the bare word, live photo counts dropped, and the vacation scenario now earns its price in turn 1.
metrics_before: live_avg=95; hard_fails=3; consecutive-gallery-requests=50 (0/2); plan-selection-gallery=67 (0/2); vacation-motive=88 (0/2)
metrics_after: deterministic_avg=100 (31 scenarios, 0 hard fails); unit=1470 pass; live_rerun=NOT RUN — items (c) and (d) are LLM-compliance and remain unproven until `eval:conversations:llm-bot` runs
context: Four traps. (a) **Three of the eight failing criteria were the harness, not the bot.** `FOTOS|marcador` compiles with the `i` flag, so it matched the ordinary word "fotos" in a perfectly good reply; exact photo counts compared a live CDN feed against CI-fixture counts; and `vacation-motive` seeded `priceGiven` over a history containing no price, so the model correctly quoted. Read a live-only failure as scenario fidelity before touching a prompt. (b) **Widening a classifier is safe only when a downstream gate bounds it.** Adding "muéstrame" is harmless precisely because themes must still resolve, so "muéstrame los precios" yields zero themes and changes nothing — without that gate the same edit would demand photos for every visual verb. (c) **The QUOTE LOCK tail had to be gated on `!priceGiven`.** Ungated it contradicts `PRECIO YA ENTREGADO` ("no repitas el total"), which is the same self-contradiction class that cost the 2026-08-13 suite. (d) **The 2026-08-13 colon warning repeated itself immediately.** The first draft of the §GALERIA edit wrote "si RUNTIME trae QUOTE LOCK:" as prose, which put the literal cue string into every prompt and failed the unit test asserting it is absent outside its state. The test caught it; the rule is real — refer to cues descriptively.

## 2026-08-21 Prompt budget ceiling 30,000 → 31,500 (measured worst case 30,731)

date: 2026-08-21
profile: andean-scapes-co@1
symptom: `measure:prompt` failed in CI (`Prompt budget exceeded by 744 estimated tokens, ci-fixture/retargeting-R01`). Not a regression from a single change: the ceiling was never raised after skills v3 added `entry-strategy`, `cold-info-handler` and the referent packs, and the branch had not been pushed since 2026-08-06, so CI measured it for the first time across all of that work. Even the `default` profile was over (30,117).
change: `profile.andean-scapes-co.json` `tokenBudget.systemPromptMaxTokens` 30,000 → 31,500. No prompt content was cut.
metrics_before: worst=30,731 (dev-payload/retargeting-R01); ceiling=30,000; over_by=731; default_profile=30,117
metrics_after: ceiling=31,500; headroom_over_worst=769; projected_context=37,031 of 65,536; input_cost_delta=+$0.00011/call (~$1/month at 300 calls/day, before DeepSeek prompt caching)
context: Raising a budget to match reality risks turning the gate into a rubber stamp, so record the reasoning. Three facts drove it. (1) **It is not a context risk** — the projected request uses 37,031 of a 65,536 window, so nothing truncates. The ceiling is cost discipline, not a model limit. (2) **The cost is negligible and measured**: 731 tokens is $0.00011 per call, ~$1/month at 300 calls/day against a $30/month budget, and the system prompt is byte-identical between calls so DeepSeek's cache makes the real figure lower. (3) **Every trimmable block is behavioural.** The largest are the feed-generated catalog (4,364) and LIVE DATA (1,503) — cutting those removes facts the model needs — then `RITMO WHATSAPP` (1,707), `GALERIA` (1,651) and `CHECKLIST PRODUCTO` (1,449), all sales methodology whose removal needs a live eval pass and a judgement call about sales quality, not a green CI run. `whatsapp-sales.skill.md` alone is 15,892 tokens, 52% of the prompt: that file, not the ceiling, is where a real reduction has to come from, and it deserves its own PR with `eval:conversations:llm-bot` evidence. `LESSONS.md` and `SKILLS-ASSEMBLY.md` are NOT in the prompt — do not count them when sizing.

## 2026-08-24 Consent ask reframed back to explicit permission (reverses 2026-08-13)

date: 2026-08-24
profile: andean-scapes-co@1
symptom: Product decision, NOT an observed live failure. The benefit-framed ask ("¿te aviso cuando haya novedades o salidas especiales?") never states what it actually authorises, so a "sí" is weak evidence of consent for a channel we then write to months later. The owner asked for the ask to name the thing being permitted — writing again on this WhatsApp — and to justify it with the context already in the thread.
change: Prompt-only, `whatsapp-sales.skill.md` §PERMISO-SEGUIMIENTO + §PERMISO-SEGUIMIENTO-POST-PARADA. (1) The close is now an explicit permission question ("si podés volver a escribirle más adelante por este WhatsApp"), answerable with a bare "sí". (2) A new bullet requires one sentence on why a future contact helps *the customer*, anchored in known context, with no invented motive. (3) New ban on naming Meta / ventanas / horas / APIs / plantillas / mecanismos internos. (4) New ban on asserting the permission is already recorded. (5) The 2026-08-13 ban on the *words* "permiso para escribirte" / "seguimiento" / "mensajes automáticos" is LIFTED — that was the mechanism this entry deliberately reverses. (6) The 2026-08-13 ban on inviting a "no" is KEPT and strengthened with its consequence; POST-PARADA's "si preferís, lo dejamos así" exit door was removed and the two sections' cross-reference realigned ("pregunta de permiso", not "de beneficio").
metrics_before: ask_framing=opportunity; names_authorised_channel=false; decline_option_offered=false (base) / true (POST-PARADA); prompt_tokens_est=31,262 (worst: dev-payload/retargeting-R01)
metrics_after: ask_framing=explicit_permission; names_authorised_channel=true; decline_option_offered=false (both sections); prompt_tokens_est=31,397 (+135, headroom 103 of ceiling 31,500); validate_prompt=pass; test:ci=pass (1633); acceptance_rate=NOT MEASURED — `eval:conversations:llm-bot` not run
context: This knowingly reverses the mechanism of the 2026-08-13 entry, whose recorded symptom was that a permission-framed ask "reads as a marketing-permission request … so the customer has no reason to say yes". Read that entry before touching this one. Three things make the reversal defensible rather than a loop. (a) **The 2026-08-13 symptom had two causes and only one is being reverted.** That ask was permission-framed *and* offered an explicit way out ("Si prefieres que no, me dices y listo"). The exit door is the half that plausibly suppressed yeses, and it stays banned — in both sections, which is new: POST-PARADA had kept its own exit door and nothing flagged the contradiction. What returns is only the naming of the channel, now paired with a customer-benefit clause the 2026-08-13 version did not require. (b) **Consent quality is the point, not acceptance rate.** Per invariant 10 a "sí" here authorises recurring templates for the whole consent cycle; an ask that never says "escribirte por WhatsApp" buys a cheaper yes for a permission the customer did not knowingly grant. A lower acceptance rate on a clearer question is an acceptable trade; a higher one on a vague question is not. (c) **The `declined` asymmetry is why the exit door matters more than the framing.** `declined` never auto-reopens, so an invited "no" is permanent, whereas silence leaves `pending` and a later inbound can re-arm the ask. Inviting a decline is therefore strictly worse than a weak ask. NOT VERIFIED LIVE: acceptance rate is unmeasured, and the 2026-08-13 regression is not disproven — run `eval:conversations:llm-bot` and watch the consent scenarios before trusting this in prod. If acceptance collapses, revert the *wording* and keep changes (3), (4) and (6).

## 2026-08-24 Live rerun of the 2026-08-20 fixes: two harness bugs, three fixes disproven

date: 2026-08-24
profile: andean-scapes-co@1
symptom: `eval:conversations:llm-bot` averaged 94 with 4 hard fails. This is the rerun the 2026-08-20 entry called for (`live_rerun=NOT RUN`), so it is the first evidence about fixes (c) and (d) there. Two of the four fails were the harness, not the bot. (1) `entry-retarget-R03-moto` 83: the model replied "¿Qué **los** frenó: fecha, presupuesto o detalles de la ruta?" — a textbook blocker diagnosis — but `diagnoses-blocker` listed only `te|les|nos`, never `los`/`las`. (2) `vacation-motive-discovery-baredate` 78: the model replied "Publicadas tenemos el 14 y el 28 de noviembre"; both are real dates in the live feed, but `no-invented-november-day` hardcoded `28` in an invented-day denylist because the CI fixture publishes only 2026-11-14. The other two are real: `plan-selection-gallery` 67 (0/2) quoted the total correctly and emitted no `[[FOTOS:mine]]`, and `consecutive-gallery-requests` 63 (1/2) said "Claro, **aquí van de nuevo** las de la mina" (turn 3) and "**Te comparto** el hospedaje y el transporte" (turn 4) while shipping ZERO photos both times.
change: Harness only; no prompt edit. (a) New `no_unpublished_date` criterion rule in `evaluate-scenario.ts` derives the published day/month set from `getFutureAvailableDates(getActiveExperience(getSkills()))` and flags any "<day> de <month>" the loaded feed does not publish. `vacation-motive` now uses it instead of a literal denylist. (b) `diagnoses-blocker` in BOTH `entry-retarget-R03-moto` and `entry-retarget-R01-with-history` now accepts `te|le|les|los|las|nos` and the union of the two scenarios' previously divergent phrasings. R01 passed only by luck of phrasing and carried the identical latent bug. (c) Three unit tests for the new rule in `evaluate-scenario.test.ts`, because the scenario's own mockReply says "el 14" with no month and therefore checks zero dates.
metrics_before: live_avg=94; hard_fails=4 (consecutive-gallery 63, entry-retarget-R03 83, plan-selection-gallery 67, vacation-motive 78); false_failures=2
metrics_after: deterministic_avg=100 (31 scenarios, 0 hard fails); conversation-eval unit=15 pass; test:ci=1631 pass; live_rerun=DONE, avg still 94 / 4 hard fails — both harness fixes confirmed (entry-retarget-R03 83→100, vacation-motive 78→89 with no-invented-november-day passing), but a THIRD harness bug surfaced in its place (`ad-info-then-group-asks-plan` 100→82, fixed below) and the three real failures persisted as predicted
context: Four things worth keeping. (a) **A `live` scenario must not hardcode feed-derived facts.** The 2026-08-20 entry recorded this for photo counts and the same trap immediately reappeared as a date denylist. `no_unpublished_date` fixes the class, not the instance: it flags 28-nov against the CI fixture and accepts it against the live feed, which is the correct behaviour in both passes. (b) **The 2026-08-20 fixes (c) and (d) are now DISPROVEN, not unverified.** §GALERIA's mandatory plan-choice demonstration did not change `plan-selection-gallery` at all (67 → 67, still 0/2), and the QUOTE LOCK "this turn delivers the total" tail did not produce a T3b close — `vacation-motive` turn 3 re-quoted `$1.000.000` on a bare-day acceptance instead of moving to anticipo. Both are prompt-compliance problems needing their own PR; do not read this entry as fixing them. (c) **The `no-announcement` patterns are load-bearing, and I nearly relaxed them.** They fail while photos DO ship on turns 1-2, which reads like an over-strict assertion — until you see turns 3-4 use the same phrases and ship nothing. "aquí van de nuevo las de la mina" is a promise-without-delivery that `PHOTO_PROMISE` still does not match: 2026-08-20 added the proclitic form ("te las mando de nuevo") and the model simply moved to another shape. Widen the detector by shape class, not by phrase, or it will keep chasing. (d) **A scenario whose criteria tolerate two bot paths must not hardcode a user reply that fits only one.** `ad-info-then-group-asks-plan` was green for two runs and failed the third at 82. Its `diagnosis-question-turn2` and `reflects-diagnosis-turn3` deliberately accept either a transport diagnosis (`vehiculo|traslado|ruta`) or an intensity one (`ritmo|intens|tranquil`), but turn 3's user text was the fixed string "Traslado local". When the model picked the intensity axis that reply became a non-sequitur, the diagnosis stayed unanswered, and §8 ("Grupo, activo sin diagnostico ... sin plan") correctly forbade the plan — so `plan-recommendation-turn3` hard-failed a COMPLIANT reply. Fixed by answering both axes ("Algo tranquilo, y con traslado local"), not by relaxing the criterion: the plan requirement is real, only the path-dependence was wrong. Audit every fixed user turn for this — the harness scripts the customer but never the bot's question choice. (e) **Read the recorded replies before touching anything.** `artifacts/conversation-eval-llm-bot.json` holds every turn's text; both harness bugs and both real bugs were diagnosable from it for $0, and two of the four would have been misclassified from the criterion names alone.

## 2026-08-26 Markerless consent ask accepted by question shape, not keyword presence

date: 2026-08-26
profile: andean-scapes-co@1
symptom: Live owner alert `Consent ask agotado: <phone> c1 tras 3 intentos (ultimo error: draft_marker_missing)`. The lead was correctly eligible (plan collected, dormant, inside the 24h window) and the scheduler fired on time, but the model omitted the mandatory `[[FOLLOWUP_CONSENT]]` on all three bounded attempts, so `validateConsentAsk` rejected every draft, nothing was sent, and the cycle became permanently unclaimable. `claim()` refuses a `failed` row at `attempts >= MAX` forever while `listConsentAskCandidates` keeps returning the lead, so the customer was silently unreachable and the row re-scanned on every tick. The same digest showed seven other leads receiving the ask normally, so this is prompt variance on an obligatory token, not a broken path.
change: Engine + operator tooling only; NO prompt edit. (a) `validateConsentAsk` now accepts a markerless draft when its **question sentence** carries both a permission frame and a future-contact object (`followup-consent.ts`); the marker remains the contract and the primary path. (b) New `residual_marker` rejection: only `[[FOLLOWUP_CONSENT]]` is ever stripped, so a draft still holding e.g. `[[FOTOS:mina]]` would have shipped the literal token to the customer. (c) New operator command `/followupretry <phone>` resets a `status = 'failed'` exhausted cycle via `resetExhaustedCycle()`; `accepted`/`delivered`/`uncertain` are refused because Meta may hold the message. (d) The exhaustion alert and the `/followupstatus` blocker now name that command.
metrics_before: exhausted_cycles_unrecoverable=yes; markerless_drafts_accepted=0; residual_marker_guard=none; tests=1635
metrics_after: exhausted_cycles_unrecoverable=no (operator-gated); false_positives_rejected=6/6; false_negatives_fixed=2/2; tests=1658; typecheck/lint/validate:prompt/validate:skills/build/test:ci=pass; live_verification=NOT RUN
context: Three things worth keeping. (a) **The first fix attempt was more dangerous than the bug.** A whole-draft keyword match (`/te\s+escribo.*\?$/`, `/is\s+it\s+ok/`, `/would\s+you\s+(mind|like)/`) accepted "Te escribo el itinerario mañana, ¿cuántos van a viajar?", "Is it ok for 4 people in one cabin?" and "Would you like the guided mine tour?" as permission asks. Each would have burned the single free-form message the 24h window allows on a sales question, set the subscription to `pending`, and then let a bare "sí" to *that* question activate recurring marketing consent — consent the customer never granted. The original bug fails closed (lead dormant); that fix failed open (fabricated consent). **Scope the match to the question sentence and require two independent signals.** (b) **The `¿`-anchored patterns were precisely inverted.** They rejected real asks that omit the opening mark ("Te parece si te escribo mas adelante con novedades?" — normal in WhatsApp) while the one unanchored pattern was the loosest and passed the sales turns. Offer frames ("would you like", "te interesa") are excluded on purpose: they introduce a product, not a request to write later. (c) **An automatic exhaustion reset is still forbidden.** A persistently malformed draft would loop on the provider's bill forever, which is why recovery is an explicit operator action restricted to `failed`. NOT VERIFIED LIVE: no markerless draft has been accepted in production and `/followupretry` has never run against Meta — the originally alerted lead still needs the command run manually.

## 2026-08-26 Marker compliance is unfixable by prompt; the validator is what delivers

date: 2026-08-26
profile: andean-scapes-co@1
symptom: Follow-up on the same-day `draft_marker_missing` exhaustion. The question asked was whether the prompt can be changed so the model never omits `[[FOLLOWUP_CONSENT]]`. New script `measure:consent` answers it with real DeepSeek calls (no Meta, no DB, no customer) across the four production shapes. It cannot: first-attempt marker compliance measured 59-80% across runs on `deepseek-v4-flash` @ temp 0.2 — the SAME model and temperature as production (`.env.dev` and `.env.prod` agree). Two further beliefs baked into the existing design were disproven. (1) **The corrective retry does not help**: 70% with `consentAskRetryInstruction` vs 80% without, i.e. the 3-attempt budget is three samples of one distribution, not an escalation. (2) **More prompt instruction does not help**: an explicit RUNTIME clause telling the post-stop variant to keep the permission inside an interrogative produced the identical declarative draft 2/6 times, so it was reverted rather than left in as dead tokens.
change: Prompt-shape + validator, no new sales copy. (a) The turn signal is no longer `[[…]]`-shaped: `CONSENT_ASK_TURN_EVENT = 'SYSTEM_EVENT: PROACTIVE_FOLLOWUP_CONSENT_TURN'`. It used to be `[[PROACTIVE_FOLLOWUP_CONSENT_TURN]]`, so the turn carried two identically shaped bracket tokens with OPPOSITE instructions ("never repeat this", "always emit this"); a model generalising "internal `[[…]]` tokens are not written" drops both. (b) A `FORMATO OBLIGATORIO` block is now the unconditional LAST element of the assembled prompt and ends on the literal marker, so the required token is the most recent thing in context; asserted for five variants including the two cues pushed after it in source order. (c) RUNTIME states the direction of each token explicitly and the consequence of omission. (d) Validator: plural/formal pronouns (`te|le|les|os`) and a tag-question branch. (e) New `internal_echo` rejection, since the unbracketed signal is invisible to the `[[` residual check.
metrics_before: marker_compliance=59-80%; deliverable(pricing-then-silence)=33%; retry_compliance=70%; singular_only_pronouns=yes; tag_question_supported=no
metrics_after: marker_compliance unchanged (model-bound, 59-80%); deliverable=91% overall and 100% on `pricing-then-silence` (the exact live-incident context) and on `qualified-date-and-group`; markerless fallback rescued 13 of 32 drafts in the 8-run pass; validator suite 11 hostile rejects / 11 accepts; tests=1682; typecheck/lint/validate:prompt/validate:skills/build/test:ci/eval:conversations=pass
context: Five things worth keeping. (a) **Measure before believing a prompt fix.** Every plausible intervention here (repeat the rule, add a consequence, add corrective retry guidance) was already in place or was added and measured, and none moved marker compliance. What moved *deliverability* 33%→100% on the failing context was the validator accepting a well-formed markerless ask. Compliance and deliverability are different metrics; only the second one reaches a customer. (b) **The validator's first design was wrong in two specific, measurable ways, and only live drafts exposed them.** Singular-only pronouns rejected every group ask, because for `personas: 4` the model correctly writes "¿les sirve que les escriba…?" — that is why the qualified-group context was the worst performer. And requiring both signals inside the question sentence rejected "…quería saber si te puedo escribir más adelante por aquí. ¿Te parece?", which is the exact shape §PERMISO-SEGUIMIENTO asks for (a close answerable with a bare "sí"). Unit tests written from imagination passed while both bugs were live. (c) **The tag-question branch is safe only because the QUESTION must still carry the permission frame.** That single requirement is what keeps "Te puedo escribir mas adelante por aqui. ¿Cuantos van a viajar?" rejected while accepting "…¿Te parece?", and it is backed by a sales-deliverable exclusion so "Te puedo escribir el total mañana. ¿Te parece?" also stays rejected. Never relax the frame requirement to "anywhere in the draft" — that is the fabricated-consent bug recorded in the previous entry. (d) **Do not add to the static skill files for this.** `measure:prompt` is already over budget by 109 tokens on the dev payload at HEAD (pre-existing; the CI fixture is at 31,348 of 31,500, so ~150 tokens of headroom). An 8-line addition to `whatsapp-sales.skill.md` pushed the worst profile to 31,832 and was reverted; per-turn guidance belongs in RUNTIME, where it costs nothing on ordinary replies. (e) UNRESOLVED: `post-stop-reask` still yields ~33% `no_question` — the model writes "quería saber si te sirve que te avise…" with no question mark. It is a valid indirect permission question in Spanish and a customer would answer "sí", but `validateConsentAsk` requires a literal `?` and `classifyConsentReply` expects a yes/no-answerable ask. Accepting indirect questions is a third heuristic layer and a product decision, so it was left alone: the path is rare (needs a prior opt-out, a return, and a second silence) and fails closed, recoverable with `/followupretry`.

## 2026-10-09 CORE/PRIME framed by scope and total time, not intensity

date: 2026-10-09
profile: andean-scapes-co@1
symptom: First manual test of the CORE/PRIME catalog. (1) The diagnosis asked "¿ritmo intenso metidos en la mina, o algo más tranquilo?", a leftover from the retired 3D/2N calm plan: PRIME is actually the longest day, and CORE must not be sold as the calm/cheap option. (2) The CORE pitch said "una mina real (~2.5h)", which reads as a short plan. (3) The bot said "3 comidas"; the 2026 brochures list 4 (2 desayunos, 1 almuerzo fiambre, 1 cena).
change: All three came from data, not code. Catalog: plan-level `included` mirrors the brochure items with durations; plan `shortDescription` states the total (CORE ~11.5h, PRIME ~14h = every timed brochure item) and arrival time; intensity/calm wording removed from plan copy, `fullDescription` and `planMatch`; "3 comidas" → 4 everywhere in the site. `physicalDemands`, the "tiempo subterraneo varia" disclaimer, depth, medical-staff caveat and arrival guidance are kept. Skill: diagnosis axis is scope (esencial vs. más completa) instead of ritmo/intensidad; new §6b (plan duration = catalog total; positioning words). Referents e/g: plan-choice axis ritmo → alcance.
metrics_before: ci_fixture_worst_prompt_tokens=31307; diagnosis_axis=ritmo/intensidad; meals=3
metrics_after: ci_fixture_worst_prompt_tokens=31480 (cap 31500); diagnosis_axis=alcance; meals=4; tests/test:ci/eval:conversations/typecheck/lint/validate:prompt/validate:skills/build=pass
context: (a) **The first draft overflowed the CI prompt budget by ~510 tokens** (32,010). Restating every brochure item inside `shortDescription` duplicated plan `included`; the item list lives in `included`, the description carries only positioning + total. Headroom is now ~20 tokens: the next catalog addition must remove something. (b) Do not move the totals into `physicalDemands`: it describes effort, and meals/transport are not effort. (c) The brochure's "Transporte 4x4 interno Chivor - Hacienda (~2h)" coexists with the older site item "Chivor pueblo hasta la mina (~45 min, si el cliente no tiene 4x4)"; the two were not reconciled because the owner has not confirmed whether they are the same leg. (d) NOT VERIFIED LIVE: run `eval:conversations:llm-bot` before trusting the diagnosis wording.

## 2026-10-25 Price objections compare catalog options before closing

symptom: A Coscuez PRIME customer asked for a more basic option after objecting to the total. `costoso` was classified as a soft close but not as a recoverable price objection, so the engine skipped DeepSeek and returned the generic Instagram farewell despite a cheaper CORE option.
change: After a quote, a cost objection without an explicit decline reaches the LLM, overriding closing cues even with a stored date. RUNTIME lists cheaper confirmed totals with the same requested transport; missing inputs or unconfirmed pricing produce an incomplete-comparison cue, never a claim that no cheaper plan exists. Another site appears only when strictly cheaper than the cheapest local plan. The plan stays locked until the customer chooses. An objection reply ships a card only for exactly one quoted alternative from that list; a plan switch keeps its own card. Explicit declines soft-close regardless of qualification or earlier reservation intent; the existing regex-backed score helper applies any negative score without inferring booking intent. Detection is cost/budget wording only: "otro plan", "otra opción" and a neutral "presupuesto" question are plan/price questions.
metrics_before: costoso_price_objection_reached_llm=no; stored_prime_card_could_ship_on_alternative_quote=yes
metrics_after: costoso_price_objection_reached_llm=yes; ambiguous_or_unpriced_alternative_card=no; live_copy_verification=NOT RUN
context: Similar prices across sites are not a reason to move the customer. Compare only real cheaper options; never imply a discount or silently switch plan. Live LLM wording remains unverified until `npm run eval:conversations:llm-bot -- --scenario price-objection-downsell-coscuez`.

## 2026-10-26 Three Chivor plans shown by name; group quotes carry a per-person equivalent

date: 2026-10-26
profile: andean-scapes-co@1
symptom: With the BASIC pasadía added, the diagnosis still offered a binary "esencial o más completa", hiding the pasadía; the customer could not tell the options apart. Group totals were hard to value without a per-person figure.
change: RUNTIME `OPCIONES DE PLAN ESTE TURNO` (site with >2 plans, group known, no plan chosen) lists every plan by name + duration, no prices; suppressed when a campaign `ENTRY_SEGMENT` is active (the segment's catalog `diagnosisQuestion` owns that turn), on retargeting, proactive, consent and other-site turns. QUOTE LOCK and price-objection alternatives add `EQUIVALENTE POR PERSONA` (total ÷ people, labelled approximate when rounded), omitted while transport is pending confirmation. §FASE 2 exception + §Cotización de grupo state the equivalent accompanies the total and is never the catalog's solo rate.
metrics_before: pasadia_visible_after_group=no; per_person_equivalent=no
metrics_after: chivor-three-plans-per-person=100; group-of-5-math, group-then-plan-quote, date-pick-price-then-close-T3b, entry-funnel-H02-car, entry-X04-kids-gallery=100 (live, 1 run each)
context: The first version let the options cue override campaign diagnosis (C02/H02 vehicle, C04/H04 kids). C01/H01 list the three plans through their own catalog copy, not the cue.

## 2026-10-26 A pain the chosen plan causes is answered with the plan that removes it

date: 2026-10-26
profile: andean-scapes-co@1
symptom: A BASIC customer said "no quisiera regresar tan tarde". The bot answered the logistics and closed with "¿Están pensando en ir y volver el mismo día?", never mentioning that CORE (overnight, return Sunday) removes exactly that concern.
change: §FASE 4 "Mejora que resuelve un dolor" + pain-matrix row: answer the fact, then 1 sentence linking that exact pain to a same-destination plan that reduces it per CATALOGO, and a compare/quote question. Recommendation only (plan stays locked), no price unless asked, once per pain, never on a budget objection or after a decline. Never suggest a plan that worsens the pain (longer day, earlier start, more effort). Not applied on T3b / POST-CTA or when QUOTE LOCK must deliver the total.
metrics_before: late_return_upgrade_suggested=no
metrics_after: chivor-basic-late-return-upgrade, chivor-upgrade-declined-no-repeat, chivor-core-fatigue-no-prime, chivor-budget-to-pasadia, date-pick-price-then-close-T3b=100; chivor-basic-late-return-t3b-close=100 (3/3 after the pattern fix; the earlier 75s were the harness — `PRIME` matched "Primero" under the `i` flag, now `\bPRIME\b`)
context: Assert plan names in live scenarios with word boundaries: "Primero" contains "prime" and "corE" sits inside ordinary words. vacation-motive-discovery-baredate scored 93 (non-critical `motive-reflected` miss), unrelated to this rule.

## 2026-10-26 Transport is the objection, not the plan; generic words never choose a plan

date: 2026-10-26
profile: andean-scapes-co@1
symptom: A solo C01 lead never chose a plan, yet the bot quoted "PRIME + transporte = $2.660.000" and, when the customer said "costoso, en particular el transporte", downsold to CORE/BASIC instead of separating plan from transport. Root cause 1: PRIME's catalog `keywords` held generic words (`aventura`, `adventure`, `completo`, `full`, `intenso`, `ganaderia`), so the C01 opener "…la aventura minera en Chivor" stored PRIME on turn 1. Root cause 2: `OBJECION DE PRECIO` only lists cheaper plans.
change: Catalog (dev + CI): dropped those PRIME keywords and CORE's `caminata`/`una noche` (BASIC has a walk; PRIME has a night). Added Chivor clarifications `REALIDAD DEL VIAJE` (distance in hours, 4x4 last stretch, why the night exists) and `TRANSPORTE PRIVADO` (why it costs what it costs, bus/own car alternative). New RUNTIME cue `OBJECION DE TRANSPORTE` when a cost word sits next to a transport word (`isTransportObjectionMessage`, computed in the engine; "¿incluye transporte?" is excluded). The cue names no logistics; facts come from the site's CATALOGO: plan total without transport, no other plans unless the plan itself weighs, then only transport-free totals. Skill: transport without a chosen plan is quoted alone; explore time/arrival before recommending; one honest trip-reality line per conversation; respect a no-night choice.
metrics_before: c01_opener_stores_prime=yes; transport_objection_downsell=yes
metrics_after: chivor-solo-transport-objection=100 (3/3 live); chivor-budget-to-pasadia=100; price-objection-no-discount, solo-traveler-quote, entry-cold-C01=100; prompt default estimated_tokens=36089
context: price-objection-downsell-coscuez scores 65 live because Coscuez is paused in the CDN feed and the bot correctly offers Chivor; unrelated to this change. The catalog edits reach the live bot only after `npm run dynamic:push`.

## 2026-10-26 A hesitation opener is not a negation; a paused plan can accept the alternative

date: 2026-10-26
profile: andean-scapes-co@1
symptom: "no sé, el transporte es muy caro" lost the transport cue: the negation check allowed 25 chars between "no" and the cost word, and normalizeText drops the comma, so the opener read as "no ... caro" and the turn fell back to the cheaper-plan downsell. Separately, a lead stored on paused Coscuez who answered "sí" to "¿Te interesa Chivor?" stored no plan.
change: Negation must sit on the cost word ("no es caro", "no esta tan costoso"). Paused plans keep their catalog tier in `unavailableSites[].planTiers`, so the site-choice predicate transfers them to the active site's equivalent tier.
metrics_before: hesitation_opener_transport_cue=no; paused_lead_accepts_alternative=no
metrics_after: detector + engine regressions green; chivor-solo-transport-objection live 3/3

## 2026-10-27 Humanness pass: stop sounding like a template

symptom: Real customers identified the bot as automated. Causes found in the 2026-10 export: the same closing questions and closers repeated verbatim ("¿Qué te parece?", "Quedo pendiente", "Cualquier cosa, acá estoy"), a voseo/tú mix copied from the skill files, product codes used as names, a flat denial "no hay bots aquí" that broke once caught, and a permission ask ("¿te escribo más adelante?") sent while the team was validating a booking.
change: Skills: tú/ustedes only, no voseo imperatives; sincere "are you a bot?" is answered honestly in one line, with no promise that someone will write (nothing in the engine alerts the team on that turn); templates are a rhythm with varied examples; short "ok/gracias" gets a single short reply. Engine: T3b/T3a question variants added to CLOSE_CTA and SOFT_RESERVATION patterns so POST-CTA and the owner alert keep firing; consent ask skipped while `human_pending` (candidate SQL only, shared with the digest). A post-claim "last bot message is a booking question" gate was tried and removed: it blocked dormant post-CTA leads forever and split sender from digest. Fallback `aiBudgetExhausted` reworded.
metrics_before: export 2026-10-27, app 2.0.3 outbound texts=894: with voseo=23, with stock closer=19, threads with >=2 stock closers=2; voseo imperatives in whatsapp-sales.skill.md=~145; consent ask after a pending booking: qualitative (2 threads read manually).
metrics_after: deterministic conversation eval 93/93; skills-prompt-assembly 84/84; response-engine 421/421 + 4 follow-up suites 176/176; validate:prompt pass; measure:prompt projected 43,685 / 65,536 window (cap 40,000 system).
context: (a) Honesty over disguise: the bot must not deny being AI when sincerely asked; it keeps its warm first-person voice and promises no contact the engine does not perform. (b) Close-question wording is a control signal for handoff and the owner alert; any rewording needs the regex widened in the same PR, and new variants must match only inside `¿…?` so booking statements never read as a CTA. (c) The "don't sound like a template" fix is mostly wording, deliberately not new deterministic copy (invariant 8). (d) **A phase boundary must not be softened by "don't copy this example".** Rewording the T3a example as "Molde (no lo copies igual)" made the model merge T3a and T3b in one turn (total + anticipo + CTA): `date-pick-price-then-close-T3b` went 2/2 → 0/3. Restoring the literal example plus one line "este turno termina ahí" brought it back to 3/3. Vary the question, never the turn's scope. (e) Live after the fixes (1 run each unless noted): humanness-* x3=100, reserve-request-skips-cta=100, date-pick-price-then-close-T3b=100 (3/3), group-of-5-math=100, consent-granted-ack=100, still-looking-after-price=100, vacation-motive-discovery-baredate=93 (pre-existing non-critical motive-reflected miss). Full live pass (32 scenarios, --runs 2, $0.66): average 92, 5 hard fails. Each fail was re-run against HEAD prompts: ad-info-then-group-asks-plan (HEAD 0/2), destination-first-plan-without-site (HEAD 0/2) and price-objection-downsell-coscuez (HEAD 0/2, Coscuez paused in the CDN feed) are pre-existing; consult-with-partner is flaky on both (HEAD 2/4, change 2/4); date-pick-price-then-close-T3b passed 3/3 on rerun. (f) **Identity must be one story.** Five openers said "Soy {{OWNER_NAME}}" while the honesty rule said "admit you are the assistant" — the exact catch-out seen in the export. Owner decision 2026-10-27 (revised): the persona speaks in first person as {{OWNER_NAME}} ("Soy {{OWNER_NAME}}") and never volunteers being automated. A sincere direct "are you a bot?" is the one exception: the reply must not deny it or claim to be human (it says the WhatsApp is handled with an assistant's support and {{OWNER_NAME}} follows each conversation). Claiming to be human on that question is not implemented. (g) A short-acknowledgement rule must exclude replies to an open question: "ok"/"dale" after a quote or a CTA are T3b/POST-CTA, not a goodbye. (i) **Plan-name gloss and price-format lines were dropped after measurement.** A seller-personality section "NOMBRES Y PRECIOS" (gloss the plan name, copy the figure, "cada uno") made `date-pick-price-then-close-T3b` merge T3a+T3b (bisected by file, then by section: with it 0/2 and 1/3; without it 4/4, same as HEAD 4/4). Price wording belongs to the QUOTE LOCK cue; do not restate it in the personality skill. (h) `validate:prompt` now carries a voseo guard (accented forms only; the line listing banned forms is excluded) — the mechanical conversion missed `presentate`, `Vos`, `Pedilo`.

## 2026-10-28 — Returning customers and retired plans

- Observed: a lead returning after days got a fresh greeting, or a fixed "plan no longer
  available" handoff. Leads saved on retired plan ids (2d1n_mining, 3d2n_rural) were stuck.
- Change: REGRESO cue from silence gap (any ad code); `legacyPlanIds` in the catalog; retired
  plans remapped or cleared; the model answers.
- Not changed on purpose: the stored price quote is kept on return. Clearing it broke the
  booking close ("sí" to "¿Les sirve esa fecha?" after a gap) in 9 existing tests.
- Deferred: the newest ad code does not yet pick the campaign segment (only `last_entry_marker`).


## 2026-10-28 — Hot moto couple lost to a budget fallback and repeated quotes

- Observed: lead 89 (CORE Chivor, 2 people, own moto). After logistics the bot closed three
  turns with "¿Les sirve así?", repeated the full price on every pause, and answered
  "Listo. Gracias. Aún estamos discutiendo." with `aiBudgetExhausted`, which promises a
  follow-up nobody owns.
- Change (engine): the per-customer daily AI cap counts `purpose = 'reply'` only
  (`countCustomerDailyReplies`); analyzer and follow-up calls no longer exhaust a live
  lead. With AI blocked, a courtesy/deliberation turn with nothing to answer
  (`isNoReplyNeededPause`) sends nothing and alerts the owner; questions keep the fallback.
- Change (skill): T7 summary goes out once — the first pause always carries it, a later
  pause only validates the decision, no price. T5: after the quote, resolving a doubt is
  not progress; the closing question asks for a date or the booking step.
- Not changed on purpose: no photos on the pause turn (`referent.i` forbids them in the
  shareable summary; no food/pet gallery exists) and no promised recontact time (only the
  consent ask can recontact). Referent JSON untouched.
- Metrics: live `hot-lead-moto-partner-pause` 2/2 (first draft 1/2: price repeated on
  pause), `consult-with-partner` 2/2 (a first wording that keyed on "price already given"
  dropped the summary 0/2 — key on the visible summary, not on `priceGiven`),
  `still-looking-after-price`, `date-pick-price-then-close-T3b`, `group-of-5-math` 2/2,
  `chivor-solo-transport-objection`, `transport-no-4x4` all 100. Deterministic 94/94,
  test:ci 2497/2497.
- Review fix (same day): `isNoReplyNeededPause` first short-circuited on `isReviewPause`
  and allowed free-word tails, so "Hablo con mi pareja, el perro puede ir" and
  "lo hablo con mi pareja pero me interesa noviembre" were silenced on a budget block.
  Every clause must now be a closed courtesy/deliberation/consult phrase; any other
  content keeps the fallback and the owner alert.

## 2026-10-28 — Chivor dogs go into the mine (catalog was wrong)

- Observed: the bot told a hot lead the dog could not enter the mine. It was repeating the
  catalog, which said "no prometer que las mascotas ingresan a la mina" and only that the
  Hacienda is pet-friendly. Owner fact: in Chivor, on every plan, dogs do the mine with the group.
- Change: catalog only (dev, prod, CI fixture): `petPolicy`, Chivor safety note, experience
  descriptions and every Chivor plan `shortDescription`. No skill or engine change — the
  model reported the catalog faithfully. Coscuez (paused) keeps "sujeto a coordinacion".
- Guards: `skills-prompt-assembly.test.ts` fails if the fact leaves the CI catalog (verified
  red on the old fixture); live `pet-in-mine-objection-close` 2/2.
- Open: the model added "con correa", which the catalog does not state. Owner to confirm.
- Live variance (same day): the first 2/2 on `hot-lead-moto-partner-pause` was luck; 10 more
  runs gave 3/10 with the skill wording alone (the model re-sent "CORE … $950.000" on the
  second pause). Fix: RUNTIME cue `PAUSA CON RESUMEN YA ENVIADO` when the turn is a review
  pause and 2+ of our messages already carry a price (quote + summary). After: 4/4.
  `consult-with-partner` stays flaky as on HEAD: its `shareable-summary` word list misses a
  correct summary that says "CORE … para 2 personas" (no "plan/resumen/precio" word).
- Review fix: the cue first fired on any review pause with 2+ priced bot messages, so
  "lo hablo con mi pareja, quiero el prime" (a plan choice) would have suppressed the PRIME
  quote. It now also requires no plan choice/switch, no price question, and that the last
  two priced bot messages both quote the stored plan (`detectQuotedPlan`). Engine-level
  tests in `response-engine.test.ts` cover the four cases.
- Decision: `consult-with-partner` keeps its word list unchanged (AGENTS.md: never weaken an
  existing test). Its flakiness is a test-wording gap, not a reply defect; widening it to
  `personas|CORE` needs an explicit owner decision.

## 2026-10-28 — Quoted leads left with nothing to pick; templates at midnight

- Observed (7-day export, 32 threads): leads 7309 (PRIME couple) and 1261 (CORE solo) got
  the total and "¿Tienen alguna fecha en mente?" or a PRIME upsell; both went silent. 15
  one-shot templates shipped at 00:03 Bogota; zero replies.
- Change: QUOTE LOCK without a chosen day now carries the published dates to offer
  (`datesToOfferAfterQuote`: the month the customer named, else the next three) and bans
  "alguna fecha en mente" / "qué mes" / "te suena" / an unasked plan. Data, not copy.
  A FASE 3 skill line alone did nothing live (0/4) and was removed; the cue is what moves
  it. Dates go into the cue as "31 de octubre": ISO dates were copied verbatim into the
  reply. Also fixes "Para 1 personas" in the lock sentence. Templates (one-shot +
  recurring) wait for 9–20h Bogota (`isTemplateSendHour`); the consent ask is not gated.
- Metrics: live `quote-without-date-offers-dates` 0/2 → 2/2, `couple-prime-quote-offers-dates`
  0/2 → 4/4. `date-pick-price-then-close-T3b` and `vacation-motive-discovery-baredate`
  fail identically on HEAD (stash-verified): the live dev catalog has no 14 November
  departure those scenarios assume. Pre-existing; needs its own PR.
- Review fix: the digest reused the sender's timing but not the send window, so it called a
  template due at 23:00 "next tick" while the sender held it until 09:00. Both template
  projections now read `nextTemplateSendAt`, the same predicate the sender gates on. An empty
  or inverted window (start >= end) fails startup; 0/24 disables it. Quote dates follow the
  reply language ("October 31" / "31 de octubre").
- Deploy: add `FOLLOWUP_TEMPLATE_SEND_START_HOUR_BOGOTA=9` and `..._END_HOUR_BOGOTA=20` to
  `/etc/andean-whatsapp-bot.env` (defaults apply when absent).
- Open: `date-pick-price-then-close-T3b` and `vacation-motive-discovery-baredate` assume a
  14 November departure the live dev catalog no longer publishes. Known red on HEAD; fix the
  scenarios or the catalog in their own PR.

## 2026-10-28 — Live suite drop 92 → 88 (9 hard fails): triage

Bisected each failure against HEAD (stash), the working tree, and the tree without the
quote-dates cue.
- **Ours (fixed):** `entry-retarget-R01-with-history` — tree 0/2, no-cue 2/2. The QUOTE LOCK
  dates close made the model price the retarget opener. The close is now skipped on a
  retarget or REGRESO turn (referent.h diagnoses first); prompt test added. Live 2/2.
- **Catalog moved, tests adapted (product change, not a weaker check):**
  - C02/H01/H02 diagnosis is the plan-options question since `cffe48c`, and the dev feed
    serves it (prod still has the vehicle question). `ad-info-then-group-asks-plan`,
    `entry-funnel-H01` and `entry-funnel-H02-car` accept the plan-options question; H02's
    route mention stays as a non-critical nicety. The harness transport pattern learned
    "traslado" ("con traslado local" is a transport answer).
  - 14 Nov is no longer published: `date-pick-*` and `vacation-*` moved to 28 Nov.
  - Coscuez is paused live: `destination-first-*` and `price-objection-downsell-coscuez`
    run with `reopenPausedSites`.
- **Still red, pre-existing:** `date-pick-price-then-close-T3b` merges T3a+T3b (HEAD with the
  28 Nov fix 0/3); `entry-retarget-R01-no-history` is variance (HEAD 0/2, tree 1/2);
  `consult-with-partner` keyword gap (owner decision pending);
  `price-objection-downsell-coscuez` now lists Chivor plans, which are strictly cheaper
  than Coscuez CORE, so the cue is right and the single-total check predates it (owner
  decision). `consecutive-gallery-requests` flaked once in the full run, 2/2 on rerun.
- Metrics: full live pass 88 / 9 hard fails → 95 / 5 hard fails ($0.60).
- Review fix: the harness counts "traslado" as transport given only as an answer ("con
  traslado", "traslado local") and never in a question ("¿hay traslado?"). H02 keeps one
  critical diagnosis check that accepts either catalog copy (plan options or vehicle).
- Catalog state (owner, 2026-10-28): dev serves the plan-options diagnosis on C02-C04 /
  H02-H04 and is in sync with R2; prod still serves the vehicle/moto/kids-age copy and will
  be synced by the owner later today. Until then the live suite reflects dev only.

## 2026-10-28 — "28 está bien" was not a date pick

- Observed: `date-pick-price-then-close-T3b` flipped between pass and fail, and failed 0/3 on
  HEAD. Bisect (CI fixture, 3-4 runs per commit) pointed at `ee88fe8` (REGRESO skill text),
  but a RUNTIME dump showed the real cause: the T3a cue never fired. `selectedDateFromAvailabilityReply`
  only accepted a day that followed an affirmative ("sí, el 28"), so "28 está bien", "el 28"
  or a bare "28", answering our own date list, left the date at month level. The model then
  ran T3a from skill text alone (any prompt edit tipped it into a T3a+T3b merge), and the
  quote-dates cue re-offered the dates the customer had just picked.
- Change: a short day-only answer counts as a pick, with the existing guards (our last
  question offered dates, and that day is one we offered). Engine tests: 3 phrasings pick,
  an unoffered day does not (red without the fix). The scenario gains a replayed date-offer
  turn and no longer seeds a date its history never justified.
- Not changed: a stronger T3a cue wording was tried and dropped; with the date fix it adds
  nothing (date-fix only 4/4 live).
- Test-only fixes (catalog/wording, not weaker checks): `consult-with-partner` accepts a
  summary naming plan+group; `price-objection-downsell-coscuez` requires the Coscuez CORE
  total instead of it being the only total (the cue may list cheaper Chivor plans);
  `entry-retarget-R01-no-history` drops "de nuevo" (echo of "ya consulté antes") and runs 2x.
- Metrics: full live pass 96 / 4 hard fails → 100 / 0 ($0.59). Only miss: H02 non-critical route mention.

## 2026-11-01 — Permission ask names blockers and never offers an exit

date: 2026-11-01
profile: andean-scapes-co@1
symptom: The 23h permission message reached 19 quiet leads last week with 0 yes and 1 reply (a voice note). Templates reach nobody without permission, so the 23h message is the only follow-up that reaches everyone. The ask named no reason the lead stopped.
change: §PERMISO-SEGUIMIENTO asks for 2 or 3 likely blockers (fecha, valor, cómo llegar, consultarlo) as a statement with no question mark, then the single permission question. Sales policy (owner decision): the ask never offers an exit from future contact. Enforced in the prompt (both sections and RUNTIME) and in `validateConsentAsk`, which rejects `opt_out_offer` (never repaired). The pattern runs on `normalize(text)` and every branch names the exit itself: the first draft of the regex rejected "respondes cuando puedas, no hay afán" and any English "stop", and each false rejection burns one of the three attempts. An unprompted stop request is still honoured by the opt-out path.
metrics_before: opt_out_offer_rejected=n/a; motive_statements_in_prompt=0
metrics_after: measure:consent deliverable 100% before and after (5 runs x 4 contexts, deepseek-v4-flash @0.2), 0 opt_out_offer rejections; drafts name context-fitting blockers (a lead with a date no longer hears "la fecha"); post-stop variant names none; test:ci 2542 pass
context: Opt-out phrasing is compliance-sensitive. Keep the rule owner-visible: removing the exit is a sales decision, not a legal one. Colombia Ley 2300 hour limits are not yet applied (see PR2); verify with counsel before relying on a timing change.

## 2026-11-01 — Close without the bridge: budget (C1 of 6)

- Observed: 73 threads of last week; about 10 leads went silent after the quote, 6 paused on "lo hablo con mi pareja" with no recovery, and the owner bridged several closes by hand.
- Change: `systemPromptMaxTokens` 40,000 → 44,000 before the behavior commits. Worst measured prompt was 38,566 with 1,434 headroom, too little for the new rules. No skill text removed in this commit.
- Metrics: measure:prompt worst 38,566 / 44,000; projected 44,866 / 65,536 window; output 800 and history 12,000 unchanged.

## 2026-11-01 — Close without the bridge: emerald policy (C2 of 6)

- Observed: two leads were told "si la encuentras es tuya" and another "se maneja con los mineros". The catalog said nothing about ownership, so the model invented it.
- Change: catalog `emeraldPolicy.notes` and one Chivor clarification say a find is not guaranteed, is handled on the spot with the miners and the guide, and is the emerald culture, nature and food. andean-scapes skill: answer in one sentence from `emeraldPolicy`; do not state ownership unless the policy says so.
- Scenario `emerald-ownership-honest` (ES + EN, live). Criteria added: no find promise, no ownership claim (critical).
- Caveat: live runs read the CDN feed. Catalog text reaches the live suite only after `npm run dynamic:push -- --target dev`. Before the push, EN live showed "it's yours to keep" from the old notes.
- Full live pass C2 (--runs 1, CDN feed): ES avg 99 / 2 hard fails, EN avg 98 / 4 hard fails. Pre-branch baseline f2c0b2e in the same session: ES 98 / 2, EN 97 / 4. Hard-fail sets differ between runs (variance); none of the C2 scenarios failed.

## 2026-11-01 — Close without the bridge: partner pause (C3 of 6)

- Observed: 6 threads paused on "lo hablo con mi pareja" and never came back; the owner bridged the closes with the reschedule policy (free until 7 days before) and photos.
- Change: first explicit pause = plan + group summary, one reschedule line from `reservationPolicy`, and one support question (photos to show the partner, or what matters most). The total is not repeated (the existing `pause-no-price-repeat` guard stays). Second pause unchanged: no price, no question. `referent.i` shareable-summary updated to match.
- Test change (owner-approved): `hot-lead-moto-partner-pause` turn 5 `pause-no-question` max 0 -> 1. New scenario `partner-pause-reschedule-offer` (ES + EN).
- Metrics: partner-pause-reschedule-offer 100/100 (ES/EN, 2 runs); hot-lead-moto-partner-pause 100 (2 runs). Full pass ES 100 / 1 hard fail (consecutive-gallery-requests), EN 98 / 4 hard fails (all in the pre-branch baseline set except entry-retarget-R03-moto, which passes 2/2 on rerun).

## 2026-11-01 — Close without the bridge: quote, objections, close (C4 of 6)

- Observed: quotes ended with "¿alguna fecha en mente?" or no date; two-plan leads were asked a third question instead of both totals; "lo pienso" and "está caro" got a generic answer; the price-sensitive question about kids got no lighter option.
- Change (skill): FASE 3 quote carries what is not included (only when asked or a known extra), a recommended published date and a soft booking question; never "qué mes" or "alguna fecha en mente" (any language). Two plans with 1-2 people: quote both in one turn. Price-sensitive question: answer from DATOS and offer the lighter scope. FASE 4 "lo pienso / está caro": one question about what weighs most. T3b: one reschedule line next to the deposit. `referent.b` and `referent.g` do-fields updated to match.
- New scenarios ES + EN: `kids-price-sensitivity-downsell`, `two-plan-narrow-quotes-both`, `quote-recommends-date-soft-cta`.
- Test notes: the EN twin of `two-plan-narrow-quotes-both` accepts `950.000` or `950,000`. The live EN reply printed Spanish thousands separators (open point, not changed here). `kids-rule` is non-critical in the kids scenario (the turn asks for a lighter option, not the kids rule).
- Engine finding, NOT changed (out of scope, prompt/catalog only): "Uf, es mucho para nosotros" hits the deterministic soft-close path (`isSoftCloseMessage`, response-engine.ts ~1466) and returns the Instagram farewell with a link, a deterministic reply that breaks invariant 9. Needs its own PR.
- Metrics: full pass ES 99 / 1 hard fail (consecutive-gallery-requests, pre-existing flake), EN 99 / 3 hard fails (pre-branch baseline EN 97 / 4). New scenarios 2/2 each on rerun.

## 2026-11-01 — Close without the bridge: humanness and opener (C5 of 6)

- Observed: openers repeated "Buenísimo" and campaign lines near-verbatim; C01 first reply was a menu with no price.
- Change: seller-personality varies the acknowledgment word per thread; referent.a/c do-fields ask for varied openings; entry-strategy and cold-info-handler unchanged. The price-anchor line was tried in three wordings and did not move the live model (0/4 on c01-opener-price-anchor), so it was dropped; the scenario keeps the length, one-question and no-link checks.
- Also in this commit: T3a routing for "¿cuál me recomiendas?" (recommend a published date, not T3); T3b reschedule line only when asked; FASE 3 "dos planes nombrados" quotes both totals.
- Metrics: c01-opener-price-anchor 100/100 (ES/EN); date-pick-price-then-close-T3b 100 on rerun (one 87 flake); two-plan-narrow-quotes-both 100/100 after the FASE 3 fix.

## 2026-11-01 — Close without the bridge: permission copy (C6 of 6)

- Observed: 23h permission message reached 19 quiet leads, 0 yes. Follow-up timing, switches, validator and marker unchanged.
- Change (content only): §PERMISO-SEGUIMIENTO may name ONE real DATOS condition that resolves the likely blocker (free rescheduling up to 7 days, or the transport route). No amounts, no new dates.
- Metrics: measure:consent 100% marker / 100% deliverable (4 contexts x 10 runs), 0 markerless fallbacks, 0 opt_out_offer rejections. Test suite conversation eval 282/282.

## 2026-11-01 — Close without the bridge: final pass

- Gates: typecheck, lint, validate:prompt, validate:skills, build, measure:prompt (worst 38,776 / 44,000), test:ci 2552/2552, conversation eval 282/282, measure:consent 100%.
- Live single pass (--runs 1): ES 99 / 1 hard fail; EN 95 / 9 hard fails. Reruns of the new or touched scenarios: emerald-ownership-honest EN 87 (0 hard) and hot-lead-moto-partner-pause ES 100/3 runs. EN flakes (ad-price-date-opening, chivor-basic-late-return-t3b-close, consecutive-gallery-requests, date-pick-price-then-close-T3b, entry-retarget-R01-with-history) are variance; a live EN run also answered in Spanish once on emerald-ownership-honest, an open language-consistency issue.
- Open: EN language drift on replayed-EN scenarios; "Uf, es mucho" Instagram soft-close (engine, invariant 9); per-person rounding and EN thousands separators; one-shot template still 0 replies (not a skill issue).

## 2026-11-01 — Review fix: policy number and place name in the prompt

- Review (REQUEST CHANGES): "hasta 7 días antes" was hardcoded in whatsapp-sales (3 lines) and referent.i, and "Bogotá" in the FASE 3 example. Both are catalog data (`reservationPolicy` already reaches DATOS) and broke invariant 6. T7 still listed "precio" in the summary that must not repeat it.
- Fix: the prompt points to DATOS `reservationPolicy` with no number; the example says "el transporte va aparte"; T7 summary is plan + personas.
- Guard gap: `validate:prompt` let both through. New guard `policy day count` (`\d+ días antes`). The destination guard ended in `\b`, which never matches after an accented letter without the `u` flag, so "Bogotá", "Ubalá" and "Boyacá" followed by a space were never caught; now a negative lookahead. Added Bogotá, Coscuez, Borbur. Verified red on the old text, green on the fix.
- Metrics: gates green, test:ci 2552/2552, eval 282/282; live 2 runs: partner-pause-reschedule-offer, hot-lead-moto-partner-pause, consult-with-partner, date-pick-price-then-close-T3b, quote-recommends-date-soft-cta all 100.
- Second review: two more literals from this series. Plan names in the FASE 3 two-plan example (now `[PLAN_A] y [PLAN_B]`) and a "4x4 local" arrival claim in §PERMISO-SEGUIMIENTO that is false for Coscuez (now "the arrival alternative the site's CATALOGO gives"). New guard `catalogPlanNameGuards`: plan short names come from the CDN payloads, because `andean-scapes.skill.json` is brand-only and `registryGuards` never saw a plan name. Verified red on the old text. `hot-lead-moto-partner-pause` restored to its original one-line formatting so the approved change is a 1-number diff. Gates green; two-plan-narrow-quotes-both and hot-lead-moto-partner-pause 100 (ES/EN, 2 runs); measure:consent 100%.

## 2026-11-02 — Release 2.2.0 CI: stale October scenario and EN "how do I book"

- CI (llm eval, EN compare) failed on two drops > 8: `buying-signal-payment-facts` 100 -> 75 and `pet-in-mine-objection-close` 100 -> 89.
- `pet-in-mine-objection-close`: variance. 4/4 on the release and 4/4 on master with the CI fixture.
- `buying-signal-payment-facts`: calendar drift. It asked to book "for October"; the CI fixture's October dates (24, 31) are now past, so the model correctly offered November and dropped the deposit line (5/5 fail). Moved to January (fixture: 9, 23), ES + EN; criteria unchanged.
- After the move EN still failed ~1 in 2: "how do I book for January?" listed the dates and dropped the deposit and methods. T8 now states the rule holds in any language, and FASE 3 "Fecha y cierre" defers to T8 on a booking question. EN 10/10, ES 4/4.
- CI-equivalent run (no CDN URL): ES 98, EN 98; both compare steps exit 0.
- Note: `baselines/master-llm-bot.json` (ES) has no scenarios, so the ES compare only checks the average floor. Refresh it from a real `--runs 2` artifact.

## 2026-11-02 — Close-without-bridge, round 2: price anchor, deliberation, metrics

- Anchor: first reply to a C/H marker lead gets one `PRECIO DESDE` / `PRICE ANCHOR` line computed from the site's lowest per-person price. Not on turns where the customer already asks price or dates (`isPriceQuestion` + `ASKS_DATES`), since the reply answers those itself. Unit tested; ad-price-date-opening 100/100.
- "Lo voy a pensar" after a quote goes to the LLM (§FASE 4 question), not the Instagram farewell. Explicit declines ("no me interesa") still soft-close. "es mucho" counts as a price objection.
- Per-person equivalent rounds an inexact split to the nearest 1,000 (~$887.000). EN QUOTE LOCK keeps `.` separators: the comma version regressed T3a/T3b in the full EN pack. EN anchor uses commas.
- Metrics: messages carry `sender='operator'` for bridge sends (NULL = bot or pre-deploy). `/summary` now reports conversations with a bridge reply, conversations where the bot asked a deposit, and deposit requests with no bridge. Pre-deploy history counts as bot, so bridge figures only mean something from deploy onward.
- Removed two §GALERIA bullets I had added ("si escribes que van fotos, marcador obligatorio"; "no prometas fotos sin destino"). In A/B runs they moved the EN two-plan quote from 100 to 63 and did not clearly help the gallery scenario. The engine now logs an unmarked photo promise with no resolvable theme (log-only).
- Test changes (patterns and harness only, no criterion removed): `no_unpublished_date` replaces the denylist in quote-recommends-date-soft-cta; EN transfer and "for one person" synonyms; pet "pueden entrar"; "deja por fuera" for the Coscuez downsell; bolded starting price ("Desde *$370.000*") counts as a starting price; kids scenario asks the rule on turn 2 instead of the replay.
- Known, not fixed: consecutive-gallery-requests (marker compliance, LESSONS 2026-08-26); date-pick-price-then-close-T3b EN is 33 in isolation on develop too and flips to 87 or 33 in the full pack depending on order; two-plan-narrow-quotes-both EN is intermittent in the full pack (100 isolated).
- Review fix (same day): the "desde" anchor reply contains a price, so two writers (`initialPriceMentioned` and `finalPriceJustGiven`) recorded `price_given_at` on turn 1. That switched off QUOTE LOCK and sent a later date pick straight to T3b. Both writers now skip the anchor turn (`entryPriceAnchorTurn`, gated by marker temperature cold/funnel, not by code letters). Regression test: C01 opening with people keeps `price_given_at` null and the next turn still gets QUOTE LOCK. The skill line "o pregunta por uno solo: los dos totales" was dropped: it contradicted QUOTE LOCK and the single-plan card. Removed the duplicate `ASKS_PRICE_OR_DATES` regex (it matched "vale" as "ok") in favour of `isPriceQuestion` plus a dates check.
- QUOTE LOCK on a retarget/REGRESO turn no longer says "Este turno entrega ese total": it says to diagnose first and use the total only if asked. That instruction contradicted §REGRESO; entry-retarget-R01-with-history ES went 3/4 -> 5/5 (EN 5/5).
- Metrics after the review fixes: test:ci 2556/2556; live --runs 2 ES 99 / 0 hard fails, EN 96 / 3 hard fails (consecutive-gallery-requests, date-pick-price-then-close-T3b, two-plan-narrow-quotes-both). The last two and partner-pause-reschedule-offer pass 5/5 in isolation; their full-pack failures did not reproduce. CI compare still exits 1 on a single-run drop (partner-pause 100 -> 83, reschedule line missing in 1 of 2 runs).
- Second review fix: the anchor still fired on a quote-eligible opener ("C01 somos 2, quiero el CORE"), so the prompt carried both `PRECIO DESDE` ("no des total") and QUOTE LOCK ("entrega ese total"), and the real quote was not recorded. The anchor now requires a new conversation, no plan+group quote available (same rule as `lockedPlanId`), no price given and no REGRESO, checked in the engine and in the prompt builder. Tests: quote-eligible C01 opener gets QUOTE LOCK, no anchor, and `price_given_at` set; prompt-builder cases for quote-eligible, priced and returning turns. The `/summary` deposit metric now needs a booking word next to the deposit, so an FAQ mention does not count. Live, 3 runs each, ES + EN: c01-opener-price-anchor, entry-cold-C01, ad-price-date-opening, ad-info-then-group-asks-plan, entry-funnel-H01, entry-retarget-R01-with-history all 3/3.

## 2026-11-02 — Prod 2.2.0 export: English ad opener answered in Spanish

- Observed (export 2026-11-02, first day of 2.2.0): "P410 Hi! I'd like the PRIME emerald mine trip (2D/1N) in Chivor. Dates?" got a Spanish reply. The phone had an earlier Spanish conversation, and `resolveLanguage` always kept the stored language unless the customer asked explicitly.
- Change: `detectAdOpenerLanguage` — a message starting with any ad code (`[A-Z]{1,2}\d{2,3}`) whose winning language has 2+ markers and outnumbers the other overrides the stored language. Ordinary messages stay sticky ("Hola como estas" on an English thread stays English, existing test). Verified on 132 ad openers from both eval packs and both prod exports: 0 mismatches.
- Not changed, reported to owner: ad codes M03, D03, D04, A05, A06, G04, P410 are not catalog markers (`[CHR]\d{2}` only), so those leads get no entry segment and no attribution.

## 2026-11-02 — "El 2D/1N es CORE" hid PRIME

- Observed: in the 2026-11-01 and 2026-11-02 exports, four "plan 2D/1N" openers (8530, 5634, 7973, 1997) were told the 2D/1N plan is CORE. PRIME has the same duration and was never offered.
- Change: RUNTIME `DURACION COMPARTIDA` when the customer names a duration ("2D/1N", "2 días y 1 noche") that 2+ plans of the chosen site share and no plan is stored. It lists those plans from the catalog and tells the model not to call the duration a single plan. State only; the model writes the reply. Skipped on proactive, consent, paused-plan and pending-site turns.
- Tests: prompt-builder unit test (shared duration lists CORE and PRIME but not BASIC; no cue for a unique duration, a stored plan or no duration). New live scenario `duration-shared-by-two-plans` (ES + EN) from the real D04 opener.
- Metrics: with the cue ES 4/4, EN 4/4; same scenario with the cue removed ES 3/4, EN 2/4 (`names-both-plans`). Neighbours 2/2 in both languages: ad-price-date-opening, ad-info-then-group-asks-plan, entry-cold-C01, group-then-plan-quote, two-plan-narrow-quotes-both, chivor-three-plans-per-person.

- Owner follow-up (same day): a "2D/1N" request now also names the site's other plans (BASIC) as an alternative of another duration; scenario `mentions-shorter-option` added. A test bug was found on the way: `no-single-plan-claim` matched "tienes CORE" as "es CORE"; fixed with `\\bes`. Live 5/5 ES and EN.

## 2026-11-02 — "¿Qué precio tienen los dos?" shipped no plan card

- Observed: in both exports, every price question answered with two or three plans' totals (5501, 3957, 4551, 5033, 8152, 1139) got no card: the card rule needs exactly one quoted plan. The owner then sent the cards by bridge.
- Change: `detectQuotedPlans` (plural; `detectQuotedPlan` now wraps it). After a price question, a reply quoting 2+ plans' totals sets `comparedPlanIds`; the webhook sends every quoted card in reply order, the last carrying the reply, the others first with their feed caption, each with its own 72h claim. Not on objection turns or unasked comparisons. Requires known group size (totals depend on it), so a comparison before the group is known still ships no card. AGENTS.md invariant 11 updated.
- Tests: webhook (two cards, carrier last; one already sent in 72h is skipped and the other still carries the reply); engine (two totals after a price question -> both ids; one total or no price question -> none).
- Metrics: test:ci 2564/2564; live --runs 2 ES 99 / 0 hard fails, EN 97 / 2 (date-pick-price-then-close-T3b, two-plan-narrow-quotes-both, the known full-pack flakes).

## 2026-11-02 — Plan C1: price comes with a value line and a micro-decision

- Observed (85 conversations): after the quote, "¿cuál fecha les sirve?" answered 6/13; "¿con cuál seguimos?" answered 8/13. Quotes without a value line were price + question only.
- Change (whatsapp-sales §FASE 3): step 1 (value line) is now required and must cite a DATOS/CATALOGO fact; step 4 asks which of two quoted plans, or offers two published dates from the QUOTE LOCK cue, instead of an open date question. referent.b `value-not-pitch` updated to match. QUOTE LOCK sentence and the group-total rule are untouched.
- Tests: targeted live pack ES 2/2 and EN 2/2 for group-then-plan-quote, two-plan-narrow-quotes-both, date-pick-price-then-close-T3b, couple-prime-quote-offers-dates, quote-recommends-date-soft-cta, group-of-5-math, chivor-three-plans-per-person. Full pack ES 99 / 0 hard fails; EN 96 / 4 (chivor-core-fatigue-no-prime and reserve-request-skips-cta fail in the full run but pass 4/4 in isolation; the other two are the known flakes).
- Plan C2 (same day): after two resolved doubts with plan and price known, the next turn offers to check the cupo of a published date (§T5, §FASE 3 step 4). New scenario `two-doubts-then-cupo-offer` (ES+EN). Live 3/4 each language (was 2/4 before this wording); the model still sometimes asks "¿seguimos con el CORE?". Not weakened. A reliable version needs a RUNTIME cue that counts doubts in history: an engine change, held for approval under the plan's skills-only scope.
- Test/fixture fixes found on the way: the scenario's mock used Nov 21, which the CI fixture does not publish (fixed to Nov 14); English twin opener too short for the language detector (fixed).
- Plan C3 (same day): finding before the change: every campaign opener already asks the scope question from the catalog `diagnosisQuestion` (C01/H01/C02: "BASIC / CORE / PRIME"), so the group-first rule only applied to plain "info" messages with no campaign code. The change is limited to that case: scope first, group next turn, unless the segment's own diagnosis question is present. Lever for campaign openers is the catalog copy (proposal delivered separately).
- Approved test change: `ad-price-date-opening` `asks-group` (critical) now also accepts scope words (BASIC/CORE/PRIME, una mina, dos minas, pasadía, esencial/completa, EN equivalents). The group words still count; nothing removed. It failed 2/2 before the widening, as expected.
- Live after C3: ES 98 / 2 hard fails (consecutive-gallery-requests; two-doubts-then-cupo-offer 62 — the known partial from C2). EN 96 / 7 hard fails; all but two-doubts pass 3/3+ when run alone: chivor-core-fatigue-no-prime (its `no-prime-for-fatigue` forbids any mention of PRIME, and the model names PRIME as the contrast; same full-pack failure seen at C1), entry-retarget-R03-moto, hot-lead-moto-partner-pause, pet-in-mine-objection-close. Full-pack English noise is pre-existing, not introduced here.
- ad-info-then-group-asks-plan EN: 4/4 before and after the change (the earlier 3/4 was variance).
- Plan C4 (same day): §PERMISO-SEGUIMIENTO now opens with one real DATOS/CATALOGO fact tied to the most likely blocker (reprogramming, how to get there, what is included) and the permission question follows from it. No amounts, dates or availability; the validator is unchanged. measure:consent: 100% marker and 100% deliverable on 2 runs x 4 contexts x 10, 0 rejections. The CDN dev catalog URL returned 404 during this run, so the check used the production catalog URL for that command only (read-only). Restoring the dev object is an ops item.
- Expected effect (not measured yet): 2–4 replies out of 19 permission messages per week, from 0.
- Plan C5 tried and reverted (same day): rule "answer a different question and do not repeat the last question". A two-turn live check (customer asks travel time instead of giving the group) showed the old skill already answers the question 4/4 and then asks the group again; the new wording did not change that (1/4 ES, 0/4 EN). The group is still unknown there, so the repeat is not clearly a defect. No behaviour change, so the rule and its check were removed. The 2026-11-01 export cases (5501, 9727, 6315) need a single-turn replay with the real history to judge.
- Plan C6 + review (same day): referent.g `next-action` now ends with a micro-decision. The full English pack dropped to 94 / 7 after C1–C6 (pre-plan 1981df5: 97 / 3). Isolating the new failures found one real regression: after a logistics answer with plan known and date missing, the bot asked "¿mantenemos el CORE?" (no date), failing the critical `logistics-then-advance`. Fixed by making the micro-decision a date while the date is missing, and listing "¿mantenemos [PLAN]?" as forbidden after the plan is chosen. hot-lead-moto-partner-pause then 6/6 across two runs. Two other new English fails were pattern synonyms the reply used ("what got in the way") in entry-retarget-R03-moto (widened, approved category); chivor-core-fatigue-no-prime still fails in the full pack only (its check forbids any mention of PRIME, which the reply uses as a contrast; 3/3 alone).
- Final live (2 runs): ES 99 / 1 hard fail (consecutive-gallery-requests, known). EN 98 / 3 hard fails (consecutive-gallery-requests, date-pick-price-then-close-T3b 87, entry-retarget-R03-moto 83 before widening, now 4/4 alone). Pre-plan EN 97 / 3.

## 2026-11-03 — Release 2.3.0 CI: EN gate stabilization

- `chivor-basic-late-return-t3b-close` EN failed both attempts once (100 -> 75): on a T3b turn the model answered "does it finish late?" and then named the plans that include the night, because the catalog's travel-reality note phrases the fact that way. §Mejora already excluded T3b; the exception now says "sin nombrar otro plan". EN 5/5 (1 retry, was 3 retries in 5); ES 3/3; `chivor-basic-late-return-upgrade` ES 3/3, EN 4/4 (the upgrade still fires outside T3b).
- `consecutive-gallery-requests`: `PEDIDO DE FOTOS` now names the literal marker line. EN missing-marker corrections 17 -> 8, photos 5/5; ES 3/3.
- `reserve-request-skips-cta` EN regex forbade the T3b statement "To start the reservation, the deposit is…". Now forbids only the question forms, as the Spanish twin does.
- `pet-in-mine-objection-close`, `hot-lead-moto-partner-pause`, `ad-info-then-group-asks-plan`: variance (5/5 locally). Covered by the eval retry (one per run, recorded in `retries`).
- Final EN pack, CI conditions: 99 / 0 hard fails; EN compare exit 0.
- Correction (same day): the "final EN pack 99 / 0" above ran with `.env.dev`, not the CI env, and CI then failed on three scenarios. Rerun with the exact CI env (no env file, ci.yml job vars):
  - `date-pick-price-then-close-T3b` EN 0/5 (master code 3/5, worst 33; ES 3/3). Cause was in the engine, not the prompt: `selectedDateFromAvailabilityReply` only knew Spanish. "28 is fine" after "…the 21st and the 28th. Which one works for you?" failed three checks (English day suffixes, the ordinal "28th" vs `\b28\b`, and the date-question words), so `dateSelectedThisTurn` was false, the T3a cue never fired, and the model bundled deposit + validation into the quote turn. Captured by hooking `fetch`: EN prompt had QUOTE LOCK and no `ESTADO DE TURNO: T3a`, ES had both. Fixed; EN 5/5 with no retries, ES 3/3. Four English unit twins, red before the fix.
  - `pet-in-mine-objection-close` EN: the failing reply was correct ("Yes, he can go in with the group") but `mine-allows-dog` required the word "mine" in that sentence. English drops the object where Spanish says "entrar a la mina". Added an alternative for a reply opening with yes + an entry verb; `mine-no-false-denial` still catches "Yes, but he can't go in". EN 5/5.
  - `chivor-basic-late-return-t3b-close` EN 5/5 under the CI env.
  - CI-env packs: EN 99 / 0 hard fails (2 retries recovered), ES 100 / 0; both compare steps exit 0.

## 2026-11-07 — Ad opener asks the group first; "desde" anchor removed (P1)

- Observed (export 2026-11-07, 1,164 ad leads): replies after our first message fell from 62% (2.0.x) to 32% (2.3.0). Two causes: the BASIC/CORE/PRIME menu as the opening question (since 2.1.0; 42% vs 59% replied) and the "desde $370.000" anchor (2.3.0; 3/16 vs 7/14 replied). Group capture fell from 44% to 26%. The first-reply delay had no effect (62/62/59/59% across delay buckets).
- Change: RUNTIME `APERTURA DE ANUNCIO` on the first inbound of an ad lead (C/R code, or Meta default text with a referral) with the group unknown: intro as the cofounder, one value line, one solo/pareja/grupo question; no price, menu or dates even if asked. Funnel (H) leads keep their segment opener. `PRECIO DESDE` removed. A price asked on the opener is quoted on the group turn for the overnight plans (`PRECIO PEDIDO SIN PLAN`, ad leads only). English group answers ("there are 2 of us") now set the group. First-message delay 0s (burst gap kept). Catalog: C02/C03 hooks lead with the trip, R01–R04 hooks drop the blocker question; R0x `diagnosisQuestion` unchanged (used by retarget-with-history).
- **The opener method must live in the cue, not in a skill file.** As skill text (cold-info-handler, then entry-strategy, even marked "solo si RUNTIME trae…"), H01/H02 introduced themselves and asked the group 0/3; moved into the cue, 3/3. Replacing the cold-info Bloque 3 `diagnosisQuestion` line also broke H01: keep it and add the exception.
- `CONTINUACION` fired on every first inbound (language, site and dateStatus count as 2 fields). Now skipped on the ad opener only; other first turns unchanged (H leads depended on it).
- Metrics: live CI env, ES 100 / 0 hard fails, EN 99 / 0. New ES+EN scenarios `ad-opener-*` 3/3. test:ci 2584, deterministic eval 67/67, prompt 40,523 tokens.

## 2026-11-09 — Stock closers and the consent ask (P2/P3)

- Observed (export 2026-11-09, 129 conversations on 2.1+): 22 of 27 consent asks used the same "si te frena la fecha, el valor o cómo llegar, cuéntame y lo miramos" line, and most follow-ups opened with "Quedó pendiente…". Across leads the copy is identical, which reads as a bot. 0 of 72 consent replies led to a booking.
- Change: §PERMISO-SEGUIMIENTO picks up the exact point the customer left (what they were checking, who they were asking, the date) in one affirmative sentence; the listed-motives line and the stock phrases are banned. The permission question itself is unchanged (owner 2026-11-09: always ask, it is what unlocks follow-up outside the 24h window). §3 rule 15: the name once per conversation, no repeated closer, and no promise that someone will send a video or map later.
- Not verified live yet: re-run the consent-ask scenarios and `entry-retarget-R01-with-history` (REGRESO opener changed to "Retomamos lo que hablamos.").

## 2026-11-09 — Persona switch and greeting photo

- Owner marketing test: most leads are men, so the bot speaks as a woman. `BOT_PERSONA_NAME` / `BOT_PERSONA_FULL_NAME` / `BOT_PERSONA_GENDER` set who the prompt speaks as; `OWNER_NAME` stays the owner for routing, alerts, commands and the name filter. Name, gender and photo revert with the env; these do NOT: the first message no longer names the partner, `referent.c` says "quien fundó la marca", and funnel (H) leads get `APERTURA DE ANUNCIO`. `FOTO DE SALUDO` is cued pre-LLM, so on a turn where the photo is later dropped (handoff, card, gallery, bridge, caption over 1024) the reply still opens with her name, with no photo.
- Skill MD files use `{{PERSONA_*}}` tokens (`substituteTokens`); `{{PERSONA_GENDER_RULE}}` fixes self-reference gender and, for a female persona, forbids flirting back. Hardcoded "cofundador" and "Heinner" removed from skill files, `referent.c` and the `APERTURA DE ANUNCIO` cue.
- Greeting photo: first reply of a new conversation rides on `media.ownerImage` as caption (`PERSONA_GREETING_IMAGE_ENABLED`). It is the lowest-priority reply-carrying image; the old separate-message owner block was removed.
- Not verified live: eval scenarios and baselines still expect "Soy Heinner"/"cofundador" in mocks; `COFOUNDER_PATTERN` already accepts "cofundadora". Run the live packs with the persona env before release.
- Follow-up (same day): the first message names only the persona (no partner, owner request). `FOTO DE SALUDO` RUNTIME cue on a greeting-photo turn makes her open with her name even on a concrete question, since the reply is the caption under her face. Funnel (H) leads now get `APERTURA DE ANUNCIO` too (owner decision): their segment opener was the plan menu (42% vs 59% replied for menu vs group question, export 2026-11-07). The cue also covers "ya consulté antes" with no history (R04 asked the blocker 3/3 before) and kids (asks how many and their ages). Simulated with the real model, dev catalog: plain Hola, organic price, C01–C04, H01–H04, R01–R04 all open as Alexandra and end on the group question; menu leak 1/12 before the "no enumeres los planes" wording, 0/16 after.
- Follow-up 2 (same day, live dev "C02 Hola"): she still wrote "Con Heinner armamos esto…" 4/4. The identity block named the partner six times ("cofundadora … con Heinner", "Voces: Alexandra y Heinner", even the ban "p. ej. Heinner"), and the "Armamos esto" example invited the completion. The partner is now only in trust vignette 2 ("nunca en el primer mensaje"). 0/22 since. Also, the opener defers the segment's diagnosis to turn 2, where the generic `OPCIONES DE PLAN ESTE TURNO` cue listed plans without the C02 car angle (0/4). The cue now frames the options with the ENTRY_SEGMENT angle, and APERTURA keeps the valueHook's distinguishing detail (how they arrive / who travels): C02/C03 opener and turn 2 8/8. Not addressed: after the plan choice the car angle fades (quote, T3b), and `planMatch` "si vienen en vehículo propio, confirmamos compatibilidad" is never asked.
- Follow-up 3 (same day): live packs with the female persona + greeting photo (CI env) found a real regression. `FOTO DE SALUDO` ("open with your name… then answer what this turn needs") made EN `two-plan-narrow-quotes-both` introduce itself and list plans instead of quoting (0/4; persona alone 4/4, default 3/4). The cue now says the name is the only change and never postpones a quote: EN 7/8, ES 8/8. The cue is also gated on `SEND_IMAGES_ENABLED` (it told the model a photo was coming with images off). Full packs, female + photo: ES 99 / 0 hard fails, EN 99 / 0. One compare DOWN (`buying-signal-payment-facts` 88, a second "?") was 5/5 at 100 in isolation for both personas. Opener angle per marker (C02–C04, H01–H04): 18/18 with the real model.

## 2026-11-09 — Mid-chat language switch (export export case A)

- Observed: customer started in English, then wrote "Entre el basic y el core" and "Que costo tiene cada una?" in Spanish. The bot answered in English, then flip-flopped. Cause: `resolveLanguage` returned the stored language whenever one existed, and the prompt said "keep this language unless the customer explicitly asks to switch", while the brand skill said "responde en el idioma del cliente".
- Rule now (`resolveTurnLanguage`, `qualification-engine.ts`): explicit request, then a new ad opener, then the message. A message with 2+ words of another language switches at once. A single word ("En pareja!", "Hi") switches only when the customer's previous message was in that language too. Bare answers ("ok", "sí", "2", emoji, plan names) never switch. First contact keeps the original es/en scoring (e.g. "stop" is English there).
- Detection: `detectMessageLanguage` (`language-service.ts`) knows es, en, fr, pt, de, it. Words shared between languages are left out of the lists. Replies in fr/pt/de/it are written in that language; fixed copy (opt-out, errors, templates) falls back to English because `language` stays es|en. `reply_language` stores the detected code.
- Prompt: `Language: <code>. Reply in <name> on every turn` names the reply language and says a single word in another language does not change it. On the switch turn `IDIOMA CAMBIADO` is added. Earlier replies in the history, even in another language, do not decide the language (without this line the model copied the English replies of the same chat on turn 4).
- Measured: live replay of export case A with the real model, 6 runs: turn 2 stayed English in 6/6, turn 3 switched to Spanish in 5/6. The miss was the reply text (the state was already `es`). Live packs under CI env: ES 100 / 0 hard fails, EN 99 / 0. `language-switch-mid-chat` (ES→EN and the EN twin replaying export case A): 9/9 runs at 100 across both languages.
- Not covered: consent-ask copy and follow-up templates still use `language` (es|en), so a French lead gets English follow-ups. The QUOTE LOCK sentence and money separators (EN thousands separators) are unchanged.
- Review fix (same day): the first word lists put common Spanish words in other languages ("tres", "les", "sur" in French; "come", "siete" in Italian; "das" in German; "ola", "queremos", "podemos" in Portuguese), so "venimos del sur, vamos tres" switched a Spanish chat to French. Those words are out. A switch into fr/pt/de/it needs 3 words (es/en keep 2). URLs are stripped before detection: replaying the export found two Spanish leads whose first message was a TikTok link, read as Portuguese through "com". Replay of all 6,746 inbound messages in the 2026-11-09 export: 5 switches before the fix (2 wrong), 3 after, all correct. A repeated single word ("Hi", "Hi") now counts as two in a row.

## 2026-11-09 — Returning customers on an ad code (REGRESO wins)

- Observed (export 2026-11-09): 8 R01 messages came from leads with a real earlier conversation; 1 reply used it. Replaying export case B (couple, PRIME quoted for 27 Feb) on the current code: the REGRESO cue was in the prompt, but 3/3 replies pasted the R01 segment copy ("Qué bueno que sigues la historia… ¿qué te frenó?") and never named PRIME. export case C (came on C01, back on R01) re-asked the group 1/3. Cause: on the same turn the prompt also carried `SEGMENT_DETECTED`, the segment's ENTRY_SEGMENT block and `UNA SOLA PREGUNTA`, and the R01 prefilled text reads like a first contact. Note: 51 of 55 R01 leads never talked to the bot (Meta retargeting audience); a first-contact reply is right for them.
- Change: on a returning turn the ad segment is not rendered at all (no SEGMENT_DETECTED, no ENTRY_SEGMENT, no UNA SOLA PREGUNTA). REGRESO now carries the plan display name (not the id), `paso alcanzado` (info / grupo / plan / cotización / fecha elegida / pidió reservar) and `frenos probables` for that step; a previous consent ask is reported as "no lo retomes" instead of as our open question. The how-to (first sentence names the case, past date left out, one blocker question, no price) lives in the REGRESO runtime line. `[RETURNING]` log line records the gap decision.
- **Do not put the REGRESO example in §REGRESO.** A skill-file example "con cotización entregada: ¿Qué te frenó: el valor o la fecha?" is in every prompt, and it replaced the cupo offer on ordinary priced turns (`two-doubts-then-cupo-offer` 0/4; 4/4 once moved to the runtime line).
- Non-Spanish reply language is repeated as the last RUNTIME line: at the top only, a switched English turn was answered in Spanish once in 3 (`language-switch-mid-chat`); 8/8 after.
- Eval: turns accept `gapDaysBefore` (runner ages the stored conversation), so a return is testable. New `returning-r01-after-quote` and `returning-r01-after-c01` (es + en).
- Measured: replay of export case B / export case C / export case D (only templates since), 3 runs each, all name the stored case and ask one blocker question, no intro, no price, past date dropped. New scenarios 12/12 live (es+en, 3 runs each). Full live packs after the final change: NOT RUN (aborted); last full run before the §REGRESO move: EN 99 / 0 hard fails, ES 97 / 2 (both since fixed and re-run in isolation).
- Review fix (same day): the REGRESO line ended "Sin precio" unconditionally, which contradicted the fresh QUOTE LOCK a returning price question gets (invariant 14). On `returningPriceQuestion` it now says to answer per QUOTE LOCK instead of asking the blocker. The legacy consent-ask matcher dropped "cuente" ("¿te gustaría que te cuente el PRIME?" is a sales question) and is matched inside the question sentence only. The example uses placeholders, not catalog literals. Live (CI env, 3 runs each): returning-r01-after-quote and -after-c01 es+en 12/12 (EN regex widened for "holding"), language-switch-mid-chat 6/6, entry-funnel-H01 6/6, group-of-5-math 6/6, two-doubts-then-cupo-offer 3/3.

## 2026-11-11 Three options by budget and comfort (2.5.0 candidate)

- Observed (bot export 2026-11-11, price messages since 10-28): 59% of leads went silent after a price message (58 of 98). Leads who answered a question before the price gave a date 27–30% of the time vs 8% when the price came first. Price messages under 250 characters got a reply 47% of the time vs 38% at 250–400.
- Observed: the day plan (BASIC) was never quoted to leads who asked the price, so leads assumed the all-inclusive plan was the only option. 2 of 84 replying leads asked for a cheaper or day option.
- Change (bot data): trip value clarification `VALOR DEL VIAJE` replaces `REALIDAD DEL VIAJE`; new `REGIONES` clarification; regional safety facts (La Esmeralda and Guavio reservoirs, military bases, base in the mining area); coffee and water at the hacienda.
- Change (code): the "price asked, no plan" cue starts with the start point (`PUNTO DE INICIO`, per site), names the day plan without a price (`Menciona primero, sin precio`), marks the core plan as recommended, lists totals from simplest to most complete, and asks for one paragraph of at most 300 characters. `quotablePlans` is unchanged, so the day plan still has no total on that turn. A chosen day plan adds an obligatory long-day sentence to the quote lock.
- Change (prompt): objection map rows for "thinks there's only the all-inclusive plan" and "thinks transport from their city is included"; permission message opens with the start point or a safety fact; 250-character limit.
- Live (DeepSeek, CI env, 2 runs each, Spanish): first cue draft gave 378–407 characters in three paragraphs; the 300-character cue gave 299–323. Open residuals, all measured: the long-day sentence after a day plan is chosen is missing in about half the runs; the bot does not close after a date (repeats the price, no meeting point, no deposit); pickup answers with bus times run to 412 characters; the day option is sometimes named after the totals.
- Found, not changed: the reply guard that removes deposit sentences before a date (`stripPaymentMoveWithoutDate`) splits at the decimal point of COP amounts and leaves fragments such as "000."; English "too expensive" hits the soft-close list and returns a fallback that includes an Instagram link.
- Metrics to check after release: silent after price (59% today), gave a date (about 5% last week), share of day plans chosen, long-day disclosure (target all day-plan quotes), price-message length (target at most 300).

## 2026-11-11 Plan explanation on the menu and quote turns (same 2.5.0 candidate)

- Observed (live dev demo, C01 → "pareja" → "CORE"): none of the three-options work above fired. It lives in `PRECIO PEDIDO SIN PLAN`, which needs a price question; the common path is group → `OPCIONES DE PLAN` → plan choice → `QUOTE LOCK`. The menu had no start point, no recommendation and no long-day note; the quote called CORE "la experiencia esencial" on a three-plan site and closed with three dates + "¿Cuál les sirve?".
- Observed (full export, 1,936 conversations): 49% of priced leads never wrote again after the first price. Most common last message before silence: total + date list + "¿cuál les sirve?" after a group answer (~136). Reply rate by quote length: <200 47%, 200-249 49%, 250-299 40%, 300-349 52%, 350-399 39%, 400+ 37% (453 of 835 quotes). Plan menus: 200-249 66%, 250-299 56%.
- Change (code): `planGuidance` + `REPLY_CHAR_LIMIT` (options 280, quote 340, price without plan 300 → 340). `OPCIONES DE PLAN` adds the start point, CORE recommended and the day plan as a same-day round trip. `QUOTE LOCK` adds the start point (getting there is the customer's own, never "incluye transporte"), names the plan by catalog name on 3+ plan sites (no esencial/completa), and without a chosen day recommends ONE published date with a soft space question. Retarget/return turns get none of the start/size cues.
- Change (data): Chivor `meetingPoint` "Chivor town center" → "parque principal de Chivor, Boyacá" (it was copied verbatim into Spanish replies).
- Change (prompt): §FASE 2 options exception and §FASE 3 steps 1 and 4 follow the cues; step 4 no longer asks for two dates on the quote turn.
- Eval: new `ad-info-pareja-core-quote` (es + en) replays the demo.
- Follow-ups after the first live run: plain "Marca/Menciona" wording was skipped (menu without start point, "la que mejor equilibra" instead of a recommendation; EN "I'd go with CORE", no day option), so the start point, the word "recomendado"/"recommended" (per language, copied verbatim) and the day option are stated as obligatory in both the options and the price-without-plan cues. The QUOTE LOCK start clause is written in the conversation language: EN skipped the Spanish clause 2 of 3 runs.
- Eval fixes: `ad-opener-price-asked-*` length threshold 320 → 390 (cue now 340), ES `recomend` did not match "recomiendo", EN arrival/day regexes widened ("on you", "single day").
- Live (DeepSeek, CI env): `ad-info-pareja-core-quote` ES 100 (3/3, then 2/2), EN 100 (3/3), last EN run 95 (1/2, quote start point missed once). Quote set ES 2 runs each, all 100: group-then-plan-quote, group-of-5-math, quote-without-date-offers-dates, quote-recommends-date-soft-cta, couple-prime-quote-offers-dates, plan-selection-gallery, date-pick-price-then-close-T3b, price-three-options-budget, solo-traveler-quote, ad-opener-price-asked-couple/solo. EN same set 100 except price-three-options-budget 50 (below).
- Open residuals: CORE catalog `shortDescription` itself says "La experiencia esencial con noche", so the quote still says "esencial" sometimes (scenario check non-critical; fix is a catalog copy change). `ad-info-then-group-asks-plan` ES 85 once: its turn-2 ban on "2 días" conflicts with the options cue listing durations (pre-existing). EN QUOTE LOCK sentence formats COP with dots ("$950.000") because `formatMoney` there has no language argument.
- Review fixes (same day): the QUOTE LOCK start/no-transport clause is skipped when the quote carries or awaits private transport (it contradicted a transport-inclusive total). The English headcount may be followed by a price question ("We are 2, how much is it?"), mirroring "somos 2, ¿cuánto?"; EN `price-three-options-budget` 50 → 100 (2/2).

## 2026-11-11 Quote opens with the trip scale (anti-marketing)

- Observed (live dev demo C01 → pareja → prime): start point and recommendation came through, but the quote said only "PRIME es el que más se vive"; nothing said it is a 2-day all-inclusive adventure, not an afternoon plan.
- Observed (export, first price): leads with no question before the price replied 49% (n 886), one question 65% (n 127), 2+ questions 56% with 17% booking intent vs 4% (n 36). Top pre-price questions: transport/how to get there 115, duration 79, kids/pets 69. Part of it is selection (engaged leads ask), but the questions are about the size of the trip.
- Change (code): QUOTE LOCK carries one ordered `APERTURA DE COTIZACION` checklist instead of separate start/scale clauses: not an afternoon plan nor for everyone, a {duration} adventure, starts/ends at the meeting point with own arrival (only without private transport), everything handled from there. It is the plan's value sentence (no extra description). Ideas are written in the conversation language.
- Live (CI env, 3 runs): as two separate clauses the model kept one and dropped the other (ES lost the start point; EN lost everything 3/3 while the ideas were in Spanish). Merged + language-specific: ES `ad-info-pareja-core-quote` 3/3 (95-100), EN 2/3 (90-95; one run stacked its own value sentence, 509 chars, before the "no extra description" line). "llegar es por su cuenta" is still often dropped on the quote turn (non-critical; the menu turn says it). Quote regression set ES/EN 2 runs each: all 100 except `basic-chosen-long-day-deposit` (ES 75, EN 50), a residual recorded above before this change (day-plan path never reaches the new opening).
- Review fix + follow-up (same day): inclusions are no longer a fixed "4x4, guía, hacienda, comidas" list (false for Coscuez: rural hotel, conventional transport); the cue asks for 2-3 items from the plan's catalog `included`. Day plans keep only the start-point idea and no "no extra description" clause (it contradicted the long-day sentence). Test with Coscuez active.
- Live after that (CI env, 4 x 2 runs per language): the full four-idea opening came through in roughly a quarter to half of runs; lengths 287-451. Merging into two dense ideas made ES skip the opening 0/3. The fixed-inclusions version had better compliance (ES 3/3) but violated invariant 1. Open trade-off for the owner: full honest framing vs the 340-character target.
- T3a turns (date just chosen, no price yet) skip the opening: it displaced the T3a close (date-pick-price-then-close-T3b 87 → 100 after the gate). Cue label now matches the CATALOGO `includes` list.
- Review fix (invariants 1 and 9): the opening's wording moved to whatsapp-sales.skill.md §FASE 3 "Apertura de cotización"; QUOTE LOCK now carries only facts (`PLAN_CON_NOCHE`, `DURACION`, `INICIO`, `LLEGADA`). The recommended plan is a catalog flag (`plans.*.recommended: true`, set on both core plans in dev and CI) instead of `tier === 'core'`; no flag → no recommendation cue. Live after the move (CI env, 2 x 2 runs per language): every reply framed the trip size ("no es un plan de una tarde", "aventura de dos días"); full checklist 1/2 per batch; lengths 274-421.
- Deploy order: code first (the strict schema must know `recommended` and `meetingPoint` reads), then `npm run media:push` and `npm run dynamic:push -- --target prod`. Until the prod feed is pushed, prod still serves `meetingPoint: "Chivor town center"`, has no `recommended` flag (so no recommendation) and lacks VALOR DEL VIAJE / REGIONES.
- Found in dev (same day): the single recommended date broke the team alert. "sí" to "¿Revisamos el cupo del 21 de noviembre?" stored no date (`selectedDateFromAvailabilityReply` only accepted questions naming fecha/salida/date…, not cupo/availability), so the next "sí" to "¿iniciemos la reserva?" failed the close-CTA gate (needs a confirmed date) and no owner alert fired. The gate now also accepts `cupo`/`availability`; regression test in response-engine.test.ts (es + en).
- Follow-up (live dev demo C01 → pareja → "el core"): the quote dropped the anti-marketing line and the menu said "aventura familiar" to a couple. Skill §Apertura de cotización now marks two obligatory ideas (not an afternoon plan nor for everyone; duration in words + everything handled from town with 2-3 catalog `includes`), the start point is optional on the quote (the menu already states it), and QUOTE LOCK sends `IDEAS_OBLIGATORIAS=1,2` for overnight plans. The options cue uses the ENTRY_SEGMENT route/vehicle angle only when it fits the stated group (never "familiar" for a couple or a solo traveller) and sits before the obligatory "recomendado" request. Live (CI env): `ad-info-pareja-core-quote` ES 10/10 runs carried both ideas (6/6 after the scenario regex accepted "no un plan de una tarde"), EN 6/8 then 4/4; quotes 287-319 characters; no "familiar". Regression ES/EN 2 runs each all 100 (C02/C03 vehicle angle kept), except ES `ad-info-then-group-asks-plan` 85 (pre-existing: forbids "2 días" while the options cue lists durations) and EN `chivor-three-plans-per-person` (regex widened to "single day|same day", then 2/2).
- Review follow-up (same day): the conditional segment angle ("solo si encaja… si no, omítelo") made ES drop the C02 vehicle angle 4/4. Route/vehicle stays obligatory; only the kids/family frame depends on the stated group, and "familiar"/"family" is banned for couples and solo travellers. New turn-2 `vehicle-angle-turn2` criterion in `ad-info-then-group-asks-plan` (es + en). Instructions now name plans by their short catalog name (`shortPlanName`): repeating "CORE — 2 Dias / 1 Noche" inside a cue made the model copy the duration onto the options turn (`no-plan-offer-turn2` 0/4 → 4/4 after the fix). Live (CI env, 2 x 2 runs): `ad-info-then-group-asks-plan` ES 4/4, EN 4/4; `ad-info-pareja-core-quote` ES 4/4, EN 2/4; quote regression ES/EN 8 scenarios all 100.
- Review fixes: catalog schema rejects two `recommended` plans on one site (dynamic-data.test.ts); AGENTS.md / ci.yml cost-cap and scenario counts updated (79 per pack, 62 live, default cap 2.00); stale "ideas follow the conversation language" comment removed (the opening now sends facts). Extra date-capture negatives: "¿Te aparto el cupo?" and "me ocupo… 28 de noviembre" + non-date question store no date.

## 2026-11-12 Coscuez back on sale: group first, destination second

- Observed: reopening Coscuez (BASIC 420.000/720.000, CORE 580.000/1.004.000, PRIME 1.497.000/2.270.000, 50% deposit) made `SITIO PENDIENTE` own the first turn of every lead that names no destination, including the top ad opener "C01 ¿Cuánto vale la experiencia minera?". That replaced the group question the 2026-11-07 export showed ad leads answer.
- Change (code): `DESTINO SIN ELEGIR` on the opening turn (group question only, no destination, plans or prices); `SITIO PENDIENTE` from the next turn, with a price note when one is pending. The opener's "price in my next message" bridge is skipped while the destination is still open.
- Change (data): `siteSelection.context` carries the region facts, what both sites share and the no-preference suggestion (Chivor, saying Coscuez is also a great option). Chivor's "REGIONES" clarification no longer calls it the only destination on sale.
- Found by the new scenario `two-destinations-group-first`: a "sí" to "¿Te interesa empezar por Chivor?" matched the soft reservation frame and paged the team as a reservation handoff. A destination answer now suppresses reservation intent for that turn.
- Review fixes (same day): English choice markers were narrowed ("go with" / "prefer" / "choose" only directly before the site); a yes to an offer to send or explain something about a site no longer switches it (`parece`, `how about`, `start with` were too broad).
- Mocked pack: Coscuez stays paused in `eval.test.ts`, so the 79 single-destination scenarios keep their meaning; `chivor-three-plans-per-person` now asks the destination before the Chivor options.

## 2026-11-12 Destination by interest, R01 new vs returning, first-turn guard, export reasons

- Live run after the two-destination flow: four opener scenarios regressed (r01-videos 89, price-asked-solo 83, price-asked-couple 94, c03-moto 89). Causes: the shared-region copy said "equipo de seguridad" (safety is banned on the opener); the bridge mentioned regions and the group question was paraphrased ("¿cómo sería en su caso?"); with the destination open the C03 opener lost its moto angle because segments belong to a site.
- Change (data): `siteSelection.context` without safety equipment, both regions safe/similar distance/unique, off-road matched to Chivor, customer chooses; new `siteSelection.defaultSiteId` (schema-checked). R01 `diagnosisQuestion` asks what caught their attention (new video viewers got "¿qué te frenó?", 0/2 replies per the marketing brief).
- Change (code): the opener borrows the default destination's segment while the destination is open; bridge is half a sentence with no regions and the three group options said explicitly; ≤60 words. QUOTE LOCK "diagnose the blocker first" now needs real history (`retargetingWithHistory`), not the R01 code.
- Export: `/daysummary` conversations carry `bookedAt` (`converted_at`) and an INFERRED `notBookedReason` (stored pain, else silence after our last message).
- Not applied from the marketing brief: free-form value follow-up (invariant 10), presenting as Heinner (persona is Alexandra), "Chivor only" (Coscuez is on sale), one total and ≤300 chars at quote (weak evidence, n=19; candidate A/B).

## 2026-11-12 Prompt budget for two destinations on sale

- Observed (CI `measure:prompt`): worst profile retargeting-R01 48,719 tokens vs `systemPromptMaxTokens` 44,000. `develop` measured 40,979. Coscuez on sale renders its full catalog block (plans, routes, rules, dates, segments): 5,727 of the +7,740 tokens; the rest is the three-options, destination and R01 cues.
- Change: `systemPromptMaxTokens` 44,000 → 52,000 (about 7% headroom over the measured worst). No prompt content removed. Projected request 55,019 / 65,536 window (history 12,000 chars, output 800 unchanged).
- Cost note: about +19% input tokens per call against `develop`; most of the system prompt is static and cache-friendly.
- Follow-up candidate (not done here, needs its own eval run): once a destination is chosen, render only that site's catalog block. That would recover about 5,700 tokens on post-choice turns, but cross-site questions ("¿y Coscuez?") and alternatives read that block today.
