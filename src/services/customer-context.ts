export interface CustomerContext {
  name?: string;
  people?: number;
  date?: string;
  transport?: 'own_car' | 'own_motorcycle' | 'public' | 'private' | 'ambiguous';
  childAges?: number[];
  groupRelationship?: string;
  lodgingNeeded?: true;
  pet?: true;
}

const MONTHS = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|january|february|march|april|may|june|july|august|september|october|november|december';

/** Extracts only explicit facts from the current inbound message; nothing is persisted. */
export function extractCustomerContext(message: string): CustomerContext {
  const context: CustomerContext = {};
  const name = message.match(/\b(?:soy|me llamo|mi nombre es|i am|my name is)\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{2,20})\b/i)?.[1];
  if (name) context.name = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();

  const people = message.match(/\b(?:somos|vamos|ser[ií]amos|there (?:are|will be)|we are)\s+(\d{1,2})\b/i)
    ?? message.match(/\b(\d{1,2})\s+(?:personas|people|pax|adultos?|adults?)\b/i);
  if (people) {
    const count = Number(people[1]);
    if (Number.isInteger(count) && count > 0 && count <= 100) context.people = count;
  }

  const date = message.match(new RegExp(`\\b(?:\\d{1,2}\\s+(?:de\\s+)?(?:${MONTHS})|(?:${MONTHS})\\s+\\d{1,2})(?:\\s+(?:de\\s+)?\\d{4})?\\b`, 'i'))?.[0];
  if (date) context.date = date;
  else {
    const month = message.match(new RegExp(`\\b(?:${MONTHS})\\b`, 'i'))?.[0];
    if (month) context.date = month;
  }

  if (/\b(?:moto|motorcycle)\b/i.test(message)) context.transport = 'own_motorcycle';
  else if (/\b(?:carro|auto|coche|veh[ií]culo|own (?:car|transport|vehicle)|driving ourselves)\b/i.test(message)) context.transport = 'own_car';
  else if (/\b(?:bus|transporte p[uú]blico|public transport)\b/i.test(message)) context.transport = 'public';
  else if (/\b(?:transporte privado|private transport)\b/i.test(message)) context.transport = 'private';
  else if (/\b(?:transporte|recoger|pickup|transport)\b/i.test(message)) context.transport = 'ambiguous';
  const childAges = [...message.matchAll(/\b(?:niñ[oa]|child|kid)\s+(?:de\s+)?(\d{1,2})\s*(?:años|anos|years? old)\b/gi)]
    .map(match => Number(match[1]))
    .filter(age => Number.isInteger(age) && age >= 0 && age <= 17);
  if (childAges.length > 0) context.childAges = childAges;
  if (/\b(?:padre e hijo|pap[aá] e hijo|father and son)\b/i.test(message)) context.groupRelationship = 'padre e hijo';
  if (/\b(?:hotel|hospedaje|alojamiento|lodging|stay|overnight)\b/i.test(message)) context.lodgingNeeded = true;
  if (/\b(?:mascota|perr(?:o|a|ito)?|gato|pet|dog|cat)\b/i.test(message)) context.pet = true;

  return context;
}
