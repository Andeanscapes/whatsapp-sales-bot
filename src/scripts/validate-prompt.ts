import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptPath = join(__dirname, '..', 'prompts', 'deepseek-system.prompt.md');
const salesStrategyPath = join(__dirname, '..', 'data', 'sales-strategy.skill.json');

interface Check {
  label: string;
  pattern: RegExp;
}

const CHECKS: Check[] = [
  { label: 'price amounts (e.g. $550,000)', pattern: /\$\s?[\d.,]{3,}/ },
  { label: 'COP currency reference', pattern: /\bCOP\b/ },
  { label: 'route name: Chivor', pattern: /\bChivor\b/ },
  { label: 'route name: Bogota', pattern: /Bogot[áa]/ },
  { label: 'route name: Ubala', pattern: /\bUbal[aá]\b/ },
  { label: 'route keyword: ferry', pattern: /\bferry\b/i },
  { label: 'mine name', pattern: /\bLa Uni[óo]n\b/ },
  { label: 'hacienda name', pattern: /\bEl Recuerdo\b/ },
  { label: 'region name: Valle de Tenza', pattern: /Valle de Tenza/ },
  { label: 'region name: Boyaca', pattern: /Boyac[aá]/ },
  { label: 'pricing formula (Individual $)', pattern: /\bIndividual.*?\$/ },
  { label: 'pricing formula (Pareja $)', pattern: /\bPareja.*?\$/ },
  { label: 'transport price amount', pattern: /\b1[,.]?700[,.]?000\b/ },
  { label: 'deposit percentage', pattern: /\b15%\b/ },
  { label: 'payment method: Nequi', pattern: /\bNequi\b/ },
  { label: 'payment method: Mercado Pago', pattern: /Mercado Pago/ },
  { label: 'specific date', pattern: /\b2026-\d{2}-\d{2}\b/ },
  { label: 'month names in context', pattern: /\b[eE]nero\b|\b[fF]ebrero\b|\b[mM]arzo\b|\b[aA]bril\b|\b[mM]ayo\b|\b[jJ]unio\b|\b[jJ]ulio\b|\b[aA]gosto\b|\b[sS]eptiembre\b/ },
  { label: 'public URL pattern', pattern: /https?:\/\/\S+/ },
];

const SALES_STRATEGY_CHECKS: Check[] = [
  { label: 'hardcoded price amounts', pattern: /\$\s?[\d.,]{3,}/ },
  { label: 'hardcoded transport price amount', pattern: /\b1[,.]?700[,.]?000\b/ },
  { label: 'hardcoded package price amount', pattern: /\b1[,.]?040[,.]?000\b|\b550[,.]?000\b/ },
];

function collectFailures(filename: string, content: string, checks: Check[]): string[] {
  const failures: string[] = [];
  for (const check of checks) {
    const match = content.match(check.pattern)?.[0];
    if (match) {
      failures.push(`  FAIL: ${filename}: ${check.label} — matched: "${match.slice(0, 60)}"`);
    }
  }
  return failures;
}

function main(): void {
  const content = readFileSync(promptPath, 'utf-8');
  const salesStrategy = readFileSync(salesStrategyPath, 'utf-8');
  const failures = [
    ...collectFailures('deepseek-system.prompt.md', content, CHECKS),
    ...collectFailures('sales-strategy.skill.json', salesStrategy, SALES_STRATEGY_CHECKS),
  ];

  if (failures.length > 0) {
    console.error(`\n${failures.length} business data pattern(s) found outside andean-scapes.skill.json:\n`);
    console.error(failures.join('\n'));
    console.error('\n These must come from skill JSON files, not the prompt.\n');
    process.exit(1);
  }

  console.log('OK: no hardcoded business data found outside andean-scapes.skill.json.');
  process.exit(0);
}

main();
