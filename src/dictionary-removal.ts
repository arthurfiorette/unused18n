import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ts from '@typescript/typescript6';
import type {
  DictionaryInfo,
  DictionaryKeySource,
  DictionaryRemovalBarrier,
  DictionarySourceProperty
} from './dictionary.js';

/** A source range whose exact original text must still match before application. */
export interface DictionaryRemovalEdit {
  /** Absolute or program-provided path of the source file to update. */
  readonly fileName: string;
  /** Inclusive character offset in the planned source text. */
  readonly start: number;
  /** Exclusive character offset in the planned source text. */
  readonly end: number;
  /** Stale-plan guard that must match before any temporary output is written. */
  readonly expectedText: string;
}

/** An immutable set of validated, non-overlapping source edits. */
export interface DictionaryRemovalPlan {
  /** Non-overlapping deletion ranges, ordered by file position. */
  readonly edits: readonly DictionaryRemovalEdit[];
  /** Requested active keys covered by the deletion ranges. */
  readonly removedKeys: ReadonlySet<string>;
}

/** Why a requested active key cannot be removed without changing unrelated behavior. */
export interface DictionaryRemovalFailure {
  /** Active flattened key for which no safe source boundary exists. */
  readonly key: string;
  /** Deduplicated conditions encountered along the key's source path. */
  readonly barriers: readonly DictionaryRemovalBarrier[];
}

/** The all-or-nothing result of read-only dictionary removal planning. */
export type DictionaryRemovalPlanResult =
  | { readonly ok: true; readonly plan: DictionaryRemovalPlan }
  | { readonly ok: false; readonly failures: readonly DictionaryRemovalFailure[] };

type PropertyCoverage = Map<ts.ObjectLiteralElementLike, { total: number; unused: number }>;

/**
 * Plans safe source removals without mutating the AST or filesystem.
 *
 * Planning fails as a whole when any requested active key has no safe property boundary. Unknown
 * keys are ignored because they are not active dictionary descendants.
 */
export function planDictionaryRemoval(
  dictionary: DictionaryInfo,
  unusedKeys: ReadonlySet<string>
): DictionaryRemovalPlanResult {
  const activeUnusedKeys = new Set([...unusedKeys].filter((key) => dictionary.keySources.has(key)));
  const coverage = propertyCoverage(dictionary.keySources, activeUnusedKeys);
  const selectedProperties = new Map<ts.ObjectLiteralElementLike, DictionarySourceProperty>();
  const failures: DictionaryRemovalFailure[] = [];

  for (const key of activeUnusedKeys) {
    const source = dictionary.keySources.get(key);
    if (!source) continue;
    const candidate = source.propertyChain.find((property) => {
      const count = coverage.get(property.node);
      return (
        property.barriers.every((barrier) => barrier === 'array') &&
        isSupportedProperty(property.node) &&
        count?.total === count?.unused
      );
    });
    if (candidate) {
      selectedProperties.set(candidate.node, candidate);
      continue;
    }
    failures.push({
      key,
      barriers: uniqueBarriers(source.propertyChain)
    });
  }

  if (failures.length > 0) return { ok: false, failures };

  const sourceFile = dictionary.sourceFile;
  const edits = editsForProperties(sourceFile, new Set(selectedProperties.keys()));
  return {
    ok: true,
    plan: {
      edits,
      removedKeys: activeUnusedKeys
    }
  };
}

/**
 * Applies a complete plan only when every source slice still matches its planned contents.
 *
 * Files are prepared in memory first and replaced through sibling temporary files so stale plans
 * never cause partial edits within a source file.
 */
export function applyDictionaryRemoval(plan: DictionaryRemovalPlan): void {
  const editsByFile = validateAndGroupEdits(plan.edits);
  const outputs = new Map<string, string>();

  for (const [fileName, edits] of editsByFile) {
    const sourceText = fs.readFileSync(fileName, 'utf8');
    const chunks: string[] = [];
    let cursor = 0;
    for (const edit of edits) {
      if (edit.end > sourceText.length) {
        throw new Error(`Dictionary removal edit is out of bounds: ${fileName}`);
      }
      if (sourceText.slice(edit.start, edit.end) !== edit.expectedText) {
        throw new Error(`Dictionary source changed after removal was planned: ${fileName}`);
      }
      chunks.push(sourceText.slice(cursor, edit.start));
      cursor = edit.end;
    }
    chunks.push(sourceText.slice(cursor));
    outputs.set(fileName, chunks.join(''));
  }

  const temporaryFiles = new Map<string, string>();
  const backupFiles = new Map<string, string>();
  const installed = new Set<string>();
  let committed = false;
  try {
    for (const [fileName, output] of outputs) {
      const temporaryFile = `${fileName}.unused18n-${randomUUID()}.tmp`;
      fs.writeFileSync(temporaryFile, output, {
        encoding: 'utf8',
        mode: fs.statSync(fileName).mode,
        flag: 'wx'
      });
      temporaryFiles.set(fileName, temporaryFile);
    }
    // Backups make ordinary multi-file commit failures reversible after every output is staged.
    for (const fileName of temporaryFiles.keys()) {
      const backupFile = `${fileName}.unused18n-${randomUUID()}.bak`;
      fs.renameSync(fileName, backupFile);
      backupFiles.set(fileName, backupFile);
    }
    for (const [fileName, temporaryFile] of temporaryFiles) {
      fs.renameSync(temporaryFile, fileName);
      installed.add(fileName);
    }
    committed = true;
    for (const backupFile of backupFiles.values()) {
      try {
        fs.unlinkSync(backupFile);
      } catch {
        // A committed destination remains authoritative; a leftover backup is safer than rollback.
      }
    }
  } catch (error) {
    for (const fileName of installed) {
      if (fs.existsSync(fileName)) fs.unlinkSync(fileName);
    }
    const restoreErrors: unknown[] = [];
    for (const [fileName, backupFile] of [...backupFiles].reverse()) {
      try {
        if (fs.existsSync(backupFile)) fs.renameSync(backupFile, fileName);
      } catch (restoreError) {
        restoreErrors.push(restoreError);
      }
    }
    if (restoreErrors.length > 0)
      throw new AggregateError([error, ...restoreErrors], 'Dictionary rollback failed');
    throw error;
  } finally {
    for (const temporaryFile of temporaryFiles.values()) {
      if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
    }
    if (committed) {
      for (const backupFile of backupFiles.values()) {
        try {
          if (fs.existsSync(backupFile)) fs.unlinkSync(backupFile);
        } catch {
          // Preserve the successfully installed output even when backup cleanup is unavailable.
        }
      }
    }
  }
}

/** Canonicalizes deletion ranges before any destination or temporary file is touched. */
export function validateAndGroupEdits(
  edits: readonly DictionaryRemovalEdit[]
): Map<string, DictionaryRemovalEdit[]> {
  const editsByFile = new Map<string, DictionaryRemovalEdit[]>();
  for (const edit of edits) {
    if (
      !Number.isSafeInteger(edit.start) ||
      !Number.isSafeInteger(edit.end) ||
      edit.start < 0 ||
      edit.end < edit.start
    ) {
      throw new Error(`Dictionary removal edit has an invalid range: ${edit.fileName}`);
    }
    const fileName = path.resolve(edit.fileName);
    const fileEdits = editsByFile.get(fileName);
    if (fileEdits) fileEdits.push(edit);
    else editsByFile.set(fileName, [edit]);
  }

  for (const [fileName, fileEdits] of editsByFile) {
    fileEdits.sort((left, right) => left.start - right.start || left.end - right.end);
    const normalized: DictionaryRemovalEdit[] = [];
    for (const edit of fileEdits) {
      const previous = normalized.at(-1);
      if (previous?.start === edit.start && previous.end === edit.end) {
        if (previous.expectedText !== edit.expectedText) {
          throw new Error(`Dictionary removal edits disagree for the same range: ${fileName}`);
        }
        continue;
      }
      if (previous && edit.start < previous.end) {
        throw new Error(`Dictionary removal edits overlap: ${fileName}`);
      }
      normalized.push(edit);
    }
    editsByFile.set(fileName, normalized);
  }
  return editsByFile;
}

function propertyCoverage(
  keySources: ReadonlyMap<string, DictionaryKeySource>,
  unusedKeys: ReadonlySet<string>
): PropertyCoverage {
  const coverage: PropertyCoverage = new Map();
  for (const [key, source] of keySources) {
    for (const property of source.propertyChain) {
      const count = coverage.get(property.node) ?? { total: 0, unused: 0 };
      count.total += 1;
      if (unusedKeys.has(key)) count.unused += 1;
      coverage.set(property.node, count);
    }
  }
  return coverage;
}

function uniqueBarriers(
  propertyChain: readonly DictionarySourceProperty[]
): DictionaryRemovalBarrier[] {
  return [...new Set(propertyChain.flatMap((property) => property.barriers))];
}

function isSupportedProperty(
  node: ts.ObjectLiteralElementLike
): node is ts.PropertyAssignment | ts.ShorthandPropertyAssignment {
  return ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node);
}

function editsForProperties(
  sourceFile: ts.SourceFile,
  selected: ReadonlySet<ts.ObjectLiteralElementLike>
): DictionaryRemovalEdit[] {
  const edits: DictionaryRemovalEdit[] = [];
  const parents = new Set<ts.ObjectLiteralExpression>();
  for (const property of selected) {
    if (!ts.isObjectLiteralExpression(property.parent)) {
      throw new Error('Dictionary property is not inside an object literal');
    }
    parents.add(property.parent);
  }

  for (const parent of parents) {
    const properties = [...parent.properties];
    let index = 0;
    while (index < properties.length) {
      if (!selected.has(properties[index]!)) {
        index += 1;
        continue;
      }
      const first = index;
      while (index + 1 < properties.length && selected.has(properties[index + 1]!)) index += 1;
      const last = index;
      const range = removalRange(sourceFile, properties, first, last);
      edits.push({
        fileName: sourceFile.fileName,
        start: range.start,
        end: range.end,
        expectedText: sourceFile.text.slice(range.start, range.end)
      });
      index += 1;
    }
  }

  return edits.sort((left, right) => left.start - right.start);
}

function removalRange(
  sourceFile: ts.SourceFile,
  properties: readonly ts.ObjectLiteralElementLike[],
  first: number,
  last: number
): { start: number; end: number } {
  const firstProperty = properties[first]!;
  const lastProperty = properties[last]!;
  const nextProperty = properties[last + 1];
  if (nextProperty) {
    return {
      start: firstProperty.getFullStart(),
      end: commaBetween(sourceFile, lastProperty.end, nextProperty.getStart(sourceFile)).end
    };
  }

  const previousProperty = properties[first - 1];
  if (previousProperty) {
    return {
      start: commaBetween(sourceFile, previousProperty.end, firstProperty.getStart(sourceFile))
        .start,
      end: lastProperty.end
    };
  }

  const parent = firstProperty.parent;
  const trailingComma = ts.isObjectLiteralExpression(parent)
    ? findCommaBetween(sourceFile, lastProperty.end, parent.end)
    : undefined;
  return {
    start: firstProperty.getFullStart(),
    end: trailingComma?.end ?? lastProperty.end
  };
}

function commaBetween(
  sourceFile: ts.SourceFile,
  start: number,
  end: number
): { start: number; end: number } {
  const comma = findCommaBetween(sourceFile, start, end);
  if (comma) return comma;
  throw new Error('Expected a comma between dictionary properties');
}

function findCommaBetween(
  sourceFile: ts.SourceFile,
  start: number,
  end: number
): { start: number; end: number } | undefined {
  const scanner = ts.createScanner(
    sourceFile.languageVersion,
    true,
    sourceFile.languageVariant,
    sourceFile.text
  );
  scanner.setTextPos(start);
  while (scanner.getTextPos() < end) {
    const token = scanner.scan();
    if (token === ts.SyntaxKind.CommaToken) {
      return { start: scanner.getTokenPos(), end: scanner.getTextPos() };
    }
    if (token === ts.SyntaxKind.EndOfFileToken) break;
  }
  return undefined;
}
