import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { DiagnosticCode, lint } from '../dist/index.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const projectFixture = path.join(fixtures, 'project');
const unsafeFixture = path.join(fixtures, 'unsafe');
const cli = path.join(projectFixture, '../../../bin/run.js');

function options(project = projectFixture) {
  return {
    project,
    dictionary: path.join(project, 'dictionary.ts'),
    dictionaryExport: 'dictionary'
  };
}

function diagnostics(project = projectFixture) {
  return [...lint(options(project))];
}

function temporaryProject(t, sourceFiles) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unused18n-lint-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  for (const [fileName, source] of Object.entries(sourceFiles)) {
    fs.writeFileSync(path.join(directory, fileName), source);
  }
  return directory;
}

test('lint is a lazy diagnostic generator', () => {
  const result = lint(options());

  assert.equal(result[Symbol.iterator](), result);
  assert.equal(typeof result.next, 'function');
});

test('emits only statically unused dictionary leaves as warning diagnostics', () => {
  const unused = diagnostics()
    .filter(({ code }) => code === DiagnosticCode.UnusedKey)
    .map(({ messageText }) => String(messageText).match(/"(.+)"/)?.[1]);

  assert.deepEqual(unused, [
    'configuredObject.stale',
    'customExposedHook.stale',
    'customHook.stale',
    'destructured.stale',
    'forwarded.two',
    'objects.unused',
    'trulyUnused',
    'wrapped.stale'
  ]);
  assert.ok(
    diagnostics().every(
      ({ category, source }) => category === ts.DiagnosticCategory.Warning && source === 'unused18n'
    )
  );
});

test('locates unused keys and unresolved runtime calls in their source files', () => {
  const result = diagnostics(unsafeFixture);
  const unresolved = result.find(({ code }) => code === DiagnosticCode.UnresolvedReference);
  const unused = result.find(({ code }) => code === DiagnosticCode.UnusedKey);

  assert.equal(unresolved?.file?.fileName, path.join(unsafeFixture, 'usage.ts'));
  assert.equal(unresolved?.file?.getLineAndCharacterOfPosition(unresolved.start ?? 0).line + 1, 6);
  assert.equal(
    unresolved?.file?.text.slice(
      unresolved.start,
      (unresolved.start ?? 0) + (unresolved.length ?? 0)
    ),
    't(key)'
  );
  assert.equal(unused?.file?.fileName, path.join(unsafeFixture, 'dictionary.ts'));
  assert.equal(
    unused?.file?.text.slice(unused.start, (unused.start ?? 0) + (unused.length ?? 0)),
    'arbitrary'
  );
});

test('yields native project diagnostics and stops before dictionary analysis', (t) => {
  const project = temporaryProject(t, {
    'tsconfig.json': '{ invalid json',
    'dictionary.ts': `export const dictionary = { unused: 'unused' }\n`
  });
  const result = diagnostics(project);

  assert.ok(result.length > 0);
  assert.ok(result.every(({ code }) => code !== DiagnosticCode.UnusedKey));
});

test('--remove applies every safe edit and leaves no unused diagnostics', (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'unused18n-remove-'));
  t.after(() => fs.rmSync(project, { force: true, recursive: true }));
  fs.cpSync(projectFixture, project, { recursive: true });

  const removed = [...lint({ ...options(project), remove: true })];
  const after = diagnostics(project);

  assert.equal(removed.filter(({ code }) => code === DiagnosticCode.RemovedKey).length, 8);
  assert.equal(
    removed.some(({ code }) => code === DiagnosticCode.UnusedKey),
    false
  );
  assert.equal(
    after.some(({ code }) => code === DiagnosticCode.UnusedKey),
    false
  );
});

test('syntax errors prevent --remove from changing the dictionary', (t) => {
  const project = temporaryProject(t, {
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }),
    'dictionary.ts': `export const dictionary = { unused: 'unused' }\n`,
    'usage.ts': 'export const broken = ;\n'
  });
  const dictionaryPath = path.join(project, 'dictionary.ts');
  const before = fs.readFileSync(dictionaryPath, 'utf8');
  const result = [...lint({ ...options(project), remove: true })];

  assert.ok(result.some(({ category }) => category === ts.DiagnosticCategory.Error));
  assert.equal(fs.readFileSync(dictionaryPath, 'utf8'), before);
});

test('--remove can leave an empty dictionary that lints cleanly', (t) => {
  const project = temporaryProject(t, {
    'tsconfig.json': JSON.stringify({ include: ['*.ts'] }),
    'dictionary.ts': `export const dictionary = { unused: 'unused' }\n`
  });

  const removed = [...lint({ ...options(project), remove: true })];
  const after = diagnostics(project);

  assert.equal(removed.filter(({ code }) => code === DiagnosticCode.RemovedKey).length, 1);
  assert.deepEqual(after, []);
});

test('--remove leaves the file unchanged when an unused key is unsafe', (t) => {
  const project = temporaryProject(t, {
    'tsconfig.json': JSON.stringify({ include: ['*.ts'] }),
    'dictionary.ts': `export const dictionary = { values: ['unused'] }\n`
  });
  const dictionaryPath = path.join(project, 'dictionary.ts');
  const before = fs.readFileSync(dictionaryPath, 'utf8');
  const result = [...lint({ ...options(project), remove: true })];

  assert.ok(result.some(({ code }) => code === DiagnosticCode.RemovalFailure));
  assert.equal(fs.readFileSync(dictionaryPath, 'utf8'), before);
});

test('Oclif exits 1 for unused keys and 2 for invalid flags', () => {
  const unused = spawnSync(
    process.execPath,
    [
      cli,
      '--project',
      unsafeFixture,
      '--dictionary',
      path.join(unsafeFixture, 'dictionary.ts'),
      '--export',
      'dictionary'
    ],
    { encoding: 'utf8' }
  );
  const invalid = spawnSync(process.execPath, [cli, '--project', unsafeFixture], {
    encoding: 'utf8'
  });

  assert.equal(unused.status, 1);
  assert.match(unused.stderr, /TS95001/);
  assert.match(unused.stderr, /TS95002/);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Missing required flag/);
});

test('Oclif --remove fixes safe unused keys and exits 0', (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'unused18n-cli-remove-'));
  t.after(() => fs.rmSync(project, { force: true, recursive: true }));
  fs.cpSync(projectFixture, project, { recursive: true });
  const args = [
    cli,
    '--project',
    project,
    '--dictionary',
    path.join(project, 'dictionary.ts'),
    '--export',
    'dictionary'
  ];

  const removed = spawnSync(process.execPath, [...args, '--remove'], { encoding: 'utf8' });
  const clean = spawnSync(process.execPath, args, { encoding: 'utf8' });

  assert.equal(removed.status, 0);
  assert.match(removed.stderr, /TS95003/);
  assert.equal(clean.status, 0);
  assert.equal(clean.stderr, '');
});
