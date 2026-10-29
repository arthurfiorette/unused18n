import assert from 'node:assert/strict';
import test from 'node:test';
import { DiagnosticCategory } from 'typescript/sync';
import { createReporter } from '../dist/reporter.js';

/**
 * Builds a file-less diagnostic in the shape `lint()` yields.
 *
 * @param {DiagnosticCategory} category
 * @param {number} code
 * @param {string} text
 * @param {string | null} [source] `null` builds a compiler diagnostic, which has no source.
 */
function diagnostic(category, code, text, source = 'U18N') {
  return { pos: 0, end: 0, category, code, text, ...(source ? { source } : {}) };
}

test('throttles operational events while diagnostics remain immediate', () => {
  let time = 0;
  const messages = [];
  const reporter = createReporter({
    level: 'info',
    isTTY: false,
    now: () => time,
    write: (message) => messages.push(message)
  });

  reporter.event({ type: 'phase', phase: 'project' });
  time = 1_000;
  reporter.event({ type: 'phase', phase: 'analysis' });
  reporter.diagnostic(diagnostic(DiagnosticCategory.Error, 1, 'failure'));
  time = 3_000;
  reporter.event({
    type: 'file-progress',
    fileName: 'source.ts',
    completedFiles: 1,
    totalFiles: 2
  });
  time = 6_000;
  reporter.event({ type: 'phase', phase: 'results' });

  assert.equal(messages.length, 3);
  assert.match(messages[0], /error U18N1: failure/);
  assert.match(messages[1], /50% of files processed/);
  assert.match(messages[2], /Preparing diagnostics/);
  assert.ok(messages.every((message) => !message.includes('\u001B[')));
});

test('silent suppresses operations but TTY diagnostics use color', () => {
  const messages = [];
  const reporter = createReporter({
    level: 'silent',
    isTTY: true,
    write: (message) => messages.push(message)
  });

  reporter.event({ type: 'phase', phase: 'project' });
  reporter.diagnostic(diagnostic(DiagnosticCategory.Error, 1, 'failure'));

  assert.equal(messages.length, 1);
  assert.equal(messages[0].includes('\u001B['), true);
});

test('prints compiler diagnostics with the TS prefix', () => {
  const messages = [];
  const reporter = createReporter({
    level: 'info',
    isTTY: false,
    write: (message) => messages.push(message)
  });

  reporter.diagnostic(diagnostic(DiagnosticCategory.Error, 5108, 'Option has been removed.', null));

  assert.deepEqual(messages, ['error TS5108: Option has been removed.']);
});

test('reports semantic request counts only at debug level', () => {
  const output = (level) => {
    let time = 0;
    const messages = [];
    const reporter = createReporter({
      level,
      isTTY: false,
      now: () => time,
      write: (message) => messages.push(message)
    });
    time = 3_000;
    reporter.event({ type: 'semantic', singleRequests: 2, batchRequests: 7 });
    return messages;
  };

  assert.deepEqual(output('debug'), ['[3.0s] Semantic requests: single=2 batch=7']);
  assert.deepEqual(output('info'), []);
});

test('reports cache lifecycle only at debug level and through the same throttle', () => {
  let time = 0;
  const messages = [];
  const reporter = createReporter({
    level: 'debug',
    isTTY: false,
    now: () => time,
    write: (message) => messages.push(message)
  });

  reporter.event({
    type: 'cache',
    event: { type: 'miss', reason: 'absent', analyzedFiles: 2, reusedFiles: 0 }
  });
  time = 3_000;
  reporter.event({ type: 'cache', event: { type: 'write', files: 2 } });

  assert.deepEqual(messages, ['[3.0s] Cache write: files=2']);
});

test('reports completed stage durations only at debug level', () => {
  let time = 0;
  const messages = [];
  const reporter = createReporter({
    level: 'debug',
    isTTY: false,
    now: () => time,
    write: (message) => messages.push(message)
  });

  reporter.event({ type: 'stage', stage: 'dictionary', status: 'start', timestamp: 100 });
  time = 3_000;
  reporter.event({ type: 'stage', stage: 'dictionary', status: 'end', timestamp: 350 });

  assert.deepEqual(messages, ['[3.0s] dictionary stage: 250.0ms']);
});

test('suppresses per-key diagnostics and reports final statistics even in silent mode', () => {
  const messages = [];
  const reporter = createReporter({
    level: 'silent',
    isTTY: false,
    write: (message) => messages.push(message)
  });

  reporter.diagnostic(diagnostic(DiagnosticCategory.Error, 95_001, 'unused key'));
  reporter.diagnostic(diagnostic(DiagnosticCategory.Message, 95_003, 'removed key'));
  reporter.event({
    type: 'summary',
    unusedKeys: 4_184,
    removedKeys: 5,
    unresolvedReferences: 12,
    removalFailures: 0,
    translationObjectCasts: 2,
    removedCasts: 0
  });

  assert.deepEqual(messages, [
    'Summary: 4,184 unused | 5 removed | 12 unresolved | 0 removal failures | 2 casts',
    'Run --remove to remove 2 translation object casts automatically.'
  ]);
});
