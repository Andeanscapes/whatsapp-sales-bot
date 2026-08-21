# Skills Assembly — Andean Scapes WhatsApp Bot

**Audience:** coding agent / engineer with ZERO prior chat context.  
**Goal:** system prompt for DeepSeek that sells well, never invents commercial data, and supports **N experiences / N plans / external providers** when data sources grow.

This file is **NOT** sent to DeepSeek.

---

## Inputs

| # | Source | Role |
|---|---|---|
| 0 | `src/prompts/seller-personality.skill.md` | Seller voice, identity, humor rules, fixed trust vignettes |
| 1 | `src/prompts/entry-strategy.skill.md` | How to read a campaign segment marker (must precede #2) |
| 2 | `src/prompts/cold-info-handler.skill.md` | First-turn structure for cold "info / precio" leads |
| 3 | `src/prompts/whatsapp-sales.skill.md` | How to sell (no product hardcodes) |
| 4 | `src/prompts/andean-scapes.skill.md` | Brand + catalog protocol |
| 5 | `src/prompts/dynamic-context.template.md` | Template for CATALOGO + DATOS |
| 6 | Static product registry (`andean-scapes.skill.json`) | Brand-only today (`experiences: []`); narratives come from the feed |
| 7 | External `dynamic.json` (v6+) | Live: pricing, availability, payments, media, reservationPolicy, `sites.*.entrySegments` |
| 8 | Runtime DB | LO QUE YA SABEMOS, phase, pain, selectedExperienceId, entry marker, history |

Env: `OWNER_NAME` (default Heinner), `PARTNER_NAME` (default Alexandra).

---

## Assembly order (system prompt)

All MD blocks get `{{OWNER_NAME}}` / `{{PARTNER_NAME}}` substituted.

```
0. seller-personality.skill.md
1. entry-strategy.skill.md        <- MUST precede cold-info-handler
2. cold-info-handler.skill.md
3. whatsapp-sales.skill.md
4. andean-scapes.skill.md
5. ESTRATEGIAS DE VENTA           (anonymized referent packs, weighted by entry temperature)

6. Render dynamic-context.template.md:
   - strip CODING AGENT header
   - {{CATALOG}} = renderCatalog(skills, lang)
   - {{BUSINESS_DATA}} = renderBusinessData(skills, entryMarker?.code)
       includes `ENTRY_SEGMENT <code>` inside the matching SITE block

7. RUNTIME (per request):
    - LO QUE YA SABEMOS DE ESTE CLIENTE
    - SALES PHASE ACTUAL
    - DOLOR CONOCIDO DEL LEAD
    - selectedExperienceId / PLAN ACTIVO if any
    - ENTRADA + SEGMENT_DETECTED + CONTEXTO PREVIO (internal only)
    - CONTINUACION if >= 2 known fields
    - QUOTE LOCK when people + settled plan + pricing available
      (precomputed plan total — model must copy, never re-arithmetic)
    - TEMAS DE GALERIA DISPONIBLES from registry media for the selected experience
```

The order is asserted by `skills-prompt-assembly.test.ts` ("orders the skills so entry
strategy precedes the first-turn handler"). Reordering silently degrades first contact.

**Follow-up outbound and this assembly.** The template paths (one-shot post-24h and
recurring, `followup-service.ts`) use fixed Meta-approved bodies and never call the
LLM or this assembly. The consent ask is the one exception: it calls
`assembleSystemPrompt({ proactiveMode: 'consent_ask' })`, which appends a RUNTIME
block that overrides the sales cues and defers to
`whatsapp-sales.skill.md` §PERMISO-SEGUIMIENTO. No copy is added in TypeScript.


Model I/O:

- `messages[]` = conversation history  
- Latest user text = inbound WhatsApp  
- Output = plain WhatsApp text only  
- A valid `[[FOTOS:<theme>]]` suffix is an internal media signal: runtime strips it
  and sends captionless gallery images. It is never customer-visible.

---

## Product data model (critical)

```
brand-only static JSON (`experiences: []`) + dynamic.json.experiences{id}
                                                   │
                                                   │ narrative + live business facts
                                                   ▼
                                        one block per experienceId
```

- Iterate product ids from the validated registry. Production product entries come from dynamic JSON; static experience support remains only as a legacy/offline fixture seam.  
- **Do not** hardcode `emerald_mining_tour` or any plan id in TypeScript prompts.  
- New destination/provider = new experience entry in data sources; **no** sales-skill edit.

### Conflict resolution

| Topic | Winner |
|---|---|
| Price, dates, slots, deposit %, enabled pay methods, reservationPolicy | `dynamic.json` |
| Name, includes, route, safety, difficulty, plan copy | `dynamic.json` (authoritative product catalog) |
| Campaign hook / diagnosis question / plan match per segment | `dynamic.json` → `sites.*.entrySegments` |
| How to sell | `whatsapp-sales.skill.md` |
| First-turn structure for a cold lead | `cold-info-handler.skill.md` |
| How to read a segment marker | `entry-strategy.skill.md` |
| Voice, identity, humor, trust vignettes | `seller-personality.skill.md` |
| Catalog reading rules | `andean-scapes.skill.md` |

If dynamic pricing missing for an experience: mark `PRICING: NO DISPONIBLE — el equipo confirma` for that id.  
If no dates: same for availability.  
If catalog empty: `CATALOGO: no hay experiencias cargadas` — bot must not invent tours.

---

## `{{CATALOG}}` renderer

For each sellable experience, emit structured text (compact):

```
### {id} — {name}
status: {active?}
provider: {provider or "Andean Scapes"}
location: {location}
short: {shortDescription}

whatItIs / whatItIsNot: (if present)
idealFor / notIdealFor: (if present)

PLANS:
- {planId}: {name} | duration: {duration}
  short: …
  includes: comma-separated or short bullets
  benefits: …
  keywords: …
  (idealFor plan-level if any)

LOGISTICS / ROUTE: (from route + botRules summary, or logistics fields)
SAFETY: …
DIFFICULTY / CLIMATE / WHAT_TO_BRING: (short)
POLICIES: age, pets, cancel notes from static
NOTES: whyNotOneDay / experienceReality one-liners if present
```

Rules:

- Omit empty sections.  
- Do not paste entire FAQ arrays if huge — top facts only; LLM can use logistics/safety blocks.  
- Plan list = **all** plans on that experience object (N plans).  
- Provider/partner name only if present in data.

---

## `{{BUSINESS_DATA}}` renderer

Global once:

```
PAYMENTS (global):
currency: …
deposit: {value}% — {label}; remaining {remainingBalancePercentage}%
methods_enabled: {names only, comma-separated}
confirmation: {message}
displayPolicy: summarize (no payment before availability validation; never full pay without confirmation; LLM never outputs phones/links)

RESERVATION_POLICY (if any):
reschedule free until {freeUntilDaysBefore} days before; late: {lateChangeRule}
```

Per experience id present in `dynamic.experiences`:

```
### {experienceId} — LIVE DATA
currency: …
PLANS_PRICES:
  {planId}: individual {fmt} | couple {fmt}   # only keys that exist
ADDONS:
  {addonId}: {label} | pp/price | max | plans: […]
PRICING_RULES:
  {rules string or joined array}
  # Must include group formula when applicable, e.g.:
  # 1=individual, 2=couple, 3=couple+individual, 4=couple×2, 5+=(couple/2)×N
AVAILABILITY tz={tz}:
  {YYYY-MM-DD} ({status}{, ~sl slots})   # skip past dates in tz
AVAILABILITY_RULE: {rule}
```

### `ENTRY_SEGMENT` (inside the matching SITE block)

Only the ONE segment matching the lead's persisted `entry_marker` is rendered:

```
  ENTRY_SEGMENT C02 (4x4 / Off-Road):
    valueHook: …
    diagnosisQuestion: …
    planMatch: …
```

- Rendering all six would cost ~950 tokens per request and invite cross-segment bleed
  (a 4x4 hook offered to a family lead).
- `description` is internal targeting metadata and is deliberately NOT rendered.
- Empty `valueHook` (hot leads) emits no line, so the model skips the brand pitch.
- No marker, or a marker the feed does not define → no block, and RUNTIME omits
  `SEGMENT_DETECTED` so the model never chases a missing section.
- Segments are site-scoped: two destinations can run different campaigns under the
  same marker code without colliding.

### QUOTE LOCK (runtime, after DATOS)

When `collected.personas` + settled plan + pricing available, assembly injects the
copyable sentence itself (see `skills-prompt-assembly.ts`):

```
QUOTE LOCK: escribe "Para {N} personas, el plan queda en {fmt} {currency}".
Copia esas personas y ese total; no recalcules ni redondees otra cifra.
[+ transporte pendiente, si aplica]
[+ "Este turno entrega ese total…" — solo cuando el precio NO se ha dado aún]
```

Sales skills must treat this as the only allowed plan total. Listing unit rates
or rebuilding 3/4-person stacks for 5+ is a money bug (`group-of-5-math`).

Two conditions matter and are easy to break:

- **A settled plan means the customer chose it, or the experience has exactly one
  plan.** Never fall back to `plans[0]`: that injects an authoritative total for a
  plan nobody picked and walks the model past the price gate. When the group is known
  but the plan is not, assembly emits `PRICE GATE ACTIVO` instead — the two are
  mutually exclusive.
- **The "deliver it this turn" tail is gated on `!priceGiven`.** Without that gate it
  contradicts `PRECIO YA ENTREGADO`, which forbids repeating the total. A runtime
  self-contradiction already cost one live suite (LESSONS.md 2026-08-13), and the tail
  exists because the model described a freshly chosen plan and asked for a month
  instead of quoting (`plan-selection-gallery`, 0/2 live runs).

**Never write a runtime cue name followed by a colon in a skill MD.** Prose like
`QUOTE LOCK:` inside `whatsapp-sales.skill.md` puts that literal string in *every*
prompt, hands the model a fake state marker, and breaks the unit tests that assert a
cue is absent outside its state. Refer to it descriptively ("cuando RUNTIME trae un
total autorizado").

### Money format
- COP default: `$1.000.000` (es-CO)  
- Use `currency` from JSON when not COP  

### Payments security
- **Never** put `phoneNumber`, `fullPhoneNumber`, `paymentLink`, or raw transfer instructions into the LLM system prompt for free recitation.  
- Payment-detail release is **human-gated**, not model-gated: the owner-only Telegram
  command `/payment <phone> confirm` stamps `availability_confirmed_at` and the system
  sends the link from a template. The LLM has no phase that emits payment credentials.
- A post-LLM guard (`containsPaymentDetailLeak`) treats any Colombian mobile, payment
  URL, or offer to send payment data as an echo-risk failure and **suppresses the whole
  turn** plus alerts the owner. An LLM-authored number produces silence, not a message —
  so "let the model send it after confirmation" is not a viable design.
- LLM only sees method **names** + deposit **percentage** + confirmation **message**.

### Media
- Do not dump 30 gallery URLs into the prompt.  
- Runtime sends media using `dynamic.media` + caps.  
- Optional one-liner: `media: ownerImage/planImages/gallery available for code-side send`.
- Photos ship **only** when the model emits `[[FOTOS:<theme>]]`. Assembly supplies the
  state the model needs to decide, never the decision: `TEMAS DE GALERIA DISPONIBLES`
  (resolvable themes), `PEDIDO DE FOTOS ESTE TURNO` (themes matching this inbound),
  `GALERIA_YA_MOSTRADA` (blocks proactive repeats only), `CUPO_FOTOS_RESTANTE` (0 means
  do not promise photos).
- `PEDIDO DE FOTOS ESTE TURNO` appears when `isGalleryRequest` matches — photo nouns
  **or** visual imperatives ("muéstrame", "enséñame", "show me") — and the request
  resolves to at least one site-scoped theme. A visual verb with no matching theme
  yields no cue, so widening the verb list cannot invent media.
- A repeat request ("otra vez", "de nuevo") is a full request and needs the marker
  again. If the model promises photos without marking them, assembly may add
  `CORRECCION FOTOS` for exactly one corrective call; the engine never adds the
  marker itself.

---

## Placeholder tokens in skill MD files

| Token | Source |
|---|---|
| `{{OWNER_NAME}}` | env |
| `{{PARTNER_NAME}}` | env |
| `{{CATALOG}}` | renderer above |
| `{{BUSINESS_DATA}}` | renderer above |

Sales/product skills must **not** contain literal prices, plan rosters, or “15% / Nequi” as business truth.

---

## Multi-provider checklist

When onboarding a new place/provider:

1. Add the experience and its sites/plans/narrative to `dynamic.experiences[id]`.  
2. Add site pricing, rules, availability, media, and optional `entrySegments`.  
3. Mirror the validated shape in dev/CI fixtures without adding product copy to skill MD files.  
4. **Do not** edit any prompt skill unless sales methodology changes.  
5. Run acceptance tests with a **non-mining** fixture experience name.

---

## Acceptance tests

### A — Dynamic price change
Change only couple price in dynamic.json → simulate quote → reply uses new number, not any old figure.

### B — New plan on same site
Add `sites.<siteId>.plans.new_plan_id` + static plan entry → bot can quote it when asked; sales skill unchanged.

### B2 — New site on same experience
Add `sites.new_site_id` with its own addons/rules/availability/plans → DATOS renders an
additional `SITE new_site_id:` block; existing site's prices/addons/rules are untouched;
sales skill unchanged (site grouping is generic, no per-site literal in the MD).

### C — Second experience
Fixture `experiences.coffee_farm_tour` + static stub → bot asks A vs B or matches keywords; never invents coffee facts beyond stub.

### D — Payment methods
Disable Nequi in JSON → close CTA must not offer Nequi.

### E — Empty catalog
No experiences → no invented tours.

### F — Classic mining ad (regression)
Inbound mining/Chivor-style message with full current data still: short open → group → value+price → objections from **catalog fields** → close with deposit% + enabled methods only (no phone).

### G — Grep guard on skill MD
`npm run validate:prompt` scans all five skill MD files + the context template and
fails on money amounts, any percentage, any Colombian mobile, plan/experience ids,
duration shorthand or prose, destination names, campaign nouns, payment method names,
and any experience/plan name from the product registry.

Note the historical hole: `/\b15%\b/` never matched `15% ` because `%`→space is not a
word boundary, so the deposit literal passed for as long as that guard existed. The
guard is now `/\b\d{1,3}\s?%/`.

(Assembly examples in THIS file may show formats; production skill MD files must stay clean.)

### H — Group quote integrity (5+)
`npm run eval:conversations` / live `group-of-5-math`: one total matching
QUOTE LOCK / `(couple÷2)×N`. Never individual+couple menu on that turn.

### I — Retarget with history
`entry-retarget-R01-with-history`: return greeting = group+plan recall + one
diagnosis question. No price, COP, “todo incluido”, or activity list.

### J — Follow-up outbound is limited to three gated paths
`followup-service.ts` only: one-shot post-24h template (operator-consent gated,
one delivered send per customer), consent ask (free-form, model-written via
`proactiveMode: 'consent_ask'`, inside the 24h window), and recurring template
(after an explicit "sí"). Sales nudges and the old multi-track template stack stay
removed; adding a fourth path needs a fresh design (see AGENTS.md Phase 9).

---

## Code wiring (implement in bot)

Replace/extend `buildSystemPrompt` in `deepseek-client.ts` (or equivalent):

1. Read sales + andean skill MD (token substitute names).  
2. `renderCatalog(skills.andeanScapes.experiences, dynamic)`.  
3. `renderBusinessData(dynamic)`.  
4. Fill `dynamic-context.template.md`.  
5. Concatenate order above + runtime lead context.  
6. Stop appending old ad-hoc “facts” arrays that duplicate/hardcode plans if superseded.

Keep `resolveExperience` / `selectedExperienceId` seam: optional highlight in runtime context  
`EXPERIENCIA ACTIVA: {id}` so the model does not jump catalogs mid-thread.

---

## Files in `src/prompts/`

| File | Sent to the LLM? |
|---|---|
| `seller-personality.skill.md` | yes — block 0 |
| `entry-strategy.skill.md` | yes — block 1 |
| `cold-info-handler.skill.md` | yes — block 2 |
| `whatsapp-sales.skill.md` | yes — block 3 |
| `andean-scapes.skill.md` | yes — block 4 |
| `dynamic-context.template.md` | yes — block 6 (header stripped) |
| `lead-analyzer.prompt.md` | yes, but a **separate** LLM call (lead scoring), not this assembly |
| `SKILLS-ASSEMBLY.md` | no — this doc |
| `LESSONS.md` | no — eval notes |

Every file added here must also be copied by the `build` script in `package.json`,
or `dist/` boots without it.

---

## Security (non-negotiable)

1. No invented prices, discounts, dates, slots, payment endpoints.  
2. No AI self-disclosure.  
3. Speak as `{{OWNER_NAME}}`.  
4. Payment detail release = deterministic runtime, not LLM creativity.
