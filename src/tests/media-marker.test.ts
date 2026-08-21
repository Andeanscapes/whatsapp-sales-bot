import { afterEach, beforeEach, describe, it, expect, vi, type MockInstance } from 'vitest';
import { containsMediaMarkerSyntax, parseMediaMarker, resolveMediaThemes } from '../services/media-marker.js';
import { diagnosticMediaReply, hasUnmarkedPhotoPromise, isGalleryContinuationRequest, isGalleryRequest } from '../services/reply-guard.js';
import { detectRequestedGalleryThemes } from '../services/contextual-media.js';
import { logger } from '../config/logger.js';
import { loadSkills, type Skills } from '../services/skill-loader.js';

const baseSkills = loadSkills();
const mockSkills: Skills = {
  ...baseSkills,
  dynamicMedia: {
    ownerImage: null,
    planImages: [],
    galleryImages: [
      { url: 'https://cdn.example.com/exp_1.jpg', type: 'mine', experienceId: 'test', siteId: 'test', caption: '' },
      { url: 'https://cdn.example.com/exp_2.jpg', type: 'mine', experienceId: 'test', siteId: 'test', caption: '' },
      { url: 'https://cdn.example.com/exp_10.jpg', type: 'hotel', experienceId: 'test', siteId: 'test', caption: '' },
      { url: 'https://cdn.example.com/exp_11.jpg', type: 'hotel', experienceId: 'test', siteId: 'test', caption: '' },
      { url: 'https://cdn.example.com/exp_20.jpg', type: 'food', experienceId: 'test', siteId: 'test', caption: '' },
      { url: 'https://cdn.example.com/exp_61.jpg', type: 'kids', experienceId: 'test', siteId: 'test', caption: '' },
    ],
    siteTypes: { 'test/test': ['mine', 'hotel', 'food', 'kids'] },
    typeKeywords: {
      'test/test': {
        mine: ['mina', 'minas', 'socavon', 'esmeralda', 'mineros'],
        hotel: ['hotel', 'hospedaje', 'hacienda', 'alojamiento', 'habitacion'],
        food: ['comida', 'almuerzo', 'desayuno'],
        nature: ['naturaleza', 'paisaje', 'represa'],
        car: ['4x4', 'camioneta', 'vehiculo'],
        bike: ['bicicleta', 'bici', 'ciclismo'],
        beekeping: ['abejas', 'apiario', 'miel'],
        // Stored accent-free: both the marker parser and detectMediaType compare
        // against NFD-stripped text, so "niños" arrives as "ninos".
        kids: ['nino', 'ninos', 'hijos', 'peques', 'children'],
      },
    },
  },
};

describe('isGalleryContinuationRequest', () => {
  it.each([
    '¿Tienes más?',
    'Tienes más fotos?',
    '¿Otras?',
    'Do you have more?',
    'Send more photos',
    'Send me more photos',
    'Can you send me more?',
    '¿Me mandas más fotos?',
    '¿Puedes enviarme más?',
  ])('recognizes a short continuation: %s', text => {
    expect(isGalleryContinuationRequest(text)).toBe(true);
  });

  it.each([
    'Quiero más información',
    'No me mandes más fotos',
    'Somos más personas',
    '¿Tienes fotos?',
  ])('rejects an unrelated message: %s', text => {
    expect(isGalleryContinuationRequest(text)).toBe(false);
  });
});

// Live regression: "Y muéstrame hospedaje y transporte" shipped zero photos because
// only the foto/imagen nouns were matched, so the turn never counted as a photo
// request — no RUNTIME theme cue and no corrective retry.
describe('isGalleryRequest', () => {
  it.each([
    'Y muéstrame hospedaje y transporte',
    'muestrame el hospedaje',
    'enséñame la mina',
    'Show me the lodging',
    'show us the route',
    '¿Tienes fotos de la mina?',
  ])('treats a visual request as a gallery request: %s', text => {
    expect(isGalleryRequest(text)).toBe(true);
  });

  // A visual verb aimed at something with no gallery type must stay harmless: it
  // resolves to zero themes downstream, so widening the verb list cannot invent media.
  it.each([
    'Somos una pareja',
    'El plan de la mina',
    'Quiero más información',
    '¿Cuánto cuesta?',
  ])('does not treat a plain sales message as a gallery request: %s', text => {
    expect(isGalleryRequest(text)).toBe(false);
  });
});

describe('parseMediaMarker', () => {
  it('extracts marker and strips it from reply', () => {
    const reply = `Claro, te comparto fotos de la Hacienda para que vean cómo es el hospedaje.
Es un ambiente rural cómodo, perfecto para descansar.
[[FOTOS:hotel]]`;
    const result = parseMediaMarker(reply);
    expect(result).not.toBeNull();
    expect(result?.text).toContain('Claro, te comparto fotos');
    expect(result?.text).not.toContain('[[FOTOS:hotel]]');
    expect(result?.requestedThemes).toEqual(['hotel']);
  });

  it('handles multiple comma-separated themes', () => {
    const reply = `Aquí van fotos de ambos lugares.
[[FOTOS:hotel,nature]]`;
    const result = parseMediaMarker(reply);
    expect(result?.requestedThemes).toEqual(['hotel', 'nature']);
  });

  it('normalizes accents and case', () => {
    const reply = `Fotos de la Hacienda.
[[FOTOS:HACIENDA,MINA]]`;
    const result = parseMediaMarker(reply);
    expect(result?.requestedThemes).toEqual(['hacienda', 'mina']);
  });

  it('returns null when no marker present', () => {
    const reply = 'Just a regular reply without markers.';
    const result = parseMediaMarker(reply);
    expect(result).toBeNull();
  });

  it('strips an empty marker so internal syntax cannot leak', () => {
    const reply = 'Reply text.\n[[FOTOS:]]';
    const result = parseMediaMarker(reply);
    expect(result).toEqual({ text: 'Reply text.', requestedThemes: [], atEnd: true });
  });

  it('strips a misplaced marker and reports it was not at the end', () => {
    const reply = '[[FOTOS:hotel]]\nThis text comes after the marker.';
    const result = parseMediaMarker(reply);
    expect(result).toEqual({
      text: 'This text comes after the marker.',
      requestedThemes: ['hotel'],
      atEnd: false,
    });
  });

  it('reports atEnd for a trailing marker', () => {
    expect(parseMediaMarker('Reply.\n[[FOTOS:hotel]]')?.atEnd).toBe(true);
    expect(parseMediaMarker('Reply.\n[[FOTOS:hotel]]\n  ')?.atEnd).toBe(true);
  });

  it('strips every occurrence when the model emits more than one marker', () => {
    const result = parseMediaMarker('A [[FOTOS:hotel]] B [[FOTOS:mine]]');
    expect(result?.text).toBe('A  B');
    expect(result?.requestedThemes).toEqual(['hotel', 'mine']);
    expect(result?.atEnd).toBe(true);
  });

  it('strips whitespace from marker payload', () => {
    const reply = `Reply.\n[[FOTOS: hotel , mine ]]`;
    const result = parseMediaMarker(reply);
    expect(result?.requestedThemes).toEqual(['hotel', 'mine']);
  });

  it('detects malformed marker syntax for the hard safety guard', () => {
    expect(containsMediaMarkerSyntax('Reply\n[[FOTOS:hotel')).toBe(true);
  });
});

describe('resolveMediaThemes', () => {
  it('resolves exact type ids', () => {
    const result = resolveMediaThemes(mockSkills, ['mine', 'hotel']);
    expect(result).toEqual([
      { siteId: 'test', type: 'mine' },
      { siteId: 'test', type: 'hotel' },
    ]);
  });

  it('resolves keyword synonyms', () => {
    const result = resolveMediaThemes(mockSkills, ['hacienda', 'alojamiento']);
    expect(result).toEqual([{ siteId: 'test', type: 'hotel' }]);
  });

  it('deduplicates resolved types', () => {
    const result = resolveMediaThemes(mockSkills, ['hotel', 'hacienda', 'hospedaje']);
    // All three are synonyms for 'hotel', should deduplicate
    expect(result).toEqual([{ siteId: 'test', type: 'hotel' }]);
  });

  it('mixes exact ids and synonyms', () => {
    const result = resolveMediaThemes(mockSkills, ['mine', 'hacienda']);
    expect(result).toEqual([
      { siteId: 'test', type: 'mine' },
      { siteId: 'test', type: 'hotel' },
    ]);
  });

  it('ignores unknown themes', () => {
    const result = resolveMediaThemes(mockSkills, ['mine', 'unknown_theme']);
    expect(result).toEqual([{ siteId: 'test', type: 'mine' }]);
  });

  it('returns empty array when no themes resolve', () => {
    const result = resolveMediaThemes(mockSkills, ['invalid1', 'invalid2']);
    expect(result).toEqual([]);
  });

  it('returns empty when no gallery exists', () => {
    const emptySkills: Skills = { ...mockSkills, dynamicMedia: null };
    const result = resolveMediaThemes(emptySkills, ['mine']);
    expect(result).toEqual([]);
  });

  it('handles accent variations', () => {
    const result = resolveMediaThemes(mockSkills, ['hacienda']);
    expect(result).toContainEqual({ siteId: 'test', type: 'hotel' });
  });

  it('uses the preferred site when a type exists at multiple sites', () => {
    const multiSiteSkills: Skills = {
      ...mockSkills,
      dynamicMedia: {
        ...mockSkills.dynamicMedia!,
        galleryImages: [
          ...mockSkills.dynamicMedia!.galleryImages,
          { url: 'https://cdn.example.com/other-hotel.jpg', type: 'hotel', experienceId: 'test', siteId: 'other', caption: '' },
        ],
        siteTypes: { ...mockSkills.dynamicMedia!.siteTypes, 'test/other': ['hotel'] },
        typeKeywords: {
          ...mockSkills.dynamicMedia!.typeKeywords,
          'test/other': { hotel: ['posada'] },
        },
      },
    };

    expect(resolveMediaThemes(multiSiteSkills, ['hotel'], 'test')).toEqual([]);
    expect(resolveMediaThemes(multiSiteSkills, ['hotel'], 'test', 'other')).toEqual([
      { siteId: 'other', type: 'hotel' },
    ]);
    expect(resolveMediaThemes(multiSiteSkills, ['posada'], 'test', 'test')).toEqual([]);
    expect(resolveMediaThemes(multiSiteSkills, ['hacienda'], 'test')).toEqual([
      { siteId: 'test', type: 'hotel' },
    ]);
  });

  it('does not read keywords from another experience with the same site id', () => {
    const multiExperienceSkills: Skills = {
      ...mockSkills,
      dynamicMedia: {
        ...mockSkills.dynamicMedia!,
        galleryImages: [
          ...mockSkills.dynamicMedia!.galleryImages,
          { url: 'https://cdn.example.com/other-exp.jpg', type: 'mine', experienceId: 'other_exp', siteId: 'test', caption: '' },
        ],
        siteTypes: {
          ...mockSkills.dynamicMedia!.siteTypes,
          'other_exp/test': ['mine'],
        },
        typeKeywords: {
          ...mockSkills.dynamicMedia!.typeKeywords,
          'other_exp/test': { mine: ['foreign_keyword'] },
        },
      },
    };

    expect(resolveMediaThemes(multiExperienceSkills, ['foreign_keyword'], 'test')).toEqual([]);
    expect(resolveMediaThemes(multiExperienceSkills, ['foreign_keyword'], 'other_exp')).toEqual([
      { siteId: 'test', type: 'mine' },
    ]);
  });
});

// Log-only guard: the engine must never add a marker or invent photos, so the
// only defence against "te comparto unas fotos" with no marker is visibility.
describe('diagnosticMediaReply', () => {
  const phone = '573001112288';
  let warnSpy: MockInstance<typeof logger.warn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // The exact live reply: the noun "fotos" is elided, so a noun-only matcher misses it.
  it('warns when the reply promises photos with the noun elided', () => {
    diagnosticMediaReply('Claro, te comparto unas del hospedaje. ¿Avanzamos?', 0, phone);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('warns when an adverb and definite article elide the photo noun', () => {
    diagnosticMediaReply('Te comparto también las del hospedaje. ¿Avanzamos?', 0, phone);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('warns when the reply names the photos explicitly', () => {
    diagnosticMediaReply('Te comparto unas fotos de la ruta. ¿Avanzamos?', 0, phone);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('stays quiet on a factual reply that shares something other than media', () => {
    diagnosticMediaReply('Te comparto la ruta exacta desde Bogotá. ¿Te sirve?', 0, phone);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('stays quiet on a reply that never mentions photos', () => {
    diagnosticMediaReply('El 14 de noviembre entonces. ¿Avanzamos?', 0, phone);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('accepts a delivering reply that carries exactly one question', () => {
    diagnosticMediaReply('Así se ve la hacienda. ¿Avanzamos con esa fecha?', 5, phone);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns when a delivering reply has no question', () => {
    diagnosticMediaReply('Claro, te comparto unas del hospedaje.', 5, phone);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('warns when a delivering reply enumerates the photos', () => {
    diagnosticMediaReply('Foto 1: la mina. ¿Avanzamos?', 5, phone);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('warns on plural address (les) with elided photo noun', () => {
    diagnosticMediaReply('Les comparto unas del hospedaje. ¿Avanzamos?', 0, phone);
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});

// The kids theme is the credibility-proof case: a parent doubting the experience
// suits children gets photographic evidence instead of a claim. It only works if an
// accented request resolves, so this guards the normalization contract end to end.
describe('resolveMediaThemes — accented child vocabulary', () => {
  it('resolves the accented Spanish request to the kids type', () => {
    expect(resolveMediaThemes(mockSkills, ['niños'])).toEqual([{ siteId: 'test', type: 'kids' }]);
    expect(resolveMediaThemes(mockSkills, ['NIÑOS'])).toEqual([{ siteId: 'test', type: 'kids' }]);
  });

  it('resolves the bare type id and the English synonym', () => {
    expect(resolveMediaThemes(mockSkills, ['kids'])).toEqual([{ siteId: 'test', type: 'kids' }]);
    expect(resolveMediaThemes(mockSkills, ['children'])).toEqual([{ siteId: 'test', type: 'kids' }]);
  });

  it('keeps kids separate from the mine theme in a combined request', () => {
    expect(resolveMediaThemes(mockSkills, ['ninos', 'mina'])).toEqual([
      { siteId: 'test', type: 'kids' },
      { siteId: 'test', type: 'mine' },
    ]);
  });
});

describe('hasUnmarkedPhotoPromise', () => {
  it('fires on the live transcript turn 1 (te comparto)', () => {
    const reply = 'Claro, te comparto unas de la mina para que se hagan una idea real de lo que van a vivir. Para 2 personas, el plan de 2 días y 1 noche queda en $1.000.000 COP. ¿Qué les parece?';
    expect(hasUnmarkedPhotoPromise(reply)).toBe(true);
  });

  it('fires on the live transcript turn 2 (les comparto)', () => {
    const reply = '¡Qué bueno que les guste! Les comparto unas del hospedaje para que vean cómo es la hacienda. Para 2 personas, el plan de 2 días y 1 noche queda en $1.000.000 COP. ¿Qué les parece?';
    expect(hasUnmarkedPhotoPromise(reply)).toBe(true);
  });

  it('fires on the live transcript turn 3 (les comparto más)', () => {
    const reply = 'Claro, les comparto más de la mina para que sigan viendo cómo es la experiencia. Para 2 personas, el plan de 2 días y 1 noche queda en $1.000.000 COP. ¿Qué les parece?';
    expect(hasUnmarkedPhotoPromise(reply)).toBe(true);
  });

  it('fires on a repeated lodging request with más del', () => {
    expect(hasUnmarkedPhotoPromise('Te comparto más del hospedaje. ¿Qué mes les viene mejor?')).toBe(true);
  });

  it('fires on the live elliptical promise without flagging another option', () => {
    expect(hasUnmarkedPhotoPromise('Sí, tengo más. Te comparto otras para que se hagan una mejor idea.')).toBe(true);
    expect(hasUnmarkedPhotoPromise('Te comparto otra opción de transporte.')).toBe(false);
  });

  // Live regression: on a repeat request the object pronoun moves BEFORE the verb and
  // the noun is elided ("te las mando de nuevo"), so nothing after the verb names
  // photos. The bot promised a resend and shipped nothing, with no guard tripped.
  it('fires on a proclitic resend promise but not on a non-photo resend', () => {
    expect(hasUnmarkedPhotoPromise('Claro, te las mando de nuevo para que las vean con calma.')).toBe(true);
    expect(hasUnmarkedPhotoPromise('Te los envío otra vez.')).toBe(true);
    // Singular "lo" is not the photos plural, so an ordinary resend stays quiet.
    expect(hasUnmarkedPhotoPromise('Te lo mando de nuevo por aquí.')).toBe(false);
    expect(hasUnmarkedPhotoPromise('Te comparto la ruta desde Bogotá.')).toBe(false);
  });

  it('fires on the live transcript turn 4 (ahí van las)', () => {
    const reply = 'Tenés razón, perdón. Ahí van las de la mina. Para 2 personas, el plan de 2 días y 1 noche queda en $1.000.000 COP. ¿Qué les parece?';
    expect(hasUnmarkedPhotoPromise(reply)).toBe(true);
  });

  it('stays silent on a marked reply', () => {
    const reply = 'Claro, te comparto unas fotos de la mina. [[FOTOS:mine]]';
    expect(hasUnmarkedPhotoPromise(reply)).toBe(false);
  });

  it('stays silent on a factual te comparto (non-photo item)', () => {
    const reply = 'Te comparto la ruta exacta desde Bogotá. ¿Te sirve?';
    expect(hasUnmarkedPhotoPromise(reply)).toBe(false);
  });

  it('stays silent on phrases without photo context', () => {
    const reply = 'El 14 de noviembre entonces. ¿Avanzamos?';
    expect(hasUnmarkedPhotoPromise(reply)).toBe(false);
  });
});

describe('detectRequestedGalleryThemes', () => {
  it('resolves multiple requested categories in one message', () => {
    expect(detectRequestedGalleryThemes(mockSkills, 'fotos del hospedaje y de los niños', 'test'))
      .toEqual(['hotel', 'kids']);
  });

  it('does not resolve a declared category with no gallery photos', () => {
    expect(detectRequestedGalleryThemes(mockSkills, 'fotos del paisaje', 'test')).toEqual([]);
  });

  it('rejects a theme shared by multiple sites without a preferred site', () => {
    const ambiguousSkills: Skills = {
      ...mockSkills,
      dynamicMedia: {
        ...mockSkills.dynamicMedia!,
        galleryImages: [
          ...mockSkills.dynamicMedia!.galleryImages,
          { url: 'https://cdn.example.com/other-hotel.jpg', type: 'hotel', experienceId: 'test', siteId: 'other', caption: '' },
        ],
        siteTypes: {
          ...mockSkills.dynamicMedia!.siteTypes,
          'test/other': ['hotel'],
        },
        typeKeywords: {
          ...mockSkills.dynamicMedia!.typeKeywords,
          'test/other': { hotel: ['hotel'] },
        },
      },
    };

    expect(detectRequestedGalleryThemes(ambiguousSkills, 'fotos del hotel', 'test')).toEqual([]);
    expect(detectRequestedGalleryThemes(ambiguousSkills, 'fotos del hotel', 'test', 'test')).toEqual(['hotel']);
  });
});
