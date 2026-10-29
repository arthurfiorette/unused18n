import type { Node, SourceFile } from 'typescript/ast';
import type { Diagnostic, DiagnosticCategory } from 'typescript/sync';

/** Code prefix printed by TypeScript's formatters, e.g. `error U18N95001: ...`. */
const DIAGNOSTIC_SOURCE = 'U18N';

/**
 * Creates an unused18n diagnostic covering `[start, end)` in `sourceFile`.
 *
 * Diagnostics are plain data so they remain valid after the compiler process exits. Positions,
 * line/character pairs and the covered source lines are precomputed because TypeScript's
 * formatter renders code frames only from these fields and never reads the file itself.
 */
export function diagnosticAt(
  sourceFile: SourceFile,
  start: number,
  end: number,
  code: number,
  category: DiagnosticCategory,
  text: string
): Diagnostic {
  const startPosition = sourceFile.getLineAndCharacterOfPosition(start);
  const endPosition = sourceFile.getLineAndCharacterOfPosition(end);
  const sourceLines = [];
  for (let line = startPosition.line; line <= endPosition.line; line += 1) {
    sourceLines.push({ line, text: lineText(sourceFile, line) });
  }
  return {
    fileName: sourceFile.fileName,
    pos: start,
    end,
    startPosition,
    endPosition,
    sourceLines,
    code,
    category,
    source: DIAGNOSTIC_SOURCE,
    text
  };
}

/** Creates an unused18n diagnostic spanning a node's text, excluding leading trivia. */
export function diagnosticAtNode(
  node: Node,
  code: number,
  category: DiagnosticCategory,
  text: string
): Diagnostic {
  const sourceFile = node.getSourceFile();
  return diagnosticAt(sourceFile, node.getStart(sourceFile), node.end, code, category, text);
}

/** Creates an unused18n diagnostic that is not attached to any file, such as a config failure. */
export function diagnosticWithoutFile(
  code: number,
  category: DiagnosticCategory,
  text: string
): Diagnostic {
  return { pos: 0, end: 0, code, category, source: DIAGNOSTIC_SOURCE, text };
}

/**
 * Joins a diagnostic message and its nested message chain into one string, indenting each
 * level by two spaces so thrown errors keep the compiler's explanation hierarchy.
 */
export function flattenDiagnosticText(diagnostic: Diagnostic, newLine = '\n'): string {
  const lines: string[] = [];
  /** Appends one line per chain entry, depth first, so nested reasons follow their parent. */
  function visit(current: Diagnostic, depth: number): void {
    lines.push(`${'  '.repeat(depth)}${current.text}`);
    for (const child of current.messageChain ?? []) visit(child, depth + 1);
  }
  visit(diagnostic, 0);
  return lines.join(newLine);
}

/** Returns the position just before the line break that ends the line containing `position`. */
export function lineEndOfPosition(sourceFile: SourceFile, position: number): number {
  const { line } = sourceFile.getLineAndCharacterOfPosition(position);
  return sourceFile.getPositionOfLineAndCharacter(line, 0) + lineText(sourceFile, line).length;
}

/** Returns the text of a 0-based line without its terminating line break. */
function lineText(sourceFile: SourceFile, line: number): string {
  const starts = sourceFile.getLineStarts();
  const start = starts[line] ?? sourceFile.text.length;
  const next = starts[line + 1] ?? sourceFile.text.length;
  // Line starts also split on U+2028 and U+2029, so those terminators are stripped as well.
  return sourceFile.text.slice(start, next).replace(/(?:\r\n|[\r\n\u2028\u2029])$/, '');
}
