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
