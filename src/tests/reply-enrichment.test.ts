import { describe, expect, it } from 'vitest';
import { loadSkills, type Skills } from '../services/skill-loader.js';
import { AVAILABILITY_NOT_AVAILABLE } from '../services/dynamic-data-service.js';
import { enrichReply } from '../services/reply-enrichment.js';

function skillsWithAvailability(available: boolean): Skills {
  const skills = loadSkills();
  const experience = skills.andeanScapes.experiences[0];
  return {
    ...skills,
    andeanScapes: {
      ...skills.andeanScapes,
      experiences: [{
        ...experience,
        availability: {
          ...experience.availability,
          availableDates: [
            { date: '2000-01-01', status: 'available', slotsApprox: null },
            { date: '2099-08-16', status: 'soldout', slotsApprox: 0 },
            { date: '2099-08-17', status: 'available', slotsApprox: null },
            { date: '2099-08-18', status: 'limited', slotsApprox: 2 },
            { date: '2099-08-19', status: 'unavailable', slotsApprox: null },
          ],
          botRule: available ? 'Use published dates only.' : AVAILABILITY_NOT_AVAILABLE,
        },
      }],
    },
  };
}

const merged = { nombre: null, plan: null, personas: null, fecha: null, transporte: null, mascota: null };

function enrich(message: string, skills: Skills): string {
  return enrichReply({
    replyText: 'Respuesta base.', message, lang: 'es', hasSafetyOverride: false,
    needsHumanEffective: false, unsafeReservationBlocked: false, pricePresented: false,
    closeIntent: false, isNewConversation: false, merged, skills,
  });
}

describe('reply date enrichment', () => {
  it('publishes only future dates when registry availability is authoritative', () => {
    const reply = enrich('Que disponibilidad tienen?', skillsWithAvailability(true));
    expect(reply).toContain('17 de agosto');
    expect(reply).toContain('18 de agosto');
    expect(reply).not.toContain('16 de agosto');
    expect(reply).not.toContain('19 de agosto');
    expect(reply).not.toContain('1 de enero');
  });

  it('filters past re-engagement dates', () => {
    const reply = enrich('Cuando retome coordinamos', skillsWithAvailability(true));
    expect(reply).toContain('17 de agosto');
    expect(reply).not.toContain('1 de enero');
  });

  it('does not enrich dates when registry availability is unavailable', () => {
    expect(enrich('Que disponibilidad tienen?', skillsWithAvailability(false))).toBe('Respuesta base.');
    expect(enrich('Cuando retome coordinamos', skillsWithAvailability(false))).toBe('Respuesta base.');
  });
});
