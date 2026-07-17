import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { getSkills, loadSkills } from '../services/skill-loader.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';

const { mockLlmComplete } = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockLlmComplete: vi.fn<any>(() => Promise.resolve(null)),
}));

vi.mock('../services/llm/deepseek-llm-client.js', () => ({
  DeepSeekLlmClient: vi.fn().mockImplementation(() => ({ complete: mockLlmComplete })),
}));

vi.mock('../services/budget-guard.js', () => ({
  checkBudget: vi.fn(() => ({ aiAllowed: true })),
}));

vi.mock('../services/whatsapp-client.js', () => ({
  sendText: vi.fn(() => Promise.resolve()),
}));

import { runFollowUps } from '../services/follow-up-service.js';
import { sendText } from '../services/whatsapp-client.js';
import { checkBudget } from '../services/budget-guard.js';
import type { LlmResult } from '../services/llm/llm-client.js';

const PHONE = '573001112233';
let repos: Repositories;
let db: Database.Database;
let previousFollowHours: number;
let previousAiEnabled: boolean;

function reply(text: string): LlmResult {
  return {
    turn: {
      reply: text,
      sales_phase: 'discovery',
      action: 'qualify',
      collected_fields: { name: null, plan: null, people: null, date: null, transport_need: null, pet: null },
      lead: { intent: 'qualifying', buying_signals: [], blockers: [], score_delta: 0, confidence: 0.5 },
      img: false,
    },
    tokens: { prompt: 100, completion: 20 },
  };
}

function addMsg(direction: 'inbound' | 'outbound', body: string, offsetMs: number): void {
  db.prepare(
    'INSERT INTO messages (customer_phone, direction, message_type, body, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(PHONE, direction, 'text', body, new Date(Date.now() + offsetMs).toISOString());
}

/** Lead that received the last bot reply 4h ago, after a recent inbound. */
function seedSilentLead(): void {
  repos.conversation.upsert(PHONE, { language: 'es' });
  addMsg('inbound', 'hola, cuanto vale?', -5 * 60 * 60 * 1000);
  addMsg('outbound', 'Hola, te cuento...', -4 * 60 * 60 * 1000);
}

beforeEach(() => {
  loadSkills();
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
  previousFollowHours = env.TIME_FOLLOW_HOURS;
  previousAiEnabled = env.AI_ENABLED;
  env.TIME_FOLLOW_HOURS = 3;
  env.AI_ENABLED = true;
  mockLlmComplete.mockReset();
  vi.mocked(sendText).mockClear();
  vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
});

afterEach(() => {
  env.TIME_FOLLOW_HOURS = previousFollowHours;
  env.AI_ENABLED = previousAiEnabled;
  db.close();
});

describe('follow-up service', () => {
  it('sends one safe follow-up and marks it sent', async () => {
    seedSilentLead();
    mockLlmComplete.mockResolvedValueOnce(reply('¿Quieres que revise opciones para tu fecha?'));

    await runFollowUps(repos);

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(repos.conversation.getByPhone(PHONE)?.follow_up_sent_at).toBeTruthy();
  });

  it('does not follow up twice (marks sent)', async () => {
    seedSilentLead();
    mockLlmComplete.mockResolvedValue(reply('¿Te ayudo con la fecha?'));

    await runFollowUps(repos);
    vi.mocked(sendText).mockClear();
    await runFollowUps(repos);

    expect(sendText).not.toHaveBeenCalled();
  });

  it('replaces an unsafe reservation claim with a safe nudge', async () => {
    seedSilentLead();
    mockLlmComplete.mockResolvedValueOnce(reply('Tu reserva quedó confirmada para esa fecha.'));

    await runFollowUps(repos);

    expect(sendText).toHaveBeenCalledWith(PHONE, getSkills().fallbackReplies.es.followUpSafeNudge);
    expect(repos.conversation.getByPhone(PHONE)?.follow_up_sent_at).toBeTruthy();
  });

  it('stays silent when the bot is paused', async () => {
    seedSilentLead();
    repos.setPaused(true);
    mockLlmComplete.mockResolvedValue(reply('¿Seguimos?'));

    await runFollowUps(repos);

    expect(sendText).not.toHaveBeenCalled();
  });

  it('skips when last message is from the customer (awaiting bot, not silent)', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    addMsg('outbound', 'Hola', -5 * 60 * 60 * 1000);
    addMsg('inbound', 'me interesa', -10 * 60 * 1000);

    await runFollowUps(repos);

    expect(sendText).not.toHaveBeenCalled();
  });

  it('does not send when a new inbound arrives after candidate selection', async () => {
    seedSilentLead();
    mockLlmComplete.mockImplementationOnce(async () => {
      addMsg('inbound', 'Tengo otra pregunta', 0);
      return reply('¿Qué detalle quieres revisar?');
    });

    await runFollowUps(repos);

    expect(mockLlmComplete).toHaveBeenCalledTimes(1);
    expect(repos.message.getLastMessageDirection(PHONE)).toBe('inbound');
    expect(sendText).not.toHaveBeenCalled();
    expect(repos.conversation.getByPhone(PHONE)?.follow_up_sent_at).toBeNull();
  });

  it('skips soft-closed leads', async () => {
    seedSilentLead();
    repos.conversation.setSoftClosed(PHONE);
    mockLlmComplete.mockResolvedValue(reply('¿Seguimos?'));

    await runFollowUps(repos);

    expect(mockLlmComplete).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it('does not send when the lead soft-closes during draft generation', async () => {
    seedSilentLead();
    mockLlmComplete.mockImplementationOnce(async () => {
      addMsg('inbound', 'No gracias, por ahora no', 0);
      repos.conversation.setSoftClosed(PHONE);
      return reply('¿Seguimos?');
    });

    await runFollowUps(repos);

    expect(repos.conversation.getSoftClosedAt(PHONE)).toBeTruthy();
    expect(sendText).not.toHaveBeenCalled();
    expect(repos.conversation.getByPhone(PHONE)?.follow_up_sent_at).toBeNull();
  });

  it('does not follow up on job inquiries', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    addMsg('inbound', 'Hola, ¿tienen vacantes? Quiero enviar mi hoja de vida.', -5 * 60 * 60 * 1000);
    addMsg('outbound', 'Gracias por escribirnos.', -4 * 60 * 60 * 1000);
    mockLlmComplete.mockResolvedValue(reply('¿Seguimos hablando?'));

    await runFollowUps(repos);

    expect(mockLlmComplete).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it('skips opted-out leads', async () => {
    seedSilentLead();
    repos.optOut.setOptOut(PHONE);
    mockLlmComplete.mockResolvedValue(reply('¿Seguimos?'));

    await runFollowUps(repos);

    expect(sendText).not.toHaveBeenCalled();
  });

  it('skips booked (converted) leads', async () => {
    seedSilentLead();
    repos.conversation.upsert(PHONE, { converted_at: new Date().toISOString() });
    mockLlmComplete.mockResolvedValue(reply('¿Seguimos?'));

    await runFollowUps(repos);

    expect(sendText).not.toHaveBeenCalled();
  });

  it('skips when budget is exhausted', async () => {
    seedSilentLead();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: false, reason: 'daily_budget_exceeded' });
    mockLlmComplete.mockResolvedValue(reply('¿Seguimos?'));

    await runFollowUps(repos);

    expect(sendText).not.toHaveBeenCalled();
  });

  it('records first_nudge event with correct stage and score', async () => {
    seedSilentLead();
    repos.conversation.upsert(PHONE, { lead_score: 15 });
    mockLlmComplete.mockResolvedValueOnce(reply('¿Seguimos armando esa idea del viaje?'));

    await runFollowUps(repos);

    const event = repos.followUpEvent.getLatestByPhone(PHONE);
    expect(event).not.toBeNull();
    expect(event?.stage).toBe('first_nudge');
    expect(event?.status).toBe('sent');
    expect(event?.scoreBefore).toBe(15);
    expect(event?.repliedAt).toBeNull();
  });

  it('strips dynamic owner re-intro and avoids repeating IG link', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    addMsg('inbound', 'hola, cuanto vale?', -5 * 60 * 60 * 1000);
    addMsg('outbound', 'Mira nuestro IG https://www.instagram.com/andean_scapes/', -4 * 60 * 60 * 1000);
    mockLlmComplete.mockResolvedValueOnce(reply(`Soy ${env.OWNER_NAME}, co-founder de Andean Scapes junto con ${env.PARTNER_NAME}. Me acordé de tu idea de Chivor.`));

    await runFollowUps(repos);

    expect(sendText).toHaveBeenCalledTimes(1);
    const [, sent] = vi.mocked(sendText).mock.calls[0] ?? [];
    const body = String(sent);
    expect(body).not.toContain(`Soy ${env.OWNER_NAME}`);
    expect(body).toContain('Me acordé de tu idea de Chivor');
    expect(body).not.toMatch(/Mientras tanto, mira nuestro IG/);
  });

  it('replaces a draft that addresses the customer with the partner name', async () => {
    seedSilentLead();
    mockLlmComplete.mockResolvedValueOnce(reply(`${env.PARTNER_NAME}, ¿ya definieron la fecha?`));

    await runFollowUps(repos);

    expect(sendText).toHaveBeenCalledWith(PHONE, getSkills().fallbackReplies.es.followUpSafeNudge);
  });

  it('sends pain question when first_nudge has been replied', async () => {
    repos.conversation.upsert(PHONE, { language: 'es', lead_score: 15 });
    // Seed a recent inbound so the service window check passes
    addMsg('inbound', 'hola cuanto vale?', -2 * 60 * 60 * 1000);

    // Directly insert a first_nudge event that is already replied
    repos.followUpEvent.insert({
      customerPhone: PHONE,
      sequenceNumber: 1,
      stage: 'first_nudge',
      sentAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      repliedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
      scoreBefore: 15,
      scoreAfter: 15,
      detectedPain: null,
      status: 'replied',
    });

    vi.mocked(sendText).mockClear();
    await runFollowUps(repos);

    expect(sendText).toHaveBeenCalledTimes(1);
    const [, painMsg] = vi.mocked(sendText).mock.calls[0] ?? [];
    expect(String(painMsg)).toMatch(/precio|fecha|seguridad|transporte/i);
  });

  it('skips pain question for booked (converted) leads', async () => {
    repos.conversation.upsert(PHONE, { language: 'es', lead_score: 15, converted_at: new Date().toISOString() });
    addMsg('inbound', 'hola cuanto vale?', -2 * 60 * 60 * 1000);

    repos.followUpEvent.insert({
      customerPhone: PHONE,
      sequenceNumber: 1,
      stage: 'first_nudge',
      sentAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      repliedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
      scoreBefore: 15,
      scoreAfter: 15,
      detectedPain: null,
      status: 'replied',
    });

    vi.mocked(sendText).mockClear();
    await runFollowUps(repos);

    expect(sendText).not.toHaveBeenCalled();
  });

  it('does not send pain question when first_nudge not yet replied', async () => {
    seedSilentLead();
    mockLlmComplete.mockResolvedValueOnce(reply('¿Seguimos armando esa idea del viaje?'));

    // Send first nudge (status = 'sent', not replied)
    await runFollowUps(repos);
    vi.mocked(sendText).mockClear();

    // Scheduler runs again — no second send
    await runFollowUps(repos);

    expect(sendText).not.toHaveBeenCalled();
  });

  it('skips leads in closing phase (pending validation)', async () => {
    seedSilentLead();
    repos.conversation.setSalesPhase(PHONE, 'closing');
    mockLlmComplete.mockResolvedValue(reply('¿Seguimos con esa idea del viaje?'));

    await runFollowUps(repos);

    expect(sendText).not.toHaveBeenCalled();
  });

  it('strips a retryable cliché opener and sends the remaining nudge', async () => {
    seedSilentLead();
    mockLlmComplete.mockResolvedValueOnce(reply('Hola de nuevo! Pensando en tu viaje de noviembre en moto, ¿ya sabes a qué hora saldrías?'));

    await runFollowUps(repos);

    expect(sendText).toHaveBeenCalledTimes(1);
    const [, sent] = vi.mocked(sendText).mock.calls[0] ?? [];
    expect(String(sent)).toBe('Pensando en tu viaje de noviembre en moto, ¿ya sabes a qué hora saldrías?');
    expect(repos.conversation.getByPhone(PHONE)?.follow_up_sent_at).toBeTruthy();
  });

  it('uses a safe nudge when a retryable opener strips to an empty draft', async () => {
    seedSilentLead();
    mockLlmComplete.mockResolvedValueOnce(reply('Hola de nuevo!'));

    await runFollowUps(repos);

    expect(sendText).toHaveBeenCalledWith(PHONE, getSkills().fallbackReplies.es.followUpSafeNudge);
    expect(repos.conversation.getByPhone(PHONE)?.follow_up_sent_at).toBeTruthy();
  });

  it('uses a safe nudge when the LLM returns no draft', async () => {
    seedSilentLead();
    mockLlmComplete.mockResolvedValue(null);

    await runFollowUps(repos);

    expect(sendText).toHaveBeenCalledWith(PHONE, getSkills().fallbackReplies.es.followUpSafeNudge);
    expect(repos.conversation.getByPhone(PHONE)?.follow_up_sent_at).toBeTruthy();
  });

  it('strips a mid-sentence cliché phrase and still sends', async () => {
    seedSilentLead();
    mockLlmComplete.mockResolvedValueOnce(reply('Justo hoy me acordé de ti, ¿ya definiste la fecha de noviembre?'));

    await runFollowUps(repos);

    expect(sendText).toHaveBeenCalledTimes(1);
    const [, sent] = vi.mocked(sendText).mock.calls[0] ?? [];
    expect(String(sent)).not.toMatch(/me acord[eé] de ti/i);
    expect(String(sent)).toMatch(/noviembre/i);
  });

  it('replaces hard-blocked commercial drafts with a safe nudge', async () => {
    seedSilentLead();
    mockLlmComplete.mockResolvedValueOnce(reply('¿Quieres reservar el plan 2D hoy?'));

    await runFollowUps(repos);

    expect(sendText).toHaveBeenCalledWith(PHONE, getSkills().fallbackReplies.es.followUpSafeNudge);
    expect(repos.conversation.getByPhone(PHONE)?.follow_up_sent_at).toBeTruthy();
  });

  it('does not append an Instagram link to first nudges', async () => {
    seedSilentLead();
    mockLlmComplete.mockResolvedValueOnce(reply('¿Ya pensaste como llegar en octubre?'));

    await runFollowUps(repos);

    expect(sendText).toHaveBeenCalledTimes(1);
    const [, sent] = vi.mocked(sendText).mock.calls[0] ?? [];
    expect(String(sent)).not.toMatch(/instagram\.com|mira nuestro IG/i);
  });
});
