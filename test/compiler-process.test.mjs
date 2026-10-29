import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { lint } from '../dist/index.js';

const project = fileURLToPath(new URL('./fixtures/project', import.meta.url));

/**
 * Lists the live TypeScript compiler processes this test process spawned. `ps --ppid` is
 * GNU-only, so every process is listed and filtered by parent pid.
 *
 * Node reaps exited children asynchronously, and these tests never yield to the event loop, so
 * a compiler that already exited stays in the table as a zombie (`Z` state, `[tsc] <defunct>`
 * on Linux) until the test ends. Zombies hold no resources and are not counted.
 */
function compilerChildren() {
  return execFileSync('ps', ['-A', '-o', 'ppid=,stat=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([ppid, stat]) => ppid === String(process.pid) && !stat?.startsWith('Z'))
    .map((fields) => fields.slice(2).join(' '))
    .filter((command) => /typescript|\btsc\b/.test(command));
}

// `ps` is unavailable on Windows.
const skip = process.platform === 'win32';

test('a lint() that is never iterated spawns no compiler', { skip }, () => {
  assert.deepEqual(compilerChildren(), []);
  const iterator = lint({
    project,
    dictionary: path.join(project, 'dictionary.ts'),
    cache: false
  });

  assert.deepEqual(compilerChildren(), []);
  assert.equal(typeof iterator.next, 'function');
});

test('the compiler has exited once lint() yields its first diagnostic', { skip }, () => {
  assert.deepEqual(compilerChildren(), []);
  const iterator = lint({
    project,
    dictionary: path.join(project, 'dictionary.ts'),
    cache: false
  });

  // Callers may stop after any diagnostic without calling return(), so nothing may still be
  // waiting on a `finally` to close the compiler.
  assert.equal(iterator.next().done, false);
  assert.deepEqual(compilerChildren(), []);
});
