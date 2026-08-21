import { describe, it, expect, vi, afterEach } from 'vitest';
import { countEmojis, extractEmojis, logEmojiStyle, stripEmojisOnPaymentClose, stripPaymentMoveWithoutDate } from '../services/reply-guard.js';
import { logger } from '../config/logger.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('countEmojis', () => {
  it('returns 0 for empty string', () => {
    expect(countEmojis('')).toBe(0);
  });

  it('counts plain single emoji', () => {
    expect(countEmojis('Hello 😊')).toBe(1);
    expect(countEmojis('🙌')).toBe(1);
    expect(countEmojis('Che 🌿')).toBe(1);
  });

  it('counts multiple plain emojis', () => {
    expect(countEmojis('🙌 🤝 😊')).toBe(3);
    expect(countEmojis('😊😊😊')).toBe(3);
  });

  it('counts ZWJ family as 1', () => {
    expect(countEmojis('👨‍👩‍👧‍👦 hello')).toBe(1);
  });

  it('counts skin-tone variant as 1', () => {
    expect(countEmojis('👋🏻')).toBe(1);
    expect(countEmojis('👋🏿')).toBe(1);
  });

  it('counts VS16 emoji as 1', () => {
    expect(countEmojis('❤️ hello')).toBe(1);
  });

  it('ignores non-emoji characters', () => {
    expect(countEmojis('Hello world')).toBe(0);
    expect(countEmojis('123 ABC')).toBe(0);
  });

  it('counts mixed emoji and text', () => {
    expect(countEmojis('El total es $2.500.000 🙌 ¿Te interesa? 😊')).toBe(2);
  });
});

describe('extractEmojis', () => {
  it('returns an empty list for empty or emoji-free text', () => {
    expect(extractEmojis('')).toEqual([]);
    expect(extractEmojis('Hola, todo bien')).toEqual([]);
  });

  it('returns distinct glyphs in first-appearance order', () => {
    expect(extractEmojis('Hola 🙌 y 🌿')).toEqual(['🙌', '🌿']);
  });

  it('deduplicates a repeated glyph', () => {
    expect(extractEmojis('😊 uno 😊 dos 😊')).toEqual(['😊']);
  });

  // Grapheme-based: a ZWJ family must not decompose into its member emoji, or the
  // "already used" list would ban unrelated glyphs.
  it('keeps a ZWJ family sequence as one entry', () => {
    expect(extractEmojis('Vienen en familia 👨‍👩‍👧‍👦')).toEqual(['👨‍👩‍👧‍👦']);
  });

  it('keeps a VS16 glyph as one entry', () => {
    expect(extractEmojis('Montaña ⛰️ linda')).toEqual(['⛰️']);
  });

  it('agrees with countEmojis on distinct-glyph text', () => {
    const text = 'Che 🙌 mirá 🌿 esto ⛏️';
    expect(extractEmojis(text)).toHaveLength(countEmojis(text));
  });
});

describe('logEmojiStyle', () => {
  it('returns 0 and does not log when no emoji', () => {
    const infoSpy = vi.spyOn(logger, 'info');
    expect(logEmojiStyle('Hello world', { phone: '573000000001' })).toBe(0);
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('returns 1 and does not log in safe context', () => {
    const infoSpy = vi.spyOn(logger, 'info');
    expect(logEmojiStyle('Hello 😊', {
      phone: '573000000001',
      mentionsPrice: false,
      movesToPayment: false,
    })).toBe(1);
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('logs when count > 1', () => {
    const infoSpy = vi.spyOn(logger, 'info');
    expect(logEmojiStyle('Hello 😊 world 🙌', {
      phone: '573000000001',
      salesPhase: 'greeting',
    })).toBe(2);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: '573000000001',
        emojiCount: 2,
        salesPhase: 'greeting',
      }),
      '[BOT] emoji style diagnostic',
    );
  });

  it('logs when emoji appears with price context', () => {
    const infoSpy = vi.spyOn(logger, 'info');
    expect(logEmojiStyle('El precio es $2.500.000 😊', {
      phone: '573000000001',
      mentionsPrice: true,
    })).toBe(1);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ emojiCount: 1, mentionsPrice: true }),
      '[BOT] emoji style diagnostic',
    );
  });

  it('logs when emoji appears with payment context', () => {
    const infoSpy = vi.spyOn(logger, 'info');
    expect(logEmojiStyle('Deposito del 15% via Nequi 😊', {
      phone: '573000000001',
      movesToPayment: true,
    })).toBe(1);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ emojiCount: 1, movesToPayment: true }),
      '[BOT] emoji style diagnostic',
    );
  });

  it('does not mutate input', () => {
    const original = 'Hello 😊 world 🙌 !';
    logEmojiStyle(original, { phone: '573000000001' });
    expect(original).toBe('Hello 😊 world 🙌 !');
  });
});

describe('stripEmojisOnPaymentClose', () => {
  it('strips emoji on payment or price turns', () => {
    const pay = 'Listo el 7. Anticipo 15% por Nequi. 😊 ¿La iniciamos?';
    expect(stripEmojisOnPaymentClose(pay, { movesToPayment: true })).toBe(
      'Listo el 7. Anticipo 15% por Nequi. ¿La iniciamos?',
    );
    const quote = 'Para 5 personas, el plan queda en $2.250.000 COP. ⛏️ ¿Fecha?';
    expect(stripEmojisOnPaymentClose(quote, { mentionsPrice: true })).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(stripEmojisOnPaymentClose(pay, {})).toBe(pay);
  });

  it('is a no-op when already emoji-free', () => {
    const clean = 'Anticipo 15% por Nequi. ¿La iniciamos?';
    expect(stripEmojisOnPaymentClose(clean, { movesToPayment: true })).toBe(clean);
  });
});

describe('stripPaymentMoveWithoutDate', () => {
  it('keeps plan summary and drops anticipo/Nequi clauses', () => {
    const input = 'Te dejo el resumen: plan 2 días para 2, $1.000.000 COP. El anticipo es 15% por Nequi. Cuando hablen me escriben.';
    const out = stripPaymentMoveWithoutDate(input);
    expect(out.toLowerCase()).toContain('resumen');
    expect(out.toLowerCase()).toContain('1.000.000');
    expect(out.toLowerCase()).not.toMatch(/anticipo|nequi/);
  });
});
