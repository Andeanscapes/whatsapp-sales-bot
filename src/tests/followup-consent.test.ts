import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  CONSENT_ASK_MARKER,
  addMonthsClamped,
  classifyConsentReply,
  consentCycleKey,
  isDuplicateConsentEcho,
  recurringCycleKey,
  validateConsentAsk,
} from '../services/followup-consent.js';
import {
  consentThresholdMs,
  isRecurringDue,
  parseStoredTimestamp,
  recurringDueBeforeIso,
  recurringIntervalMonths,
  recurringNextDueAt,
} from '../services/followup-service.js';
import { env } from '../config/env.js';

describe('classifyConsentReply', () => {
  it.each([
    'si', 'Sí', 'SI', 'dale', 'claro', 'listo', 'ok', 'Okey', 'vale', 'acepto',
    'yes', 'Yes please', 'sure', 'go ahead', 'of course',
  ])('treats %s as affirm', text => {
    expect(classifyConsentReply(text)).toBe('affirm');
  });

  it.each([
    'no', 'No gracias', 'nope', 'mejor no', 'no me interesa', 'ahora no',
    'no thanks', 'not now', 'not interested',
  ])('treats %s as decline', text => {
    expect(classifyConsentReply(text)).toBe('decline');
  });

  it.each([
    'si, escribeme cuando quieras',
    'no, dejalo asi',
  ])('uses the leading token for %s', text => {
    const expected = text.startsWith('si') ? 'affirm' : 'decline';
    expect(classifyConsentReply(text)).toBe(expected);
  });

  it('prefers decline when both readings are possible', () => {
    expect(classifyConsentReply('no, gracias')).toBe('decline');
  });

  it('never grants consent when an apparent yes contains a negation', () => {
    expect(classifyConsentReply('si pero no quiero mensajes')).toBe('decline');
  });

  it.each([
    'cuanto vale para 4 personas',
    'tienen fecha para diciembre',
    'me interesa pero primero quiero saber el precio total',
    '',
    '   ',
  ])('leaves %s ambiguous', text => {
    expect(classifyConsentReply(text)).toBe('ambiguous');
  });

  it('treats a long sentence as a real turn, not a yes/no', () => {
    expect(classifyConsentReply('si claro pero antes cuentame bien que incluye todo')).toBe('ambiguous');
  });

  // A bare leading "no" is usually the verb negation of a sales answer, not a
  // refusal of the permission question. Reading it as a decline recorded these
  // leads as having refused marketing — and `declined` never auto-reopens, so
  // they could never be asked again.
  it.each([
    'no tengo fecha',
    'no todavia',
    'no se aun',
    'no sabemos cuantos vamos',
    'No entendí tu pregunta, ¿puedes explicarla?',
  ])('does not read the sales answer %s as refusing consent', text => {
    expect(classifyConsentReply(text)).toBe('ambiguous');
  });

  // ...but an unmistakable refusal still wins wherever it appears.
  it.each([
    'no gracias igual',
    'no me escribas mas',
    'no me avises nada',
    'no, dejalo asi',
    'no me interesa por ahora',
  ])('still declines for %s', text => {
    expect(classifyConsentReply(text)).toBe('decline');
  });

  // English refusals. `dont` and `not` are bare tokens, so each negated-contact
  // form needs explicit coverage: without it these read as `ambiguous`, and the
  // continuation deferral then re-asked a customer who had just refused.
  it.each([
    'i dont want more messages',
    'dont send me anything',
    'please dont contact me',
    'i do not want messages',
    'dont message me again',
    'not really',
    'i am not interested',
  ])('declines the english refusal %s', text => {
    expect(classifyConsentReply(text)).toBe('decline');
  });

  // Guard the derivation: every non-bare DECLINE entry must also be recognised
  // mid-sentence, otherwise the two lists have drifted apart again.
  it('recognises every non-bare decline phrase mid-sentence', () => {
    const nonBare = ['no gracias', 'no me interesa', 'no quiero', 'no necesito',
      'no hace falta', 'prefiero no', 'preferiria no', 'mejor no', 'ahora no',
      'por ahora no', 'no thanks', 'no thank you', 'not now', 'not interested',
      'rather not', 'no need'];
    for (const phrase of nonBare) {
      expect(classifyConsentReply(`ok ${phrase}`)).toBe('decline');
    }
  });

  // The ask is framed as an opportunity ("¿te aviso cuando haya novedades?"), so the
  // likely reply is a yes that also asks what is coming. Consent IS granted — losing it
  // would waste the only free-form ask the window allows — and `whatsapp-sales.skill.md`
  // §PERMISO-CONCEDIDO is what answers the attached question in the same turn.
  it.each([
    'si cuales?',
    'si que promociones tienen?',
    'claro, mandame las promos',
  ])('grants consent for %s even though it carries a question', text => {
    expect(classifyConsentReply(text)).toBe('affirm');
  });

  // A LEADING affirmative token is also the first word of a sales answer. Live
  // 2026-09-02 "Si un ritmo tranquilo" (an answer about trip pace) was recorded as
  // marketing consent the customer never gave. Only a continuation that asks what is
  // coming, or names the contact being authorised, makes it a real yes.
  it.each([
    'Si un ritmo tranquilo',
    'si 4 personas',
    'si para diciembre',
    'si somos dos adultos',
  ])('never fabricates consent from the sales answer %s', text => {
    expect(classifyConsentReply(text)).toBe('ambiguous');
  });

  // Elongated assent. Live 2026-09-01 "Sii más adelante" was read as ambiguous, so the
  // yes was lost and the lead was asked a second time.
  it.each(['sii', 'Siii', 'siiii', 'Sii más adelante', 'yeaa', 'yeah'])(
    'treats the elongated affirmation %s as affirm',
    text => {
      expect(classifyConsentReply(text)).toBe('affirm');
    },
  );

  // Politeness is not part of the answer. Live 2026-08-31: "Buenos días, si señor por
  // favor y gracias" exceeded the six-word window and lost the consent.
  it.each([
    'Buenos días, si señor por favor y gracias',
    'hola si claro',
    'si gracias',
    'buenas, dale por favor',
  ])('strips the courtesy frame around %s before deciding', text => {
    expect(classifyConsentReply(text)).toBe('affirm');
  });

  // ...but courtesy that IS the refusal must survive the strip, or a decline decays
  // into a bare "no", which this module deliberately reads as a sales answer.
  it.each(['no gracias', 'no por favor', 'no thanks', 'no thank you', 'ok no gracias'])(
    'keeps %s a decline after courtesy stripping',
    text => {
      expect(classifyConsentReply(text)).toBe('decline');
    },
  );

  // Unambiguous assent only. A generic reaction is not permission to send marketing,
  // and the emoji class was previously written without the `u` flag, so EVERY emoji
  // silently classified as ambiguous.
  it.each(['👍', '👍🏽', '👌', '✅'])('treats the bare emoji %s as affirm', text => {
    expect(classifyConsentReply(text)).toBe('affirm');
  });

  // 🙏 reads as thanks or a plea far more often than as "yes, write to me", so it
  // sits with the generic reactions rather than with assent.
  it.each(['💪', '👏', '❤️', '😀', '🙏'])('leaves the generic reaction %s ambiguous', text => {
    expect(classifyConsentReply(text)).toBe('ambiguous');
  });

  // A TWO-word affirmative prefix used to short-circuit to `affirm`, routing around
  // the remainder check that the one-word branch applies. That let a plain sales
  // answer record marketing consent — the very bug the one-word branch prevents.
  it.each([
    'si claro un ritmo tranquilo',
    'si claro que somos cuatro',
    'si claro que para diciembre',
    'si claro informacion de precios',
    'de acuerdo para diciembre',
    'dale pues somos cuatro',
    'esta bien dos noches',
  ])('never fabricates consent from the two-word-prefixed sales answer %s', text => {
    expect(classifyConsentReply(text)).toBe('ambiguous');
  });

  // Booking intent is a sales answer, not permission to market (AGENTS.md: "a
  // permission answer is not buying behaviour"). It must not activate consent.
  it.each([
    'si quiero reservar para el 14',
    'si quiero reservar ya',
  ])('leaves the booking-intent reply %s ambiguous', text => {
    expect(classifyConsentReply(text)).toBe('ambiguous');
  });

  // ...while a two-word prefix followed by a real permission continuation still is a
  // yes, so the stricter rule does not cost us legitimate consent.
  it.each([
    'si claro escribeme',
    'dale pues mandame las promos',
    'de acuerdo avisame cuando haya novedades',
    'si claro que promociones tienen?',
  ])('still grants consent for %s', text => {
    expect(classifyConsentReply(text)).toBe('affirm');
  });
});

describe('parseStoredTimestamp', () => {
  it('parses a real JavaScript ISO timestamp without appending a second Z', () => {
    expect(parseStoredTimestamp('2026-08-12T16:22:00.000Z')).toBe(Date.parse('2026-08-12T16:22:00.000Z'));
  });

  it('parses a SQLite UTC timestamp as UTC', () => {
    expect(parseStoredTimestamp('2026-08-12 16:22:00')).toBe(Date.parse('2026-08-12T16:22:00Z'));
  });
});

describe('validateConsentAsk', () => {
  const good = `Quedamos a mitad de camino con tu plan.\n¿Te parece bien si te escribo más adelante?\n${CONSENT_ASK_MARKER}`;

  it('accepts a well-formed ask and strips the marker', () => {
    const result = validateConsentAsk(good);
    expect(result.ok).toBe(true);
    expect(result.text).not.toContain(CONSENT_ASK_MARKER);
    expect(result.text).toContain('¿Te parece bien');
  });

  // Preserved from before the markerless fallback existed: a bare "¿Te escribo
  // después?" is NOT a permission ask (no contact object beyond the verb itself and
  // no permission frame), so the marker stays mandatory for it.
  it('rejects a draft without the marker', () => {
    expect(validateConsentAsk('¿Te escribo después?').reason).toBe('marker_missing');
  });

  it('accepts a markerless draft whose question is an explicit permission ask', () => {
    const markerlessAsk = 'Quedamos a mitad de camino con tu plan.\n¿Te parece bien si te escribo más adelante?';
    const result = validateConsentAsk(markerlessAsk);
    expect(result.ok).toBe(true);
    expect(result.text).toBe(markerlessAsk);
    expect(result.markerlessAccepted).toBe(true);
  });

  it.each([
    '¿Te parece que te escriba cuando haya novedades?',
    '¿Puedo escribirte con las fechas disponibles?',
    '¿Te puedo contactar cuando haya salidas especiales?',
    '¿Te parece si te aviso más adelante por aquí?',
    '¿Puedo mantenerme en contacto contigo para futuras oportunidades?',
    'Your experience was great. Can I message you about future trips?',
    'Would you mind if I send you updates about new adventures?',
    'Is it okay if I contact you with special offers?',
  ])('accepts the markerless permission ask %s', ask => {
    const result = validateConsentAsk(ask);
    expect(result.ok).toBe(true);
    expect(result.markerlessAccepted).toBe(true);
  });

  // For a group the model correctly switches to plural/formal "les"/"ustedes". A
  // singular-only ("te") pattern set rejected every one of these, which made the
  // qualified-group context the worst performer in `npm run measure:consent`.
  // The first entry is a real draft captured by that script.
  it.each([
    'Heinner por acá. Vi que quedamos con el plan para ustedes cuatro, y quería saber si les sirve que les escriba por aquí cuando haya novedades?',
    '¿Les puedo escribir por aquí cuando haya salidas nuevas?',
    '¿Les parece si les aviso cuando tengamos novedades?',
  ])('accepts the plural/formal permission ask %s', ask => {
    expect(validateConsentAsk(ask).ok).toBe(true);
  });

  // WhatsApp drafts routinely omit the opening `¿`. An `¿`-anchored test rejected
  // these perfectly good asks while accepting the sales turns below.
  it.each([
    'Quedamos pendientes de tu plan. Te parece si te escribo mas adelante con novedades?',
    'Puedo escribirte por aqui cuando haya salidas especiales, te sirve?',
  ])('accepts a real ask that omits the opening question mark: %s', ask => {
    expect(validateConsentAsk(ask).ok).toBe(true);
  });

  // THE regression that matters. Each of these was accepted by a whole-draft
  // keyword match: the sales question would have been sent as the consent ask,
  // burning the one free-form message the 24h window allows, and a bare "sí" to
  // that sales question would then have activated marketing consent.
  it.each([
    'Te escribo el itinerario completo mañana temprano, ¿cuántos van a viajar?',
    'Perfecto, te escribo la confirmacion ahora. ¿Prefieres salida de manana o tarde?',
    'Is it ok for 4 people in one cabin, or do you need two?',
    'Would you like the guided mine tour included in your plan?',
    'Can i send the itinerary in english instead of spanish?',
    '¿Tienes disponibilidad para el mes que viene?',
  ])('never accepts the sales turn %s as a consent ask', draftText => {
    expect(validateConsentAsk(draftText).reason).toBe('marker_missing');
  });

  it('requires a permission frame in the question, not anywhere in the draft', () => {
    // Permission frame present, but attached to a different sentence than the question.
    expect(validateConsentAsk('Te puedo confirmar el cupo hoy. ¿Cuántos son en total?').reason)
      .toBe('marker_missing');
  });

  // The phrasing §PERMISO-SEGUIMIENTO actually asks for: a declarative permission
  // setup closed by a short tag question answerable with a bare "sí". Requiring both
  // signals inside the question rejected this shape, which measured 33% deliverable
  // on the real production context (`npm run measure:consent`). Both entries are
  // real drafts captured by that script.
  it.each([
    'Heinner por acá. Quedamos en que te interesaba la aventura minera, y quería saber si te puedo escribir más adelante por este WhatsApp cuando tengamos novedades o salidas especiales que puedan servirte. ¿Te parece?',
    'Venías mirando el plan de la mina y quería saber si te puedo volver a escribir por este WhatsApp cuando haya novedades. ¿Te parece?',
    'Quedamos pendientes con ustedes y queria saber si les puedo escribir por aqui cuando haya salidas especiales. ¿Les parece?',
  ])('accepts a permission setup closed by a tag question: %s', ask => {
    expect(validateConsentAsk(ask).ok).toBe(true);
  });

  // The tag-question branch must not become a way to smuggle a sales turn through.
  // The question still has to carry the permission frame, and the setup must not be
  // delivering a sales artefact.
  it.each([
    ['a sales deliverable in the setup', 'Te puedo escribir el total mañana por este WhatsApp. ¿Te parece?'],
    ['a price in the setup', 'Quedamos en que te puedo mandar el precio actualizado. ¿Te parece?'],
    ['a sales question after a permission setup', 'Te puedo escribir mas adelante por aqui. ¿Cuantos van a viajar?'],
    // Same sentences as above with the permission inside the question instead of a
    // tag. Guarding only the tag branch made acceptance depend on punctuation.
    ['a sales deliverable inside the question', '¿Te puedo escribir el total mañana por este WhatsApp?'],
    ['an itinerary inside the question', '¿Puedo escribirte el itinerario cuando lo tengamos listo?'],
    ['a quote inside the question', '¿Puedo escribirte la cotizacion mas adelante por aqui?'],
  ])('rejects %s', (_label, ask) => {
    expect(validateConsentAsk(ask).reason).toBe('marker_missing');
  });

  it('still accepts marker-based drafts as before', () => {
    const withMarker = `¿Te parece si te escribo más adelante?\n${CONSENT_ASK_MARKER}`;
    const result = validateConsentAsk(withMarker);
    expect(result.ok).toBe(true);
    expect(result.markerlessAccepted).toBeFalsy();
    expect(result.text).not.toContain(CONSENT_ASK_MARKER);
  });

  // Only the consent marker is stripped, so any other internal marker surviving in
  // the draft would reach the customer verbatim.
  it.each([
    `¿Te puedo escribir mas adelante?\n[[FOTOS:mina]]\n${CONSENT_ASK_MARKER}`,
    '¿Te puedo escribir mas adelante?\n[[FOTOS:mina]]',
  ])('rejects a draft with a residual internal marker', draftText => {
    expect(validateConsentAsk(draftText).reason).toBe('residual_marker');
  });

  // The turn signal is no longer `[[…]]`-shaped, so the residual-marker check above
  // cannot catch it echoing back into customer copy.
  it.each([
    `Quedamos pendientes. SYSTEM_EVENT: PROACTIVE_FOLLOWUP_CONSENT_TURN\n¿Te puedo escribir mas adelante?\n${CONSENT_ASK_MARKER}`,
    '¿Te puedo escribir mas adelante? Respondo al PROACTIVE_FOLLOWUP_CONSENT_TURN',
  ])('rejects a draft that echoes the internal turn signal', draftText => {
    expect(validateConsentAsk(draftText).reason).toBe('internal_echo');
  });

  it('rejects a draft with no question', () => {
    expect(validateConsentAsk(`Te escribo despues sin preguntar nada mas. ${CONSENT_ASK_MARKER}`).reason)
      .toBe('no_question');
  });

  it('rejects more than one question', () => {
    expect(validateConsentAsk(`¿Seguimos? ¿Te escribo el mes que viene? ${CONSENT_ASK_MARKER}`).reason)
      .toBe('multiple_questions');
  });

  it('rejects a draft that smuggles an amount back in', () => {
    expect(validateConsentAsk(`Quedo en $550.000 el plan. ¿Te escribo luego? ${CONSENT_ASK_MARKER}`).reason)
      .toBe('contains_amount');
  });

  it('rejects a markerless draft with amount even if permission pattern is present', () => {
    expect(validateConsentAsk('¿Te puedo escribir con un plan de $550.000?').reason).toBe('contains_amount');
  });

  it('rejects a draft containing a link', () => {
    expect(validateConsentAsk(`Mira https://example.com para todo. ¿Te escribo luego? ${CONSENT_ASK_MARKER}`).reason)
      .toBe('contains_link');
  });

  it('rejects a stub too short to be a real message', () => {
    expect(validateConsentAsk(`¿Si? ${CONSENT_ASK_MARKER}`).reason).toBe('too_short');
  });
});

describe('recurringCycleKey', () => {
  it('is a sequence index, never a calendar key', () => {
    expect(recurringCycleKey(0)).toBe('c1-r1');
    expect(recurringCycleKey(1)).toBe('c1-r2');
    expect(recurringCycleKey(11)).toBe('c1-r12');
  });

  it('scopes the sequence to the consent session', () => {
    expect(recurringCycleKey(0, 2)).toBe('c2-r1');
    expect(recurringCycleKey(3, 3)).toBe('c3-r4');
  });
});

describe('consentCycleKey', () => {
  // Takes `followup_subscriptions.consent_session`, which starts at 1. It used to
  // take a COUNT of previous asks and add one, which meant a cycle that burned its
  // bounded attempts kept the same key forever and could never be re-claimed.
  it('numbers each consent-ask session from one', () => {
    expect(consentCycleKey(1)).toBe('c1');
    expect(consentCycleKey(2)).toBe('c2');
    expect(consentCycleKey(3)).toBe('c3');
  });

  it('never emits c0 for a defensive or legacy zero', () => {
    expect(consentCycleKey(0)).toBe('c1');
  });

  it('matches the consent prefix used by the recurring key', () => {
    expect(recurringCycleKey(0, 2).startsWith(`${consentCycleKey(2)}-`)).toBe(true);
  });
});

describe('addMonthsClamped', () => {
  it('adds a whole month', () => {
    expect(addMonthsClamped(new Date('2026-03-15T10:00:00Z'), 1).toISOString())
      .toBe('2026-04-15T10:00:00.000Z');
  });

  it('clamps Jan 31 to the end of February instead of rolling into March', () => {
    expect(addMonthsClamped(new Date('2026-01-31T10:00:00Z'), 1).toISOString())
      .toBe('2026-02-28T10:00:00.000Z');
  });

  it('handles a leap year', () => {
    expect(addMonthsClamped(new Date('2028-01-31T10:00:00Z'), 1).toISOString())
      .toBe('2028-02-29T10:00:00.000Z');
  });

  it('crosses a year boundary', () => {
    expect(addMonthsClamped(new Date('2026-12-10T10:00:00Z'), 1).toISOString())
      .toBe('2027-01-10T10:00:00.000Z');
  });

  it('subtracts months for the due-before window', () => {
    expect(addMonthsClamped(new Date('2026-03-31T10:00:00Z'), -1).toISOString())
      .toBe('2026-02-28T10:00:00.000Z');
  });
});

describe('dev timing overrides keep sub-minute precision', () => {
  afterEach(() => vi.restoreAllMocks());

  it('honours a 30-second consent override exactly', () => {
    vi.spyOn(env, 'FOLLOWUP_DEV_CONSENT_SECONDS', 'get').mockReturnValue(30);
    expect(consentThresholdMs()).toBe(30_000);
  });

  it('falls back to the production hours when the override is 0', () => {
    vi.spyOn(env, 'FOLLOWUP_DEV_CONSENT_SECONDS', 'get').mockReturnValue(0);
    vi.spyOn(env, 'FOLLOWUP_CONSENT_HOURS_AFTER_INBOUND', 'get').mockReturnValue(23);
    expect(consentThresholdMs()).toBe(23 * 3_600_000);
  });

  it('honours a 45-second recurring override exactly', () => {
    vi.spyOn(env, 'FOLLOWUP_DEV_RECURRING_SECONDS', 'get').mockReturnValue(45);
    const now = Date.parse('2026-08-12T12:00:00.000Z');
    expect(recurringDueBeforeIso(now)).toBe('2026-08-12T11:59:15.000Z');
  });

  it('uses calendar months in production, not a fixed day count', () => {
    vi.spyOn(env, 'FOLLOWUP_DEV_RECURRING_SECONDS', 'get').mockReturnValue(0);
    vi.spyOn(env, 'FOLLOWUP_RECURRING_INTERVAL_MONTHS', 'get').mockReturnValue(1);
    const now = Date.parse('2026-03-31T10:00:00.000Z');
    expect(recurringDueBeforeIso(now)).toBe('2026-02-28T10:00:00.000Z');
  });

  it('completes the whole dev sequence well inside three minutes', () => {
    vi.spyOn(env, 'FOLLOWUP_DEV_CONSENT_SECONDS', 'get').mockReturnValue(30);
    vi.spyOn(env, 'FOLLOWUP_DEV_RECURRING_SECONDS', 'get').mockReturnValue(45);
    // consent ask + a customer reply + three recurring sends.
    const replyAllowanceMs = 10_000;
    const total = consentThresholdMs() + replyAllowanceMs + 3 * (env.FOLLOWUP_DEV_RECURRING_SECONDS * 1_000);
    expect(total).toBeLessThanOrEqual(180_000);
  });
});

describe('production recurring cadence', () => {
  afterEach(() => vi.restoreAllMocks());

  function productionCadence(): void {
    vi.spyOn(env, 'FOLLOWUP_DEV_RECURRING_SECONDS', 'get').mockReturnValue(0);
    vi.spyOn(env, 'FOLLOWUP_RECURRING_INTERVAL_MONTHS', 'get').mockReturnValue(1);
  }

  it('multiplies each production interval by three', () => {
    productionCadence();
    expect(recurringIntervalMonths(0)).toBe(1);
    expect(recurringIntervalMonths(1)).toBe(3);
    expect(recurringIntervalMonths(2)).toBe(9);
    expect(recurringIntervalMonths(3)).toBe(27);
  });

  it('schedules r1 one month after consent', () => {
    productionCadence();
    expect(recurringNextDueAt('2026-01-15T10:00:00.000Z', 0)?.toISOString())
      .toBe('2026-02-15T10:00:00.000Z');
  });

  it('schedules r2 three months after r1', () => {
    productionCadence();
    expect(recurringNextDueAt('2026-02-15T10:00:00.000Z', 1)?.toISOString())
      .toBe('2026-05-15T10:00:00.000Z');
  });

  it('schedules r3 nine months after r2', () => {
    productionCadence();
    expect(recurringNextDueAt('2026-05-15T10:00:00.000Z', 2)?.toISOString())
      .toBe('2027-02-15T10:00:00.000Z');
  });

  it('keeps month-end clamping under exponential intervals', () => {
    productionCadence();
    expect(recurringNextDueAt('2026-01-31T10:00:00.000Z', 0)?.toISOString())
      .toBe('2026-02-28T10:00:00.000Z');
  });

  it('does not send r2 at the old fixed one-month interval', () => {
    productionCadence();
    const candidate = {
      customer_phone: '573000000001',
      language: 'es',
      collected_plan: null,
      selected_experience_id: null,
      sends_so_far: 1,
      consent_cycle: 1,
      last_send_at: '2026-02-15T10:00:00.000Z',
    };
    expect(isRecurringDue(candidate, Date.parse('2026-03-15T10:00:00.000Z'))).toBe(false);
    expect(isRecurringDue(candidate, Date.parse('2026-05-15T10:00:00.000Z'))).toBe(true);
  });

  it('keeps the dev cadence fixed regardless of cycle index', () => {
    vi.spyOn(env, 'FOLLOWUP_DEV_RECURRING_SECONDS', 'get').mockReturnValue(45);
    const anchor = '2026-08-12T12:00:00.000Z';
    expect(recurringNextDueAt(anchor, 0)?.toISOString()).toBe('2026-08-12T12:00:45.000Z');
    expect(recurringNextDueAt(anchor, 8)?.toISOString()).toBe('2026-08-12T12:00:45.000Z');
  });
});

describe('isDuplicateConsentEcho', () => {
  const ACTIVATED = '2026-08-13 17:30:00';
  const activatedMs = Date.parse('2026-08-13T17:30:00Z');
  const active = { status: 'active', activated_at: ACTIVATED };

  it('treats a repeated bare yes inside the window as the same answer', () => {
    expect(isDuplicateConsentEcho(active, 'Si', 120, activatedMs + 30_000)).toBe(true);
    expect(isDuplicateConsentEcho(active, 'si', 120, activatedMs + 1_000)).toBe(true);
  });

  it('closes the cycle once the window has passed', () => {
    expect(isDuplicateConsentEcho(active, 'Si', 120, activatedMs + 121_000)).toBe(false);
  });

  // The echo window exists only to absorb a double-tapped "sí". It must never claim a
  // message carrying real content, or a genuine turn would be misreported as an echo.
  it('does not shield a message carrying real content', () => {
    expect(isDuplicateConsentEcho(active, 'si quiero reservar para el 14', 120, activatedMs + 5_000)).toBe(false);
    expect(isDuplicateConsentEcho(active, 'cuanto vale?', 120, activatedMs + 5_000)).toBe(false);
  });

  it('does not shield a decline', () => {
    expect(isDuplicateConsentEcho(active, 'No', 120, activatedMs + 5_000)).toBe(false);
  });

  it('applies only to an active subscription with an activation time', () => {
    expect(isDuplicateConsentEcho({ status: 'pending', activated_at: ACTIVATED }, 'Si', 120, activatedMs + 5_000)).toBe(false);
    expect(isDuplicateConsentEcho({ status: 'active', activated_at: null }, 'Si', 120, activatedMs + 5_000)).toBe(false);
    expect(isDuplicateConsentEcho(null, 'Si', 120, activatedMs + 5_000)).toBe(false);
  });

  it('is disabled by a zero grace window', () => {
    expect(isDuplicateConsentEcho(active, 'Si', 0, activatedMs + 1_000)).toBe(false);
  });

  it('ignores an activation timestamp in the future', () => {
    expect(isDuplicateConsentEcho(active, 'Si', 120, activatedMs - 5_000)).toBe(false);
  });
});
