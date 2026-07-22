import type { ProcessMessageOutput } from '../../services/response-engine.js';
import { env } from '../../config/env.js';
import { getSkills } from '../../services/skill-loader.js';
import { getActiveExperience } from '../../services/product-registry.js';
import { calculatePriceQuote } from '../../services/pricing-calculator.js';
import type { Criterion, CriterionResult, Scenario } from './schema.js';
import type { TurnRecord } from './runner.js';

const PRICE_PATTERN = /\b(\$\s*[\d.,]+\s*(?:COP|USD)?|[\d.,]+\s*COP|precio total|total.*COP|cuesta|vale)\b/i;
const DATE_GIVEN_PATTERN = /\b(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|january|february|march|april|may|june|july|august|september|october|november|december|mañana|manana|tomorrow|fin de semana|weekend|s[aá]bado|domingo|\d{1,2}[/-]\d{1,2})\b/i;
const PEOPLE_GIVEN_PATTERN = /(?:somos|ser[ií]amos?|para|grupo de)\s+\d+|\d+\s*(?:persona|people|pax)|\b(?:pareja|solo|sola|couple|alone|mi hijo y yo|my son and i)\b/i;
const TRANSPORT_GIVEN_PATTERN = /\b(?:carro|moto|transporte propio|veh[ií]culo|4x4|desde bogot[aá]|bus|transport|motorcycle)\b/i;
const NAME_GIVEN_PATTERN = /(?:me llamo|mi nombre es|hola soy|hello i'?m|my name is)\s+\S+|^\s*[a-záéíóúñ]{2,}(?:\s+[a-záéíóúñ]{2,})?\s*(?:,\s*(?:from|traveling)|$)/i;
const FIELD_ASK_PATTERNS = {
  name: /\b(c[óo]mo te llamas|cu[aá]l (es )?tu nombre|what'?s your name|what is your name|con qui[eé]n tengo)\b/i,
  people: /\b(cu[aá]ntas personas|how many people|para cu[aá]ntos|ser[ií]an|vienes?\s*solo|is the experience for you alone)\b/i,
  date: /\b(tienen .{0,30} fecha|(?:alguna|cual|qué|que|c[uú]al) fecha|fecha en mente|para cu[aá]ndo|fecha preferida|en mente.*fecha)\b/i,
  transport: /\b(?:llegar[ií]an|llegan|llegar)\s+(?:por su cuenta|en carro|en moto)|(?:necesitan|necesitas).{0,20}(?:transporte|transport)\b/i,
};
const BIG_GROUP_PATTERN = /\b(\d{2,})\s*(?:personas|people|pax)\b|\b(?:m[ií]nimo|aprox\.?|aproximadamente|mas de|m[aá]s de|al menos)\s*(\d{2,})\b/i;
const BIG_GROUP_DATE_PATTERN = /\b(validar.*(?:fecha|disponibilidad|cupo)|con cuidado|grupo grande|cuidadosamente|revisar.*(?:fecha|disponibilidad|cupo))\b/i;
const BIG_GROUP_PRICE_PATTERN = /\b(revis.*precio|referencial|validamos.*valor|precio.*cantidad|valor.*segun.*cantidad|precio.*revisable|ajustar.*precio|precio.*referencia)\b/i;
const COFOUNDER_PATTERN = /(?:junto\s+(?:con|a)|\bco-?fundador(?:a)?\b[^.!?\n]{0,100}\bcon)\s+([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ0-9]*)/;

export interface ScenarioEvaluation {
  score: number;
  hardFail: boolean;
  criteria: CriterionResult[];
  notes: string[];
}

function normalize(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function givesName(turns: TurnRecord[], index: number): boolean {
  const text = turns[index].user;
  if (/(?:me llamo|mi nombre es|hola soy|hello i'?m|my name is)\s+\S+/i.test(text)) return true;
  return index > 0 && FIELD_ASK_PATTERNS.name.test(turns[index - 1].reply) && NAME_GIVEN_PATTERN.test(text);
}

function fieldsBefore(turns: TurnRecord[], until: number): number {
  const fields = new Set<string>();
  for (let i = 0; i < until; i++) {
    const text = turns[i].user;
    if (givesName(turns, i)) fields.add('name');
    if (PEOPLE_GIVEN_PATTERN.test(text)) fields.add('people');
    if (DATE_GIVEN_PATTERN.test(text)) fields.add('date');
    if (TRANSPORT_GIVEN_PATTERN.test(text)) fields.add('transport');
  }
  return fields.size;
}

function criterionResult(criterion: Criterion, passed: boolean, evidence: string): CriterionResult {
  return { id: criterion.id, rule: criterion.rule, passed, score: passed ? 100 : 0, weight: criterion.weight, critical: criterion.critical, evidence };
}

function replyForTurn(turns: TurnRecord[], turn?: number): string[] {
  return turn === undefined ? turns.map(t => t.reply) : turns[turn - 1] ? [turns[turn - 1].reply] : [];
}

function evaluateCriterion(criterion: Criterion, turns: TurnRecord[]): CriterionResult {
  const replies = replyForTurn(turns, criterion.turn);
  const replyText = replies.join('\n');

  if (criterion.rule === 'reply_must_match') {
    const missing = (criterion.patterns ?? []).filter(p => !new RegExp(p, 'i').test(replyText));
    return criterionResult(criterion, missing.length === 0, missing.length === 0 ? 'required patterns present' : `missing: ${missing.join(', ')}`);
  }

  if (criterion.rule === 'reply_must_not_match' || criterion.rule === 'unsafe_pattern_absent') {
    const matched = (criterion.patterns ?? []).filter(p => new RegExp(p, 'i').test(replyText));
    return criterionResult(criterion, matched.length === 0, matched.length === 0 ? 'no forbidden patterns' : `matched: ${matched.join(', ')}`);
  }

  if (criterion.rule === 'output_flag_equals' || criterion.rule === 'output_flag_not_equals') {
    const turn = turns[(criterion.turn ?? turns.length) - 1];
    const output = turn?.processOutput as ProcessMessageOutput | undefined;
    const flagKey = criterion.flag === 'sendOwnerImage' ? 'shouldSendOwnerImage' : criterion.flag!;
    const actual = output?.[flagKey as keyof ProcessMessageOutput];
    const passed = criterion.rule === 'output_flag_equals'
      ? actual === criterion.expected
      : actual !== criterion.expected;
    return criterionResult(criterion, passed, `${flagKey}=${String(actual)}`);
  }

  if (criterion.rule === 'max_question_marks') {
    const max = criterion.max ?? 1;
    // Count closing `?` only — Spanish openers `¿` are not separate questions.
    const count = (replyText.match(/\?/g) ?? []).length;
    return criterionResult(criterion, count <= max, `questionMarks=${count} max=${max}`);
  }

  if (criterion.rule === 'known_field_not_reasked') {
    const suppliedIndex = (criterion.suppliedTurn ?? 1) - 1;
    const supplied = turns[suppliedIndex]?.user.trim();
    if (!supplied) return criterionResult(criterion, false, `${criterion.field} supplied turn missing`);
    for (let index = 0; index < turns.length; index++) {
      const turn = turns[index];
      if (index >= suppliedIndex && FIELD_ASK_PATTERNS[criterion.field!].test(turn.reply)) {
        return criterionResult(criterion, false, `re-asked ${criterion.field} at turn ${turn.turnNumber}`);
      }
    }
    return criterionResult(criterion, true, `${criterion.field} not re-asked`);
  }

  if (criterion.rule === 'price_after_min_fields') {
    const minimum = criterion.minFields ?? 2;
    for (let i = 0; i < turns.length; i++) {
      if (PRICE_PATTERN.test(turns[i].reply) && fieldsBefore(turns, i + 1) < minimum) {
        return criterionResult(criterion, false, `price before ${minimum} fields at turn ${i + 1}`);
      }
    }
    return criterionResult(criterion, true, 'price gate respected');
  }

  if (criterion.rule === 'big_group_date_validation' || criterion.rule === 'big_group_price_review') {
    const threshold = criterion.threshold ?? 10;
    const people = Math.max(0, ...turns.map(t => {
      const match = BIG_GROUP_PATTERN.exec(t.user);
      return match ? Number(match[1] || match[2]) : 0;
    }));
    if (people <= threshold) return criterionResult(criterion, true, `no group above ${threshold}`);
    const pattern = criterion.rule === 'big_group_date_validation' ? BIG_GROUP_DATE_PATTERN : BIG_GROUP_PRICE_PATTERN;
    const passed = turns.some(t => pattern.test(t.reply));
    return criterionResult(criterion, passed, passed ? `${people}p caveat present` : `${people}p caveat missing`);
  }

  if (criterion.rule === 'partner_name_not_customer_name') {
    const cofounder = turns.map(t => COFOUNDER_PATTERN.exec(t.reply)?.[1]).find(Boolean);
    const protectedNames = [cofounder, env.OWNER_NAME, env.PARTNER_NAME]
      .filter((name): name is string => Boolean(name))
      .flatMap(name => [name, name.split(/\s+/)[0]])
      .filter(name => name.length > 1);
    const turn = turns.find(item => protectedNames.some(name => new RegExp(`^${escapeRegex(normalize(name))}[,\\s!¡¿]`, 'i').test(normalize(item.reply))));
    return criterionResult(criterion, !turn, turn ? `addressed customer as owner/partner at turn ${turn.turnNumber}` : 'partner name not used as customer name');
  }

  if (criterion.rule === 'group_quote_integrity') {
    const expectedPeople = criterion.people!;
    const quote = calculatePriceQuote(getActiveExperience(getSkills()), {
      planId: criterion.planId,
      people: expectedPeople,
      transportNeed: 'own',
    });
    const expectedTotal = quote?.planTotal ?? criterion.expectedTotal!;

    const peopleCounts = [...replyText.matchAll(/\b(\d+)\s*(?:personas|people|pax)\b/gi)].map(match => Number(match[1]));
    const amounts = [...replyText.matchAll(/\$?\s*(\d[\d.,]*)\s*COP\b/gi)]
      .map(match => Number(match[1].replace(/[.,]/g, '')));
    const peopleMatch = peopleCounts.includes(expectedPeople) && peopleCounts.every(count => count === expectedPeople);
    const totalMatch = amounts.includes(expectedTotal);
    const safelyWithheld = amounts.length === 0 && /(?:confirm|valid|revis|ajust).{0,50}(?:precio|valor|cifra)|(?:precio|valor|cifra).{0,50}(?:confirm|valid|revis|ajust)/i.test(replyText);
    return criterionResult(
      criterion,
      peopleMatch && (totalMatch || safelyWithheld),
      `people=${peopleCounts.join(',') || 'missing'} total=${amounts.join(',') || (safelyWithheld ? 'safely withheld' : 'missing')} expected=${expectedPeople}/${expectedTotal}`,
    );
  }

  return criterionResult(criterion, false, `unsupported rule ${criterion.rule}`);
}

export function evaluateScenario(scenario: Scenario, turns: TurnRecord[]): ScenarioEvaluation {
  const criteria = scenario.criteria.map(criterion => evaluateCriterion(criterion, turns));
  const totalWeight = criteria.reduce((total, criterion) => total + criterion.weight, 0);
  const score = totalWeight === 0 ? 0 : Math.round(criteria.reduce((total, criterion) => total + criterion.score * criterion.weight, 0) / totalWeight);
  const hardFail = criteria.some(criterion => criterion.critical && !criterion.passed);
  const notes = criteria.filter(criterion => !criterion.passed).map(criterion => `[${criterion.id}] ${criterion.evidence}`);
  return { score, hardFail, criteria, notes };
}
