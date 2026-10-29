import os from 'node:os';
import {
  type Diagnostic,
  type FormatDiagnosticsHost,
  formatDiagnostics,
  formatDiagnosticsWithColorAndContext
} from 'typescript/sync';
import type { CacheEvent } from './cache.js';
import { DiagnosticCode } from './diagnostic-codes.js';
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
  diagnostic(diagnostic: Diagnostic): void;
}

/** Paths print relative to the working directory, and lines end with the platform newline. */
const formatHost: FormatDiagnosticsHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => process.cwd(),
  getNewLine: () => os.EOL
};

/** Operational output is sampled synchronously because timers cannot run during compiler traversal. */
export function createReporter(options: ReporterOptions): Reporter {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const minInterval = Math.max(3_000, options.minIntervalMs ?? 3_000);
  const color = options.isTTY && process.env.NO_COLOR === undefined;
  const phases = new Set<string>();
  const stageStarts = new Map<string, number>();
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
      if (event.type === 'summary') {
        const values = [
          `${event.unusedKeys.toLocaleString('en-US')} unused`,
          `${event.removedKeys.toLocaleString('en-US')} removed`,
          `${event.unresolvedReferences.toLocaleString('en-US')} unresolved`,
          `${event.removalFailures.toLocaleString('en-US')} removal failures`,
          event.removedCasts > 0
            ? `${event.removedCasts.toLocaleString('en-US')} casts removed`
            : `${event.translationObjectCasts.toLocaleString('en-US')} casts`
        ];
        options.write(`Summary: ${values.join(' | ')}`);
        if (event.translationObjectCasts > 0) {
          options.write(
            `Run --remove to remove ${event.translationObjectCasts.toLocaleString('en-US')} translation object casts automatically.`
          );
        }
        return;
      }
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
      if (event.type === 'stage') {
        if (event.status === 'start') {
          stageStarts.set(event.stage, event.timestamp);
          return;
        }
        const started = stageStarts.get(event.stage);
        if (options.level === 'debug' && started !== undefined) {
          operational(`${event.stage} stage: ${(event.timestamp - started).toFixed(1)}ms`);
        }
        return;
      }
      if (event.type === 'semantic') {
        if (options.level === 'debug') {
          operational(
            `Semantic requests: single=${event.singleRequests} batch=${event.batchRequests}`
          );
        }
        return;
      }
      if (options.level === 'debug' || event.event.type === 'error') {
        operational(formatCacheEvent(event.event));
      }
    },
    diagnostic(diagnostic) {
      if (
        diagnostic.code === DiagnosticCode.UnusedKey ||
        diagnostic.code === DiagnosticCode.RemovedKey
      ) {
        return;
      }
      options.write(
        (color
          ? formatDiagnosticsWithColorAndContext([diagnostic], formatHost)
          : formatDiagnostics([diagnostic], formatHost)
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
