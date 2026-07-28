# PLAN: Gate date-list on known plan (multi-plan)

## GOAL
Date-list asks (`vale que fechas existen ahora?`) must NOT dump dates when plan is unknown and catalog has 2+ plans. Ask which plan first.

## PATCHES (apply exactly)

### 1. Add helper after `buildAvailabilityListReply` — `response-engine.ts` ~line 221

After the closing `}` of `buildAvailabilityListReply`, before `function buildAvailabilityRecommendReply`:

```
function needsPlanBeforeDates(skills: Skills, plan: unknown): boolean {
  if (typeof plan === 'string' && plan.length > 0) return false;
  return getPlans(getActiveExperience(skills)).length > 1;
}
```

### 2. Gate date-list short-circuit — `response-engine.ts` ~line 1622

Replace:
```
  if (!hasSafetyOverride && isDirectAvailabilityListQuestion(message)) {
    const availabilityReply = buildAvailabilityListReply(skills, lang);
    if (availabilityReply) {
      return fallbackOutput(availabilityReply, { outboundDateAction: 'options_offered' });
    }
  }
```
With:
```
  if (!hasSafetyOverride && isDirectAvailabilityListQuestion(message)) {
    if (needsPlanBeforeDates(skills, dbQualification.plan)) {
      return fallbackOutput(buildPlansListReply(skills, lang), { outboundDateAction: undefined });
    }
    const availabilityReply = buildAvailabilityListReply(skills, lang);
    if (availabilityReply) {
      return fallbackOutput(availabilityReply, { outboundDateAction: 'options_offered' });
    }
  }
```

### 3. Gate date-deferral options branch — `response-engine.ts` ~line 1398

Replace:
```
      if (optionsRequested) {
        const availabilityReply = buildAvailabilityListReply(skills, lang);
        if (availabilityReply) return fallbackOutput(availabilityReply, { outboundDateAction: 'options_offered' });
      }
```
With:
```
      if (optionsRequested) {
        if (needsPlanBeforeDates(skills, dbQualification.plan)) {
          repos.conversation.setDateOptionsOffered(customerPhone);
          return fallbackOutput(buildPlansListReply(skills, lang), { outboundDateAction: 'options_offered' });
        }
        const availabilityReply = buildAvailabilityListReply(skills, lang);
        if (availabilityReply) return fallbackOutput(availabilityReply, { outboundDateAction: 'options_offered' });
      }
```

### 4. Add unit test — `response-engine.test.ts` in date-list describe block

After the existing "vale" test (~line 4471), add:

```
  it('lists plans instead of dates when plan is unknown and multiple plans exist', async () => {
    const phone = '573001991009';
    repos.conversation.upsert(phone, {
      collected_people: 1,
      lead_score: 30,
    });
    // Plan is intentionally NOT set — catalog has 2+ plans, gate must fire.

    const result = await processMessage({ repos, customerPhone: phone, message: 'vale que fechas existen ahora?' });

    expect(result.usedAi).toBe(false);
    expect(result.reply).toMatch(/planes disponibles|planes:/i);
    expect(result.reply).toMatch(/2 Dias|3 Dias/i);
    expect(result.reply).not.toMatch(/fechas disponibles/i);
  });
```

### 5. Create eval scenario — `src/tests/conversation-eval/scenarios/date-ask-requires-plan-when-unknown.json`

```json
{
  "id": "date-ask-requires-plan-when-unknown",
  "source": "production-regression-2026-07-26",
  "tags": ["availability", "plan", "regression", "answer-first"],
  "lang": "es",
  "liveRuns": 3,
  "seedQualification": { "people": 1 },
  "seedSystem": {
    "dynamicSkillAvailable": true,
    "availability": [
      { "date": "2026-08-07", "status": "available" },
      { "date": "2026-08-15", "status": "available" }
    ]
  },
  "criteria": [
    {
      "id": "deterministic-plan-list",
      "rule": "output_flag_equals",
      "flag": "usedAi",
      "expected": false,
      "turn": 1,
      "weight": 1,
      "critical": true
    },
    {
      "id": "offers-plans-not-dates",
      "rule": "reply_must_match",
      "patterns": ["planes disponibles|2 Dias|3 Dias"],
      "turn": 1,
      "weight": 1,
      "critical": true
    },
    {
      "id": "no-bare-date-dump",
      "rule": "unsafe_pattern_absent",
      "patterns": ["fechas disponibles", "7 de agosto|15 de agosto"],
      "turn": 1,
      "weight": 1,
      "critical": true
    }
  ],
  "turns": [
    {
      "user": "vale que fechas existen ahora?",
      "mockReply": "",
      "expect": { "usedAi": false, "shouldSendReply": true }
    }
  ]
}
```

### 6. Register in `manifest.json`

- Bump `totalTests` by 1
- Add `"date-ask-requires-plan-when-unknown.json"` to `newFiles` and `allFiles` (alphabetical)

## VALIDATION
```
npm run typecheck && npm run lint
npm test -- src/tests/response-engine.test.ts
npm run eval:conversations
npm run build
```
