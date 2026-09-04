import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import type {
  Repositories,
  FollowupCandidateRow,
  ConsentAskCandidateRow,
  RecurringCandidateRow,
} from '../db/repositories/index.js';
import { sendTemplate, sendImageUrlWithId, sendTextWithId, MAX_IMAGE_CAPTION_CHARS, WhatsAppSendError } from './whatsapp-client.js';
import { getSkills } from './skill-loader.js';
import { findActiveExperience, getActiveExperience, getDynamicPlanImages, getOwnerImage, getPlans } from './product-registry.js';
import { selectThemedImage } from './contextual-media.js';
import { followupGalleryMediaId, recordImageSend } from './media-service.js';
import { recordOutboundMedia } from './conversation-media.js';
import { buildSystemPrompt } from './deepseek-client.js';
import { llmClient } from './response-engine.js';
import { addMonthsClamped, consentCycleKey, CONSENT_ASK_TURN_EVENT, parseStoredTimestamp, recurringCycleKey, validateConsentAsk } from './followup-consent.js';
import { checkBudget } from './budget-guard.js';
import { estimateDeepSeekCost } from './deepseek-cost.js';
import { notifyOwnerOnce } from './owner-notice.js';

/**
 * One-shot post-24h Meta template dispatch.
 *
 * Deliberate boundaries (see docs/skills-architecture.md):
 * - No LLM involvement. The body is Meta-approved; only the plan display name and
 *   the header image are filled, both resolved through `product-registry.ts`.
 * - No sales copy in TypeScript. When the plan cannot be resolved from the
 *   registry the send is skipped rather than substituted with invented text.
 * - Exactly one delivered template per customer, enforced in SQL.
 */

/**
 * Silence threshold in hours. `FOLLOWUP_DEV_MINUTES` is rejected in production by env.ts.
 *
 * Exported so the operator digest projects the one-shot due time from the same
 * source as the sender. A second copy of this rule would drift.
 */
export function silenceThresholdHours(): number {
  if (env.FOLLOWUP_DEV_MINUTES > 0) return env.FOLLOWUP_DEV_MINUTES / 60;
  return env.FOLLOWUP_HOURS_AFTER_INBOUND;
}

export function devAllowlist(): string[] {
  return env.FOLLOWUP_DEV_ALLOWLIST_PHONES.split(',').map(entry => entry.trim()).filter(Boolean);
}

/**
 * Permission to send the one-shot post-24h template: an operator grant OR the
 * customer's own "sí". Two provenances, one predicate.
 *
 * MUST stay the exact complement of the permission clause in
 * `listFollowupCandidates`. The scan and this post-claim re-check drifting apart is
 * not a theoretical risk — it is the bug this function exists to prevent: widening
 * only the SQL left every customer-consented candidate failing here as
 * `consent_revoked`, i.e. selected for sending and then silently discarded.
 *
 * Deliberately NOT a duplicated write into `followup_consent`: the two tables must
 * keep their provenance distinct so `/followupstatus` can say WHO granted it.
 *
 * A recorded `declined` outranks both provenances. An operator grant is only a
 * presumption of consent; a customer "no" is the answer to the question we asked,
 * and `decline()` writes the subscription WITHOUT revoking the operator row — so
 * without this check the OR below sent a marketing template to a lead who had
 * explicitly refused, whenever an older `/followupgrant` existed.
 *
 * The live status is not sufficient on its own, because `revoke()` overwrites
 * `declined` with `revoked`: an operator running `/followuprevoke` and then
 * `/followupgrant` erased the refusal from the only field this predicate could see,
 * and the template shipped after a recorded "no". The append-only ledger is
 * therefore consulted for the customer's own latest decision. Leads who decided
 * before the ledger existed have no rows, so absence still means "no refusal on
 * record" — never "no permission".
 */
export function hasFollowupPermission(repos: Repositories, phone: string): boolean {
  const subscription = repos.followupSubscription.getByPhone(phone);
  if (subscription?.status === 'declined') return false;
  if (repos.followupConsentGrant.latestCustomerDecision(phone)?.decision === 'decline') return false;
  if (repos.followupConsent.hasConsent(phone)) return true;
  return subscription?.status === 'active';
}

/** ES and EN are separate approved templates; an unset EN name means EN leads are skipped. */
function resolveTemplateName(language: string | null): string | null {
  if (language === 'en') return env.FOLLOWUP_TEMPLATE_NAME_EN.trim() || null;
  return env.FOLLOWUP_TEMPLATE_NAME.trim() || null;
}

function resolveLanguageCode(language: string | null): string {
  return language === 'en' ? 'en' : 'es_CO';
}

/** Meta must be able to fetch the header image, so only public HTTPS URLs qualify. */
function isPublicHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

interface TemplatePayload {
  bodyParams: string[];
  headerImageUrl?: string;
  /**
   * Set only when the header came from the rotating gallery, so the caller can
   * record the send and stop the next template reusing the same photo.
   */
  headerGalleryMediaId?: string;
}

/**
 * Resolves the single body variable (plan display name) and the header image from
 * the product registry. Returns `null` when the approved template's required
 * pieces are unavailable — Meta rejects a missing required header with #132000,
 * so skipping keeps the audit trail honest instead of burning the attempt.
 *
 * Header preference: a random photo of `FOLLOWUP_TEMPLATE_IMAGE_TYPE` (so repeat
 * templates do not always show the same plan brochure), then the plan card, then
 * the owner photo. The theme name lives in config, never in TypeScript — the feed
 * stays the only source of theme vocabulary.
 */
function buildTemplatePayload(
  repos: Repositories,
  candidate: FollowupCandidateRow,
  header: 'image' | 'none' = env.FOLLOWUP_TEMPLATE_HEADER,
): TemplatePayload | null {
  const skills = getSkills();
  const experience = candidate.selected_experience_id
    ? findActiveExperience(skills, candidate.selected_experience_id)
    : getActiveExperience(skills);
  if (!experience) return null;
  const plan = candidate.collected_plan
    ? getPlans(experience).find(entry => entry.id === candidate.collected_plan)
    : undefined;

  const bodyParam = plan?.name ?? experience.name;
  if (!bodyParam) return null;

  if (header === 'none') return { bodyParams: [bodyParam] };

  const themed = selectThemedImage(
    skills,
    repos,
    candidate.customer_phone,
    env.FOLLOWUP_TEMPLATE_IMAGE_TYPE,
    experience.id,
    plan?.siteId,
  );
  const planImage = plan
    ? getDynamicPlanImages(skills).find(image =>
      image.experienceId === experience.id && image.planId === plan.id)
    : undefined;

  // First candidate that is actually sendable wins. Validating per candidate (not
  // just the winner) matters: an unusable themed URL must fall through to the plan
  // card, never abort a send the plan card could have carried.
  const headerImageUrl = [themed?.url, planImage?.url, getOwnerImage(skills)?.url]
    .find((url): url is string => url != null && isPublicHttpsUrl(url));
  if (!headerImageUrl) return null;

  return {
    bodyParams: [bodyParam],
    headerImageUrl,
    ...(themed && headerImageUrl === themed.url ? { headerGalleryMediaId: followupGalleryMediaId(themed) } : {}),
  };
}

async function processCandidate(repos: Repositories, candidate: FollowupCandidateRow): Promise<boolean> {
  const phone = candidate.customer_phone;

  const templateName = resolveTemplateName(candidate.language);
  if (!templateName) {
    logger.warn({ phone, language: candidate.language }, '[FOLLOWUP] no approved template for language — skipped');
    return false;
  }

  const payload = buildTemplatePayload(repos, candidate);
  if (!payload) {
    logger.warn({ phone }, '[FOLLOWUP] template assets unavailable (plan/header image) — skipped');
    return false;
  }

  const claimId = repos.followupEvent.claim(
    phone,
    candidate.anchor_at,
    env.FOLLOWUP_MAX_ATTEMPTS,
    env.FOLLOWUP_CLAIM_STALE_MINUTES,
  );
  if (claimId === null) return false;

  // Re-read state after the claim: pause/opt-out/booking/handoff/ownership may
  // have landed between the candidate scan and now.
  if (repos.isPaused()) {
    repos.followupEvent.releaseClaim(claimId);
    logger.info({ phone }, '[FOLLOWUP] bot paused — claim released');
    return false;
  }
  const conversation = repos.conversation.getByPhone(phone);
  if (!conversation) {
    repos.followupEvent.markFailed(claimId, 'conversation_not_found');
    return false;
  }
  const mode = conversation.conversation_mode ?? 'bot';
  if (
    conversation.opt_out_at
    || conversation.converted_at
    || conversation.handed_off_at
    || conversation.soft_closed_at
    || mode === 'bridge_active'
    || mode === 'referred'
    || mode === 'human_only'
  ) {
    repos.followupEvent.markFailed(claimId, 'guard_state_changed');
    return false;
  }
  if (!hasFollowupPermission(repos, phone)) {
    repos.followupEvent.markFailed(claimId, 'consent_revoked');
    return false;
  }
  if (!stillDormantAtAnchor(repos, phone, candidate.anchor_at)) {
    repos.followupEvent.releaseClaim(claimId);
    logger.info({ phone }, '[FOLLOWUP] one-shot skipped — customer active again');
    return false;
  }

  try {
    // Persist a terminal no-retry boundary before entering Meta. A definite HTTP
    // rejection transitions to failed below; a process crash remains uncertain.
    repos.followupEvent.markDispatching(claimId);
    const result = await sendTemplate(
      phone,
      templateName,
      resolveLanguageCode(candidate.language),
      payload.bodyParams,
      payload.headerImageUrl,
    );
    repos.followupEvent.markSent(claimId, result.whatsappMessageId);
    repos.message.addMessage({
      customer_phone: phone,
      direction: 'outbound',
      message_type: 'template',
      body: `[template:${templateName}]`,
      created_at: new Date().toISOString(),
      whatsapp_message_id: result.whatsappMessageId,
    });
    // Recorded so the next template prefers a photo this customer has not seen.
    if (payload.headerGalleryMediaId) recordImageSend(repos, phone, payload.headerGalleryMediaId);
    if (payload.headerImageUrl) {
      recordOutboundMedia(repos, {
        phone,
        url: payload.headerImageUrl,
        mediaId: payload.headerGalleryMediaId ?? `followup_header:${templateName}`,
        caption: '',
        carriedReply: false,
        flow: 'followup_template',
      });
    }
    logger.info({ phone, templateName, whatsappMessageId: result.whatsappMessageId }, '[FOLLOWUP] template sent');
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown_error';
    // deliveryUncertain: Meta may already have the message — never auto-retry.
    if (error instanceof WhatsAppSendError && error.deliveryUncertain) {
      repos.followupEvent.markUncertain(claimId, reason);
      logger.warn({ phone, templateName, reason }, '[FOLLOWUP] template delivery uncertain — no retry');
      return false;
    }
    const retryable = error instanceof WhatsAppSendError && error.retryable;
    repos.followupEvent.markFailed(claimId, reason);
    logger.warn({ phone, templateName, retryable, reason }, '[FOLLOWUP] template send failed');
    return false;
  }
}

export async function runFollowupCycle(repos: Repositories): Promise<void> {
  if (!env.ALLOW_FOLLOWUP_TEMPLATE) return;

  const silentSinceIso = new Date(Date.now() - silenceThresholdHours() * 60 * 60 * 1000).toISOString();
  const allowlist = devAllowlist();

  let candidates: FollowupCandidateRow[];
  try {
    candidates = repos.conversation.listFollowupCandidates({
      silentSinceIso,
      limit: env.FOLLOWUP_MAX_SENDS_PER_TICK,
    });
  } catch (err) {
    logger.error(err, '[FOLLOWUP] candidate query failed');
    return;
  }

  const targets = allowlist.length > 0
    ? candidates.filter(candidate => allowlist.includes(candidate.customer_phone))
    : candidates;

  for (const candidate of targets) {
    try {
      await processCandidate(repos, candidate);
    } catch (err) {
      logger.error(err, '[FOLLOWUP] candidate processing failed');
    }
  }
}

// ---------------------------------------------------------------------------
// Stage 1 — consent ask (free-form, LLM-authored, inside the 24h window)
// ---------------------------------------------------------------------------

/**
 * Silence required after the customer's last inbound, in milliseconds.
 *
 * Expressed in ms rather than hours so the dev override keeps sub-minute precision:
 * an hours-based fraction would round a 30s test window into uselessness.
 * The dev override is rejected in production by env.ts.
 */
export function consentThresholdMs(): number {
  if (env.FOLLOWUP_DEV_CONSENT_SECONDS > 0) return env.FOLLOWUP_DEV_CONSENT_SECONDS * 1_000;
  return env.FOLLOWUP_CONSENT_HOURS_AFTER_INBOUND * 3_600_000;
}

/**
 * Meta measures the free-form window from the CUSTOMER's last message. Any inbound
 * older than this is past the window and must never receive free-form text.
 */
export const FREE_FORM_WINDOW_HOURS = 24;
/** Safety margin so a slow tick or a retry cannot land microseconds past the window. */
export const WINDOW_SAFETY_MINUTES = 10;
/** Free-form window in ms, minus the safety margin. Single source for every caller. */
export const FREE_FORM_WINDOW_MS = (FREE_FORM_WINDOW_HOURS * 60 - WINDOW_SAFETY_MINUTES) * 60_000;

export { parseStoredTimestamp };

/**
 * Re-checks the scan's dormancy snapshot immediately before dispatch. A changed
 * inbound anchor means the customer resumed the conversation while this worker
 * was claiming, resolving assets, or waiting on the LLM.
 */
function stillDormantAtAnchor(repos: Repositories, phone: string, anchorAt: string): boolean {
  const scannedAnchorMs = parseStoredTimestamp(anchorAt);
  const currentAnchor = repos.message.getLastInboundAt(phone);
  const currentAnchorMs = currentAnchor ? parseStoredTimestamp(currentAnchor) : Number.NaN;
  return !Number.isNaN(scannedAnchorMs)
    && currentAnchorMs === scannedAnchorMs
    && repos.message.getLastMessageDirection(phone) === 'outbound';
}

function isBlockedState(repos: Repositories, phone: string): string | null {
  const conversation = repos.conversation.getByPhone(phone);
  if (!conversation) return 'conversation_not_found';
  const mode = conversation.conversation_mode ?? 'bot';
  if (conversation.opt_out_at) return 'opted_out';
  if (conversation.converted_at) return 'booked';
  if (conversation.handed_off_at) return 'handed_off';
  if (conversation.soft_closed_at) return 'soft_closed';
  if (mode === 'bridge_active' || mode === 'referred' || mode === 'human_only') return `mode_${mode}`;
  return null;
}

/**
 * `phone:cycleKey` of exhausted cycles already reported in this process.
 *
 * Bounded by the number of distinct permanently-dead cycles, which is tiny — one
 * needs three failed LLM attempts to exist at all. Resetting on restart is
 * intentional: one report per boot, not zero.
 */
const reportedExhaustedCycles = new Set<string>();

/** Test seam: exhaustion reporting is process-scoped, so suites must reset it. */
export function resetExhaustedCycleReportCache(): void {
  reportedExhaustedCycles.clear();
}

/**
 * Forgets the exhaustion notice for ONE cycle, so a cycle an operator re-armed can
 * alert again if it exhausts a second time.
 *
 * Deliberately keyed rather than a full `clear()`: clearing the whole set would let
 * unrelated leads that already alerted this boot alert again, turning one operator
 * retry into a burst of duplicate owner notices.
 */
export function forgetExhaustedCycleReport(phone: string, cycleKey: string): void {
  reportedExhaustedCycles.delete(`${phone}:${cycleKey}`);
}

async function processConsentAsk(repos: Repositories, candidate: ConsentAskCandidateRow): Promise<boolean> {
  const phone = candidate.customer_phone;

  const cycleKey = consentCycleKey(candidate.consent_session);
  const eventId = repos.followupSubscriptionEvent.claim(
    phone,
    'consent_ask',
    cycleKey,
    env.FOLLOWUP_MAX_ATTEMPTS,
    env.FOLLOWUP_CLAIM_STALE_MINUTES,
  );
  if (eventId === null) {
    // `claim()` returns null for six different reasons — a concurrent worker, a
    // fresh dispatch lease, a terminal success, or genuine exhaustion. Only the
    // last one is an operator problem, so the status is checked explicitly rather
    // than inferred from the attempt count: a row that succeeded on its final
    // attempt also satisfies `attempts >= MAX`.
    const claimed = repos.followupSubscriptionEvent.getByPhoneKindCycle(phone, 'consent_ask', cycleKey);
    const exhausted = claimed !== null
      && claimed.status === 'failed'
      && claimed.attempts >= env.FOLLOWUP_MAX_ATTEMPTS;
    // An exhausted cycle is permanent by design and the subscription stays
    // `unasked`, so this candidate is re-scanned on EVERY tick forever. Both the
    // log and the owner notice therefore need an in-process gate: `owner_alerts`
    // alone is not enough, because the row is only written after a confirmed
    // Telegram delivery, so consecutive ticks all pass the table check before the
    // first insert lands (observed: 4 duplicate alerts across 8 ticks).
    // The table still provides the durable, cross-restart dedupe.
    if (exhausted && !reportedExhaustedCycles.has(`${phone}:${cycleKey}`)) {
      reportedExhaustedCycles.add(`${phone}:${cycleKey}`);
      const reason = claimed.error_reason ?? 'unknown';
      logger.warn(
        { phone, cycleKey, attempts: claimed.attempts, reason },
        '[FOLLOWUP] consent ask cycle exhausted',
      );
      notifyOwnerOnce(
        repos,
        phone,
        `followup_consent_exhausted:${cycleKey}`,
        `Consent ask agotado: ${phone} ${cycleKey} tras ${claimed.attempts} intentos `
        + `(ultimo error: ${reason}). Para reintentar: /followupretry ${phone}`,
        { scope: 'ever' },
      );
    }
    return false;
  }
  const claimedEvent = repos.followupSubscriptionEvent.getByPhoneKindCycle(
    phone,
    'consent_ask',
    cycleKey,
  );
  const consentAskRetryInstruction = (claimedEvent?.attempts ?? 1) > 1;

  if (repos.isPaused()) {
    repos.followupSubscriptionEvent.releaseClaim(eventId);
    return false;
  }
  const blocked = isBlockedState(repos, phone);
  if (blocked) {
    // Transient state (booked, handed off, etc.). Release the claim so this customer
    // remains eligible when the state clears. Do not burn a bounded attempt.
    repos.followupSubscriptionEvent.releaseClaim(eventId);
    logger.info({ phone, reason: blocked }, '[FOLLOWUP] consent ask skipped — state guard');
    return false;
  }
  // Re-check the window after the claim: the row may have sat through a stale lease.
  const anchorMs = parseStoredTimestamp(candidate.anchor_at);
  const windowClosesMs = anchorMs + FREE_FORM_WINDOW_MS;
  if (Number.isNaN(anchorMs) || Date.now() >= windowClosesMs) {
    // Window closure is transient (only a few minutes) — release so the next cycle
    // can pick this up if it slips back in (backward clock, stale claim, etc).
    repos.followupSubscriptionEvent.releaseClaim(eventId);
    logger.info({ phone }, '[FOLLOWUP] consent ask skipped — 24h window closed');
    return false;
  }

  const language = candidate.language === 'en' ? 'en' : 'es';
  const budget = checkBudget(repos, phone);
  if (!budget.aiAllowed) {
    // Budget/time limits are temporary and nothing reached Meta. Release rather
    // than burning the bounded send-attempt budget on every scheduler tick.
    repos.followupSubscriptionEvent.releaseClaim(eventId);
    logger.warn({ phone, reason: budget.reason }, '[FOLLOWUP] consent ask AI blocked');
    return false;
  }

  let draft: string | null = null;
  let usageRecorded = false;
  try {
    // Softer framing applies to the FIRST ask after a stop request only.
    // `last_opt_out_at` is never cleared (it is the compliance record), so testing
    // it alone would soften every ask this customer ever receives again.
    const lastOptOutAt = repos.optOut.getLastOptOutAt(phone);
    const reaskAfterOptOut = lastOptOutAt !== null
      && !repos.followupSubscriptionEvent.hasAskedSince(phone, lastOptOutAt);
    const result = await llmClient.complete({
      systemPrompt: buildSystemPrompt({
        skills: getSkills(),
        lang: language,
        collectedFields: repos.conversation.getCollectedFields(phone),
        selectedExperienceId: repos.conversation.getSelectedExperienceId(phone),
        proactiveMode: 'consent_ask',
        consentAskRetryInstruction,
        reaskAfterOptOut,
      }),
      // Internal turn signal, explicitly defined in the assembled RUNTIME block.
      // An empty customer turn made the model continue the previous sales question
      // instead of applying the proactive mode. Not `[[…]]`-shaped on purpose — see
      // CONSENT_ASK_TURN_EVENT.
      message: CONSENT_ASK_TURN_EVENT,
      history: repos.message.getRecentMessages(phone, 10)
        .map(entry => ({ role: entry.role, content: entry.content })),
      lang: language,
      onAttempt: attempt => {
        usageRecorded = true;
        repos.aiUsage.recordUsage({
          phone,
          model: env.DEEPSEEK_MODEL,
          promptTokens: attempt.tokens.prompt,
          completionTokens: attempt.tokens.completion,
          cachedTokens: 0,
          estimatedCost: estimateDeepSeekCost(attempt.tokens.prompt, attempt.tokens.completion),
          purpose: 'follow_up',
          success: attempt.success,
          errorType: attempt.success ? null : 'completion_failed',
        });
      },
    });
    draft = result?.turn.reply ?? null;
    if (result && !usageRecorded) {
      repos.aiUsage.recordUsage({
        phone,
        model: env.DEEPSEEK_MODEL,
        promptTokens: result.tokens.prompt,
        completionTokens: result.tokens.completion,
        cachedTokens: 0,
        estimatedCost: estimateDeepSeekCost(result.tokens.prompt, result.tokens.completion),
        purpose: 'follow_up',
        success: true,
      });
    }
  } catch (err) {
    logger.warn({ phone, err }, '[FOLLOWUP] consent ask LLM call failed');
  }

  if (!draft) {
    // The provider attempt consumed budget and failed to produce usable text.
    // Keep it as a definite failure so retries remain bounded by MAX_ATTEMPTS.
    repos.followupSubscriptionEvent.markFailed(eventId, 'llm_no_draft');
    return false;
  }

  const validation = validateConsentAsk(draft);
  if (!validation.ok || !validation.text) {
    // Never repair or substitute copy (AGENTS.md invariants 8/9): discard and retry.
    // This is an actual LLM attempt, not a local guard; consume one bounded retry
    // rather than hammering the provider every scheduler tick forever.
    repos.followupSubscriptionEvent.markFailed(eventId, `draft_${validation.reason ?? 'invalid'}`);
    logger.warn({ phone, reason: validation.reason }, '[FOLLOWUP] consent ask draft rejected');
    return false;
  }

  if (validation.markerlessAccepted) {
    logger.info(
      { phone, cycleKey, attempt: claimedEvent?.attempts ?? 1 },
      '[FOLLOWUP] consent ask accepted without marker (matched permission pattern)',
    );
  }

  // The LLM call can take seconds. A customer reply during that wait makes this
  // proactive ask inappropriate even though the original SQL scan was valid.
  const subscription = repos.followupSubscription.getByPhone(phone);
  if (
    !stillDormantAtAnchor(repos, phone, candidate.anchor_at)
    || (subscription !== null && subscription.status !== 'unasked')
  ) {
    repos.followupSubscriptionEvent.releaseClaim(eventId);
    logger.info({ phone }, '[FOLLOWUP] consent ask skipped — customer active or consent state changed');
    return false;
  }

  try {
    repos.runInTransaction(() => {
      // Persist pending consent and the no-retry boundary before entering Meta.
      // If the process dies after Meta accepts the message, the customer's reply
      // can still be classified and the ask cannot be duplicated.
      repos.followupSubscription.ensureExists(phone);
      repos.followupSubscription.markAsked(phone, null);
      repos.followupSubscriptionEvent.startDispatching(
        eventId,
        new Date(Date.now() + env.FOLLOWUP_CLAIM_STALE_MINUTES * 60_000).toISOString(),
      );
    });
    // The ask goes out as the caption of a themed photo when one is configured and
    // available, so a returning customer sees the experience again instead of a
    // bare text nudge. The copy is unchanged either way — the engine never rewrites
    // it (AGENTS.md invariants 8/9); only the envelope differs.
    const askSkills = getSkills();
    const askExperienceId = repos.conversation.getSelectedExperienceId(phone);
    const askExperience = askExperienceId
      ? findActiveExperience(askSkills, askExperienceId)
      : getActiveExperience(askSkills);
    const askPlanId = repos.conversation.getCollectedPlan(phone);
    const askPlanSiteId = askExperience && askPlanId
      ? getPlans(askExperience).find(plan => plan.id === askPlanId)?.siteId
      : undefined;
    const themedAsk = askExperience && validation.text.length <= MAX_IMAGE_CAPTION_CHARS
      ? selectThemedImage(
        askSkills,
        repos,
        phone,
        env.FOLLOWUP_CONSENT_ASK_IMAGE_TYPE,
        askExperience.id,
        askPlanSiteId,
      )
      : null;
    // Same URL guard the template header applies. Feed URLs already pass
    // `cdnMediaUrlSchema`, but an unsendable link must degrade to text, not throw.
    const askImage = themedAsk && isPublicHttpsUrl(themedAsk.url) ? themedAsk : null;
    const { whatsappMessageId } = askImage
      ? await sendImageUrlWithId(phone, askImage.url, validation.text)
      : await sendTextWithId(phone, validation.text);
    repos.runInTransaction(() => {
      repos.followupSubscription.ensureExists(phone);
      repos.followupSubscription.markAsked(phone, whatsappMessageId);
      repos.followupSubscriptionEvent.markAccepted(eventId, whatsappMessageId);
      // Recorded as text regardless of envelope: the ask must stay attributable
      // and must read identically in LLM history however it was delivered.
      repos.message.addMessage({
        customer_phone: phone,
        direction: 'outbound',
        message_type: 'text',
        body: validation.text,
        created_at: new Date().toISOString(),
        whatsapp_message_id: whatsappMessageId,
      });
      if (askImage) recordImageSend(repos, phone, followupGalleryMediaId(askImage));
    });
    if (askImage) {
      // The ask text WAS the caption, so mark it as carrying the reply: a replay
      // must render one captioned photo, not a photo plus a duplicate text.
      recordOutboundMedia(repos, {
        phone,
        url: askImage.url,
        mediaId: followupGalleryMediaId(askImage),
        caption: validation.text,
        carriedReply: true,
        flow: 'consent_ask',
      });
    }
    if (askImage) logger.info({ phone, type: env.FOLLOWUP_CONSENT_ASK_IMAGE_TYPE }, '[FOLLOWUP] consent ask delivered as image caption');
    logger.info({ phone, whatsappMessageId }, '[FOLLOWUP] consent ask sent');
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown_error';
    if (error instanceof WhatsAppSendError && error.deliveryUncertain) {
      // Meta may hold the message; asking twice would be worse than not asking.
      repos.followupSubscriptionEvent.markUncertain(eventId, reason);
      repos.followupSubscription.ensureExists(phone);
      repos.followupSubscription.markAsked(phone, null);
      return false;
    }
    repos.followupSubscriptionEvent.markFailed(eventId, reason);
    repos.followupSubscription.resetUnaskedIfPending(phone);
    logger.warn({ phone, reason }, '[FOLLOWUP] consent ask send failed');
    return false;
  }
}

export async function runConsentAskCycle(repos: Repositories): Promise<void> {
  if (!env.FOLLOWUP_CONSENT_ASK_ENABLED) return;

  const now = Date.now();
  const silentSinceIso = new Date(now - consentThresholdMs()).toISOString();
  const windowExpiryIso = new Date(now - FREE_FORM_WINDOW_MS).toISOString();

  let candidates: ConsentAskCandidateRow[];
  try {
    candidates = repos.conversation.listConsentAskCandidates({
      silentSinceIso,
      windowExpiryIso,
      limit: env.FOLLOWUP_MAX_SENDS_PER_TICK,
    });
  } catch (err) {
    logger.error(err, '[FOLLOWUP] consent ask candidate query failed');
    return;
  }

  const allowlist = devAllowlist();
  const targets = allowlist.length > 0
    ? candidates.filter(candidate => allowlist.includes(candidate.customer_phone))
    : candidates;

  for (const candidate of targets) {
    try {
      await processConsentAsk(repos, candidate);
    } catch (err) {
      logger.error(err, '[FOLLOWUP] consent ask processing failed');
    }
  }
}

// ---------------------------------------------------------------------------
// Stages 3-4 — recurring approved template (allowed outside the 24h window)
// ---------------------------------------------------------------------------

function recurringTemplateName(language: string | null): string | null {
  if (language === 'en') return env.FOLLOWUP_RECURRING_TEMPLATE_NAME_EN.trim() || null;
  return env.FOLLOWUP_RECURRING_TEMPLATE_NAME.trim() || null;
}

/** Production cadence: each interval is three times the previous one. */
const PRODUCTION_RECURRING_MULTIPLIER = 3;

/**
 * How many broad candidates one tick may materialise, as a multiple of the send
 * limit. The exact exponential due filter runs in JS over this set, so the bound
 * must stay well above `FOLLOWUP_MAX_SENDS_PER_TICK`: limiting the scan to the send
 * limit is what let non-due rows starve due ones.
 */
const RECURRING_SCAN_MULTIPLIER = 20;

/**
 * Months to wait after the previous production send.
 * sendsSoFar=0 → base (r1), 1 → base×3 (r2), 2 → base×9 (r3).
 */
export function recurringIntervalMonths(sendsSoFar: number): number {
  const completedCycles = Math.max(0, Math.floor(sendsSoFar));
  return env.FOLLOWUP_RECURRING_INTERVAL_MONTHS
    * PRODUCTION_RECURRING_MULTIPLIER ** completedCycles;
}

/** Exact next due timestamp. Dev intentionally keeps a fixed short interval. */
export function recurringNextDueAt(lastSendAt: string, sendsSoFar: number): Date | null {
  const anchorMs = parseStoredTimestamp(lastSendAt);
  if (Number.isNaN(anchorMs)) return null;

  if (env.FOLLOWUP_DEV_RECURRING_SECONDS > 0) {
    return new Date(anchorMs + env.FOLLOWUP_DEV_RECURRING_SECONDS * 1_000);
  }

  const due = addMonthsClamped(new Date(anchorMs), recurringIntervalMonths(sendsSoFar));
  return Number.isNaN(due.getTime()) ? null : due;
}

export function isRecurringDue(candidate: RecurringCandidateRow, now: number = Date.now()): boolean {
  const dueAt = recurringNextDueAt(candidate.last_send_at, candidate.sends_so_far);
  return dueAt !== null && dueAt.getTime() <= now;
}

/**
 * Broad SQL scan threshold. Production scans customers past the shortest (r1)
 * interval; `isRecurringDue()` applies the exact exponential interval before claim.
 */
export function recurringDueBeforeIso(now: number): string {
  if (env.FOLLOWUP_DEV_RECURRING_SECONDS > 0) {
    return new Date(now - env.FOLLOWUP_DEV_RECURRING_SECONDS * 1_000).toISOString();
  }
  return addMonthsClamped(new Date(now), -env.FOLLOWUP_RECURRING_INTERVAL_MONTHS).toISOString();
}

/**
 * Silence required since the customer's last inbound before ANY recurring send.
 *
 * Deliberately independent of the cadence interval: consent authorises writing to
 * a dormant customer, never landing a template shortly after a live conversation.
 * Coupling the two would make a short (or dev-accelerated) cadence interleave
 * templates with an active chat. The dev override is rejected in production.
 */
export function recurringMinSilenceMs(): number {
  if (env.FOLLOWUP_DEV_RECURRING_MIN_SILENCE_SECONDS > 0) {
    return env.FOLLOWUP_DEV_RECURRING_MIN_SILENCE_SECONDS * 1_000;
  }
  return env.FOLLOWUP_RECURRING_MIN_SILENCE_HOURS * 3_600_000;
}

export function recurringSilentSinceIso(now: number): string {
  return new Date(now - recurringMinSilenceMs()).toISOString();
}

async function processRecurring(repos: Repositories, candidate: RecurringCandidateRow): Promise<boolean> {
  const phone = candidate.customer_phone;

  // The candidate query uses the shortest interval for one efficient SQL pass.
  // Re-check the exact 1×, 3×, 9×… production cadence before claiming/sending.
  if (!isRecurringDue(candidate)) return false;

  const templateName = recurringTemplateName(candidate.language);
  if (!templateName) {
    logger.warn({ phone, language: candidate.language }, '[FOLLOWUP] no recurring template for language — skipped');
    return false;
  }

  // Reuses the one-shot payload builder: same approved template shape.
  const payload = buildTemplatePayload(repos, {
    customer_phone: phone,
    language: candidate.language,
    collected_plan: candidate.collected_plan,
    selected_experience_id: candidate.selected_experience_id,
    anchor_at: candidate.last_send_at,
  }, env.FOLLOWUP_RECURRING_TEMPLATE_HEADER);
  if (!payload) {
    logger.warn({ phone }, '[FOLLOWUP] recurring template assets unavailable — skipped');
    return false;
  }

  const cycleKey = recurringCycleKey(candidate.sends_so_far, candidate.consent_cycle);
  const eventId = repos.followupSubscriptionEvent.claim(
    phone,
    'recurring',
    cycleKey,
    env.FOLLOWUP_MAX_ATTEMPTS,
    env.FOLLOWUP_CLAIM_STALE_MINUTES,
  );
  if (eventId === null) return false;

  if (repos.isPaused()) {
    repos.followupSubscriptionEvent.releaseClaim(eventId);
    return false;
  }
  const blocked = isBlockedState(repos, phone);
  if (blocked) {
    repos.followupSubscriptionEvent.markFailed(eventId, `guard_${blocked}`);
    return false;
  }
  // Consent must still be active at dispatch time, not merely at scan time.
  const subscription = repos.followupSubscription.getByPhone(phone);
  if (subscription?.status !== 'active') {
    repos.followupSubscriptionEvent.markFailed(eventId, `consent_${subscription?.status ?? 'missing'}`);
    return false;
  }
  // The customer may have written between the candidate scan and now. Re-evaluate
  // the same silence floor the query applied: consent authorises writing to a
  // dormant customer, never interrupting a live conversation. Nothing reached Meta,
  // so release the claim instead of consuming an attempt.
  const lastInboundAt = repos.message.getLastInboundAt(phone);
  const lastInboundMs = lastInboundAt ? parseStoredTimestamp(lastInboundAt) : Number.NaN;
  const silenceThresholdMs = parseStoredTimestamp(recurringSilentSinceIso(Date.now()));
  const lastDirection = repos.message.getLastMessageDirection(phone);
  if (lastDirection !== 'outbound'
    || (!Number.isNaN(lastInboundMs) && lastInboundMs > silenceThresholdMs)) {
    repos.followupSubscriptionEvent.releaseClaim(eventId);
    logger.info({ phone, cycleKey }, '[FOLLOWUP] recurring skipped — customer active again');
    return false;
  }

  try {
    repos.followupSubscriptionEvent.startDispatching(
      eventId,
      new Date(Date.now() + env.FOLLOWUP_CLAIM_STALE_MINUTES * 60_000).toISOString(),
    );
    const result = await sendTemplate(
      phone,
      templateName,
      resolveLanguageCode(candidate.language),
      payload.bodyParams,
      payload.headerImageUrl,
    );
    repos.runInTransaction(() => {
      repos.followupSubscriptionEvent.markAccepted(eventId, result.whatsappMessageId);
      repos.message.addMessage({
        customer_phone: phone,
        direction: 'outbound',
        message_type: 'template',
        body: `[template:${templateName}]`,
        created_at: new Date().toISOString(),
        whatsapp_message_id: result.whatsappMessageId,
      });
      // Recorded so consecutive recurring templates rotate through the theme
      // instead of showing the same photo every cycle.
      if (payload.headerGalleryMediaId) recordImageSend(repos, phone, payload.headerGalleryMediaId);
    });
    if (payload.headerImageUrl) {
      recordOutboundMedia(repos, {
        phone,
        url: payload.headerImageUrl,
        mediaId: payload.headerGalleryMediaId ?? `followup_header:${templateName}`,
        caption: '',
        carriedReply: false,
        flow: 'followup_recurring',
      });
    }
    logger.info({ phone, templateName, cycleKey, whatsappMessageId: result.whatsappMessageId }, '[FOLLOWUP] recurring template sent');
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown_error';
    if (error instanceof WhatsAppSendError && error.deliveryUncertain) {
      repos.followupSubscriptionEvent.markUncertain(eventId, reason);
      logger.warn({ phone, cycleKey, reason }, '[FOLLOWUP] recurring delivery uncertain — no retry');
      return false;
    }
    repos.followupSubscriptionEvent.markFailed(eventId, reason);
    logger.warn({ phone, cycleKey, reason }, '[FOLLOWUP] recurring template send failed');
    return false;
  }
}

export async function runRecurringCycle(repos: Repositories): Promise<void> {
  if (!env.FOLLOWUP_RECURRING_ENABLED) return;

  let candidates: RecurringCandidateRow[];
  try {
    candidates = repos.conversation.listRecurringCandidates({
      dueBeforeIso: recurringDueBeforeIso(Date.now()),
      silentSinceIso: recurringSilentSinceIso(Date.now()),
      maxSends: env.FOLLOWUP_MAX_RECURRING_SENDS,
      scanLimit: env.FOLLOWUP_MAX_SENDS_PER_TICK * RECURRING_SCAN_MULTIPLIER,
    });
  } catch (err) {
    logger.error(err, '[FOLLOWUP] recurring candidate query failed');
    return;
  }

  const allowlist = devAllowlist();
  const allowlisted = allowlist.length > 0
    ? candidates.filter(candidate => allowlist.includes(candidate.customer_phone))
    : candidates;
  // Apply exact exponential due filtering before the dispatch limit. Limiting the
  // broad SQL scan first lets old, not-yet-due r2/r3 rows occupy every slot and
  // permanently starve due r1 customers sorted behind them.
  const targets = allowlisted
    .filter(candidate => isRecurringDue(candidate))
    .slice(0, env.FOLLOWUP_MAX_SENDS_PER_TICK);

  for (const candidate of targets) {
    try {
      await processRecurring(repos, candidate);
    } catch (err) {
      logger.error(err, '[FOLLOWUP] recurring processing failed');
    }
  }
}

/** One tick: consent ask first, then recurring sends. Each stage self-gates. */
export async function runAllFollowupCycles(repos: Repositories): Promise<void> {
  await runFollowupCycle(repos);
  await runConsentAskCycle(repos);
  await runRecurringCycle(repos);
}

export function startFollowupScheduler(repos: Repositories): ReturnType<typeof setInterval> | undefined {
  const anyStageEnabled = env.ALLOW_FOLLOWUP_TEMPLATE
    || env.FOLLOWUP_CONSENT_ASK_ENABLED
    || env.FOLLOWUP_RECURRING_ENABLED;
  if (!anyStageEnabled) return undefined;

  logger.info(
    {
      pollMs: env.FOLLOWUP_POLL_MS,
      oneShotEnabled: env.ALLOW_FOLLOWUP_TEMPLATE,
      oneShotThresholdHours: silenceThresholdHours(),
      consentAskEnabled: env.FOLLOWUP_CONSENT_ASK_ENABLED,
      consentThresholdSeconds: Math.round(consentThresholdMs() / 1000),
      recurringEnabled: env.FOLLOWUP_RECURRING_ENABLED,
      recurringDevSeconds: env.FOLLOWUP_DEV_RECURRING_SECONDS,
      maxRecurringSends: env.FOLLOWUP_MAX_RECURRING_SENDS,
      allowlisted: devAllowlist().length,
    },
    '[FOLLOWUP] scheduler started',
  );
  void runAllFollowupCycles(repos);

  return setInterval(() => {
    void runAllFollowupCycles(repos);
  }, env.FOLLOWUP_POLL_MS);
}
