export function parseChildAges(raw: string | null): number[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      && parsed.every((age): age is number => Number.isInteger(age) && age >= 0 && age <= 17)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function formatChildAges(raw: string | null): string | null {
  return parseChildAges(raw)?.join(', ') ?? null;
}
