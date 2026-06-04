import { logger } from '../config/logger.js';
import type { Repositories } from '../db/repositories/index.js';

let reposRef: Repositories | null = null;

export function setErrorRepos(repos: Repositories): void {
  reposRef = repos;
}

export function logSystemError(
  type: string,
  severity: 'critical' | 'error' | 'warning',
  err: unknown,
  context?: Record<string, unknown>,
): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;

  logger.error({ err, type, severity, context: context ? JSON.stringify(context).slice(0, 500) : undefined }, `[ERROR_LOG] ${type}`);

  if (reposRef) {
    try {
      reposRef.systemErrors.insert(type, severity, message, stack, context);
    } catch {
      // DB write itself failed — nothing more we can do
    }
  }
}

export function setupGlobalErrorHandlers(): void {
  process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    logSystemError('unhandled_rejection', 'critical', reason instanceof Error ? reason : new Error(String(reason)), {
      promise: String(promise).slice(0, 200),
    });
    // Let the process crash — systemd restarts it. We log before dying.
    // This prevents the process from running in an undefined state.
    setTimeout(() => process.exit(1), 1000);
  });

  process.on('uncaughtException', (err: Error, origin: NodeJS.UncaughtExceptionOrigin) => {
    logSystemError('uncaught_exception', 'critical', err, { origin });
    setTimeout(() => process.exit(1), 1000);
  });
}

export function pruneOldErrors(repos: Repositories): void {
  try {
    const deleted = repos.systemErrors.pruneOlderThan(90);
    if (deleted > 0) {
      logger.info({ deleted }, '[ERROR_LOG] pruned old system errors');
    }
  } catch {
    // non-critical — continue startup
  }
}
