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
