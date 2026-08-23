import ts from '@typescript/typescript6';
import type { CacheEvent } from './cache.js';
import type { LintEvent } from './lint.js';
import type { LogLevel } from './types.js';

export interface ReporterOptions {
  level: LogLevel;
  isTTY: boolean;
  write(message: string): void;
  now?: () => number;
  minIntervalMs?: number;
}

export interface Reporter {
  event(event: LintEvent): void;
  diagnostic(diagnostic: ts.Diagnostic): void;
}

/** Operational output is sampled synchronously because timers cannot run during compiler traversal. */
export function createReporter(options: ReporterOptions): Reporter {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const minInterval = Math.max(3_000, options.minIntervalMs ?? 3_000);
  const color = options.isTTY && process.env.NO_COLOR === undefined;
  const phases = new Set<string>();
  let lastOperationalAt = startedAt;

  function operational(message: string): void {
    const current = now();
    if (current - lastOperationalAt < minInterval) return;
    lastOperationalAt = current;
    const elapsed = ((current - startedAt) / 1_000).toFixed(1);
    options.write(`${paint(`[${elapsed}s]`, '36')} ${message}`);
  }

  function paint(value: string, code: string): string {
    return color ? `\u001B[${code}m${value}\u001B[0m` : value;
  }

  return {
    event(event) {
      if (options.level === 'silent') return;
      if (event.type === 'phase') {
        if (phases.has(event.phase) || phases.size >= 3) return;
        phases.add(event.phase);
        operational(
          event.phase === 'project'
            ? 'Creating TypeScript project'
            : event.phase === 'analysis'
              ? 'Analyzing translation usage'
              : 'Preparing diagnostics'
        );
        return;
      }
      if (event.type === 'file-progress') {
        const percentage =
          event.totalFiles === 0
            ? 100
            : Math.floor((event.completedFiles / event.totalFiles) * 100);
        operational(`${percentage}% of files processed`);
        return;
      }
      if (options.level === 'debug' || event.event.type === 'error') {
        operational(formatCacheEvent(event.event));
      }
    },
    diagnostic(diagnostic) {
      const host: ts.FormatDiagnosticsHost = {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => ts.sys.newLine
      };
      options.write(
        (color
          ? ts.formatDiagnosticsWithColorAndContext([diagnostic], host)
          : ts.formatDiagnostic(diagnostic, host)
        ).trimEnd()
      );
    }
  };
}

function formatCacheEvent(event: CacheEvent): string {
  if (event.type === 'write') return `Cache write: files=${event.files}`;
  if (event.type === 'bypass') return `Cache bypass: ${event.reason}`;
  if (event.type === 'error') return `Cache ${event.operation} error: ${event.message}`;
  const reason = event.reason ? ` reason=${event.reason}` : '';
  return `Cache ${event.type}:${reason} analyzed=${event.analyzedFiles} reused=${event.reusedFiles}`;
}
