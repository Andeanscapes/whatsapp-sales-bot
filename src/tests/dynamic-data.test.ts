import { afterEach, describe, expect, it, vi } from 'vitest';
import { dynamicDataSchema, DEFAULT_SITE_ID } from '../services/dynamic-data-schema.js';
import { DynamicDataService, shouldStripStaticPricing, transformDynamicData } from '../services/dynamic-data-service.js';
import { loadSkills, isDynamicDataFresh, setDynamicService, refreshSkills, getSkills } from '../services/skill-loader.js';
import { getActiveExperience, getFutureAvailableDates } from '../services/product-registry.js';

describe('dynamic data validation', () => {
  it.each([
    { name: 'Nequi 3009900001', message: 'Validar.' },
    { name: 'Nequi', message: 'Paga en https://pay.example/secret' },
  ])('rejects payment credentials embedded in public prompt fields', ({ name, message }) => {
    expect(() => dynamicDataSchema.parse({
      v: 4,
      updated: '2026-07-09T00:00:00Z',
      payments: {
        currency: 'COP',
        deposit: {
          type: 'percentage', value: 15, label: 'Anticipo', calculationRule: 'x',
          remainingBalancePercentage: 85,
        },
        methods: [{ id: 'nequi', name, type: 'mobile_transfer', enabled: true, currency: 'COP', requiresPaymentProof: true }],
        confirmation: { automatic: false, requiresTeamValidation: true, message },
        displayPolicy: {
          showAfterAvailabilityValidation: true,
          showWhenCustomerWantsToReserve: true,
          showWhenCustomerAsksHowToPay: true,
          doNotRequestPaymentBeforeAvailabilityValidation: true,
          neverRequestFullPaymentWithoutConfirmation: true,
        },
      },
      experiences: {},
    })).toThrow(/phone numbers or URLs/);
  });

  it.each([
    'Consulta mpago.la/secret',
    'Transfiere al dato privado',
    'Confirma en el 300 990 0001',
    'Banco 6012345678',
    'PayPal +1 212 555 1234',
    'Consigna en Bancolombia',
    'Send to Nequi',
    'Transfer via Nequi',
  ])('rejects credentials in any prompt-bound dynamic string: %s', (rule) => {
    expect(() => dynamicDataSchema.parse({
      v: 4,
      updated: '2026-07-09T00:00:00Z',
      experiences: {
        emerald_mining_tour: {
          pricing: { currency: 'COP', plans: {}, rules: [rule] },
        },
      },
    })).toThrow(/payment credentials/);
  });

  it('allows links in non-prompt attribution and media fields', () => {
    expect(() => dynamicDataSchema.parse({
      v: 4,
      updated: '2026-07-09T00:00:00Z',
      referentAttribution: {
        profileId: 'andean-scapes-co',
        version: 1,
        sources: { source: { role: 'sales', sourceLabel: 'docs.example.com' } },
      },
      media: {
        ownerImage: { url: 'https://cdn.andeanscapes.com/owner.jpg', caption: 'Call +1 212 555 1234' },
      },
      experiences: {},
    })).not.toThrow();
  });

  it('accepts the v4 payment contract with optional availability', () => {
    const parsed = dynamicDataSchema.parse({
      v: 4,
      updated: '2026-07-09T00:00:00Z',
      payments: {
        currency: 'COP',
        deposit: {
          type: 'percentage', value: 15, label: 'Anticipo',
          calculationRule: 'depositAmount = totalReservationAmount * 0.15',
          remainingBalancePercentage: 85,
        },
        methods: [{
          id: 'nequi', name: 'Nequi', type: 'mobile_transfer', enabled: true,
          phoneNumber: '3000000000', formattedPhoneNumber: '300 000 0000', countryCode: '+57',
          fullPhoneNumber: '+573000000000', currency: 'COP', instructions: 'Transferencia por Nequi.',
          requiresPaymentProof: true,
        }, {
          id: 'mercado_pago', name: 'Mercado Pago', type: 'payment_link', enabled: true,
          currency: 'COP', paymentLink: null, instructions: 'El equipo enviara el enlace.',
          requiresPaymentProof: false,
        }],
        confirmation: { automatic: false, requiresTeamValidation: true, message: 'Validacion requerida.' },
        displayPolicy: {
          showAfterAvailabilityValidation: true,
          showWhenCustomerWantsToReserve: true,
          showWhenCustomerAsksHowToPay: true,
          doNotRequestPaymentBeforeAvailabilityValidation: true,
          neverRequestFullPaymentWithoutConfirmation: true,
        },
      },
      media: {},
      experiences: {
        emerald_mining_tour: {
          pricing: {
            currency: 'COP',
            plans: { '2d1n_mining': { individual: 550000, couple: 1000000 } },
            addons: {},
            paymentPolicy: {
              depositRequired: true, depositPercentage: 15, remainingBalancePercentage: 85,
              paymentMethods: ['nequi', 'mercado_pago'], paymentDataReference: 'payments',
              requiresAvailabilityValidation: true, requiresPaymentValidation: true,
            },
            rules: ['Para confirmar la reserva se requiere un anticipo del 15%.'],
          },
        },
      },
    });

    expect(parsed.payments?.deposit.value).toBe(15);
    expect(parsed.experiences.emerald_mining_tour?.sites[DEFAULT_SITE_ID]?.availability.dates).toEqual([]);
  });

  it('accepts remote referent attribution metadata', () => {
    const parsed = dynamicDataSchema.parse({
      v: 7,
      updated: '2026-08-02T00:00:00Z',
      referentAttribution: {
        profileId: 'andean-scapes-co',
        version: 1,
        sources: {
          'referent.a': { role: 'cold-open', sourceLabel: 'Private source' },
        },
      },
      experiences: {},
    });

    expect(parsed.referentAttribution?.sources['referent.a']?.role).toBe('cold-open');
  });

  it('strips private payment fields from methods without failing load', () => {
    const parsed = dynamicDataSchema.parse({
      v: 4,
      updated: '2026-07-09T00:00:00Z',
      payments: {
        currency: 'COP',
        deposit: {
          type: 'percentage', value: 15, label: 'Anticipo', calculationRule: 'x',
          remainingBalancePercentage: 85,
        },
        methods: [{
          id: 'nequi', name: 'Nequi', type: 'mobile_transfer', enabled: true,
          currency: 'COP', requiresPaymentProof: true,
          phoneNumber: '3009900001', fullPhoneNumber: '+573009900001',
          instructions: 'Transfiere al 3009900001',
        }, {
          id: 'mercado_pago', name: 'Mercado Pago', type: 'payment_link', enabled: true,
          currency: 'COP', paymentLink: 'https://pay.example/secret', instructions: 'Pagar.',
          requiresPaymentProof: false,
        }],
        confirmation: { automatic: false, requiresTeamValidation: true, message: 'Validar.' },
        displayPolicy: {
          showAfterAvailabilityValidation: true,
          showWhenCustomerWantsToReserve: true,
          showWhenCustomerAsksHowToPay: true,
          doNotRequestPaymentBeforeAvailabilityValidation: true,
          neverRequestFullPaymentWithoutConfirmation: true,
        },
      },
      experiences: {},
    });
    expect(parsed.payments?.methods).toEqual([
      { id: 'nequi', name: 'Nequi', type: 'mobile_transfer', enabled: true, currency: 'COP', requiresPaymentProof: true },
      { id: 'mercado_pago', name: 'Mercado Pago', type: 'payment_link', enabled: true, currency: 'COP', requiresPaymentProof: false },
    ]);
    expect(JSON.stringify(parsed.payments)).not.toContain('3009900001');
    expect(JSON.stringify(parsed.payments)).not.toContain('pay.example');
  });

  it('accepts the reservation rescheduling policy', () => {
    const parsed = dynamicDataSchema.parse({
      v: 5,
      updated: '2026-07-26T00:00:00Z',
      reservationPolicy: {
        rescheduling: {
          allowed: true,
          freeUntilDaysBefore: 7,
          lateChangeRule: 'Después de ese plazo se aplican los gastos ya causados.',
        },
      },
      experiences: {},
    });

    expect(parsed.reservationPolicy?.rescheduling.freeUntilDaysBefore).toBe(7);
  });

  it('rejects unknown fields', () => {
    const data = {
      v: 1,
      updated: '2026-05-30T00:00:00Z',
      extra: true,
      experiences: {},
    };

    expect(() => dynamicDataSchema.parse(data)).toThrow();
  });

  it.each(['2026-11-31', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-10'])(
    'rejects impossible calendar date %s in availability',
    (d) => {
      expect(() => dynamicDataSchema.parse({
        v: 11,
        updated: '2026-07-09T00:00:00Z',
        experiences: {
          emerald_mining_tour: {
            clarifications: [],
            sites: {
              chivor: {
                clarifications: [], addons: {}, rules: [], media: { gallery: [] }, plans: {},
                availability: { tz: 'America/Bogota', dates: [{ d, s: 'available' }], rule: '' },
              },
            },
          },
        },
      })).toThrow(/real calendar date/);
    },
  );

  it('accepts real calendar dates in availability', () => {
    expect(() => dynamicDataSchema.parse({
      v: 11,
      updated: '2026-07-09T00:00:00Z',
      experiences: {
        emerald_mining_tour: {
          clarifications: [],
          sites: {
            chivor: {
              clarifications: [], addons: {}, rules: [], media: { gallery: [] }, plans: {},
              availability: {
                tz: 'America/Bogota',
                dates: [
                  { d: '2026-11-30', s: 'available' },
                  { d: '2028-02-29', s: 'limited', sl: 2 },
                ],
                rule: '',
              },
            },
          },
        },
      },
    })).not.toThrow();
  });

  it('strips static pricing only when dynamic URL is configured and unavailable', () => {
    expect(shouldStripStaticPricing('', false)).toBe(false);
    expect(shouldStripStaticPricing('https://cdn.andeanscapes.com/whatsapp_bot/bot-dynamic.json', false)).toBe(true);
    expect(shouldStripStaticPricing('https://cdn.andeanscapes.com/whatsapp_bot/bot-dynamic.json', true)).toBe(false);
  });

  it('loads offline CI catalog when no dynamic service is configured', () => {
    setDynamicService(null);
    const skills = loadSkills();
    // Product SSoT is scripts/bot-dynamic.ci.json (offline) / CDN (online).
    expect(skills.andeanScapes.experiences[0].id).toBe('emerald_mining_tour');
    expect(skills.andeanScapes.experiences[0].pricing.items.length).toBeGreaterThan(0);
    expect(skills.dynamicData).not.toBeNull();
  });

  it('keeps C03 entry valueHook factual: no ad-copy, no invented comparative, keeps route caveats', () => {
    setDynamicService(null);
    const skills = loadSkills();
    const valueHook = skills.dynamicData?.experiences.emerald_mining_tour
      ?.sites.chivor?.entrySegments?.C03?.valueHook ?? '';
    expect(valueHook).not.toBe('');
    // Ad-copy lemas.
    expect(valueHook).not.toMatch(/solo se disfrutan en dos ruedas/i);
    expect(valueHook).not.toMatch(/la aventura empieza cuando enciendes la moto/i);
    // Comparative/superlative claims the catalog does not support: the route is
    // documented as "NO es la recomendada", and Chivor is the closest/safest access.
    expect(valueHook).not.toMatch(/m[aá]s (?:directa|corta|r[aá]pida|cercana|segura)/i);
    // Facts that must survive: distance + the moto/4x4-only restriction.
    expect(valueHook).toMatch(/35 km/);
    expect(valueHook).toMatch(/moto o (?:carro )?4x4/i);
  });

  it('keeps mining duration, medical assistance, and mine type distinctions', () => {
    setDynamicService(null);
    const experience = getActiveExperience(loadSkills());
    const reality = experience.experienceReality;
    const safety = experience.safetyInfo;
    if (!reality || !safety) throw new Error('CI catalog must include experience reality and safety info');

    expect(reality.physicalDemands).toMatch(/jornada total de unas 6 horas/i);
    expect(reality.physicalDemands).toMatch(/ingreso variable/i);
    expect(safety.medicalSupport).toMatch(/seguro de asistencia medica incluido/i);
    expect(safety.medicalSupport).toMatch(/no hay personal sanitario presencial/i);
    expect(experience.mineDetails.type).toMatch(/minas reales de esmeralda/i);
    expect(experience.mineDetails.type).toMatch(/no son minas de carbon/i);
  });

  it('accepts valid dynamic media config and distributes flat images into sites', () => {
    const parsed = dynamicDataSchema.parse({
      v: 2,
      updated: '2026-05-30T00:00:00Z',
      media: {
        ownerImage: {
          url: 'https://cdn.andeanscapes.com/whatsapp_bot/emerald_mining_chivor/agentaandpartnera.jpg',
          caption: 'AgentA y PartnerA — Andean Scapes',
        },
        planImages: [{
          id: 'emerald_mining_preview_1',
          experienceId: 'emerald_mining_tour',
          planId: '2d1n_mining',
          url: 'https://cdn.andeanscapes.com/whatsapp_bot/details/2d1n_1.png',
          caption: 'Imagen de referencia del plan 2D/1N',
        }],
        galleryImages: [{
          url: 'https://cdn.andeanscapes.com/whatsapp_bot/emerald_mining_chivor/gallery_1.jpg',
          caption: 'Galeria',
        }],
      },
      experiences: {
        emerald_mining_tour: {
          pricing: { currency: 'COP', plans: { '2d1n_mining': { individual: 550000 } }, rules: '' },
        },
      },
    });

    // Top level keeps only the brand-wide owner image; per-experience images move
    // into that experience's default site.
    expect(parsed.media?.ownerImage?.url).toContain('agentaandpartnera.jpg');
    expect((parsed.media as { planImages?: unknown }).planImages).toBeUndefined();
    expect((parsed.media as { galleryImages?: unknown }).galleryImages).toBeUndefined();

    const site = parsed.experiences.emerald_mining_tour?.sites[DEFAULT_SITE_ID];
    expect(site?.media.gallery).toHaveLength(1);
    expect(site?.plans['2d1n_mining']?.media.planImages).toHaveLength(1);
  });

  it('rejects invalid dynamic media urls', () => {
    expect(() => dynamicDataSchema.parse({
      v: 2,
      updated: '2026-05-30T00:00:00Z',
      media: {
        ownerImage: { url: 'not-a-url' },
        planImages: [],
      },
      experiences: {},
    })).toThrow();
  });

  it('rejects dynamic media urls outside the Andean Scapes CDN', () => {
    expect(() => dynamicDataSchema.parse({
      v: 3,
      updated: '2026-05-30T00:00:00Z',
      media: {
        galleryImages: [{ url: 'https://evil.example.com/gallery.jpg' }],
      },
      experiences: {},
    })).toThrow();
  });

  it('accepts gallery images with valid type from site vocabulary', () => {
    const result = dynamicDataSchema.parse({
      v: 3,
      updated: '2026-05-30T00:00:00Z',
      experiences: {
        tour1: {
          status: 'active',
          sites: {
            chivor: {
              plans: {
                plan1: { status: 'active', media: { planImages: [] } },
              },
              media: {
                types: ['mine', 'hotel', 'nature'],
                gallery: [
                  { url: 'https://cdn.andeanscapes.com/img1.jpg', caption: 'Mine photo', type: 'mine' },
                  { url: 'https://cdn.andeanscapes.com/img2.jpg', caption: 'Hotel photo', type: 'hotel' },
                ],
              },
              entrySegments: {},
            },
          },
        },
      },
    });
    expect(result.experiences.tour1.sites.chivor.media.types).toEqual(['mine', 'hotel', 'nature']);
    expect(result.experiences.tour1.sites.chivor.media.gallery[0].type).toBe('mine');
    expect(result.experiences.tour1.sites.chivor.media.gallery[1].type).toBe('hotel');
  });

  it('rejects gallery image with type not in site vocabulary', () => {
    expect(() => dynamicDataSchema.parse({
      v: 3,
      updated: '2026-05-30T00:00:00Z',
      experiences: {
        tour1: {
          status: 'active',
          sites: {
            chivor: {
              plans: {
                plan1: { status: 'active', media: { planImages: [] } },
              },
              media: {
                types: ['mine', 'hotel'],
                gallery: [
                  { url: 'https://cdn.andeanscapes.com/img1.jpg', caption: 'Photo', type: 'unknown_type' },
                ],
              },
              entrySegments: {},
            },
          },
        },
      },
    })).toThrow(/Unknown type/);
  });

  it('rejects gallery image with type when site vocabulary is empty', () => {
    expect(() => dynamicDataSchema.parse({
      v: 3,
      updated: '2026-05-30T00:00:00Z',
      experiences: {
        tour1: {
          status: 'active',
          sites: {
            chivor: {
              plans: {
                plan1: { status: 'active', media: { planImages: [] } },
              },
              media: {
                gallery: [
                  { url: 'https://cdn.andeanscapes.com/img1.jpg', caption: 'Photo', type: 'mine' },
                ],
              },
              entrySegments: {},
            },
          },
        },
      },
    })).toThrow(/type must be declared in media.types vocabulary/);
  });

  it('accepts gallery images without type (optional)', () => {
    const result = dynamicDataSchema.parse({
      v: 3,
      updated: '2026-05-30T00:00:00Z',
      experiences: {
        tour1: {
          status: 'active',
          sites: {
            chivor: {
              plans: {
                plan1: { status: 'active', media: { planImages: [] } },
              },
              media: {
                types: ['mine'],
                gallery: [
                  { url: 'https://cdn.andeanscapes.com/img1.jpg', caption: 'Photo' },
                  { url: 'https://cdn.andeanscapes.com/img2.jpg', caption: 'Another', type: 'mine' },
                ],
              },
              entrySegments: {},
            },
          },
        },
      },
    });
    expect(result.experiences.tour1.sites.chivor.media.gallery[0].type).toBeUndefined();
    expect(result.experiences.tour1.sites.chivor.media.gallery[1].type).toBe('mine');
  });

  it('accepts typeKeywords whose keys belong to the site vocabulary', () => {
    const result = dynamicDataSchema.parse({
      v: 3,
      updated: '2026-05-30T00:00:00Z',
      experiences: {
        tour1: {
          status: 'active',
          sites: {
            chivor: {
              plans: {
                plan1: { status: 'active', media: { planImages: [] } },
              },
              media: {
                types: ['mine', 'bike'],
                gallery: [
                  { url: 'https://cdn.andeanscapes.com/img1.jpg', caption: 'Photo', type: 'mine' },
                ],
                typeKeywords: {
                  mine: ['mina', 'esmeraldas'],
                  bike: ['moto', 'ubala'],
                },
              },
              entrySegments: {},
            },
          },
        },
      },
    });
    expect(result.experiences.tour1.sites.chivor.media.typeKeywords).toEqual({
      mine: ['mina', 'esmeraldas'],
      bike: ['moto', 'ubala'],
    });
  });

  it('rejects typeKeywords key not in site vocabulary', () => {
    expect(() => dynamicDataSchema.parse({
      v: 3,
      updated: '2026-05-30T00:00:00Z',
      experiences: {
        tour1: {
          status: 'active',
          sites: {
            chivor: {
              plans: {
                plan1: { status: 'active', media: { planImages: [] } },
              },
              media: {
                types: ['mine'],
                gallery: [
                  { url: 'https://cdn.andeanscapes.com/img1.jpg', caption: 'Photo', type: 'mine' },
                ],
                typeKeywords: {
                  hotel: ['hotel'],
                },
              },
              entrySegments: {},
            },
          },
        },
      },
    })).toThrow(/typeKeywords key .*must be declared in media.types vocabulary/);
  });

  it('rejects typeKeywords when site vocabulary is empty', () => {
    expect(() => dynamicDataSchema.parse({
      v: 3,
      updated: '2026-05-30T00:00:00Z',
      experiences: {
        tour1: {
          status: 'active',
          sites: {
            chivor: {
              plans: {
                plan1: { status: 'active', media: { planImages: [] } },
              },
              media: {
                gallery: [
                  { url: 'https://cdn.andeanscapes.com/img1.jpg', caption: 'Photo', type: 'mine' },
                ],
                typeKeywords: {
                  mine: ['mina'],
                },
              },
              entrySegments: {},
            },
          },
        },
      },
    })).toThrow(/typeKeywords key .*must be declared in media.types vocabulary/);
  });

  it('distributes legacy flat media without a types vocabulary', () => {
    const result = dynamicDataSchema.parse({
      v: 3,
      updated: '2026-05-30T00:00:00Z',
      media: {
        ownerImage: { url: 'https://cdn.andeanscapes.com/owner.jpg', caption: 'Owner' },
        galleryImages: [
          { url: 'https://cdn.andeanscapes.com/legacy1.jpg', caption: 'Legacy 1' },
          { url: 'https://cdn.andeanscapes.com/legacy2.jpg', caption: 'Legacy 2' },
        ],
      },
      experiences: {
        tour1: {
          status: 'active',
          sites: {
            chivor: {
              plans: {
                plan1: { status: 'active', media: { planImages: [] } },
              },
              media: { gallery: [] },
              entrySegments: {},
            },
          },
        },
      },
    });
    expect(result.media?.ownerImage?.url).toContain('owner.jpg');
    expect(result.experiences.tour1.sites.chivor.media.gallery).toHaveLength(2);
    expect(result.experiences.tour1.sites.chivor.media.gallery[0].type).toBeUndefined();
  });
});

describe('DynamicDataService refresh', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function okResponse(): Response {
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ v: 3, updated: '2026-06-06T00:00:00Z', experiences: {} }),
    } as unknown as Response;
  }

  it('refreshIfStale skips refetch within the throttle window', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());
    const svc = new DynamicDataService('https://cdn.andeanscapes.com/whatsapp_bot/bot-dynamic.json', 5000);

    await svc.refreshIfStale();
    await svc.refreshIfStale();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('forceRefresh fetches even within the throttle window', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());
    const svc = new DynamicDataService('https://cdn.andeanscapes.com/whatsapp_bot/bot-dynamic.json', 5000);

    await svc.refreshIfStale();
    await svc.forceRefresh();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('DynamicDataService availability', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not expose dates that have already passed in Bogota', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-26T12:00:00.000Z'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        v: 11,
        updated: '2026-07-10T00:00:00Z',
        experiences: {
          emerald_mining_tour: {
            status: 'inactive',
            name: 'Emerald Mining Tour',
            currency: 'COP',
            sites: {
              chivor: {
                clarifications: [], addons: {}, rules: [], media: { gallery: [] }, plans: {},
                availability: {
                  tz: 'America/Bogota',
                  dates: [
                    { d: '2026-07-19', s: 'limited', sl: 8 },
                    { d: '2026-08-07', s: 'limited', sl: 7 },
                  ],
                  rule: '',
                },
              },
            },
          },
        },
      }),
    } as unknown as Response);
    const svc = new DynamicDataService('https://cdn.andeanscapes.com/whatsapp_bot/bot-dynamic.json', 5_000);

    await svc.forceRefresh();

    expect(svc.getData()?.experiences.emerald_mining_tour?.availability.availableDates)
      .toEqual([{ date: '2026-08-07', status: 'limited', slotsApprox: 7 }]);
  });

  it('keeps the current Bogota date before midnight local time', () => {
    const exp = getActiveExperience(loadSkills());
    const originalAvailability = exp.availability;
    exp.availability = {
      lastUpdated: '2026-07-29',
      timezone: 'America/Bogota',
      availableDates: [{ date: '2026-07-29', status: 'available', slotsApprox: 4 }],
      botRule: 'Published availability is authoritative.',
    };

    try {
      expect(getFutureAvailableDates(exp, new Date('2026-07-30T00:30:00.000Z'))).toHaveLength(1);
    } finally {
      exp.availability = originalAvailability;
    }
  });

  it('applies an add-on to every plan listed by the dynamic feed', async () => {
    const data = transformDynamicData(dynamicDataSchema.parse({
        v: 9,
        updated: '2026-07-29T00:00:00Z',
        experiences: {
          emerald_mining_tour: {
            clarifications: [],
            plans: {
              '2d1n_mining': {
                pricing: { individual: 550000, couple: 1000000 },
                clarifications: [],
                addons: ['apiary_cattle'],
              },
              '3d2n_rural': {
                pricing: { individual: 650000, couple: 1200000 },
                clarifications: [],
                addons: ['apiary_cattle'],
              },
            },
            pricing: {
              currency: 'COP',
              addons: {
                apiary_cattle: { label: 'Apicultura', pp: 55000 },
              },
              rules: '',
            },
            availability: {
              tz: 'America/Bogota',
              dates: [],
              rule: '',
            },
          },
        },
      }));

    const addonPlans = data.experiences.emerald_mining_tour?.pricing.items
      .filter(item => item.id === 'apiary_cattle')
      .map(item => item.planId);
    expect(addonPlans).toEqual(['2d1n_mining', '3d2n_rural']);
  });

  it('prefilters dynamic dates in the experience timezone', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T06:00:00.000Z'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        v: 11,
        updated: '2026-07-29T00:00:00Z',
        experiences: {
          emerald_mining_tour: {
            status: 'inactive',
            name: 'Emerald Mining Tour',
            currency: 'COP',
            sites: {
              chivor: {
                clarifications: [], addons: {}, rules: [], media: { gallery: [] }, plans: {},
                availability: {
                  tz: 'Pacific/Honolulu',
                  dates: [{ d: '2026-07-29', s: 'available', sl: 4 }],
                  rule: 'Published availability is authoritative.',
                },
              },
            },
          },
        },
      }),
    } as unknown as Response);
    const svc = new DynamicDataService('https://cdn.andeanscapes.com/whatsapp_bot/bot-dynamic.json', 5_000);

    await svc.forceRefresh();

    expect(svc.getData()?.experiences.emerald_mining_tour?.availability.availableDates)
      .toEqual([{ date: '2026-07-29', status: 'available', slotsApprox: 4 }]);
  });
});

describe('DynamicDataService lastFetchOk', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const URL = 'https://cdn.andeanscapes.com/whatsapp_bot/bot-dynamic.json';

  function response(overrides: Partial<Response> & { jsonBody?: unknown }): Response {
    const { jsonBody, ...rest } = overrides;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => jsonBody ?? { v: 3, updated: '2026-06-06T00:00:00Z', experiences: {} },
      ...rest,
    } as unknown as Response;
  }

  it('starts false before any fetch', () => {
    const svc = new DynamicDataService(URL, 5000);
    expect(svc.lastFetchOk).toBe(false);
  });

  it('is true after a successful 200 fetch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ status: 200 }));
    const svc = new DynamicDataService(URL, 5000);
    await svc.forceRefresh();
    expect(svc.lastFetchOk).toBe(true);
  });

  it('is true after a 304 not-modified response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ status: 304 }));
    const svc = new DynamicDataService(URL, 5000);
    await svc.forceRefresh();
    expect(svc.lastFetchOk).toBe(true);
  });

  it('is false after a 500 error response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ ok: false, status: 500 }));
    const svc = new DynamicDataService(URL, 5000);
    await svc.forceRefresh();
    expect(svc.lastFetchOk).toBe(false);
  });

  it('is false after a network/fetch throw', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const svc = new DynamicDataService(URL, 5000);
    await svc.forceRefresh();
    expect(svc.lastFetchOk).toBe(false);
  });

  it('is false after invalid JSON (ZodError)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response({ status: 200, jsonBody: { v: 1, updated: '2026-06-06T00:00:00Z', extra: true, experiences: {} } }),
    );
    const svc = new DynamicDataService(URL, 5000);
    await svc.forceRefresh();
    expect(svc.lastFetchOk).toBe(false);
  });

  it('flips back to false when a good fetch is followed by a failed one', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ status: 200 }))
      .mockResolvedValueOnce(response({ ok: false, status: 503 }));
    const svc = new DynamicDataService(URL, 5000);
    await svc.forceRefresh();
    expect(svc.lastFetchOk).toBe(true);
    await svc.forceRefresh();
    expect(svc.lastFetchOk).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('isDynamicDataFresh', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setDynamicService(null);
  });

  it('returns true when no dynamic service is configured', () => {
    setDynamicService(null);
    expect(isDynamicDataFresh()).toBe(true);
  });

  it('mirrors the service lastFetchOk when a service is configured', async () => {
    const url = 'https://cdn.andeanscapes.com/whatsapp_bot/bot-dynamic.json';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ v: 3, updated: '2026-06-06T00:00:00Z', experiences: {} }),
    } as unknown as Response);
    const svc = new DynamicDataService(url, 5000);
    setDynamicService(svc);

    expect(isDynamicDataFresh()).toBe(false);
    await svc.forceRefresh();
    expect(isDynamicDataFresh()).toBe(true);
  });
});

describe('business rules merge with dynamic pricing', () => {
  const URL = 'https://cdn.andeanscapes.com/whatsapp_bot/bot-dynamic.json';

  afterEach(() => {
    vi.restoreAllMocks();
    setDynamicService(null);
    loadSkills(); // reset cached skills to static baseline
  });

  it('accepts valid entry segment codes without placeholder leaks', () => {
    const parsed = dynamicDataSchema.parse({
      v: 11,
      updated: '2026-08-11T00:00:00Z',
      experiences: {
        emerald_mining_tour: {
          clarifications: [],
          sites: {
            chivor: {
              clarifications: [],
              addons: {},
              rules: [],
              media: { gallery: [] },
              availability: { tz: 'America/Bogota', dates: [], rule: '' },
              plans: {},
              entrySegments: {
                C01: {
                  label: 'Cold - General',
                  description: 'Test',
                  valueHook: 'A clean hook with no placeholders',
                  diagnosisQuestion: 'What is your preference?',
                  planMatch: 'Any plan',
                },
                H02: {
                  label: 'Hot 4x4',
                  description: 'Test',
                  valueHook: '',
                  diagnosisQuestion: 'Do you bring your own vehicle?',
                  planMatch: '2D/1N 4x4',
                },
                R03: {
                  label: 'Returning - Moto',
                  description: 'Test',
                  valueHook: 'You were interested in the moto route',
                  diagnosisQuestion: 'What held you back last time?',
                  planMatch: '2D/1N moto',
                },
              },
            },
          },
        },
      },
    });

    expect(parsed.experiences.emerald_mining_tour?.sites[DEFAULT_SITE_ID]?.entrySegments).toBeDefined();
    expect(Object.keys(parsed.experiences.emerald_mining_tour?.sites[DEFAULT_SITE_ID]?.entrySegments || {})).toHaveLength(3);
  });

  it('applies remote pricing rules from authoritative dynamic catalog and drops the sentinel', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({
        v: 11, updated: '2026-06-06T00:00:00Z',
        experiences: {
          emerald_mining_tour: {
            name: 'Emerald Mining Tour',
            currency: 'COP',
            sites: {
              chivor: {
                shortDescription: 'Real emerald mining experience.',
                clarifications: [],
                addons: {},
                rules: 'REMOTE_RULE: 15% deposito via Nequi|Nunca inventes descuentos',
                media: { gallery: [] },
                availability: { tz: 'America/Bogota', dates: [], rule: 'REMOTE_AVAIL_RULE' },
                plans: {
                  '2d1n_mining': {
                    name: 'Mining plan',
                    duration: '2D/1N',
                    shortDescription: 'Two-day mining experience.',
                    pricing: { individual: 550000, couple: 1000000 },
                    clarifications: [],
                    addons: [],
                    media: { planImages: [] },
                  },
                },
              },
            },
          },
        },
      }),
    } as unknown as Response);

    const svc = new DynamicDataService(URL, 5000);
    setDynamicService(svc);
    await svc.forceRefresh();
    loadSkills();
    await refreshSkills(true);

    const experiences = getSkills().andeanScapes.experiences;
    expect(experiences.length).toBeGreaterThan(0);
    const pricing = experiences[0].pricing;
    expect(pricing.items.some(i => i.couplePrice === 1000000)).toBe(true);
    expect(pricing.botRules).toContain('REMOTE_RULE: 15% deposito via Nequi');
    expect(pricing.botRules.some(r => r.includes('Nunca inventes descuentos'))).toBe(true);
    expect(pricing.botRules).not.toContain('PRICING_NOT_AVAILABLE');
  });
});
