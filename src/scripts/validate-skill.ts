import { loadSkills } from '../services/skill-loader.js';
import { loadSalesComposition } from '../services/sales-composition.js';

try {
  loadSkills();
  loadSalesComposition();
  console.log('All skill files validated successfully.');
  process.exit(0);
} catch (err) {
  console.error('Skill validation failed:', err);
  process.exit(1);
}
