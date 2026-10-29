import fs from 'node:fs';
import { API } from 'typescript/sync';
import { Semantic } from '../dist/semantic.js';

/**
 * Opens a TypeScript 7 program over explicit root files and closes its compiler process when
 * the test ends.
 *
 * @param {import('node:test').TestContext} t Owning test; cleanup runs in `t.after`.
 * @param {string[]} rootNames Absolute root file paths.
 * @param {import('typescript/sync').CompilerOptions} [compilerOptions]
 * @param {import('typescript/sync').APIOptions} [apiOptions] For example `collectTiming` when a
 *   test counts wire requests.
 */
export function openProgram(t, rootNames, compilerOptions = {}, apiOptions = {}) {
  const api = new API(apiOptions);
  t.after(() => api.close());
  const program = api.createProgram(rootNames, compilerOptions);
  return { api, program, semantic: new Semantic(api, program) };
}

/**
 * Parses one in-memory source file without building a program. The file is parsed by the
 * compiler process, so it is retained there until the test ends.
 *
 * @param {import('node:test').TestContext} t Owning test; cleanup runs in `t.after`.
 * @param {string} fileName Its extension selects the script kind, e.g. `.tsx` for JSX.
 * @param {string} text Source text.
 */
export function parseSource(t, fileName, text) {
  const api = new API();
  t.after(() => api.close());
  return api.createSourceFile(fileName, text).sourceFile;
}

/**
 * Returns the source text a diagnostic covers. Diagnostics carry no source file, so the file is
 * read from disk; call this before anything rewrites the file.
 *
 * @param {import('typescript/sync').Diagnostic} diagnostic A diagnostic with a `fileName`.
 */
export function diagnosticSource(diagnostic) {
  if (!diagnostic.fileName) throw new Error(`Diagnostic ${diagnostic.code} has no file`);
  return fs.readFileSync(diagnostic.fileName, 'utf8').slice(diagnostic.pos, diagnostic.end);
}
