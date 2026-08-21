export type EntryTemperature = 'cold' | 'funnel' | 'retargeting';

export interface EntryMarker {
  code: string;
  temperature: EntryTemperature;
}

const ENTRY_MARKER = /^([CHR])(\d{2})\b/;

export function parseEntryMarker(text: string): EntryMarker | null {
  const match = ENTRY_MARKER.exec(text);
  if (!match) return null;

  const letter = match[1].toUpperCase();
  const temperature: EntryTemperature = letter === 'C'
    ? 'cold'
    : letter === 'H' ? 'funnel' : 'retargeting';
  return { code: `${letter}${match[2]}`, temperature };
}

export function findEntryMarker(currentMessage: string, previousInbound: readonly string[]): EntryMarker | null {
  const current = parseEntryMarker(currentMessage);
  if (current) return current;
  if (previousInbound.length >= 2) return null;
  return previousInbound.map(parseEntryMarker).find((marker): marker is EntryMarker => marker !== null) ?? null;
}
