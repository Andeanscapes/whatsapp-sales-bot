import type { PhaseBreakdown } from '../db/repositories/types.js';
import type { CommandContext } from './index.js';

function formatPhases(phases: PhaseBreakdown[]): string {
  if (phases.length === 0) return 'No hay conversaciones activas.';

  const total = phases.reduce((sum, p) => sum + p.count, 0);
  const lines = ['📈 *Pipeline por Fase*', ''];

  for (const p of phases) {
    const pct = Math.round((p.count / total) * 100);
    lines.push(`${p.phase}: ${p.count} (${pct}%)`);
  }

  lines.push('', `Total activas: ${total}`);
  return lines.join('\n');
}

export async function phasesHandler(ctx: CommandContext): Promise<string> {
  const phases = ctx.repos.stats.getPhaseBreakdown();
  return formatPhases(phases);
}
