import assert from 'node:assert/strict';
import test from 'node:test';
import ts from '@typescript/typescript6';
import { createReporter } from '../dist/reporter.js';

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
  reporter.diagnostic({ category: ts.DiagnosticCategory.Error, code: 1, messageText: 'failure' });
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
  assert.match(messages[0], /error TS1: failure/);
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
  reporter.diagnostic({ category: ts.DiagnosticCategory.Error, code: 1, messageText: 'failure' });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].includes('\u001B['), true);
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

  reporter.diagnostic({
    category: ts.DiagnosticCategory.Error,
    code: 95_001,
    messageText: 'unused key'
  });
  reporter.diagnostic({
    category: ts.DiagnosticCategory.Message,
    code: 95_003,
    messageText: 'removed key'
  });
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
