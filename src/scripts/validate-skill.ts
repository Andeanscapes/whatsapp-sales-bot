import { loadSkills } from '../services/skill-loader.js';

try {
  loadSkills();
  console.log('All skill files validated successfully.');
  process.exit(0);
} catch (err) {
  console.error('Skill validation failed:', err);
  process.exit(1);
}
