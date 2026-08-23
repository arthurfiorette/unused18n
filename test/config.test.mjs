import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ConfigFileError, loadConfig } from '../dist/config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = path.join(root, 'test/fixtures/config');
const cli = path.join(root, 'bin/run.js');

test('loads .unused18nrc and resolves configured paths from its directory', () => {
  const loaded = loadConfig(undefined, fixture);

  assert.equal(loaded.fileName, path.join(fixture, '.unused18nrc'));
  assert.equal(loaded.config.project, path.join(fixture, 'project/tsconfig.json'));
  assert.equal(loaded.config.dictionary, path.join(fixture, 'project/dictionary.ts'));
  assert.equal(loaded.config.cache, false);
  assert.equal(loaded.config.cacheStats, true);
});

test('ignores only a missing implicit config', () => {
  assert.deepEqual(loadConfig(undefined, path.join(fixture, 'project')), { config: {} });
  assert.throws(
    () => loadConfig('missing.json', fixture),
    (error) => error instanceof ConfigFileError && /Cannot read config/.test(error.message)
  );
});

test('rejects malformed, unknown, and invalid config values', () => {
  assert.throws(() => loadConfig('malformed.txt', fixture), /Cannot parse config/);
  assert.throws(() => loadConfig('invalid-unknown.json', fixture), /unknown option "unknown"/);
  assert.throws(
    () => loadConfig('invalid-value.json', fixture),
    /invalid value for "maxExpansions"/
  );
});

test('generated schema documents every config field and rejects unknown properties', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'schema.json'), 'utf8'));
  const definition = schema.definitions?.Unused18nConfig;

  assert.equal(definition?.additionalProperties, false);
  assert.deepEqual(Object.keys(definition?.properties ?? {}).sort(), [
    '$schema',
    'cache',
    'cacheDir',
    'cacheStats',
    'dictionary',
    'dictionaryExport',
    'maxExpansions',
    'project',
    'remove'
  ]);
  assert.equal(definition?.properties?.dictionaryExport?.default, 'default');
  assert.equal(definition?.properties?.maxExpansions?.default, 1000);
  assert.equal(definition?.properties?.project?.minLength, 1);
  assert.deepEqual(definition?.properties?.$schema?.examples, [
    './node_modules/unused18n/schema.json'
  ]);
});

test('CLI discovers config, honors config-relative paths, and lets flags override it', () => {
  const discovered = spawnSync(process.execPath, [cli], { cwd: fixture, encoding: 'utf8' });
  assert.equal(discovered.status, 1);
  assert.match(discovered.stderr, /Translation key "configUnused" is unused/);
  assert.match(discovered.stderr, /\[cache\] bypass \(disabled\)/);

  const explicit = spawnSync(
    process.execPath,
    [cli, `--config=${path.join(fixture, '.unused18nrc')}`],
    { cwd: root, encoding: 'utf8' }
  );
  assert.equal(explicit.status, 1);
  assert.match(explicit.stderr, /Translation key "configUnused" is unused/);

  const overridden = spawnSync(
    process.execPath,
    [
      cli,
      `--config=${path.join(fixture, '.unused18nrc')}`,
      `--dictionary=${path.join(fixture, 'project/override.ts')}`,
      '--no-cache',
      '--no-cache-stats'
    ],
    { cwd: root, encoding: 'utf8' }
  );
  assert.equal(overridden.status, 1);
  assert.match(overridden.stderr, /Translation key "overrideUnused" is unused/);
  assert.doesNotMatch(overridden.stderr, /configUnused/);
  assert.doesNotMatch(overridden.stderr, /\[cache\]/);
});

test('CLI can disable destructive boolean options from config', () => {
  const dictionary = path.join(fixture, 'project/dictionary.ts');
  const before = fs.readFileSync(dictionary, 'utf8');
  const result = spawnSync(
    process.execPath,
    [cli, `--config=${path.join(fixture, 'remove.json')}`, '--no-remove'],
    { cwd: root, encoding: 'utf8' }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Translation key "configUnused" is unused/);
  assert.equal(fs.readFileSync(dictionary, 'utf8'), before);
});

test('CLI reports config and merged required-option failures as argument errors', () => {
  const missingConfig = spawnSync(process.execPath, [cli, '--config=missing.json'], {
    cwd: fixture,
    encoding: 'utf8'
  });
  assert.equal(missingConfig.status, 2);
  assert.match(missingConfig.stderr, /Cannot read config/);

  const missingOptions = spawnSync(process.execPath, [cli], {
    cwd: path.join(fixture, 'project'),
    encoding: 'utf8'
  });
  assert.equal(missingOptions.status, 2);
  assert.match(missingOptions.stderr, /Missing required option.*project/);
});

test('npm package includes the generated schema at the documented path', () => {
  const packed = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.equal(packed.status, 0, packed.stderr);
  const manifest = JSON.parse(packed.stdout);
  assert.ok(manifest[0]?.files?.some(({ path: fileName }) => fileName === 'schema.json'));
});
