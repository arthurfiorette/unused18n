import path from 'node:path';
import ts from '@typescript/typescript6';

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
  readonly node: ts.ObjectLiteralElementLike;
  /** The flattened prefix covered by removing this property. */
  readonly keyPrefix: string;
  /** Conditions that make this specific property boundary unsafe to remove. */
  readonly barriers: readonly DictionaryRemovalBarrier[];
}

/** Source provenance for the value currently visible at a flattened dictionary key. */
export interface DictionaryKeySource {
  /** The active leaf expression after object overwrite semantics have been applied. */
  readonly valueNode: ts.Expression;
  /** Candidate removal boundaries from the dictionary root to the active leaf. */
  readonly propertyChain: readonly DictionarySourceProperty[];
}

/** The flattened dictionary and source provenance needed for read-only removal planning. */
export interface DictionaryInfo {
  readonly exportName: string;
  readonly sourceFile: ts.SourceFile;
  readonly declaration: ts.Node;
  readonly symbol: ts.Symbol;
  readonly type: ts.Type;
  /** Active flattened keys after spreads and later properties have overwritten earlier values. */
  readonly keys: ReadonlySet<string>;
  /** Active key provenance with the same overwrite semantics as {@link keys}. */
  readonly keySources: ReadonlyMap<string, DictionaryKeySource>;
}

/** Resolves and flattens one exported dictionary while retaining active source provenance. */
export function readDictionary(
  program: ts.Program,
  checker: ts.TypeChecker,
  dictionaryPath: string,
  exportName?: string
): DictionaryInfo {
  const absolutePath = path.resolve(dictionaryPath);
  const sourceFile = program
    .getSourceFiles()
    .find((source) => path.resolve(source.fileName) === absolutePath);
  if (!sourceFile)
    throw new Error(`Dictionary is not part of the TypeScript program: ${absolutePath}`);

  let declaration: ts.Node;
  let initializer: ts.Expression;
  let symbol: ts.Symbol;
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
    const statement = sourceFile.statements.find(ts.isExpressionStatement);
    // TypeScript binds JSON's synthetic `export=` here but omits the field from its public type.
    const sourceSymbol = (sourceFile as ts.SourceFile & { readonly symbol?: ts.Symbol }).symbol;
    const jsonSymbol = sourceSymbol?.exports?.get(ts.InternalSymbolName.ExportEquals);
    if (!statement || !jsonSymbol) {
      throw new Error(`JSON dictionary could not be resolved: ${absolutePath}`);
    }
    declaration = statement;
    initializer = statement.expression;
    symbol = jsonSymbol;
    exportName = 'default';
  } else {
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    const exports = moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : [];
    let exported =
      exportName !== undefined
        ? exports.find((candidate) => candidate.name === exportName)
        : exports.find((candidate) => candidate.name === 'default');
    if (exportName !== undefined && !exported)
      throw new Error(`Export "${exportName}" not found in ${absolutePath}`);
    if (exportName === undefined && !exported && exports.length === 1) exported = exports[0];
    if (!exported) {
      const names = exports.map(({ name }) => `"${name}"`).join(', ');
      throw new Error(
        exports.length === 0
          ? `Cannot infer dictionary export from ${absolutePath}: the module has no exports.`
          : `Cannot infer dictionary export from ${absolutePath}: multiple exports exist: ${names}. Pass --export=<name>.`
      );
    }
    exportName = exported.name;

    const resolvedSymbol = unwrapAlias(checker, exported);
    if (!resolvedSymbol) throw new Error(`Export "${exportName}" could not be resolved`);
    const variableDeclaration = resolvedSymbol.declarations?.find(ts.isVariableDeclaration);
    const exportAssignment = resolvedSymbol.declarations?.find(ts.isExportAssignment);
    const resolvedDeclaration = variableDeclaration ?? exportAssignment;
    const resolvedInitializer = variableDeclaration?.initializer ?? exportAssignment?.expression;
    if (!resolvedDeclaration || !resolvedInitializer) {
      throw new Error(
        `Export "${exportName}" must resolve to an initialized dictionary expression`
      );
    }
    declaration = resolvedDeclaration;
    initializer = resolvedInitializer;
    symbol = resolvedSymbol;
  }

  const keySources = new Map<string, DictionaryKeySource>();
  flattenExpression(initializer, [], [], keySources, checker, sourceFile, new Set(), false);
  if (keySources.size === 0 && !isDictionaryContainer(initializer, checker, new Set())) {
    throw new Error(`Dictionary export "${exportName}" must resolve to an object or array`);
  }

  return {
    exportName,
    sourceFile,
    declaration,
    symbol,
    type: checker.getTypeAtLocation(initializer),
    keys: new Set(keySources.keys()),
    keySources
  };
}

function isDictionaryContainer(
  input: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Node>
): boolean {
  const expression = unwrapExpression(input);
  if (seen.has(expression)) return false;
  seen.add(expression);
  if (ts.isObjectLiteralExpression(expression) || ts.isArrayLiteralExpression(expression))
    return true;
  if (!ts.isIdentifier(expression)) return false;
  const declaration = declarationForExpression(expression, checker);
  return declaration?.initializer
    ? isDictionaryContainer(declaration.initializer, checker, seen)
    : false;
}

function flattenExpression(
  input: ts.Expression,
  prefix: string[],
  propertyChain: DictionarySourceProperty[],
  keySources: Map<string, DictionaryKeySource>,
  checker: ts.TypeChecker,
  dictionarySourceFile: ts.SourceFile,
  seen: Set<ts.Node>,
  sharedSource: boolean
): void {
  const expression = unwrapExpression(input);
  if (seen.has(expression)) return;
  seen.add(expression);

  if (ts.isIdentifier(expression)) {
    const declaration = declarationForExpression(expression, checker);
    if (declaration?.initializer) {
      const imported = declaration.getSourceFile() !== dictionarySourceFile;
      flattenExpression(
        declaration.initializer,
        prefix,
        imported ? addBarrier(propertyChain, 'imported-declaration') : propertyChain,
        keySources,
        checker,
        dictionarySourceFile,
        seen,
        sharedSource || propertyChain.length > 0
      );
      return;
    }
  }

  if (ts.isObjectLiteralExpression(expression)) {
    const encounteredPrefixes = new Set<string>();
    let unresolvedSpreadBefore = false;
    for (const property of expression.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spreadNames = objectPropertyNames(property.expression, checker, new Set());
        if (spreadNames) {
          for (const name of spreadNames) encounteredPrefixes.add([...prefix, name].join('.'));
        } else {
          unresolvedSpreadBefore = true;
          addBarrierToSubtree(keySources, prefix.join('.'), 'spread');
        }
        flattenExpression(
          property.expression,
          prefix,
          addBarrier(propertyChain, 'spread'),
          keySources,
          checker,
          dictionarySourceFile,
          new Set(seen),
          true
        );
        continue;
      }

      if (ts.isPropertyAssignment(property)) {
        const name = propertyName(property.name, checker);
        if (name === undefined) continue;
        const propertyPrefix = [...prefix, name];
        const keyPrefix = propertyPrefix.join('.');
        const overwritten = encounteredPrefixes.has(keyPrefix) || hasSubtree(keySources, keyPrefix);
        encounteredPrefixes.add(keyPrefix);
        deleteSubtree(keySources, keyPrefix);
        let sourceProperty: DictionarySourceProperty = {
          node: property,
          keyPrefix,
          barriers: sourceBarriers(property, dictionarySourceFile, sharedSource)
        };
        const computed = ts.isComputedPropertyName(property.name);
        if (computed) sourceProperty = withBarrier(sourceProperty, 'computed-property');
        if (overwritten) sourceProperty = withBarrier(sourceProperty, 'overwrite');
        if (unresolvedSpreadBefore) sourceProperty = withBarrier(sourceProperty, 'spread');
        flattenExpression(
          property.initializer,
          propertyPrefix,
          computed
            ? addBarrier([...propertyChain, sourceProperty], 'computed-property')
            : [...propertyChain, sourceProperty],
          keySources,
          checker,
          dictionarySourceFile,
          new Set(seen),
          sharedSource
        );
        continue;
      }

      if (ts.isShorthandPropertyAssignment(property)) {
        const keyPrefix = [...prefix, property.name.text].join('.');
        const overwritten = encounteredPrefixes.has(keyPrefix) || hasSubtree(keySources, keyPrefix);
        encounteredPrefixes.add(keyPrefix);
        deleteSubtree(keySources, keyPrefix);
        let sourceProperty: DictionarySourceProperty = {
          node: property,
          keyPrefix,
          barriers: sourceBarriers(property, dictionarySourceFile, sharedSource)
        };
        if (overwritten) sourceProperty = withBarrier(sourceProperty, 'overwrite');
        if (unresolvedSpreadBefore) sourceProperty = withBarrier(sourceProperty, 'spread');
        const declaration = declarationForShorthand(property, checker);
        if (declaration?.initializer) {
          const imported = declaration.getSourceFile() !== dictionarySourceFile;
          flattenExpression(
            declaration.initializer,
            [...prefix, property.name.text],
            imported
              ? addBarrier([...propertyChain, sourceProperty], 'imported-declaration')
              : [...propertyChain, sourceProperty],
            keySources,
            checker,
            dictionarySourceFile,
            new Set(seen),
            true
          );
        } else {
          flattenExpression(
            property.name,
            [...prefix, property.name.text],
            [...propertyChain, sourceProperty],
            keySources,
            checker,
            dictionarySourceFile,
            new Set(seen),
            sharedSource
          );
        }
      }
    }
    return;
  }

  if (ts.isArrayLiteralExpression(expression)) {
    const blockedChain = addBarrier(propertyChain, 'array');
    expression.elements.forEach((element, index) => {
      if (ts.isExpression(element)) {
        const elementPrefix = [...prefix, String(index)];
        flattenExpression(
          element,
          elementPrefix,
          blockedChain,
          keySources,
          checker,
          dictionarySourceFile,
          new Set(seen),
          sharedSource
        );
        addBarrierToSubtree(keySources, elementPrefix.join('.'), 'array');
      }
    });
    return;
  }

  if (prefix.length > 0) {
    keySources.set(prefix.join('.'), {
      valueNode: expression,
      propertyChain
    });
  }
}

function hasSubtree(keySources: ReadonlyMap<string, DictionaryKeySource>, prefix: string): boolean {
  for (const key of keySources.keys()) {
    if (key === prefix || key.startsWith(`${prefix}.`)) return true;
  }
  return false;
}

function deleteSubtree(keySources: Map<string, DictionaryKeySource>, prefix: string): void {
  for (const key of keySources.keys()) {
    if (key === prefix || key.startsWith(`${prefix}.`)) keySources.delete(key);
  }
}

function addBarrierToSubtree(
  keySources: Map<string, DictionaryKeySource>,
  prefix: string,
  barrier: DictionaryRemovalBarrier
): void {
  for (const [key, source] of keySources) {
    if (prefix && key !== prefix && !key.startsWith(`${prefix}.`)) continue;
    keySources.set(key, { ...source, propertyChain: addBarrier(source.propertyChain, barrier) });
  }
}

function objectPropertyNames(
  input: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Node>
): Set<string> | undefined {
  const expression = unwrapExpression(input);
  if (seen.has(expression)) return undefined;
  seen.add(expression);
  if (ts.isIdentifier(expression)) {
    const declaration = declarationForExpression(expression, checker);
    return declaration?.initializer
      ? objectPropertyNames(declaration.initializer, checker, seen)
      : undefined;
  }
  if (!ts.isObjectLiteralExpression(expression)) return undefined;

  const names = new Set<string>();
  for (const property of expression.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spreadNames = objectPropertyNames(property.expression, checker, new Set(seen));
      if (!spreadNames) return undefined;
      for (const name of spreadNames) names.add(name);
      continue;
    }
    if (
      ts.isPropertyAssignment(property) ||
      ts.isShorthandPropertyAssignment(property) ||
      ts.isMethodDeclaration(property) ||
      ts.isGetAccessorDeclaration(property) ||
      ts.isSetAccessorDeclaration(property)
    ) {
      const name = propertyName(property.name, checker);
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
  property: ts.ObjectLiteralElementLike,
  dictionarySourceFile: ts.SourceFile,
  sharedSource: boolean
): DictionaryRemovalBarrier[] {
  const barriers: DictionaryRemovalBarrier[] = [];
  if (sharedSource) barriers.push('shared-source-property');
  if (property.getSourceFile() !== dictionarySourceFile) barriers.push('imported-declaration');
  return barriers;
}

function propertyName(name: ts.PropertyName, checker: ts.TypeChecker): string | undefined {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const type = checker.getTypeAtLocation(name.expression);
    if (type.isStringLiteral() || type.isNumberLiteral()) return String(type.value);
  }
  return undefined;
}

function declarationForExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker
): ts.VariableDeclaration | undefined {
  const symbol = checker.getSymbolAtLocation(expression);
  return unwrapAlias(checker, symbol)?.declarations?.find(ts.isVariableDeclaration);
}

function declarationForShorthand(
  property: ts.ShorthandPropertyAssignment,
  checker: ts.TypeChecker
): ts.VariableDeclaration | undefined {
  const symbol = checker.getShorthandAssignmentValueSymbol(property);
  return unwrapAlias(checker, symbol)?.declarations?.find(ts.isVariableDeclaration);
}

/** Resolves a TypeScript alias symbol when one exists. */
export function unwrapAlias(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined
): ts.Symbol | undefined {
  if (!symbol) return undefined;
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

/** Removes transparent TypeScript expression wrappers without changing the underlying AST. */
export function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}
