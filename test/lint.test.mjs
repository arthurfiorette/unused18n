import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from '@typescript/typescript6';
import { analyzeProject } from '../dist/analyzer.js';
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

test('build emits JavaScript and declaration source maps', () => {
  assert.equal(fs.existsSync(path.join(projectFixture, '../../../dist/index.js.map')), true);
  assert.equal(fs.existsSync(path.join(projectFixture, '../../../dist/index.d.ts.map')), true);
});

test('emits only statically unused dictionary leaves as error diagnostics', () => {
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
    diagnostics()
      .filter(({ code }) => code === DiagnosticCode.UnusedKey)
      .every(
        ({ category, source }) => category === ts.DiagnosticCategory.Error && source === 'unused18n'
      )
  );
});

test('array receiver iteration marks descendants without confusing a property named map', () => {
  const project = path.join(fixtures, 'array-usage');
  const result = analyzeProject({
    project,
    dictionary: path.join(project, 'dictionary.ts'),
    dictionaryExport: 'default'
  });
  const statuses = new Map(result.keys.map(({ key, status }) => [key, status]));

  for (let index = 0; index < 5; index += 1) {
    assert.equal(statuses.get(`calendar.weekDays.${index}`), 'possibly-used');
  }
  assert.equal(statuses.get('mutableValues.0'), 'possibly-used');
  assert.equal(statuses.get('mutableValues.1'), 'possibly-used');
  assert.equal(statuses.get('forOfValues.0'), 'possibly-used');
  assert.equal(statuses.get('forOfValues.1'), 'possibly-used');
  assert.equal(statuses.get('staticValues.0'), 'unused');
  assert.equal(statuses.get('staticValues.1'), 'used');
  assert.equal(statuses.get('dynamicValues.0'), 'possibly-used');
  assert.equal(statuses.get('dynamicValues.1'), 'possibly-used');
  assert.equal(statuses.get('literalMap.map.label'), 'used');
  assert.equal(statuses.get('literalMap.map.unused'), 'unused');
});

test('emits ordered stage timestamps from a caller-provided clock', () => {
  const events = [];
  let timestamp = 0;

  [
    ...lint({
      ...options(),
      cache: false,
      now: () => ++timestamp,
      onEvent: (event) => events.push(event)
    })
  ];

  assert.deepEqual(
    events.filter(({ type }) => type === 'stage'),
    [
      { type: 'stage', stage: 'project', status: 'start', timestamp: 1 },
      { type: 'stage', stage: 'project', status: 'end', timestamp: 2 },
      { type: 'stage', stage: 'dictionary', status: 'start', timestamp: 3 },
      { type: 'stage', stage: 'dictionary', status: 'end', timestamp: 4 },
      { type: 'stage', stage: 'discovery', status: 'start', timestamp: 5 },
      { type: 'stage', stage: 'discovery', status: 'end', timestamp: 6 },
      { type: 'stage', stage: 'usage', status: 'start', timestamp: 7 },
      { type: 'stage', stage: 'usage', status: 'end', timestamp: 8 },
      { type: 'stage', stage: 'replay', status: 'start', timestamp: 9 },
      { type: 'stage', stage: 'replay', status: 'end', timestamp: 10 }
    ]
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

test('resolves a dictionary exported as the module default', (t) => {
  const project = temporaryProject(t, {
    'tsconfig.json': JSON.stringify({ include: ['*.ts'] }),
    'dictionary.ts': `export default { used: 'used', unused: 'unused' }
`,
    'usage.ts': `import dictionary from './dictionary.js'
dictionary.used
`
  });
  const result = [
    ...lint({
      ...options(project),
      dictionaryExport: 'default'
    })
  ];

  assert.deepEqual(
    result
      .filter(({ code }) => code === DiagnosticCode.UnusedKey)
      .map(({ messageText }) => String(messageText).match(/"(.+)"/)?.[1]),
    ['unused']
  );

  const command = spawnSync(
    process.execPath,
    [
      cli,
      `--project=${project}`,
      `--dictionary=${path.join(project, 'dictionary.ts')}`,
      '--export=default'
    ],
    { encoding: 'utf8' }
  );
  assert.equal(command.status, 1);
  assert.match(command.stderr, /Summary: 1 unused/);

  const removed = [
    ...lint({
      ...options(project),
      dictionaryExport: 'default',
      remove: true
    })
  ];
  assert.ok(removed.some(({ code }) => code === DiagnosticCode.RemovedKey));
  assert.doesNotMatch(fs.readFileSync(path.join(project, 'dictionary.ts'), 'utf8'), /unused/);
});

test('resolves a default export that references a dictionary variable', (t) => {
  const project = temporaryProject(t, {
    'tsconfig.json': JSON.stringify({ include: ['*.ts'] }),
    'dictionary.ts': `const dictionary = { used: 'used', unused: 'unused' }
export default dictionary
`,
    'usage.ts': `import dictionary from './dictionary.js'
dictionary.used
`
  });
  const result = [
    ...lint({
      ...options(project),
      dictionaryExport: 'default'
    })
  ];

  assert.deepEqual(
    result
      .filter(({ code }) => code === DiagnosticCode.UnusedKey)
      .map(({ messageText }) => String(messageText).match(/"(.+)"/)?.[1]),
    ['unused']
  );
});

test('lints a JSON dictionary through default import usage without resolveJsonModule', (t) => {
  const project = temporaryProject(t, {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', strict: true },
      include: ['usage.ts']
    }),
    'messages.json': JSON.stringify(
      {
        common: { used: 'Used', unused: 'Unused' },
        categories: { first: 'First', second: 'Second' }
      },
      null,
      2
    ),
    'usage.ts': `import messages from './messages.json' with { type: 'json' }
const copy = messages
copy.common.used
Object.keys(messages.categories)
`
  });
  const dictionary = path.join(project, 'messages.json');
  const result = [...lint({ project, dictionary })];

  assert.deepEqual(
    result
      .filter(({ code }) => code === DiagnosticCode.UnusedKey)
      .map(({ messageText }) => String(messageText).match(/"(.+)"/)?.[1]),
    ['common.unused']
  );

  const command = spawnSync(
    process.execPath,
    [cli, `--project=${project}`, `--dictionary=${dictionary}`],
    { encoding: 'utf8' }
  );
  assert.equal(command.status, 1);
  assert.match(command.stderr, /Summary: 1 unused/);
});

test('rejects named exports for JSON dictionaries', (t) => {
  const project = temporaryProject(t, {
    'tsconfig.json': JSON.stringify({ include: ['usage.ts'] }),
    'messages.json': JSON.stringify({ unused: 'Unused' }),
    'usage.ts': 'export {}\n'
  });
  const result = [
    ...lint({
      project,
      dictionary: path.join(project, 'messages.json'),
      dictionaryExport: 'messages'
    })
  ];

  assert.equal(result.length, 1);
  assert.equal(result[0]?.code, DiagnosticCode.ConfigurationFailure);
  assert.match(
    String(result[0]?.messageText),
    /JSON dictionaries only expose the "default" export/
  );
});

test('removes unused JSON object properties while preserving valid JSON', (t) => {
  const project = temporaryProject(t, {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler' },
      include: ['usage.ts']
    }),
    'messages.json': `{
  "common": {
    "used": "Used",
    "unused": "Unused"
  },
  "remove": "Remove"
}
`,
    'usage.ts': `import messages from './messages.json' with { type: 'json' }
messages.common.used
`
  });
  const dictionary = path.join(project, 'messages.json');
  const result = [...lint({ project, dictionary, remove: true })];
  const output = fs.readFileSync(dictionary, 'utf8');

  assert.equal(result.filter(({ code }) => code === DiagnosticCode.RemovedKey).length, 2);
  assert.deepEqual(JSON.parse(output), { common: { used: 'Used' } });
  assert.match(output, /"used": "Used"/);
});

test('malformed JSON stays unchanged and wholly unused JSON array properties are removed', (t) => {
  const malformedProject = temporaryProject(t, {
    'tsconfig.json': JSON.stringify({ include: ['usage.ts'] }),
    'messages.json': `{ "broken": }
`,
    'usage.ts': 'export {}\n'
  });
  const malformedPath = path.join(malformedProject, 'messages.json');
  const malformedBefore = fs.readFileSync(malformedPath, 'utf8');
  const malformed = [
    ...lint({ project: malformedProject, dictionary: malformedPath, remove: true })
  ];

  assert.ok(malformed.some(({ category }) => category === ts.DiagnosticCategory.Error));
  assert.ok(malformed.every(({ code }) => code !== DiagnosticCode.RemovedKey));
  assert.equal(fs.readFileSync(malformedPath, 'utf8'), malformedBefore);

  const arrayProject = temporaryProject(t, {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler' },
      include: ['usage.ts']
    }),
    'messages.json': JSON.stringify({ used: 'Used', items: [{ unused: 'Unused' }] }, null, 2),
    'usage.ts': `import messages from './messages.json' with { type: 'json' }
messages.used
`
  });
  const arrayPath = path.join(arrayProject, 'messages.json');
  const arrayResult = [...lint({ project: arrayProject, dictionary: arrayPath, remove: true })];

  assert.ok(arrayResult.some(({ code }) => code === DiagnosticCode.RemovedKey));
  assert.deepEqual(JSON.parse(fs.readFileSync(arrayPath, 'utf8')), { used: 'Used' });
});

test('rejects JSONC syntax before removal', (t) => {
  for (const source of [
    `{ "used": "Used", "unused": "Unused", }
`,
    `{
  // JSON comments are not portable.
  "used": "Used",
  "unused": "Unused"
}
`
  ]) {
    const project = temporaryProject(t, {
      'tsconfig.json': JSON.stringify({
        compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler' },
        include: ['usage.ts']
      }),
      'messages.json': source,
      'usage.ts': `import messages from './messages.json' with { type: 'json' }
messages.used
`
    });
    const dictionary = path.join(project, 'messages.json');
    const before = fs.readFileSync(dictionary, 'utf8');
    const result = [...lint({ project, dictionary, remove: true })];

    assert.ok(result.some(({ code }) => code === DiagnosticCode.ConfigurationFailure));
    assert.ok(result.every(({ code }) => code !== DiagnosticCode.RemovedKey));
    assert.equal(fs.readFileSync(dictionary, 'utf8'), before);
  }
});

test('lints JSON under Classic module resolution without overriding the resolver', (t) => {
  const project = temporaryProject(t, {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { ignoreDeprecations: '6.0', moduleResolution: 'Classic' },
      include: ['usage.ts']
    }),
    'messages.json': JSON.stringify({ unused: 'Unused' }),
    'usage.ts': 'export {}\n'
  });
  const result = [...lint({ project, dictionary: path.join(project, 'messages.json') })];

  assert.equal(result.length, 1);
  assert.equal(result[0]?.code, DiagnosticCode.UnusedKey);
});

test('accepts empty JSON objects and rejects scalar JSON roots', (t) => {
  const emptyProject = temporaryProject(t, {
    'tsconfig.json': JSON.stringify({ include: ['usage.ts'] }),
    'messages.json': '{}',
    'usage.ts': 'export {}\n'
  });
  assert.deepEqual(
    [...lint({ project: emptyProject, dictionary: path.join(emptyProject, 'messages.json') })],
    []
  );

  for (const value of ['"text"', '42', 'true', 'null']) {
    const scalarProject = temporaryProject(t, {
      'tsconfig.json': JSON.stringify({ include: ['usage.ts'] }),
      'messages.json': value,
      'usage.ts': 'export {}\n'
    });
    const result = [
      ...lint({ project: scalarProject, dictionary: path.join(scalarProject, 'messages.json') })
    ];
    assert.equal(result.at(-1)?.code, DiagnosticCode.ConfigurationFailure);
    assert.match(String(result.at(-1)?.messageText), /must resolve to an object or array/);
  }
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
    'dictionary.ts': `export const dictionary = { values: ['used', 'unused'] }\n`,
    'usage.ts': `import { dictionary } from './dictionary.js';\ndictionary.values[0];\n`
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
  assert.match(unused.stderr, /Summary: 3 unused/);
  assert.match(unused.stderr, /TS95002/);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Missing required option.*dictionary/s);
});

test('Oclif exposes help, autocomplete, and unknown-command plugins', () => {
  const help = spawnSync(process.execPath, [cli, 'help'], { encoding: 'utf8' });
  const autocomplete = spawnSync(process.execPath, [cli, 'autocomplete', '--help'], {
    encoding: 'utf8'
  });
  const unknown = spawnSync(process.execPath, [cli, 'unknown-command'], { encoding: 'utf8' });

  assert.equal(help.status, 0);
  assert.match(help.stdout, /autocomplete/);
  assert.match(help.stdout, /lint/);
  assert.equal(autocomplete.status, 0);
  assert.match(autocomplete.stdout, /Display autocomplete installation instructions/);
  assert.equal(unknown.status, 127);
  assert.match(unknown.stderr, /is not a unused18n command/);
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
    'dictionary',
    '--log-level',
    'silent'
  ];

  const removed = spawnSync(process.execPath, [...args, '--remove'], { encoding: 'utf8' });
  const clean = spawnSync(process.execPath, args, { encoding: 'utf8' });

  assert.equal(removed.status, 0);
  assert.match(removed.stderr, /Summary: 0 unused \| 8 removed/);
  assert.equal(clean.status, 0);
  assert.match(clean.stderr, /Summary: 0 unused \| 0 removed/);
});

test('defaults the project and infers unambiguous dictionary exports', () => {
  const project = path.join(fixtures, 'inference');
  const defaultResult = [
    ...lint({ project, dictionary: path.join(project, 'default.ts'), cache: false })
  ];
  const soleResult = [
    ...lint({ project, dictionary: path.join(project, 'sole.ts'), cache: false })
  ];
  const typedSoleResult = [
    ...lint({ project, dictionary: path.join(project, 'typed-sole.ts'), cache: false })
  ];
  const explicitResult = [
    ...lint({
      project,
      dictionary: path.join(project, 'ambiguous.ts'),
      dictionaryExport: 'first',
      cache: false
    })
  ];
  const ambiguousResult = [
    ...lint({ project, dictionary: path.join(project, 'ambiguous.ts'), cache: false })
  ];
  const emptyResult = [
    ...lint({ project, dictionary: path.join(project, 'empty.ts'), cache: false })
  ];
  const factoryResult = [
    ...lint({ project, dictionary: path.join(project, 'factory-dictionary.ts'), cache: false })
  ];
  const emptySelectorResult = [
    ...lint({
      project,
      dictionary: path.join(project, 'sole.ts'),
      dictionaryExport: '',
      cache: false
    })
  ];
  const cliResult = spawnSync(
    process.execPath,
    [cli, '--dictionary', './sole.ts', '--log-level', 'silent', '--no-cache'],
    { cwd: project, encoding: 'utf8' }
  );

  assert.match(String(defaultResult[0]?.messageText), /defaultUnused/);
  assert.match(String(soleResult[0]?.messageText), /soleUnused/);
  assert.match(String(typedSoleResult[0]?.messageText), /typedSoleUnused/);
  assert.match(String(explicitResult[0]?.messageText), /firstUnused/);
  assert.match(String(ambiguousResult[0]?.messageText), /multiple exports exist/);
  assert.match(String(emptyResult[0]?.messageText), /module has no exports/);
  assert.deepEqual(
    factoryResult
      .filter(({ code }) => code === DiagnosticCode.UnusedKey)
      .map(({ messageText }) => String(messageText)),
    ['Translation key "unusedThroughFactory" is unused.']
  );
  assert.match(String(emptySelectorResult[0]?.messageText), /Export "" not found/);
  assert.equal(cliResult.status, 1);
  assert.match(cliResult.stderr, /Summary: 1 unused/);
});

test('reports a missing default project as a configuration diagnostic', () => {
  const project = path.join(fixtures, 'no-project');
  const result = spawnSync(
    process.execPath,
    [cli, '--dictionary', './dictionary.ts', '--log-level', 'silent'],
    { cwd: project, encoding: 'utf8' }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /TS95005/);
  assert.match(result.stderr, /tsconfig\.json/);
});

test('groups maximal fully-unused object subtrees with complete source ranges', () => {
  const project = path.join(fixtures, 'grouping');
  const result = [
    ...lint({ project, dictionary: path.join(project, 'dictionary.ts'), cache: false })
  ].filter(({ code }) => code === DiagnosticCode.UnusedKey);
  const messages = result.map(({ messageText }) => String(messageText));

  assert.deepEqual(messages, [
    'Translation subtree "complete" is unused.',
    'Translation key "list.0" is unused.',
    'Translation key "list.1" is unused.',
    'Translation key "mixed.unused" is unused.',
    'Translation subtree "single" is unused.',
    'Translation subtree "spreadComplete" is unused.',
    'Translation key "spreadMixed" is unused.',
    'Translation key "spreadMixed.unused" is unused.'
  ]);
  const complete = result[0];
  assert.match(
    complete.file.text.slice(complete.start, complete.start + complete.length),
    /^complete: \{[\s\S]*second: 'Second'[\s\S]*\}$/
  );
  assert.ok(result.every(({ category }) => category === ts.DiagnosticCategory.Error));
});
