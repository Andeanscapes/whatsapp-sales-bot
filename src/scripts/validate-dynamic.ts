import { readFileSync } from 'fs';
import { dynamicDataSchema } from '../services/dynamic-data-schema.js';

const filePath = process.argv[2];

if (!filePath) {
  console.error('Usage: tsx src/scripts/validate-dynamic.ts <path-to-dynamic.json>');
  process.exit(1);
}

try {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  const validated = dynamicDataSchema.parse(parsed);

  const expCount = Object.keys(validated.experiences).length;
  const planCount = Object.values(validated.experiences).reduce(
    (sum, e) => sum + Object.keys(e.pricing.plans).length, 0
  );
  const dateCount = Object.values(validated.experiences).reduce(
    (sum, e) => sum + e.availability.dates.length, 0
  );

  console.log('Dynamic skill file is VALID');
  console.log(`   Experiences: ${expCount}`);
  console.log(`   Plans with pricing: ${planCount}`);
  console.log(`   Available dates: ${dateCount}`);
  console.log(`   Last updated: ${validated.updated}`);
  process.exit(0);
} catch (err) {
  console.error('Dynamic skill file is INVALID');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
