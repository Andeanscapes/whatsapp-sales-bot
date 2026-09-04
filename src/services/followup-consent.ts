/**
 * Consent classification and scheduling maths for the recurring follow-up flow.
 *
 * Deliberately free of I/O so the rules are unit-testable: the scheduler and the
 * webhook both call into here, and neither may re-implement the semantics.
 */

/** Marker the model appends to a consent ask; validated and stripped before send. */
export const CONSENT_ASK_MARKER = '[[FOLLOWUP_CONSENT]]';

/**
 * Internal signal placed in the customer-message slot of a proactive consent turn.
 *
 * Deliberately NOT `[[…]]`-shaped. It used to be `[[PROACTIVE_FOLLOWUP_CONSENT_TURN]]`,
 * which put two identically-shaped bracket tokens in the same turn carrying opposite
 * instructions — "never repeat this one" for the input and "always emit this one" for
 * the output. A model that generalises "internal `[[…]]` tokens must not be written"
 * drops both, which is exactly the `draft_marker_missing` exhaustion observed in
 * production. Distinct shapes make the two directions unambiguous.
 */
export const CONSENT_ASK_TURN_EVENT = 'SYSTEM_EVENT: PROACTIVE_FOLLOWUP_CONSENT_TURN';

/** Fragments of the internal turn signal that must never reach a customer. */
const INTERNAL_ECHO_PATTERN = /SYSTEM_EVENT|PROACTIVE_FOLLOWUP_CONSENT_TURN/i;

/**
 * Parses both JS ISO timestamps and SQLite UTC (`YYYY-MM-DD HH:mm:ss`) values.
 *
 * Lives here rather than in the scheduler because the webhook path needs it too,
 * and `followup-service.ts` already imports this module — the reverse would be a
 * cycle. Re-exported from the scheduler for existing callers.
 */
export function parseStoredTimestamp(value: string): number {
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
    ? value
    : `${value.replace(' ', 'T')}Z`;
  return Date.parse(normalized);
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[¿?¡!.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize affirmative variants. Catches:
 *   sii, siii, siiii → si
 *   yea, yeaa, yeah → yes
 */
function normalizeAffirmatives(norm: string): string {
  return norm
    .replace(/\bs(i+)\b/g, 'si')        // sii, siii, etc. → si
    .replace(/\by(e+)(a+|h)\b/g, 'yes'); // yea, yeaa, yeah → yes
}

/** Single-token trailing courtesy. `por favor` is handled as a pair below. */
const TRAILING_COURTESY = new Set(['gracias', 'thanks', 'please', 'porfa', 'porfavor']);

/**
 * Strips a leading greeting and any trailing courtesy so the ≤6-word test measures
 * the ANSWER, not the politeness around it. Recovers the real production reply
 * "Buenos días, si señor por favor y gracias" → "si senor".
 *
 * Iterative because a real reply stacks them ("… por favor y gracias"), and a single
 * pass leaves a dangling conjunction that then fails exact matching.
 *
 * A trailing courtesy is NEVER stripped when it follows a bare negation: "no gracias"
 * and "no thanks" ARE the refusal, and splitting them turned a decline into a bare
 * "no", which this module deliberately reads as a sales answer rather than a refusal.
 */
function stripCourtesyFrame(norm: string): string {
  let words = norm
    .replace(/^(buenos dias|buenas|buenos|hola|hi|hello|hey)\s*,?\s*/, '')
    .split(' ')
    .filter(word => word.length > 0);

  for (;;) {
    const count = words.length;
    if (count < 2) break;
    const last = words[count - 1];
    const previous = words[count - 2];

    // "no gracias" / "no thanks" — the courtesy carries the refusal.
    if (BARE_NEGATIONS.has(previous)) break;

    if (last === 'favor' && previous === 'por') {
      // "no por favor" is equally a refusal; keep it intact.
      if (count >= 3 && BARE_NEGATIONS.has(words[count - 3])) break;
      words = words.slice(0, count - 2);
      continue;
    }
    if (TRAILING_COURTESY.has(last)) {
      words = words.slice(0, count - 1);
      continue;
    }
    // Conjunction left dangling by a strip above ("… por favor y gracias").
    if (last === 'y') {
      words = words.slice(0, count - 1);
      continue;
    }
    break;
  }

  return words.join(' ');
}

/**
 * Emoji that stand alone as a permission answer.
 *
 * Deliberately NOT a character class: a class of astral-plane codepoints without the
 * `u` flag is a class of surrogate HALVES, so `^[👍]$` never matches the two-code-unit
 * emoji it appears to describe — it silently classified every 👍 as ambiguous, and
 * `no-misleading-character-class` fails lint on it.
 *
 * Kept to unambiguous assent. A generic reaction (💪, 👏, ❤️) is not permission to
 * send marketing, and treating it as one records a grant the customer never gave.
 * 🙏 is excluded for the same reason: in WhatsApp it reads as thanks or a plea far
 * more often than as "yes, write to me".
 */
const AFFIRM_EMOJI = new Set(['👍', '👌', '✅']);

/**
 * Variation selectors and skin-tone modifiers, so "👍🏽" is the same answer as "👍".
 *
 * Written as an alternation rather than a character class: a class mixing a variation
 * selector with emoji fails `no-misleading-character-class`, because a class element
 * can silently combine with its neighbour.
 */
const EMOJI_MODIFIERS =
  /\u{FE0E}|\u{FE0F}|\u{1F3FB}|\u{1F3FC}|\u{1F3FD}|\u{1F3FE}|\u{1F3FF}/gu;

function isBareEmojiAffirmation(text: string): boolean {
  const bare = text.trim().replace(EMOJI_MODIFIERS, '');
  return AFFIRM_EMOJI.has(bare);
}

// Affirmatives are matched only while a consent ask is pending, so short tokens are
// safe here. They would be far too greedy in the general sales path.
const AFFIRM = [
  'si', 'si claro', 'claro', 'claro que si', 'dale', 'listo', 'bueno', 'dale pues',
  'si porfa', 'si por favor', 'dale gracias', 'dale listo', 'dale si', 'dale ok',
  'dale va', 'dale de una', 'de una', 'dale hazlo', 'esta bien', 'dale tranquilo',
  'ok', 'okey', 'oki', 'vale', 'va', 'perfecto', 'de acuerdo', 'me parece',
  'si me interesa', 'si quiero', 'acepto', 'autorizo', 'permiso concedido',
  // Explicit grant phrases
  'si senor', 'si sr', 'escribeme', 'escribame', 'puedes escribirme',
  'me avisas', 'si mas adelante', 'mas adelante si',
  'yes', 'yes please', 'yeah', 'yep', 'yup', 'sure', 'sure thing', 'of course',
  'okay', 'alright', 'fine', 'go ahead', 'sounds good', 'please do', 'i accept',
  'that works', 'no problem',
];

const DECLINE = [
  'no', 'no gracias', 'no por favor', 'nope', 'negativo', 'mejor no', 'no por ahora',
  'no me interesa', 'no quiero', 'preferiria no', 'prefiero no', 'no hace falta',
  'no necesito', 'ahora no', 'por ahora no', 'no thanks', 'no thank you',
  'nah', 'not now', 'not interested', 'rather not', 'no need', 'dont',
];

/**
 * Bare negation tokens. On their own they are far more often the verb negation of
 * a sales answer ("no tengo fecha") than a refusal of the permission question, so
 * they only count as a decline when the whole reply IS one of them.
 */
const BARE_NEGATIONS = new Set(['no', 'not', 'dont', 'nope', 'nah']);

/**
 * Refusals unmistakable enough to match ANYWHERE in a short reply.
 *
 * This is what keeps "si, pero no quiero mensajes" a decline without treating
 * every stray "no" as one.
 *
 * DERIVED from `DECLINE` rather than retyped: the two lists overlapped by 19
 * entries when written by hand, so adding a refusal to one and forgetting the
 * other silently changed classification. Only the bare tokens are filtered out,
 * plus the explicit extras below that have no single-phrase form in `DECLINE`.
 */
const DECLINE_ANYWHERE = [
  ...DECLINE.filter(phrase => !BARE_NEGATIONS.has(phrase)),
  // Spanish: refusing further contact.
  'no me escribas', 'no me escriban', 'no me avises', 'no me avisen',
  'no me contactes', 'no me contacten', 'no me mandes', 'no me manden',
  'no me envies', 'no me envien', 'no me interesa nada',
  'dejalo asi', 'dejelo asi', 'dejalo ahi',
  // English: `dont`/`not` are bare tokens, so every negated-contact form needs an
  // explicit entry. Omitting these classified "i dont want more messages" as
  // ambiguous, which then let the deferral re-ask someone who had just refused.
  'dont want', 'do not want', 'dont send', 'do not send',
  'dont contact', 'do not contact', 'dont message', 'do not message',
  'dont bother', 'do not bother', 'dont write', 'do not write',
  'not really', 'leave it', 'im good', 'i am good',
];

function containsPhrase(normalized: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(normalized);
}

/**
 * What keeps a LEADING affirmative token a real yes rather than the first word of a
 * sales answer.
 *
 * Two shapes only:
 * - an interrogative asking what is coming ("si cuales?", "si que promociones tienen");
 * - the contact being authorised ("si escribeme cuando quieras", "claro mandame las promos").
 *
 * Everything else — "si un ritmo tranquilo", "si 4 personas", "si para diciembre" —
 * answers the SALES question and must leave consent untouched.
 */
const CONSENT_CONTACT_CONTINUATION = /escrib|avis|mensaje|contact|mand|envi|perm/;
const CONSENT_QUESTION_CONTINUATION =
  /\b(cual|cuales|que|cuando|como|donde|cuanto|cuantos|what|which|when)\b/;

export type ConsentDecision = 'affirm' | 'decline' | 'ambiguous';

/**
 * Classifies a reply to a pending consent ask.
 *
 * Only ever called while `followup_subscriptions.status = 'pending'`. Anything that
 * is not an unmistakable yes/no is `ambiguous`, which leaves consent untouched and
 * lets the message flow through the normal sales path.
 *
 * Decline wins ties: "no, gracias" contains an affirm-ish token in some phrasings,
 * and the safe failure mode is to not collect consent.
 */
export function classifyConsentReply(text: string): ConsentDecision {
  // Bare emoji affirmation (thumbs up, check, etc.)
  if (isBareEmojiAffirmation(text)) return 'affirm';

  const norm = normalize(text);
  if (!norm) return 'ambiguous';

  // "sii"/"siii"/"yeaa" are the same answer as "si"/"yes". Normalised before the
  // length test so the elongation cannot push a one-word reply out of the window.
  const normalized = normalizeAffirmatives(norm);

  // Politeness is not part of the answer, so it is stripped before the ≤6-word test.
  const stripped = stripCourtesyFrame(normalized);

  const words = stripped.split(' ').filter(word => word.length > 0);
  // Long messages are a real conversation turn, not a yes/no answer.
  if (words.length > 6) return 'ambiguous';
  if (words.length === 0) return 'ambiguous';

  if (DECLINE.includes(stripped)) return 'decline';
  if (AFFIRM.includes(stripped)) return 'affirm';

  // An unmistakable refusal wins wherever it sits, so "si, pero no quiero
  // mensajes" can never activate marketing consent.
  if (DECLINE_ANYWHERE.some(phrase => containsPhrase(stripped, phrase))) return 'decline';

  // Narrow leading-token fallback for "si, escribeme" / "no gracias igual".
  //
  // A BARE leading negation is deliberately NOT a decline: "no" is usually the
  // verb negation of a sales answer, not a refusal of the permission question.
  // Treating it as one recorded "no tengo fecha", "no todavia", "no se aun" and
  // "no entendi tu pregunta" as refusals — and `declined` never auto-reopens, so
  // those leads could never be asked again. Two-token declines ("no gracias …")
  // still match, and anything genuinely refusing contact is caught above.
  const first = words[0];
  const firstTwo = words.slice(0, 2).join(' ');

  if (DECLINE.includes(firstTwo)) return 'decline';

  // How many leading words form a known affirmative: "de acuerdo" (2), "si" (1), or
  // none. The longer prefix wins so the remainder under test is the smallest.
  //
  // BOTH lengths must validate the remainder. A two-word prefix used to short-circuit
  // straight to `affirm`, which routed around the check below entirely: "si claro un
  // ritmo tranquilo" and "de acuerdo para diciembre" recorded marketing consent from a
  // plain sales answer — the exact bug the one-word branch was added to stop.
  const affirmPrefix = words.length >= 2 && AFFIRM.includes(firstTwo)
    ? 2
    : AFFIRM.includes(first) ? 1 : 0;

  if (affirmPrefix > 0) {
    if (words.length === affirmPrefix) return 'affirm';

    // A LEADING affirmative token is not by itself a yes: it is also the first word
    // of a sales answer. Live 2026-09-02 the reply "Si un ritmo tranquilo" — an
    // answer about trip pace — was recorded as marketing consent the customer never
    // gave, because the leading token alone decided it.
    //
    // The continuation is what disambiguates: a real yes either asks WHAT is coming
    // ("si cuales?", "si que promociones tienen") or names the contact being
    // authorised ("si escribeme cuando quieras"). Anything else answers a sales
    // question and must stay ambiguous, leaving consent untouched — including
    // booking intent ("si quiero reservar para el 14"), which is a sales answer and
    // not permission to market (AGENTS.md: a permission answer is not buying
    // behaviour).
    const remainder = words.slice(affirmPrefix).join(' ');
    if (AFFIRM.includes(remainder)) return 'affirm';
    if (CONSENT_CONTACT_CONTINUATION.test(remainder)) return 'affirm';
    if (/[?¿]/.test(text) && CONSENT_QUESTION_CONTINUATION.test(remainder)) return 'affirm';
    return 'ambiguous';
  }

  return 'ambiguous';
}

/**
 * Exact-match affirmation only — no leading-token fallback.
 *
 * Narrower than `classifyConsentReply` on purpose. That function accepts a leading
 * affirmative plus a permission-shaped continuation ("si escribeme"), which is right
 * when deciding a pending ask but wrong for the duplicate-echo window: the echo
 * window exists only to absorb a double-tapped bare "sí", so anything carrying extra
 * content must fall through as an ordinary turn.
 *
 * Uses the same affirmative normalization as the classifier so "Sii" and "Si" are
 * recognized as the same affirmation.
 */
function isBareAffirmation(text: string): boolean {
  if (isBareEmojiAffirmation(text)) return true;
  const norm = normalize(text);
  if (norm === '') return false;
  const normalized = normalizeAffirmatives(norm);
  return AFFIRM.includes(normalized);
}

/**
 * True when this inbound is the customer repeating the "sí" they just gave, inside
 * `graceSeconds` of consent activating.
 *
 * WhatsApp users double-tap send. Without this, the second identical "Si" is read
 * as a fresh customer-initiated turn and closes the cycle that the first one just
 * opened — leaving the bot promising a follow-up it is no longer authorised to
 * send. Deliberately narrow:
 * - only while the subscription is `active` and only from its `activated_at`;
 * - only for an EXACT bare affirmation: "si quiero reservar el 14" carries intent
 *   and must still close the cycle, even though the consent classifier would read
 *   it as an affirmation;
 * - `graceSeconds <= 0` disables it entirely.
 *
 * It does not weaken the dormancy floor: a recurring template still requires the
 * thread to go silent for `FOLLOWUP_RECURRING_MIN_SILENCE_HOURS`, so a customer who
 * genuinely keeps talking cannot receive one regardless of this window.
 */
export function isDuplicateConsentEcho(
  subscription: { status: string; activated_at: string | null } | null,
  message: string,
  graceSeconds: number,
  now: number = Date.now(),
): boolean {
  if (graceSeconds <= 0) return false;
  if (!subscription || subscription.status !== 'active' || !subscription.activated_at) return false;
  if (!isBareAffirmation(message)) return false;

  const activatedAtMs = parseStoredTimestamp(subscription.activated_at);
  if (Number.isNaN(activatedAtMs)) return false;
  const elapsed = now - activatedAtMs;
  return elapsed >= 0 && elapsed <= graceSeconds * 1_000;
}

export interface ConsentAskValidation {
  ok: boolean;
  /** Marker-stripped text, present only when `ok` is true. */
  text?: string;
  reason?: string;
  /** True if marker was omitted but draft was accepted as explicit permission question. */
  markerlessAccepted?: boolean;
}

/**
 * Second-person object pronouns, singular AND plural/formal.
 *
 * The plural forms are load-bearing, not decoration: for a group the model correctly
 * writes "¿les sirve que les escriba…?" / "¿les puedo escribir…?", and a singular-only
 * pattern set rejected every one of those. Measured with
 * `npm run measure:consent`: the qualified-group context was the worst performer
 * precisely because of this gap.
 */
const YOU = '(?:te|le|les|os)';

/**
 * Asking-for-permission frames. Deliberately excludes offer frames ("would you
 * like…", "te interesa…"): those introduce a product, not a request to write later.
 */
const PERMISSION_FRAME = [
  // Spanish
  new RegExp(`\\b${YOU}\\s+puedo\\b`), /\bpuedo\b/, /\bpodria\b/,
  new RegExp(`\\b${YOU}\\s+(?:parece|sirve|molesta)\\b`),
  /\bme\s+permit(?:es|en)\b/, /\bautoriza(?:s|n)?\b/, /\besta\s+bien\s+si\b/,
  /\bme\s+deja(?:s|n)\b/,
  // English
  /\bcan\s+i\b/, /\bmay\s+i\b/, /\bis\s+it\s+ok(?:ay)?\s+(?:if|to)\b/,
  /\b(?:would|do)\s+you\s+mind\b/, /\bare\s+you\s+ok(?:ay)?\s+with\b/,
];

/**
 * The thing being permitted must be FUTURE CONTACT, not a sales artefact.
 *
 * Spanish entries are stems so they cover the conjugations the model actually uses
 * ("escriba", "escribirles", "avisarles"). `send you` rather than a bare `send` is
 * what separates "can i send you updates" (a permission ask) from "can i send the
 * itinerary" (a sales turn).
 */
const CONTACT_OBJECT = [
  // Spanish
  /\bescrib/, /\bavis/, /contact/, /\bmensaje/, /\bcomunic/,
  new RegExp(`\\bmandar${YOU}\\b`), new RegExp(`\\b${YOU}\\s+mando\\b`),
  // English
  /\bmessag/, /\bwrit/, /\breach\s+out\b/, /\bsend\s+you\b/, /\btext\s+you\b/, /\bemail/,
];

/**
 * Sales artefacts. Their presence means "escribir" is delivering a sales document,
 * not asking to make contact later, so a tag question must not rescue them.
 */
const SALES_DELIVERABLE = /\b(?:total|precio|valor|cotizaci|itinerario|factura|comprobante|anticipo|link|cupo|disponibilidad|reserva|pago|deposito)/;

/**
 * Splits the draft into the sentence carrying the question and everything before it.
 *
 * Scoping to the question — rather than testing the whole draft — is the safety
 * property. "Te escribo el itinerario mañana, ¿cuántos van a viajar?" contains
 * permission-shaped words but its QUESTION is a sales question; a whole-draft match
 * accepted it, burned the single free-form message the 24h window allows, and let a
 * bare "sí" to that sales question activate marketing consent.
 *
 * Callers guarantee exactly one `?`.
 */
function splitAtQuestion(text: string): { setup: string; question: string } {
  const end = text.indexOf('?');
  if (end < 0) return { setup: '', question: '' };
  const head = text.slice(0, end);
  const start = Math.max(
    head.lastIndexOf('.'),
    head.lastIndexOf('!'),
    head.lastIndexOf('\n'),
    head.lastIndexOf('¿'),
  );
  return { setup: head.slice(0, start + 1), question: head.slice(start + 1) };
}

/**
 * True when the draft is an explicit request for permission to make future contact.
 *
 * The question sentence must ALWAYS carry a permission frame — that is what keeps a
 * sales question ("¿cuántos van a viajar?") from ever qualifying, no matter what the
 * rest of the draft says. What the contact object is allowed to do is move:
 *
 * - (A) self-contained: "¿Te puedo escribir más adelante?" — both signals in the question.
 * - (B) tag question: "…quería saber si te puedo escribir más adelante por aquí. ¿Te parece?"
 *   The question is a permission tag and the contact object sits in the setup.
 *
 * (B) exists because it is the phrasing §PERMISO-SEGUIMIENTO actively asks for (a
 * close answerable with a bare "sí"), and requiring both signals in the question
 * rejected it — measured at 33% deliverable on the real production context with
 * `npm run measure:consent`. It is bounded by the frame requirement above plus the
 * sales-deliverable exclusion, so "Te puedo escribir el total mañana. ¿Te parece?"
 * stays rejected.
 *
 * Unanchored on purpose: WhatsApp drafts routinely omit the opening `¿`.
 */
function isExplicitPermissionQuestion(text: string): boolean {
  const { setup, question } = splitAtQuestion(text);
  const q = normalize(question);
  if (!q) return false;
  // Non-negotiable: the thing being asked must be permission, never trip details.
  if (!PERMISSION_FRAME.some(p => p.test(q))) return false;

  // The sales-deliverable exclusion applies to whichever segment carries the contact
  // object — that segment IS the permission subject. Guarding only the tag-question
  // branch made the same sentence pass or fail depending on punctuation:
  // "¿Te puedo escribir el total mañana?" was accepted while
  // "Te puedo escribir el total mañana. ¿Te parece?" was rejected.
  if (CONTACT_OBJECT.some(p => p.test(q))) return !SALES_DELIVERABLE.test(q);

  const s = normalize(setup);
  if (!s || SALES_DELIVERABLE.test(s)) return false;
  return PERMISSION_FRAME.some(p => p.test(s)) && CONTACT_OBJECT.some(p => p.test(s));
}

/**
 * Validates an LLM-authored consent ask. The engine may only accept-and-strip or
 * reject: rewriting or appending copy would violate the "LLM owns reply text"
 * invariant, so a malformed draft is discarded rather than repaired.
 *
 * Fallback: if the marker is missing but the text is an explicit permission question
 * with valid structure, it is accepted without the marker. This prevents leads from
 * becoming permanently blocked when the LLM omits the internal marker due to prompt
 * variance, while preserving safety (no sales copy, exactly one question, no amounts).
 */
export function validateConsentAsk(reply: string): ConsentAskValidation {
  const raw = reply.trim();
  const hasMarker = raw.includes(CONSENT_ASK_MARKER);

  const text = hasMarker
    ? raw.split(CONSENT_ASK_MARKER).join('').trim()
    : raw;

  if (text.length < 20) return { ok: false, reason: 'too_short' };
  if (text.length > 900) return { ok: false, reason: 'too_long' };

  const questionCount = (text.match(/\?/g) ?? []).length;
  if (questionCount === 0) return { ok: false, reason: 'no_question' };
  if (questionCount > 1) return { ok: false, reason: 'multiple_questions' };

  // The ask must not smuggle the sales pitch back in.
  if (/\$\s?\d|\b\d{1,3}[.,]\d{3}\b/.test(text)) return { ok: false, reason: 'contains_amount' };
  if (/\bhttps?:\/\//i.test(text)) return { ok: false, reason: 'contains_link' };
  // Only the consent marker is stripped, so any OTHER internal marker left in the
  // draft would be delivered verbatim to the customer.
  if (text.includes('[[')) return { ok: false, reason: 'residual_marker' };
  // The turn signal is no longer bracketed, so the check above cannot catch it.
  if (INTERNAL_ECHO_PATTERN.test(text)) return { ok: false, reason: 'internal_echo' };

  // The marker stays the contract. Accepting a markerless draft is a bounded
  // fallback for prompt variance, and only when the draft's own question is an
  // unmistakable request for permission to write later.
  if (!hasMarker && !isExplicitPermissionQuestion(text)) {
    return { ok: false, reason: 'marker_missing' };
  }

  return { ok: true, text, markerlessAccepted: !hasMarker };
}

/**
 * `c1`, `c2`, … — one key per consent-ask SESSION, so a customer who opted out and
 * later returned can be asked again without colliding with the first ask.
 *
 * Takes the session number directly (`followup_subscriptions.consent_session`,
 * which starts at 1). It deliberately does NOT add one: deriving the key from a
 * COUNT of previous asks made a cycle that burned its bounded attempts keep the
 * same key forever, so the customer could never be asked again.
 */
export function consentCycleKey(consentSession: number): string {
  return `c${Math.max(1, Math.floor(consentSession))}`;
}

/** `c1-r1`, `c2-r1`, … — scoped by consent session, never a calendar key. */
export function recurringCycleKey(sendsSoFar: number, consentCycle: number = 1): string {
  return `c${Math.max(1, consentCycle)}-r${sendsSoFar + 1}`;
}

/**
 * Adds whole months, clamping to the last valid day so Jan 31 + 1 month lands on
 * Feb 28/29 instead of rolling into March.
 */
export function addMonthsClamped(from: Date, months: number): Date {
  const targetMonth = from.getUTCMonth() + months;
  const candidate = new Date(Date.UTC(
    from.getUTCFullYear(), targetMonth, 1,
    from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(), from.getUTCMilliseconds(),
  ));
  const daysInTargetMonth = new Date(Date.UTC(
    candidate.getUTCFullYear(), candidate.getUTCMonth() + 1, 0,
  )).getUTCDate();
  candidate.setUTCDate(Math.min(from.getUTCDate(), daysInTargetMonth));
  return candidate;
}
