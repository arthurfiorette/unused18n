import path from 'node:path';
import {
  type Expression,
  InternalSymbolName,
  isArrayLiteralExpression,
  isAsExpression,
  isComputedPropertyName,
  isExportAssignment,
  isExpression,
  isExpressionStatement,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNonNullExpression,
  isNumericLiteral,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPrivateIdentifier,
  isPropertyAssignment,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isStringLiteralLikeNode,
  isTypeAssertion,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralElementLike,
  type PropertyName,
  type ShorthandPropertyAssignment,
  type SourceFile,
  type VariableDeclaration
} from 'typescript/ast';
import type { Symbol as TsSymbol, Type } from 'typescript/sync';
import { ActiveDictionaryTree } from './dictionary-tree.js';
import type { Semantic } from './semantic.js';

/** A condition that prevents a source property from being removed without ambiguity. */
export type DictionaryRemovalBarrier =
  | 'array'
  | 'computed-property'
  | 'imported-declaration'
  | 'overwrite'
  | 'shared-source-property'
  | 'spread';

/** One property on the winning source path, ordered from the dictionary root to the leaf. */
export interface DictionarySourceProperty {
  /** The original AST node; removal never synthesizes or prints a replacement node. */
  readonly node: ObjectLiteralElementLike;
  /** The flattened prefix covered by removing this property. */
  readonly keyPrefix: string;
  /** Conditions that make this specific property boundary unsafe to remove. */
  readonly barriers: readonly DictionaryRemovalBarrier[];
}

/** Source provenance for the value currently visible at a flattened dictionary key. */
export interface DictionaryKeySource {
  /** The active leaf expression after object overwrite semantics have been applied. */
  readonly valueNode: Expression;
  /** Candidate removal boundaries from the dictionary root to the active leaf. */
  readonly propertyChain: readonly DictionarySourceProperty[];
}

/** The flattened dictionary and source provenance needed for read-only removal planning. */
export interface DictionaryInfo {
  readonly exportName: string;
  readonly sourceFile: SourceFile;
  readonly declaration: Node;
  readonly symbol: TsSymbol;
  /** Exported value type, preserving explicit shared dictionary aliases across locale files. */
  readonly declaredType: Type;
  /** Active flattened keys after spreads and later properties have overwritten earlier values. */
  readonly keys: ReadonlySet<string>;
  /** Active key provenance with the same overwrite semantics as {@link keys}. */
  readonly keySources: ReadonlyMap<string, DictionaryKeySource>;
}

/**
 * Resolves and flattens one exported dictionary while retaining active source provenance.
 *
 * @param semantic Checker facade of the program that contains the dictionary file.
 * @param dictionaryPath Dictionary module or JSON file, resolved against the working directory.
 * @param exportName Export to read; inferred from `default` or a sole value export when omitted.
 */
export function readDictionary(
  semantic: Semantic,
  dictionaryPath: string,
  exportName?: string
): DictionaryInfo {
  const absolutePath = path.resolve(dictionaryPath);
  const sourceFile = semantic.sourceFile(absolutePath);
  if (!sourceFile)
    throw new Error(`Dictionary is not part of the TypeScript program: ${absolutePath}`);

  let declaration: Node;
  let initializer: Expression;
  let symbol: TsSymbol;
  if (path.extname(absolutePath).toLowerCase() === '.json') {
    try {
      JSON.parse(sourceFile.text);
    } catch (error) {
      throw new Error(
        `Invalid JSON dictionary ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (exportName !== undefined && exportName !== 'default') {
      throw new Error(
        `JSON dictionaries only expose the "default" export; received "${exportName}"`
      );
    }
    const statement = sourceFile.statements.find(isExpressionStatement);
    // A JSON file binds one synthetic `export=` symbol, reachable only through the file symbol.
    const jsonSymbol = semantic.checker
      .getSymbolOfNode(sourceFile)
      ?.getExports()
      .get(InternalSymbolName.ExportEquals);
    if (!statement || !jsonSymbol) {
      throw new Error(`JSON dictionary could not be resolved: ${absolutePath}`);
    }
    declaration = statement;
    initializer = statement.expression;
    symbol = jsonSymbol;
    exportName = 'default';
  } else {
    const moduleSymbol = semantic.rawSymbol(sourceFile);
    const exports = moduleSymbol ? semantic.checker.getExportsOfModule(moduleSymbol) : [];
    // Only the handle's presence matters here, so it is never resolved.
    const valueExports = exports.filter(
      (candidate) => semantic.aliased(candidate)?.valueDeclaration
    );
    let exported =
      exportName !== undefined
        ? exports.find((candidate) => candidate.name === exportName)
        : valueExports.find((candidate) => candidate.name === 'default');
    if (exportName !== undefined && !exported)
      throw new Error(`Export "${exportName}" not found in ${absolutePath}`);
    if (exportName === undefined && !exported && valueExports.length === 1)
      exported = valueExports[0];
    if (!exported) {
      const names = valueExports.map(({ name }) => `"${name}"`).join(', ');
      throw new Error(
        valueExports.length === 0
          ? `Cannot infer dictionary export from ${absolutePath}: the module has no exports.`
          : `Cannot infer dictionary export from ${absolutePath}: multiple exports exist: ${names}. Pass --export=<name>.`
      );
    }
    exportName = exported.name;

    const resolvedSymbol = semantic.aliased(exported);
    const resolvedDeclarations = semantic.declarations(resolvedSymbol);
    const variableDeclaration = resolvedDeclarations.find(isVariableDeclaration);
    const exportAssignment = resolvedDeclarations.find(isExportAssignment);
    const resolvedDeclaration = variableDeclaration ?? exportAssignment;
    const resolvedInitializer = variableDeclaration?.initializer ?? exportAssignment?.expression;
    // TS 6 mapped an unresolvable alias to the declaration-less unknown symbol, which failed here
    // too; `aliased` returns `undefined` instead, so it joins the same error for parity.
    if (!resolvedSymbol || !resolvedDeclaration || !resolvedInitializer) {
      throw new Error(
        `Export "${exportName}" must resolve to an initialized dictionary expression`
      );
    }
    declaration = resolvedDeclaration;
    initializer = resolvedInitializer;
    symbol = resolvedSymbol;
  }

  const activeDictionary = new ActiveDictionaryTree();
  flattenExpression(initializer, [], [], activeDictionary, semantic, sourceFile, new Set(), false);
  const keySources = activeDictionary.toKeySources();
  if (keySources.size === 0 && !isDictionaryContainer(initializer, semantic, new Set())) {
    throw new Error(`Dictionary export "${exportName}" must resolve to an object or array`);
  }
  let declaredType: Type | undefined;

  return {
    exportName,
    sourceFile,
    declaration,
    symbol,
    get declaredType() {
      // Lazy because most analyses never compare dictionary types, and each query is an IPC call.
      if (!declaredType)
        declaredType = semantic.checker.getTypeOfSymbolAtLocation(symbol, declaration);
      return declaredType;
    },
    keys: new Set(keySources.keys()),
    keySources
  };
}

/** Returns whether an expression is, or names a variable initialized with, an object or array. */
function isDictionaryContainer(input: Expression, semantic: Semantic, seen: Set<Node>): boolean {
  const expression = unwrapExpression(input);
  if (seen.has(expression)) return false;
  seen.add(expression);
  try {
    if (isObjectLiteralExpression(expression) || isArrayLiteralExpression(expression)) return true;
    if (!isIdentifier(expression)) return false;
    const declaration = declarationForExpression(expression, semantic);
    return declaration?.initializer
      ? isDictionaryContainer(declaration.initializer, semantic, seen)
      : false;
  } finally {
    seen.delete(expression);
  }
}

/**
 * Records every leaf under `prefix` into `activeDictionary`, applying spread and overwrite order
 * and tagging each property on the path with the barriers that make its removal unsafe.
 */
function flattenExpression(
  input: Expression,
  prefix: string[],
  propertyChain: DictionarySourceProperty[],
  activeDictionary: ActiveDictionaryTree,
  semantic: Semantic,
  dictionarySourceFile: SourceFile,
  seen: Set<Node>,
  sharedSource: boolean
): void {
  const expression = unwrapExpression(input);
  if (seen.has(expression)) return;
  seen.add(expression);
  try {
    if (isIdentifier(expression)) {
      const declaration = declarationForExpression(expression, semantic);
      if (declaration?.initializer) {
        const imported = declaration.getSourceFile() !== dictionarySourceFile;
        flattenExpression(
          declaration.initializer,
          prefix,
          imported ? addBarrier(propertyChain, 'imported-declaration') : propertyChain,
          activeDictionary,
          semantic,
          dictionarySourceFile,
          seen,
          sharedSource || propertyChain.length > 0
        );
        return;
      }
    }

    if (isObjectLiteralExpression(expression)) {
      const encounteredNames = new Set<string>();
      let unresolvedSpreadBefore = false;
      for (const property of expression.properties) {
        if (isSpreadAssignment(property)) {
          const spreadNames = objectPropertyNames(property.expression, semantic, new Set());
          if (spreadNames) {
            for (const name of spreadNames) encounteredNames.add(name);
          } else {
            unresolvedSpreadBefore = true;
            activeDictionary.addBarrier(prefix, 'spread');
          }
          flattenExpression(
            property.expression,
            prefix,
            addBarrier(propertyChain, 'spread'),
            activeDictionary,
            semantic,
            dictionarySourceFile,
            seen,
            true
          );
          continue;
        }

        if (isPropertyAssignment(property)) {
          const name = propertyName(property.name, semantic);
          if (name === undefined) continue;
          prefix.push(name);
          try {
            const overwritten = encounteredNames.has(name) || activeDictionary.hasSubtree(prefix);
            encounteredNames.add(name);
            activeDictionary.deleteSubtree(prefix);
            let sourceProperty: DictionarySourceProperty = {
              node: property,
              keyPrefix: prefix.join('.'),
              barriers: sourceBarriers(property, dictionarySourceFile, sharedSource)
            };
            const computed = isComputedPropertyName(property.name);
            if (computed) sourceProperty = withBarrier(sourceProperty, 'computed-property');
            if (overwritten) sourceProperty = withBarrier(sourceProperty, 'overwrite');
            if (unresolvedSpreadBefore) sourceProperty = withBarrier(sourceProperty, 'spread');
            const nextPropertyChain = [...propertyChain, sourceProperty];
            flattenExpression(
              property.initializer,
              prefix,
              computed ? addBarrier(nextPropertyChain, 'computed-property') : nextPropertyChain,
              activeDictionary,
              semantic,
              dictionarySourceFile,
              seen,
              sharedSource
            );
          } finally {
            prefix.pop();
          }
          continue;
        }

        if (isShorthandPropertyAssignment(property)) {
          // The parser only builds identifier names here, but the 7.1 type admits any PropertyName.
          if (!isIdentifier(property.name)) continue;
          const name = property.name.text;
          prefix.push(name);
          try {
            const overwritten = encounteredNames.has(name) || activeDictionary.hasSubtree(prefix);
            encounteredNames.add(name);
            activeDictionary.deleteSubtree(prefix);
            let sourceProperty: DictionarySourceProperty = {
              node: property,
              keyPrefix: prefix.join('.'),
              barriers: sourceBarriers(property, dictionarySourceFile, sharedSource)
            };
            if (overwritten) sourceProperty = withBarrier(sourceProperty, 'overwrite');
            if (unresolvedSpreadBefore) sourceProperty = withBarrier(sourceProperty, 'spread');
            const declaration = declarationForShorthand(property, semantic);
            if (declaration?.initializer) {
              const imported = declaration.getSourceFile() !== dictionarySourceFile;
              const nextPropertyChain = [...propertyChain, sourceProperty];
              flattenExpression(
                declaration.initializer,
                prefix,
                imported
                  ? addBarrier(nextPropertyChain, 'imported-declaration')
                  : nextPropertyChain,
                activeDictionary,
                semantic,
                dictionarySourceFile,
                seen,
                true
              );
            } else {
              flattenExpression(
                property.name,
                prefix,
                [...propertyChain, sourceProperty],
                activeDictionary,
                semantic,
                dictionarySourceFile,
                seen,
                sharedSource
              );
            }
          } finally {
            prefix.pop();
          }
        }
      }
      return;
    }

    if (isArrayLiteralExpression(expression)) {
      const blockedChain = addBarrier(propertyChain, 'array');
      for (let index = 0; index < expression.elements.length; index += 1) {
        const element = expression.elements[index];
        if (!element || !isExpression(element)) continue;
        prefix.push(String(index));
        try {
          flattenExpression(
            element,
            prefix,
            blockedChain,
            activeDictionary,
            semantic,
            dictionarySourceFile,
            seen,
            sharedSource
          );
          activeDictionary.addBarrier(prefix, 'array');
        } finally {
          prefix.pop();
        }
      }
      return;
    }

    if (prefix.length > 0) {
      activeDictionary.set(prefix, {
        valueNode: expression,
        propertyChain
      });
    }
  } finally {
    seen.delete(expression);
  }
}

/** Returns the statically known member names of an object, or `undefined` when any is unknown. */
function objectPropertyNames(
  input: Expression,
  semantic: Semantic,
  seen: Set<Node>
): Set<string> | undefined {
  const expression = unwrapExpression(input);
  if (seen.has(expression)) return undefined;
  seen.add(expression);
  if (isIdentifier(expression)) {
    const declaration = declarationForExpression(expression, semantic);
    return declaration?.initializer
      ? objectPropertyNames(declaration.initializer, semantic, seen)
      : undefined;
  }
  if (!isObjectLiteralExpression(expression)) return undefined;

  const names = new Set<string>();
  for (const property of expression.properties) {
    if (isSpreadAssignment(property)) {
      const spreadNames = objectPropertyNames(property.expression, semantic, new Set(seen));
      if (!spreadNames) return undefined;
      for (const name of spreadNames) names.add(name);
      continue;
    }
    if (
      isPropertyAssignment(property) ||
      isShorthandPropertyAssignment(property) ||
      isMethodDeclaration(property) ||
      isGetAccessorDeclaration(property) ||
      isSetAccessorDeclaration(property)
    ) {
      const name = propertyName(property.name, semantic);
      if (name === undefined) return undefined;
      names.add(name);
    }
  }
  return names;
}

function addBarrier(
  propertyChain: readonly DictionarySourceProperty[],
  barrier: DictionaryRemovalBarrier
): DictionarySourceProperty[] {
  return propertyChain.map((property) => withBarrier(property, barrier));
}

function withBarrier(
  property: DictionarySourceProperty,
  barrier: DictionaryRemovalBarrier
): DictionarySourceProperty {
  return property.barriers.includes(barrier)
    ? property
    : { ...property, barriers: [...property.barriers, barrier] };
}

function sourceBarriers(
  property: ObjectLiteralElementLike,
  dictionarySourceFile: SourceFile,
  sharedSource: boolean
): DictionaryRemovalBarrier[] {
  const barriers: DictionaryRemovalBarrier[] = [];
  if (sharedSource) barriers.push('shared-source-property');
  if (property.getSourceFile() !== dictionarySourceFile) barriers.push('imported-declaration');
  return barriers;
}

/** Returns the static name of an object member, reading computed names from literal types. */
function propertyName(name: PropertyName, semantic: Semantic): string | undefined {
  if (isIdentifier(name) || isPrivateIdentifier(name)) return name.text;
  if (isStringLiteralLikeNode(name) || isNumericLiteral(name)) return name.text;
  if (isComputedPropertyName(name)) {
    const type = semantic.typeAt(name.expression);
    if (type.isStringLiteralType() || type.isNumberLiteralType()) return String(type.value);
  }
  return undefined;
}

/** Returns the variable declaration an identifier refers to, following import aliases. */
function declarationForExpression(
  expression: Expression,
  semantic: Semantic
): VariableDeclaration | undefined {
  const symbol = semantic.aliased(semantic.rawSymbol(expression));
  return semantic.declarations(symbol).find(isVariableDeclaration);
}

/** Returns the variable declaration a shorthand property reads, following import aliases. */
function declarationForShorthand(
  property: ShorthandPropertyAssignment,
  semantic: Semantic
): VariableDeclaration | undefined {
  const symbol = semantic.aliased(semantic.shorthandValueSymbol(property));
  return semantic.declarations(symbol).find(isVariableDeclaration);
}

/** Removes transparent TypeScript expression wrappers without changing the underlying AST. */
export function unwrapExpression(expression: Expression): Expression {
  let current = expression;
  while (
    isParenthesizedExpression(current) ||
    isAsExpression(current) ||
    isTypeAssertion(current) ||
    isNonNullExpression(current) ||
    isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}
