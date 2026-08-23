import { globSync, statSync } from 'node:fs';
import path from 'node:path';

export interface DictionaryTarget {
  id: string;
  path: string;
  exportName: string;
  locale: string;
}

/** Expands once before project creation so compiler roots, cache identity, and diagnostics agree. */
export function resolveDictionaryTargets(
  patterns: string | readonly string[],
  exportName: string,
  cwd = process.cwd()
): DictionaryTarget[] {
  const values = typeof patterns === 'string' ? [patterns] : patterns;
  const files = new Set<string>();
  for (const pattern of values) {
    for (const match of globSync(pattern, { cwd })) {
      const fileName = path.resolve(cwd, match);
      if (statSync(fileName).isFile()) files.add(fileName);
    }
  }
  const paths = [...files].sort(comparePaths);
  if (paths.length === 0) {
    throw new Error(`No dictionaries matched: ${values.join(', ')}`);
  }
  return paths.map((fileName) => ({
    id: `${fileName}\0${exportName}`,
    path: fileName,
    exportName,
    locale: path.basename(fileName, path.extname(fileName))
  }));
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
