/**
 * Ensures better-sqlite3 matches the current Node ABI.
 * Swapping Node versions (20 ↔ 24) without rebuild breaks eval/tests.
 */
import { createRequire } from 'module';
import { spawnSync } from 'child_process';

const require = createRequire(import.meta.url);

function tryLoad() {
  require('better-sqlite3');
}

try {
  tryLoad();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (!/NODE_MODULE_VERSION|was compiled against a different Node/i.test(message)) {
    console.error('[native] better-sqlite3 failed to load:', message);
    process.exit(1);
  }
  console.warn('[native] better-sqlite3 ABI mismatch for this Node — rebuilding...');
  const result = spawnSync('npm', ['rebuild', 'better-sqlite3'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  try {
    tryLoad();
  } catch (retryErr) {
    const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
    console.error('[native] rebuild finished but load still fails:', retryMessage);
    console.error('[native] Use Node from .nvmrc (24.18.0), then: npm run native:rebuild');
    process.exit(1);
  }
}
