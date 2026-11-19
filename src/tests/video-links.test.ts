import { afterEach, describe, expect, it } from 'vitest';
import { dynamicDataSchema } from '../services/dynamic-data-schema.js';
import { getActiveExperience, getCultureVideoLinks, getPlanVideoLinks } from '../services/product-registry.js';
import { assembleSystemPrompt } from '../services/skills-prompt-assembly.js';
import { isGalleryRequest } from '../services/reply-guard.js';
import { isVideoRequest, selectVideoLinks, unapprovedVideoUrls, videoLinkId } from '../services/video-links.js';
import { allSitesActivePayload, useAllSitesActive } from './helpers/all-sites-catalog.js';

// Owner 2026-11-18: a video request gets approved Instagram links as text (the line cannot
// attach large videos). Culture links serve every site; a plan link only its own plan.
const CULTURE = 'https://www.instagram.com/reels/DeCSQOhRmlT/';
const CHIVOR = 'https://www.instagram.com/p/DTNu3O4Efj4/';

describe('video request detection', () => {
  it.each([
    '¿Tienen videos de la experiencia?',
    'mándame un video del plan',
    'me puedes enviar el reel?',
    'quiero ver un video de Chivor y dónde queda',
    'Do you have a video of the tour?',
    'can you send me the reel',
    'I would like to see a video',
  ])('"%s" asks for a video', text => {
    expect(isVideoRequest(text)).toBe(true);
  });

  it.each([
    'Hola, vi el video y quiero más información',
    'acabo de ver el video en Instagram, ¿cuánto vale?',
    'I saw your video, how much is it?',
    'Hola, ¿qué día salen?',
    'mándame fotos del hospedaje',
  ])('"%s" is not a video request', text => {
    expect(isVideoRequest(text)).toBe(false);
  });

  it('a video request is not a photo request; a photo noun still is', () => {
    expect(isGalleryRequest('muéstrame un video del hospedaje')).toBe(false);
    expect(isGalleryRequest('show me a video')).toBe(false);
    expect(isGalleryRequest('fotos y video del hospedaje')).toBe(true);
    expect(isGalleryRequest('muéstrame el hospedaje')).toBe(true);
  });
});

describe('video link selection', () => {
  const culture = [{ url: CULTURE, description: 'cultura' }];
  const plan = [{ url: CHIVOR, description: 'plan' }];
  const never = (): boolean => false;

  it('one link per category, culture first, at most two', () => {
    const picked = selectVideoLinks({ culture, plan }, never);
    expect(picked.map(link => [link.category, link.url])).toEqual([['culture', CULTURE], ['plan', CHIVOR]]);
  });

  it('empty pools give nothing; an unknown plan gives the culture link only', () => {
    expect(selectVideoLinks({ culture: [], plan: [] }, never)).toEqual([]);
    expect(selectVideoLinks({ culture, plan: [] }, never).map(link => link.url)).toEqual([CULTURE]);
  });

  it('the same link is never sent twice in one reply, whatever its path form', () => {
    const same = [{ url: CULTURE.replace('/reels/', '/reel/').replace(/\/$/, ''), description: 'x' }];
    expect(selectVideoLinks({ culture, plan: same }, never)).toHaveLength(1);
  });

  it('prefers a link not sent in this chat, stays in its pool, and repeats one when it is the only one', () => {
    const pool = [{ url: 'https://www.instagram.com/reel/AAA/', description: 'a' }, { url: 'https://www.instagram.com/reel/BBB/', description: 'b' }];
    const sentA = (url: string): boolean => videoLinkId(url) === 'AAA';
    for (const random of [0, 0.5, 0.99]) {
      expect(selectVideoLinks({ culture: pool, plan: [] }, sentA, () => random)[0].url).toContain('BBB');
    }
    const picks = new Set([0, 0.99].map(random => selectVideoLinks({ culture: pool, plan: [] }, never, () => random)[0].url));
    expect(picks).toEqual(new Set(pool.map(link => link.url)));
    expect(selectVideoLinks({ culture, plan: [] }, () => true)[0].url).toBe(CULTURE);
  });

  it('flags an Instagram post link that was neither selected nor sent before', () => {
    const reply = `Mira este: ${CULTURE} y este https://www.instagram.com/p/INVENTED1/ y el perfil https://www.instagram.com/andean_scapes/`;
    expect(unapprovedVideoUrls(reply, [CULTURE], never)).toEqual(['https://www.instagram.com/p/INVENTED1/']);
    expect(unapprovedVideoUrls(reply, [CULTURE], url => url.includes('INVENTED1'))).toEqual([]);
    expect(unapprovedVideoUrls('sin enlaces', [], never)).toEqual([]);
  });
});

describe('catalog video links', () => {
  afterEach(() => {
    useAllSitesActive();
  });

  it('the culture link serves both destinations; the Chivor link only Chivor CORE and PRIME', () => {
    const skills = useAllSitesActive();
    const exp = getActiveExperience(skills);
    expect(getCultureVideoLinks(skills, exp).map(link => link.url)).toEqual([CULTURE]);
    expect(getPlanVideoLinks(skills, exp, 'core_2d1n_chivor').map(link => link.url)).toEqual([CHIVOR]);
    expect(getPlanVideoLinks(skills, exp, 'prime_2d1n_chivor').map(link => link.url)).toEqual([CHIVOR]);
    expect(getPlanVideoLinks(skills, exp, 'prime_2d1n_chivor')[0].description).toMatch(/dos minas.*cabalgata/);
    expect(getPlanVideoLinks(skills, exp, 'core_2d1n_chivor')[0].description).not.toMatch(/cabalgata/);
    for (const planId of ['basic_1d_chivor', 'core_2d1n_coscuez', 'prime_2d1n_coscuez', null]) {
      expect(getPlanVideoLinks(skills, exp, planId), String(planId)).toEqual([]);
    }
  });

  it('a feed without the fields still loads and has no links', () => {
    const payload = allSitesActivePayload() as { experiences: Record<string, Record<string, unknown> & { sites: Record<string, { plans: Record<string, Record<string, unknown>> }> }> };
    for (const experience of Object.values(payload.experiences)) {
      delete experience.cultureReels;
      for (const site of Object.values(experience.sites)) for (const plan of Object.values(site.plans)) delete plan.reels;
    }
    const skills = useAllSitesActive(payload);
    const exp = getActiveExperience(skills);
    expect(getCultureVideoLinks(skills, exp)).toEqual([]);
    expect(getPlanVideoLinks(skills, exp, 'core_2d1n_chivor')).toEqual([]);
  });

  it.each([
    'https://instagram.com/p/ABC/',
    'http://www.instagram.com/p/ABC/',
    'https://www.instagram.com/andean_scapes/',
    'https://cdn.andeanscapes.com/video.mp4',
  ])('rejects %s as a catalog video link', url => {
    const payload = allSitesActivePayload() as { experiences: Record<string, Record<string, unknown>> };
    for (const experience of Object.values(payload.experiences)) experience.cultureReels = [{ url, description: 'x' }];
    expect(dynamicDataSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects a blank description', () => {
    const payload = allSitesActivePayload() as { experiences: Record<string, Record<string, unknown>> };
    for (const experience of Object.values(payload.experiences)) experience.cultureReels = [{ url: CULTURE, description: '  ' }];
    expect(dynamicDataSchema.safeParse(payload).success).toBe(false);
  });
});

describe('video cue in the prompt', () => {
  const runtime = (input: Partial<Parameters<typeof assembleSystemPrompt>[0]>): string => {
    const skills = useAllSitesActive();
    return assembleSystemPrompt({ skills, lang: 'es', collectedFields: {}, ...input }).split('\nRUNTIME:').at(-1) ?? '';
  };

  it('a video request carries only the selected links and their descriptions', () => {
    const cue = runtime({ videoRequested: true, videoLinks: [{ url: CULTURE, description: 'por qué importa la cultura', category: 'culture' }] });
    expect(cue).toContain('VIDEOS PEDIDOS');
    expect(cue).toContain(`"por qué importa la cultura" ${CULTURE}`);
    expect(cue).not.toContain(CHIVOR);
  });

  it('a video request with no approved link asks for no link', () => {
    const cue = runtime({ videoRequested: true, videoLinks: [] });
    expect(cue).toContain('VIDEO PEDIDO SIN ENLACE');
    expect(cue).not.toContain('instagram.com/');
  });

  it('no video cue and no link on an ordinary turn', () => {
    const cue = runtime({ latestCustomerMessage: 'hola' });
    expect(cue).not.toMatch(/VIDEO/);
    expect(cue).not.toContain('instagram.com/p/');
  });
});
