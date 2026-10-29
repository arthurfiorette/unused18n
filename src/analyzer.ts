import path from 'node:path';
import {
  type AsExpression,
  type BindingElement,
  type CallExpression,
  type Declaration,
  type Expression,
  type FunctionLikeDeclaration,
  type HeritageClauseElement,
  type Identifier,
  isArrayBindingPattern,
  isArrowFunction,
  isAsExpression,
  isBinaryExpression,
  isBindingElement,
  isBlock,
  isCallExpression,
  isComputedPropertyName,
  isConditionalExpression,
  isConstructorDeclaration,
  isElementAccessExpression,
  isExpressionWithTypeArguments,
  isForInStatement,
  isForOfStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isImportClause,
  isImportDeclaration,
  isImportSpecifier,
  isInterfaceDeclaration,
  isIntersectionTypeNode,
  isJsxAttribute,
  isJsxExpression,
  isJsxOpeningElement,
  isJsxSelfClosingElement,
  isJsxSpreadAttribute,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isModuleDeclaration,
  isNamespaceImport,
  isNonNullExpression,
  isNumericLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isParenthesizedExpression,
  isParenthesizedTypeNode,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isPropertySignatureDeclaration,
  isReturnStatement,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSignatureDeclaration,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isStringLiteralLikeNode,
  isTypeAliasDeclaration,
  isTypeAssertion,
  isTypeReferenceNode,
  isUnionTypeNode,
  isVariableDeclaration,
  type JsxAttribute,
  type JsxAttributeValue,
  type JsxOpeningLikeElement,
  type JsxSpreadAttribute,
  type Node,
  type ObjectBindingPattern,
  type ObjectLiteralElementLike,
  type ParameterDeclaration,
  type PropertyName,
  type ShorthandPropertyAssignment,
  type SourceFile,
  type SpreadAssignment,
  type SpreadElement,
  SyntaxKind,
  type TypeAssertion,
  type TypeNode
} from 'typescript/ast';
import { SymbolFlags, type Symbol as TsSymbol, type Type, TypeFlags } from 'typescript/sync';
import type { DictionaryTarget } from './dictionaries.js';
import { readDictionary, unwrapExpression } from './dictionary.js';
import { DictionaryIndex } from './dictionary-index.js';
import { expandI18nextCandidates, type TranslationVariantOptions } from './i18next-candidates.js';
import { type LoadedProject, loadProject } from './project.js';
import { inventorySource, type SourceInventory } from './source-inventory.js';
import {
  createStringResolver,
  empty,
  exact,
  joinKey,
  merge,
  prepend,
  type StringResolution,
  unresolved
} from './strings.js';
import { isSourceAssertion, writtenType } from './syntax.js';
import type { AnalysisResult, AnalyzeOptions, UsageEvidence } from './types.js';

interface TranslationWrapper {
  keyParameter: number;
  prefix: StringResolution;
}

interface TranslationHookWrapper {
  owner: FunctionLikeDeclaration;
  prefixExpressions: Array<Expression | null | undefined>;
  staticPrefixes: StringResolution[];
}

interface ObjectResolution extends StringResolution {
  origin: 'translation' | 'dictionary';
  dictionaryIds?: ReadonlySet<string>;
  unboundedRuntimeKey?: boolean;
}

interface ObjectInput {
  expression: Expression;
  path: string[];
}

const ARRAY_ITERATION_METHODS = new Set([
  'map',
  'forEach',
  'reduce',
  'reduceRight',
  'filter',
  'some',
  'every',
  'find',
  'findIndex'
]);

type BooleanOptionResolution = 'true' | 'false' | 'absent' | 'unknown';

/**
 * Use this compatibility path when semantic parity is more important than peak
 * memory. Its single project-wide `Program`, including ASTs, symbols, and
 * compiler caches, remains live until the call returns.
 */
export interface LoadedProjectAnalysis {
  result: AnalysisResult;
  dictionary: ReturnType<typeof readDictionary>;
  sourceFacts: SourceUsageFacts[];
}

/** Compact observation that can be serialized without compiler object identities. */
export interface UsageObservation {
  kind: 'exact' | 'prefix' | 'pattern';
  value: string;
  confidence: 'used' | 'possibly-used';
  evidence: UsageEvidence;
  dictionaryIds?: string[];
}

/** Ordered facts preserve evidence selection when replayed in Program source order. */
export interface SourceUsageFacts {
  fileName: string;
  observations: UsageObservation[];
  unresolvedReferences: UsageEvidence[];
  translationObjectCasts: UsageEvidence[];
}

/** Reuse is prepared only after cache invalidation proves excluded components unchanged. */
export interface AnalysisReuse {
  dictionary?: ReturnType<typeof readDictionary>;
  dictionaries?: LoadedDictionaryTarget[];
  cachedFacts?: ReadonlyMap<string, SourceUsageFacts>;
  filesToAnalyze?: ReadonlySet<string>;
}

export interface LoadedDictionaryTarget extends DictionaryTarget {
  id: string;
  exportName: string;
  info: ReturnType<typeof readDictionary>;
}

export interface LoadedProjectManyAnalysis {
  analyses: Array<{ target: LoadedDictionaryTarget; result: AnalysisResult }>;
  sourceFacts: SourceUsageFacts[];
  unresolvedReferences: UsageEvidence[];
  translationObjectCasts: UsageEvidence[];
}

/**
 * Creates the compatibility Program for API callers that do not already own one.
 *
 * The compiler process is closed before returning because the result is plain data and nothing
 * outside this call can reach the project.
 */
export function analyzeProject(options: AnalyzeOptions): AnalysisResult {
  const dictionaryPath = path.resolve(options.dictionary);
  const loaded = loadProject(options.project ?? './tsconfig.json', [dictionaryPath]);
  try {
    return analyzeLoadedProject(loaded, options).result;
  } finally {
    loaded[Symbol.dispose]();
  }
}

/**
 * Reuses one caller-owned Program so linting, diagnostics, and removal never build competing
 * compiler graphs in the same process.
 */
export function analyzeLoadedProject(
  loaded: LoadedProject,
  options: AnalyzeOptions,
  reuse: AnalysisReuse = {}
): LoadedProjectAnalysis {
  const dictionaryPath = path.resolve(options.dictionary);
  const info =
    reuse.dictionary ?? readDictionary(loaded.semantic, dictionaryPath, options.dictionaryExport);
  const target: LoadedDictionaryTarget = {
    id: `${dictionaryPath}\0${info.exportName}`,
    path: dictionaryPath,
    ...(options.dictionaryExport === undefined
      ? {}
      : { requestedExport: options.dictionaryExport }),
    exportName: info.exportName,
    locale: path.basename(dictionaryPath, path.extname(dictionaryPath)),
    info
  };
  const many = analyzeLoadedProjectMany(loaded, [target], options, {
    ...reuse,
    dictionaries: [target]
  });
  return {
    dictionary: info,
    sourceFacts: many.sourceFacts,
    result: many.analyses[0]!.result
  };
}

/** Traverses source once and replays dictionary-targeted facts into each locale result. */
export function analyzeLoadedProjectMany(
  { semantic, configPath, sourceFiles }: LoadedProject,
  targets: LoadedDictionaryTarget[],
  options: Pick<AnalyzeOptions, 'includeEvidence' | 'maxExpansions' | 'project'> & {
    onFileAnalyzed?: (fileName: string, completedFiles: number, totalFiles: number) => void;
    onStage?: (stage: 'discovery' | 'usage' | 'replay', status: 'start' | 'end') => void;
  },
  reuse: AnalysisReuse = {}
): LoadedProjectManyAnalysis {
  const includeEvidence = options.includeEvidence ?? true;
  const dictionaries = reuse.dictionaries ?? targets;
  if (dictionaries.length === 0) throw new Error('At least one dictionary is required');
  // Object resolution needs only the union key shape; provenance stays on each target.
  const dictionaryKeys = new Set(dictionaries.flatMap(({ info }) => [...info.keys]));
  const dictionary = { keys: dictionaryKeys };
  const dictionaryPrefixes = new Set<string>();
  for (const key of dictionaryKeys) {
    const segments = key.split('.');
    for (let index = 1; index < segments.length; index += 1) {
      dictionaryPrefixes.add(segments.slice(0, index).join('.'));
    }
  }
  const maxExpansions = options.maxExpansions ?? 1_000;
  const projectRoot = path.dirname(configPath);
  const analysisSourceFiles = reuse.filesToAnalyze
    ? sourceFiles.filter((source) => reuse.filesToAnalyze?.has(path.resolve(source.fileName)))
    : sourceFiles;
  const inventories = analysisSourceFiles.map(inventorySource);
  // Assignment indexing below is the first symbol lookup, so the batch has to land before it.
  semantic.prefetchSymbols(inventories.flatMap(collectSemanticTargets));
  semantic.prefetchShorthandSymbols(inventories.flatMap(collectShorthandTargets));
  const indexedReturns = new Map<FunctionLikeDeclaration, readonly Expression[]>();
  const inventoriedFunctions = new Set<FunctionLikeDeclaration>();
  for (const inventory of inventories) {
    for (const owner of inventory.functions) inventoriedFunctions.add(owner);
    for (const [owner, expressions] of inventory.returnsByFunction) {
      indexedReturns.set(owner, expressions);
    }
  }

  const functionLikeCache = new WeakMap<Node, FunctionLikeDeclaration | null>();
  const dictionaryReturnIdsCache = new WeakMap<FunctionLikeDeclaration, ReadonlySet<string>>();
  const i18nextTFunctionCache = new WeakMap<Expression, boolean>();
  const returnExpressionCache = new WeakMap<FunctionLikeDeclaration, readonly Expression[]>();
  const reassignmentCache = new WeakMap<ParameterDeclaration, boolean>();
  const assignmentIndex = new Map<
    TsSymbol,
    Array<{ owner: FunctionLikeDeclaration | undefined; right: Expression }>
  >();
  for (const inventory of inventories) {
    for (const assignment of inventory.assignments) {
      const left = unwrapExpression(assignment.left);
      if (!isIdentifier(left)) continue;
      const symbol = semantic.symbol(left);
      if (!symbol) continue;
      const entries = assignmentIndex.get(symbol) ?? [];
      entries.push({ owner: assignment.owner, right: assignment.right });
      assignmentIndex.set(symbol, entries);
    }
  }
  const strings = createStringResolver(semantic, maxExpansions, {
    assignments: assignmentIndex,
    returns: indexedReturns
  });

  const translators = new Map<TsSymbol, StringResolution>();
  const translationHookWrappers = new Map<TsSymbol, TranslationHookWrapper>();
  const wrappers = new Map<TsSymbol, TranslationWrapper>();
  const wrapperCalls = new Map<TsSymbol, number>();
  // Discovery still uses live Symbols, but only dirty connected components need new observations.
  const freshFacts = new Map<string, SourceUsageFacts>();
  for (const sourceFile of analysisSourceFiles) {
    const fileName = path.resolve(sourceFile.fileName);
    freshFacts.set(fileName, {
      fileName,
      observations: [],
      unresolvedReferences: [],
      translationObjectCasts: []
    });
  }
  const observationIdentities = new WeakMap<SourceUsageFacts, Set<string>>();
  const unresolvedIdentities = new WeakMap<SourceUsageFacts, Set<string>>();
  const translationObjectCastIdentities = new WeakMap<SourceUsageFacts, Set<string>>();
  // Reassigned only by withScratchObjectCaches, which swaps in copies for lookahead.
  let objectCache = new WeakMap<Expression, ObjectResolution | null>();
  // Parameter inputs are indexed before usage analysis, making symbol provenance immutable here;
  // cache misses too so ordinary non-translation property accesses stay cheap.
  let objectSymbolCache = new Map<TsSymbol, ObjectResolution | null>();
  const resolvingObjectSymbols = new Set<TsSymbol>();
  const objectInputs = new Map<TsSymbol, ObjectInput[]>();
  const objectPropertyInputs = new Map<TsSymbol, Map<string, ObjectInput[]>>();
  let translationHookCache = new WeakMap<CallExpression, StringResolution | null>();

  // The first pass establishes direct translator provenance needed to recognize hooks that expose
  // `t` inside a returned object. Resetting the call cache lets the second pass observe new wrappers.
  emitStage('discovery', 'start');
  try {
    discoverHookTranslators();
    discoverTranslationHookWrappers();
    translationHookCache = new WeakMap();
    discoverHookTranslators();
    propagateTranslatorParameters();
    indexObjectParameterInputs();
    prefetchObjectInputSymbols();
    discoverTranslationWrappers();
    countWrapperCalls();
  } finally {
    emitStage('discovery', 'end');
  }

  emitStage('usage', 'start');
  try {
    // Runs first because the chain lookahead below already resolves objects through calls.
    prefetchCallTargetTypes();
    semantic.prefetchTypes(
      withScratchObjectCaches(() => inventories.flatMap(objectChainTypeTargets))
    );
    inventories.forEach((inventory, index) => {
      visitSource(inventory);
      try {
        options.onFileAnalyzed?.(
          path.resolve(inventory.sourceFile.fileName),
          index + 1,
          analysisSourceFiles.length
        );
      } catch {
        // Instrumentation cannot change source classification or cache contents.
      }
    });
  } finally {
    emitStage('usage', 'end');
  }

  // Fresh and cached runs share this replay boundary so classification joins remain identical.
  emitStage('replay', 'start');
  let dictionaryIndexes: Map<string, DictionaryIndex>;
  let unresolvedReferences: UsageEvidence[];
  let translationObjectCasts: UsageEvidence[];
  let sourceFacts: SourceUsageFacts[];
  try {
    dictionaryIndexes = new Map(
      dictionaries.map((target) => [
        target.id,
        DictionaryIndex.create(target.info.keys, includeEvidence)
      ])
    );
    unresolvedReferences = [];
    translationObjectCasts = [];
    const replayedUnresolvedIdentities = new Set<string>();
    const replayedCastIdentities = new Set<string>();
    sourceFacts = sourceFiles.map((sourceFile) => {
      const fileName = path.resolve(sourceFile.fileName);
      const facts = freshFacts.get(fileName) ??
        reuse.cachedFacts?.get(fileName) ?? {
          fileName,
          observations: [],
          unresolvedReferences: [],
          translationObjectCasts: []
        };
      for (const observation of facts.observations) {
        const indexes = observation.dictionaryIds
          ? observation.dictionaryIds.flatMap((id) => {
              const index = dictionaryIndexes.get(id);
              return index ? [index] : [];
            })
          : dictionaryIndexes.values();
        for (const index of indexes) {
          const evidence = includeEvidence ? observation.evidence : undefined;
          if (observation.kind === 'exact') {
            index.markExact(observation.value, observation.confidence, evidence);
          } else if (observation.kind === 'prefix') {
            index.markPrefix(observation.value, observation.confidence, evidence);
          } else {
            index.markPattern(observation.value, observation.confidence, evidence);
          }
        }
      }
      for (const evidence of facts.unresolvedReferences) {
        const identity = evidenceIdentity(evidence);
        if (replayedUnresolvedIdentities.has(identity)) continue;
        replayedUnresolvedIdentities.add(identity);
        unresolvedReferences.push(evidence);
      }
      for (const evidence of facts.translationObjectCasts) {
        const identity = evidenceIdentity(evidence);
        if (replayedCastIdentities.has(identity)) continue;
        replayedCastIdentities.add(identity);
        translationObjectCasts.push(evidence);
      }
      return facts;
    });
  } finally {
    emitStage('replay', 'end');
  }

  return {
    sourceFacts,
    unresolvedReferences,
    translationObjectCasts,
    analyses: dictionaries.map((target) => {
      const keys = dictionaryIndexes.get(target.id)!.toKeyAnalysis();
      return {
        target,
        result: {
          dictionary: target.path,
          dictionaryExport: target.exportName,
          keys,
          unresolvedReferences,
          summary: {
            total: keys.length,
            used: keys.filter((entry) => entry.status === 'used').length,
            possiblyUsed: keys.filter((entry) => entry.status === 'possibly-used').length,
            unused: keys.filter((entry) => entry.status === 'unused').length,
            unresolvedReferences: unresolvedReferences.length
          }
        }
      };
    })
  };

  /**
   * Registers project hooks that return a `useTranslation` call or an object with a `t` member,
   * so `const { t } = useProjectHook()` binds the hook's prefix. Runs between the two
   * discoverHookTranslators passes because returned translators are known only after the first.
   */
  function discoverTranslationHookWrappers(): void {
    for (const inventory of inventories) {
      const sourceFile = inventory.sourceFile;
      for (const { call, owner } of inventory.callEdges) {
        if (!isUseTranslationCall(call)) continue;
        if (
          !owner ||
          !returnExpressionsCached(owner).some(
            (expression) => unwrapExpression(expression) === call
          )
        ) {
          continue;
        }
        const symbol = symbolForFunction(owner);
        if (!symbol) continue;
        const wrapper = translationHookWrappers.get(symbol) ?? {
          owner,
          prefixExpressions: [],
          staticPrefixes: []
        };
        wrapper.prefixExpressions.push(keyPrefixExpressionFromUseTranslation(call));
        translationHookWrappers.set(symbol, wrapper);
      }
      for (const node of inventory.functions) {
        if (!isConcreteFunctionLike(node)) continue;
        const symbol = symbolForFunction(node);
        if (!symbol) continue;
        for (const returned of returnExpressionsCached(node)) {
          const value = unwrapExpression(returned);
          if (!isObjectLiteralExpression(value)) continue;
          for (const property of value.properties) {
            const shorthandSymbol = isShorthandPropertyAssignment(property)
              ? semantic.aliased(semantic.shorthandValueSymbol(property))
              : undefined;
            const translator = returnedTranslatorProperty(property, sourceFile);
            const prefix = shorthandSymbol
              ? translators.get(shorthandSymbol)
              : translator
                ? translatorPrefix(translator)
                : undefined;
            if (!prefix) continue;
            const wrapper = translationHookWrappers.get(symbol) ?? {
              owner: node,
              prefixExpressions: [],
              staticPrefixes: []
            };
            if (
              !wrapper.staticPrefixes.some(
                (candidate) => signatureOf(candidate) === signatureOf(prefix)
              )
            ) {
              wrapper.staticPrefixes.push(prefix);
            }
            translationHookWrappers.set(symbol, wrapper);
          }
        }
      }
    }
  }

  /**
   * Binds translator prefixes to variables initialized from a translation hook result or from
   * another translator. The second pass picks up hook wrappers found in between.
   */
  function discoverHookTranslators(): void {
    for (const inventory of inventories) {
      const sourceFile = inventory.sourceFile;
      for (const node of inventory.translatorCandidates) {
        if (!node.initializer) continue;

        const hookPrefix = couldBeTranslationHookResult(node.initializer)
          ? translationHookPrefix(node.initializer)
          : undefined;
        if (isObjectBindingPattern(node.name) && hookPrefix) {
          for (const element of node.name.elements) {
            // Binding element names are typed optional because array holes have none; object
            // pattern elements always carry one.
            if (!element.name) continue;
            const sourceName =
              element.propertyName?.getText(sourceFile) ?? element.name.getText(sourceFile);
            if (sourceName !== 't' || !isIdentifier(element.name)) continue;
            addTranslator(semantic.symbol(element.name), hookPrefix);
          }
          continue;
        }

        if (isArrayBindingPattern(node.name) && hookPrefix) {
          const first = node.name.elements[0];
          // A leading hole is a binding element without a name and binds no translator.
          if (first && isBindingElement(first) && first.name && isIdentifier(first.name)) {
            addTranslator(semantic.symbol(first.name), hookPrefix);
          }
          continue;
        }

        if (isIdentifier(node.name)) {
          const initializer = unwrapExpression(node.initializer);
          if (!isPotentialTranslatorExpression(initializer)) continue;
          const aliasedPrefix = translatorPrefix(initializer);
          if (aliasedPrefix) {
            addTranslator(semantic.symbol(node.name), aliasedPrefix);
            continue;
          }
          if (
            isPropertyAccessExpression(initializer) &&
            initializer.name.text === 't' &&
            translationHookPrefix(initializer.expression)
          ) {
            addTranslator(
              semantic.symbol(node.name),
              translationHookPrefix(initializer.expression) ?? empty()
            );
          }
        }
      }
    }
  }

  /**
   * Gives each parameter the prefixes of the translators local call sites pass to it, repeating
   * until nothing changes, so a translator handed through helper functions keeps its prefix.
   */
  function propagateTranslatorParameters(): void {
    // The first iteration hands every argument of every call with a local target to
    // isPotentialTranslatorExpression, which looks up access arguments through their name and as
    // a whole. Batching exactly those lookups here leaves the loop on the cache; prefetching them
    // for all calls instead would type-check receivers no lookup ever needs. functionLikeForCall
    // depends only on Semantic, so calling it ahead of the loop cannot change its answers.
    const argumentSites: Node[] = [];
    for (const inventory of inventories) {
      for (const node of inventory.calls) {
        if (!functionLikeForCall(node)) continue;
        for (const argument of node.arguments) {
          const value = unwrapExpression(argument);
          if (isPropertyAccessExpression(value)) argumentSites.push(value.name, value);
          else if (isElementAccessExpression(value)) argumentSites.push(value);
        }
      }
    }
    semantic.prefetchSymbols(argumentSites);

    let changed = true;
    let iteration = 0;
    // The iteration cap keeps pathological call cycles from making the analysis non-terminating.
    while (changed && iteration < 20) {
      changed = false;
      iteration += 1;
      for (const inventory of inventories) {
        for (const node of inventory.calls) {
          const target = functionLikeForCall(node);
          if (!target) continue;
          node.arguments.forEach((argument, index) => {
            if (!isPotentialTranslatorExpression(argument)) return;
            const prefix = translatorPrefix(argument);
            const parameter = target.parameters[index];
            if (!prefix || !parameter || !isIdentifier(parameter.name)) return;
            const symbol = semantic.symbol(parameter.name);
            if (!symbol) return;
            const before = translators.get(symbol);
            const after = before ? merge(before, prefix) : prefix;
            if (!before || !sameResolution(before, after)) {
              translators.set(symbol, after);
              changed = true;
            }
          });
        }
      }
    }
  }

  /**
   * Records which call arguments and JSX attributes feed each parameter, so object resolution
   * can follow a translation object into a function or component. Completes during discovery;
   * the usage pass treats the index as fixed.
   */
  function indexObjectParameterInputs(): void {
    // Checker types prove component/function identity, while call-site expressions preserve the
    // runtime translation prefix that structural prop types necessarily erase.
    for (const inventory of inventories) {
      for (const call of inventory.calls) {
        const target = functionLikeForCall(call);
        if (!target) continue;
        target.parameters.forEach((parameter, index) => {
          const input = call.arguments[index] ?? parameter.initializer;
          if (input) indexParameterInput(parameter, { expression: input, path: [] });
        });
      }
      for (const node of inventory.usageNodes) {
        if (!isJsxOpeningElement(node) && !isJsxSelfClosingElement(node)) continue;
        const target = functionLikeForExpression(node.tagName);
        const parameter = target?.parameters[0];
        if (!parameter) continue;
        if (isObjectBindingPattern(parameter.name)) {
          for (const element of parameter.name.elements) {
            if (!element.name || !isIdentifier(element.name)) continue;
            const property = staticBindingElementName(element);
            if (!property) continue;
            const source = jsxPropertyInput(node, property);
            if (source.input) addObjectInput(semantic.symbol(element.name), source.input);
            if (!source.found && element.initializer) {
              addObjectInput(semantic.symbol(element.name), {
                expression: element.initializer,
                path: []
              });
            }
          }
        } else if (isIdentifier(parameter.name)) {
          const symbol = semantic.symbol(parameter.name);
          if (!symbol) continue;
          for (const property of semantic.propertiesOfType(semantic.typeAt(parameter.name))) {
            const source = jsxPropertyInput(node, property.name);
            if (source.input) addObjectPropertyInput(symbol, property.name, source.input);
          }
        }
      }
    }
  }

  /**
   * Batches the symbol lookups object resolution makes when it follows a parameter back to its
   * call-site and JSX inputs. The input index is complete once indexing finishes, so reading it
   * here involves no resolution order.
   */
  function prefetchObjectInputSymbols(): void {
    const sites: Node[] = [];
    const addInputs = (inputs: Iterable<ObjectInput>): void => {
      for (const input of inputs) {
        const value = unwrapExpression(input.expression);
        if (isIdentifier(value)) sites.push(value);
      }
    };
    for (const inputs of objectInputs.values()) addInputs(inputs);
    for (const properties of objectPropertyInputs.values()) {
      for (const inputs of properties.values()) addInputs(inputs);
    }
    semantic.prefetchSymbols(sites);
  }

  /** Finds the attribute or spread that supplies `property` to a component element. */
  function jsxPropertyInput(
    node: JsxOpeningLikeElement,
    property: string
  ): { found: boolean; input?: ObjectInput } {
    // JSX applies props left-to-right; walking backward selects the value that actually reaches the
    // component instead of retaining translation objects hidden by later attributes or spreads.
    const properties = node.attributes.properties;
    for (let index = properties.length - 1; index >= 0; index -= 1) {
      const attribute = properties[index]!;
      if (isJsxAttribute(attribute)) {
        if (attribute.name.getText() !== property) continue;
        const expression = attribute.initializer
          ? jsxAttributeExpression(attribute.initializer)
          : undefined;
        return expression ? { found: true, input: { expression, path: [] } } : { found: true };
      }
      if (semantic.propertyOfType(semantic.typeAt(attribute.expression), property)) {
        return {
          found: true,
          input: { expression: attribute.expression, path: [property] }
        };
      }
    }
    return { found: false };
  }

  /**
   * Records `input` for a parameter, or for each statically named element of a destructured
   * parameter with that property appended to the input path.
   */
  function indexParameterInput(parameter: ParameterDeclaration, input: ObjectInput): void {
    if (isIdentifier(parameter.name)) {
      addObjectInput(semantic.symbol(parameter.name), input);
      return;
    }
    if (!isObjectBindingPattern(parameter.name)) return;
    for (const element of parameter.name.elements) {
      if (!element.name || !isIdentifier(element.name)) continue;
      const property = staticBindingElementName(element);
      if (!property) continue;
      addObjectInput(semantic.symbol(element.name), {
        expression: input.expression,
        path: [...input.path, property]
      });
    }
  }

  /** Bindings without a symbol cannot be looked up later, so their inputs are dropped. */
  function addObjectInput(symbol: TsSymbol | undefined, input: ObjectInput): void {
    if (!symbol) return;
    const inputs = objectInputs.get(symbol) ?? [];
    inputs.push(input);
    objectInputs.set(symbol, inputs);
  }

  /** Records a value supplied for one prop of a props parameter that is read as a whole. */
  function addObjectPropertyInput(symbol: TsSymbol, property: string, input: ObjectInput): void {
    const properties = objectPropertyInputs.get(symbol) ?? new Map<string, ObjectInput[]>();
    const inputs = properties.get(property) ?? [];
    inputs.push(input);
    properties.set(property, inputs);
    objectPropertyInputs.set(symbol, properties);
  }

  /**
   * Finds functions that pass one of their own parameters as the key of a translator call, so
   * calls to them are analyzed as translation calls with the inner translator's prefix.
   */
  function discoverTranslationWrappers(): void {
    for (const inventory of inventories) {
      for (const node of inventory.calls) {
        if (!translatorPrefix(node.expression)) continue;
        const key = node.arguments[0] ? unwrapExpression(node.arguments[0]) : undefined;
        if (!key || !isIdentifier(key)) continue;
        const owner = enclosingFunction(node);
        if (!owner) continue;
        const parameterIndex = owner.parameters.findIndex(
          (parameter) =>
            isIdentifier(parameter.name) && semantic.symbol(parameter.name) === semantic.symbol(key)
        );
        if (parameterIndex < 0) continue;
        const parameter = owner.parameters[parameterIndex];
        if (!parameter || parameterIsReassignedCached(parameter, owner)) continue;
        const ownerSymbol = symbolForFunction(owner);
        if (!ownerSymbol) continue;
        wrappers.set(ownerSymbol, {
          keyParameter: parameterIndex,
          prefix: translatorPrefix(node.expression) ?? empty()
        });
      }
    }
  }

  /**
   * Counts call sites per wrapper; a wrapper nobody calls keeps its inner translator call
   * analyzed (see isAnalyzedWrapperParameter).
   */
  function countWrapperCalls(): void {
    for (const inventory of inventories) {
      for (const node of inventory.calls) {
        const symbol = semantic.symbol(node.expression);
        if (symbol && wrappers.has(symbol)) {
          wrapperCalls.set(symbol, (wrapperCalls.get(symbol) ?? 0) + 1);
        }
      }
    }
  }

  /**
   * Collects the base expressions whose types `resolveObject` reads while walking access chains
   * rooted in a translation or dictionary object.
   *
   * Each chain level whose base resolves asks for the base type, so a 10k-key dictionary read
   * through `dictionary.a.b.key` costs one request per level when fetched lazily.
   *
   * Roots are classified with `resolveObjectSymbol`, which must run on scratch copies of the
   * object caches (see {@link withScratchObjectCaches}).
   */
  function objectChainTypeTargets(inventory: SourceInventory): Node[] {
    const targets: Node[] = [];
    for (const node of inventory.usageNodes) {
      if (!isPropertyAccessExpression(node) && !isElementAccessExpression(node)) continue;
      if (isObjectChainBase(node)) continue;
      const bases: Expression[] = [];
      let current = unwrapExpression(node);
      while (isPropertyAccessExpression(current) || isElementAccessExpression(current)) {
        bases.push(current.expression);
        current = unwrapExpression(current.expression);
      }
      if (!isIdentifier(current)) continue;
      const symbol = semantic.symbol(current);
      if (symbol && resolveObjectSymbol(symbol)) targets.push(...bases);
    }
    return targets;
  }

  /**
   * Batches the contract types resolveObject compares with dictionaries when a call's returned
   * values do not resolve: the declared return type node and, for exported targets, the
   * signature's return type. functionLikeForCall depends only on Semantic, so this lookahead
   * cannot change what the usage pass computes.
   */
  function prefetchCallTargetTypes(): void {
    const typeNodes: TypeNode[] = [];
    const exported: FunctionLikeDeclaration[] = [];
    for (const inventory of inventories) {
      for (const call of inventory.calls) {
        const target = functionLikeForCall(call);
        if (!target) continue;
        if (target.type) typeNodes.push(target.type);
        if (isExported(target)) exported.push(target);
      }
    }
    semantic.prefetchTypesFromTypeNodes(typeNodes);
    semantic.prefetchReturnTypes(exported);
  }

  /**
   * Runs `work` against throwaway copies of the object resolution caches, then restores them.
   *
   * Mutually referencing variables cache a partial result for whichever symbol is resolved
   * second, so these caches depend on resolution order. Lookahead such as type prefetching
   * resolves symbols in a different order than the usage pass; isolating it keeps the usage
   * pass on exactly the cache state discovery left behind. The semantic layer's caches are
   * order-independent and keep everything the lookahead fetched.
   */
  function withScratchObjectCaches<T>(work: () => T): T {
    const savedObjects = objectCache;
    const savedSymbols = objectSymbolCache;
    objectCache = new WeakMap();
    objectSymbolCache = new Map(savedSymbols);
    try {
      return work();
    } finally {
      objectCache = savedObjects;
      objectSymbolCache = savedSymbols;
    }
  }

  /**
   * Runs every usage check for one file in source order. The order of resolveObject calls here
   * decides what the object caches hold, which is why lookahead uses scratch caches.
   */
  function visitSource(inventory: SourceInventory): void {
    for (const node of inventory.usageNodes) {
      if (isCallExpression(node)) analyzeCall(node);
      if (isVariableDeclaration(node) && isObjectBindingPattern(node.name) && node.initializer) {
        const object = resolveObject(node.initializer);
        if (object) analyzeBindingPattern(node.name, object, node);
        else analyzeProjectedBindingPattern(node.name, node.initializer);
      }
      if (isJsxOpeningElement(node) || isJsxSelfClosingElement(node)) analyzeTrans(node);
      if (
        (isPropertyAccessExpression(node) || isElementAccessExpression(node)) &&
        !isObjectChainBase(node)
      ) {
        analyzeObjectExpression(node);
      }
      if (isSpreadAssignment(node) || isSpreadElement(node) || isJsxSpreadAttribute(node)) {
        analyzeSpread(node);
      }
      if (isForInStatement(node) || isForOfStatement(node)) {
        const object = resolveObject(node.expression);
        if (object) markSubtrees(object, node.expression, 'Iteration over translation object');
      }
    }
  }

  /**
   * Translator calls mark their keys, wrapper calls mark the forwarded key, array iteration and
   * `Object.keys`-style enumeration mark whole subtrees, and translation objects passed to
   * functions without a local body count as escaping.
   */
  function analyzeCall(call: CallExpression): void {
    const prefix = translatorPrefix(call.expression);
    if (prefix) {
      const keyExpression = call.arguments[0];
      if (!keyExpression || isAnalyzedWrapperParameter(keyExpression, call)) return;
      // A call-level override deliberately escapes a bound translator prefix, notably for getFixedT.
      const prefixOverride = call.arguments[1]
        ? optionExpression(call.arguments[1], 'keyPrefix')
        : undefined;
      const resolution = prepend(
        prefixOverride === null
          ? merge(prefix, unresolved())
          : prefixOverride
            ? mergePrefixOverride(prefix, prefixOverride)
            : prefix,
        strings.resolve(keyExpression)
      );
      const returnsObjects = callBooleanOption(call, 'returnObjects');
      if (returnsObjects === 'true') {
        const cast = translationObjectCast(call);
        if (cast) {
          addTranslationObjectCast(
            factsForNode(cast),
            evidenceFor(
              cast,
              'used',
              'Translation object casts hide the inferred dictionary shape; remove this cast.'
            )
          );
        }
        for (let index = 1; index < call.arguments.length; index += 1) {
          const argument = call.arguments[index]!;
          if (booleanOption(argument, 'returnObjects') !== 'true') continue;
          const argumentCast = unsafeTranslationArgumentCast(argument);
          if (!argumentCast) continue;
          addTranslationObjectCast(
            factsForNode(argumentCast),
            evidenceFor(
              argumentCast,
              'used',
              'Translation object casts hide the inferred dictionary shape; remove this cast.'
            )
          );
        }
        if (isUnconsumedObjectCall(call)) {
          markSubtrees(
            resolution,
            call,
            'Translation object escapes without property-level analysis'
          );
        }
        return;
      }
      if (returnsObjects === 'unknown') {
        markSubtrees(resolution, call, 'Translation call may return an object');
      }
      markTranslationResolution(resolution, translationOptions(call), call, 'Translation call');
      return;
    }

    const wrapper = wrappers.get(semantic.symbol(call.expression) as TsSymbol);
    const argument = wrapper ? call.arguments[wrapper.keyParameter] : undefined;
    if (wrapper && argument) {
      markTranslationResolution(
        prepend(wrapper.prefix, strings.resolve(argument)),
        {},
        call,
        'Translation wrapper call'
      );
    }

    if (analyzeArrayReceiverCall(call)) return;

    if (isEnumerationCall(call)) {
      const object = call.arguments[0] ? resolveObject(call.arguments[0]) : undefined;
      if (object) markSubtrees(object, call, 'Runtime enumeration of translation object');
      return;
    }

    if (!functionLikeForCall(call)?.body) {
      for (const argument of call.arguments) {
        const object = resolveObject(argument);
        if (object) markSubtrees(object, argument, 'Translation object passed to external code');
      }
    }
  }

  /**
   * Iterating a translation array with a method such as `map` reads every element. The receiver
   * must also be typed as an array, so an object key named `map` stays ordinary data.
   */
  function analyzeArrayReceiverCall(call: CallExpression): boolean {
    const expression = unwrapExpression(call.expression);
    if (
      !isPropertyAccessExpression(expression) ||
      !ARRAY_ITERATION_METHODS.has(expression.name.text)
    ) {
      return false;
    }

    const receiver = expression.expression;
    const object = resolveObject(receiver);
    if (!object || !isArrayLikeType(semantic.typeAt(receiver))) return false;

    // Mark the receiver, not `.map`/`.find`, so a dictionary key with that name stays ordinary data.
    markSubtrees(object, call, 'Translation array iteration');
    return true;
  }

  /** Accepts arrays, tuples, and lib `ReadonlyArray` instances, including unions of them. */
  function isArrayLikeType(type: Type): boolean {
    if (type.isUnionType()) return type.getTypes().every(isArrayLikeType);
    // `Type.isTupleType` reads a flag the server ships with every type, so it needs no request.
    if (semantic.isArrayType(type) || type.isTupleType()) return true;

    // ReadonlyArray references are not consistently reported by isArrayType across TS versions.
    const symbol =
      type.getSymbol() ?? (type.isTypeReference() ? type.getTarget().getSymbol() : undefined);
    return Boolean(
      symbol?.name === 'ReadonlyArray' &&
        semantic
          .declarations(symbol)
          .some((declaration) => semantic.isDefaultLibrary(declaration.getSourceFile()))
    );
  }

  /**
   * Handles `<Trans i18nKey>` only when `Trans` comes from react-i18next, applying the prefix of
   * a translator passed through its `t` attribute.
   */
  function analyzeTrans(node: JsxOpeningLikeElement): void {
    const tagTarget = isPropertyAccessExpression(node.tagName) ? node.tagName.name : node.tagName;
    const tagSymbol = semantic.symbol(tagTarget);
    if (
      !isImportedName(tagSymbol, 'Trans', 'react-i18next') &&
      !isLibrarySymbol(tagSymbol, 'Trans', 'react-i18next')
    ) {
      return;
    }
    const keyAttribute = node.attributes.properties.find(
      (attribute): attribute is JsxAttribute =>
        isJsxAttribute(attribute) && attribute.name.getText() === 'i18nKey'
    );
    if (!keyAttribute?.initializer) return;

    const keyExpression = jsxAttributeExpression(keyAttribute.initializer);
    const key = isStringLiteral(keyAttribute.initializer)
      ? exact(keyAttribute.initializer.text)
      : keyExpression
        ? strings.resolve(keyExpression)
        : empty();
    const tAttribute = node.attributes.properties.find(
      (attribute): attribute is JsxAttribute =>
        isJsxAttribute(attribute) && attribute.name.getText() === 't'
    );
    const suppliedTranslator = tAttribute?.initializer
      ? jsxAttributeExpression(tAttribute.initializer)
      : undefined;
    const prefix = suppliedTranslator ? translatorPrefix(suppliedTranslator) : empty();
    markResolution(prepend(prefix ?? empty(), key), node, '<Trans i18nKey>');
  }

  /**
   * Marks keys read through the outermost access of a chain on a translation or dictionary
   * object. Values that are only stored or returned are analyzed where they are read.
   */
  function analyzeObjectExpression(expression: Expression): void {
    const object = resolveObject(expression);
    if (!object) return;

    const exactLeaves = dictionaryLeaves(object.values);
    if (exactLeaves.length > 0) {
      markKeys(
        exactLeaves,
        'used',
        expression,
        `${object.origin} object property access`,
        object.dictionaryIds
      );
    }

    for (const pattern of object.patterns) {
      markPattern(
        pattern,
        expression,
        `${object.origin} object dynamic property access`,
        object.dictionaryIds
      );
    }
    if (object.unboundedRuntimeKey) {
      addUnresolved(
        factsForNode(expression),
        evidenceFor(
          expression,
          'possibly-used',
          `${object.origin} object dynamic property access: unresolved runtime key`
        )
      );
    }

    if (exactLeaves.length === object.values.size && object.patterns.size === 0) return;
    if (isAliasOrReturn(expression)) return;

    for (const value of object.values) {
      if (!dictionary.keys.has(value) && hasDescendants(value)) {
        markSubtree(
          value,
          expression,
          `${object.origin} object subtree escapes static analysis`,
          object.dictionaryIds
        );
      }
    }
  }

  /**
   * Reports a translator call inside a wrapper whose key is the wrapper's own parameter. Each
   * wrapper call site marks its argument instead, so the inner call is skipped unless the
   * wrapper is exported, uncalled, or reassigns the parameter.
   */
  function isAnalyzedWrapperParameter(key: Expression, call: CallExpression): boolean {
    const value = unwrapExpression(key);
    if (!isIdentifier(value)) return false;
    const owner = enclosingFunction(call);
    if (!owner) return false;
    const ownerSymbol = symbolForFunction(owner);
    if (!ownerSymbol || !wrappers.has(ownerSymbol) || isExported(owner)) return false;
    const parameter = owner.parameters.find(
      (candidate) =>
        isIdentifier(candidate.name) && semantic.symbol(candidate.name) === semantic.symbol(value)
    );
    return Boolean(
      parameter &&
        !parameterIsReassignedCached(parameter, owner) &&
        (wrapperCalls.get(ownerSymbol) ?? 0) > 0
    );
  }

  /** A spread copies every key, so the whole spread object counts as possibly used. */
  function analyzeSpread(node: SpreadAssignment | SpreadElement | JsxSpreadAttribute): void {
    const object = resolveObject(node.expression);
    if (object) markSubtrees(object, node, 'Spread of translation object');
  }

  /** Destructuring marks each named property; a rest element marks the remaining subtree. */
  function analyzeBindingPattern(
    pattern: ObjectBindingPattern,
    object: ObjectResolution,
    node: Node
  ): void {
    for (const element of pattern.elements) {
      if (element.dotDotDotToken) {
        markSubtrees(object, element, 'Rest destructuring of translation object');
        continue;
      }
      // Only array holes lack a name, and this walk never sees array patterns.
      if (!element.name) continue;
      const rawName = element.propertyName?.getText(node.getSourceFile()) ?? element.name.getText();
      const child = appendObject(object, exact(rawName.replaceAll(/['"]/g, '')));
      if (isObjectBindingPattern(element.name)) {
        analyzeBindingPattern(element.name, child, element);
      } else {
        const leaves = dictionaryLeaves(child.values);
        if (leaves.length > 0)
          markKeys(
            leaves,
            'used',
            element,
            'Destructured translation property',
            child.dictionaryIds
          );
        else markSubtrees(child, element, 'Destructured translation subtree');
      }
    }
  }

  /**
   * Destructures a value that does not resolve as a whole, such as a call returning a mixed
   * props bag, by projecting each named property separately.
   */
  function analyzeProjectedBindingPattern(
    pattern: ObjectBindingPattern,
    initializer: Expression
  ): void {
    for (const element of pattern.elements) {
      if (element.dotDotDotToken) continue;
      const property = staticBindingElementName(element);
      if (!property) continue;
      const object = resolveProjectedObject(initializer, property, new Set());
      if (!object) continue;
      if (element.name && isObjectBindingPattern(element.name)) {
        analyzeBindingPattern(element.name, object, element);
        continue;
      }
      const leaves = dictionaryLeaves(object.values);
      if (leaves.length > 0) {
        markKeys(
          leaves,
          'used',
          element,
          'Destructured returned translation property',
          object.dictionaryIds
        );
      }
    }
  }

  /**
   * Resolves an expression to the dictionary keys it holds as a translation or dictionary
   * object. Only top-level calls are cached, because a nested result depends on `seen`.
   */
  function resolveObject(input: Expression, seen = new Set<Node>()): ObjectResolution | undefined {
    if (seen.size === 0) {
      const cached = objectCache.get(input);
      if (cached !== undefined) return cached ?? undefined;
      const result = resolveObjectUncached(input, seen);
      objectCache.set(input, result ?? null);
      return result;
    }
    return resolveObjectUncached(input, seen);
  }

  /**
   * Calls resolve through `returnObjects` translator calls, `useMemo` factories, local function
   * returns and finally declared or exported return types matched against dictionary types.
   * Identifiers resolve through their symbol, and access chains append one segment per level.
   */
  function resolveObjectUncached(input: Expression, seen: Set<Node>): ObjectResolution | undefined {
    const expression = unwrapExpression(input);
    if (seen.has(expression)) return undefined;
    const nextSeen = new Set(seen).add(expression);

    if (isCallExpression(expression)) {
      const prefix = translatorPrefix(expression.expression);
      if (
        prefix &&
        !['false', 'absent'].includes(callBooleanOption(expression, 'returnObjects')) &&
        expression.arguments[0]
      ) {
        return {
          ...prepend(prefix, strings.resolve(expression.arguments[0])),
          origin: 'translation'
        };
      }

      if (isReactUseMemoCall(expression)) {
        const factory = expression.arguments[0];
        const value = factory ? unwrapExpression(factory) : undefined;
        if (value && (isArrowFunction(value) || isFunctionExpression(value))) {
          // Restrict callback unwrapping to React's identity-preserving memo primitive; arbitrary
          // external callbacks do not guarantee that their return value becomes the call result.
          let result: ObjectResolution | undefined;
          for (const returned of returnExpressionsCached(value)) {
            const candidate = resolveObject(returned, nextSeen);
            if (candidate) result = result ? mergeObjects(result, candidate) : candidate;
          }
          if (result) return result;
        }
      }

      const target = functionLikeForCall(expression);
      if (target?.body) {
        const returns = returnExpressionsCached(target);
        let result: ObjectResolution | undefined;
        for (const returned of returns) {
          const candidate = resolveObject(returned, nextSeen);
          if (!candidate) continue;
          result = result ? mergeObjects(result, candidate) : candidate;
        }
        if (result) return result;
      }
      if (target?.type) {
        const dictionaryIds = dictionaryIdsForDeclaredType(target.type);
        if (dictionaryIds.size > 0) {
          return { ...exact(''), origin: 'dictionary', dictionaryIds };
        }
      }
      if (target && isExported(target)) {
        const dictionaryIds = dictionaryIdsForFunctionReturn(target);
        if (dictionaryIds.size > 0) {
          return { ...exact(''), origin: 'dictionary', dictionaryIds };
        }
      }
    }

    if (isIdentifier(expression)) {
      const symbol = semantic.symbol(expression);
      return symbol ? resolveObjectSymbol(symbol) : undefined;
    }

    if (isPropertyAccessExpression(expression)) {
      const base = resolveObject(expression.expression, nextSeen);
      if (base) {
        if (isDefinitelyStringLike(semantic.typeAt(expression.expression))) {
          return scalarDictionaryLeaves(base);
        }
        if (resolvesDictionaryLeaf(base)) return base;
        return appendObject(base, exact(expression.name.text));
      }
      const projected = resolveProjectedObject(
        expression.expression,
        expression.name.text,
        nextSeen
      );
      if (projected) return projected;
      return undefined;
    }

    if (isElementAccessExpression(expression)) {
      const base = resolveObject(expression.expression, nextSeen);
      if (!base || !expression.argumentExpression) return base;
      if (isDefinitelyStringLike(semantic.typeAt(expression.expression))) {
        return scalarDictionaryLeaves(base);
      }
      if (resolvesDictionaryLeaf(base)) return base;
      return appendObject(base, strings.resolve(expression.argumentExpression));
    }

    if (isConditionalExpression(expression)) {
      return mergeObjectPair(
        resolveObject(expression.whenTrue, nextSeen),
        resolveObject(expression.whenFalse, nextSeen)
      );
    }

    if (
      isBinaryExpression(expression) &&
      (expression.operatorToken.kind === SyntaxKind.QuestionQuestionToken ||
        expression.operatorToken.kind === SyntaxKind.BarBarToken)
    ) {
      return mergeObjectPair(
        resolveObject(expression.left, nextSeen),
        resolveObject(expression.right, nextSeen)
      );
    }

    return undefined;
  }

  /**
   * Resolves an indexed parameter input and appends its property path. When the input does not
   * resolve as a whole, the first path segment is projected through it instead.
   */
  function resolveObjectInput(input: ObjectInput, seen: Set<Node>): ObjectResolution | undefined {
    const direct = resolveObject(input.expression, seen);
    if (direct) {
      return input.path.reduce((result, property) => appendObject(result, exact(property)), direct);
    }
    if (input.path.length === 0) return undefined;
    const [first, ...rest] = input.path;
    if (!first) return resolveObject(input.expression, seen);
    let result = resolveProjectedObject(input.expression, first, seen);
    for (const property of rest) {
      if (!result) return undefined;
      result = appendObject(result, exact(property));
    }
    return result;
  }

  /** Resolves one named property of an object literal, call result or variable. */
  function resolveProjectedObject(
    input: Expression,
    property: string,
    seen: Set<Node>
  ): ObjectResolution | undefined {
    // Returned prop bags are heterogeneous, so resolving the whole object would conflate unrelated
    // prefixes. Project the requested property through each observed return/call edge instead.
    const expression = unwrapExpression(input);
    if (seen.has(expression)) return undefined;
    const nextSeen = new Set(seen).add(expression);

    if (isObjectLiteralExpression(expression)) {
      let result: ObjectResolution | undefined;
      for (const member of expression.properties) {
        if (isSpreadAssignment(member)) {
          const candidate = resolveProjectedObject(member.expression, property, nextSeen);
          if (semantic.propertyOfType(semantic.typeAt(member.expression), property)) {
            result = candidate;
          }
          continue;
        }
        if (staticPropertyName(member.name) !== property) continue;
        let candidate: ObjectResolution | undefined;
        if (isPropertyAssignment(member)) {
          candidate = resolveObject(member.initializer, nextSeen);
        } else if (isShorthandPropertyAssignment(member)) {
          const valueSymbol = semantic.aliased(semantic.shorthandValueSymbol(member));
          candidate = valueSymbol
            ? resolveObjectSymbol(valueSymbol)
            : resolveObject(shorthandName(member), nextSeen);
        }
        // Explicit properties always overwrite earlier spreads/properties, including with a
        // non-translation value whose unresolved candidate intentionally clears provenance.
        result = candidate;
      }
      return result;
    }

    if (isCallExpression(expression)) {
      if (isReactUseMemoCall(expression)) {
        const factory = expression.arguments[0];
        const value = factory ? unwrapExpression(factory) : undefined;
        if (value && (isArrowFunction(value) || isFunctionExpression(value))) {
          // A memoized heterogeneous bag still needs property-level projection; resolving the
          // callback as one ObjectResolution would conflate its independent translation prefixes.
          let result: ObjectResolution | undefined;
          for (const returned of returnExpressionsCached(value)) {
            const candidate = resolveProjectedObject(returned, property, nextSeen);
            if (candidate) result = result ? mergeObjects(result, candidate) : candidate;
          }
          if (result) return result;
        }
      }
      const target = functionLikeForCall(expression);
      if (!target?.body) return undefined;
      let result: ObjectResolution | undefined;
      for (const returned of returnExpressionsCached(target)) {
        const candidate = resolveProjectedObject(returned, property, nextSeen);
        if (candidate) result = result ? mergeObjects(result, candidate) : candidate;
      }
      return result;
    }

    if (isIdentifier(expression)) {
      const symbol = semantic.symbol(expression);
      const declaration = semantic.declarations(symbol).find(isVariableDeclaration);
      if (declaration?.initializer) {
        const fromDeclaration = resolveProjectedObject(declaration.initializer, property, nextSeen);
        if (fromDeclaration) return fromDeclaration;
      }
      const inputs = symbol ? objectInputs.get(symbol) : undefined;
      let fromInputs: ObjectResolution | undefined;
      for (const objectInput of inputs ?? []) {
        const candidate = resolveObjectInput(
          {
            expression: objectInput.expression,
            path: [...objectInput.path, property]
          },
          nextSeen
        );
        if (candidate) fromInputs = fromInputs ? mergeObjects(fromInputs, candidate) : candidate;
      }
      if (fromInputs) return fromInputs;
      const propertyInputs = symbol ? objectPropertyInputs.get(symbol)?.get(property) : undefined;
      let fromPropertyInputs: ObjectResolution | undefined;
      for (const objectInput of propertyInputs ?? []) {
        const candidate = resolveObjectInput(objectInput, nextSeen);
        if (candidate) {
          fromPropertyInputs = fromPropertyInputs
            ? mergeObjects(fromPropertyInputs, candidate)
            : candidate;
        }
      }
      if (fromPropertyInputs) return fromPropertyInputs;
    }

    if (isConditionalExpression(expression)) {
      return mergeObjectPair(
        resolveProjectedObject(expression.whenTrue, property, nextSeen),
        resolveProjectedObject(expression.whenFalse, property, nextSeen)
      );
    }

    if (
      isBinaryExpression(expression) &&
      (expression.operatorToken.kind === SyntaxKind.QuestionQuestionToken ||
        expression.operatorToken.kind === SyntaxKind.BarBarToken)
    ) {
      return mergeObjectPair(
        resolveProjectedObject(expression.left, property, nextSeen),
        resolveProjectedObject(expression.right, property, nextSeen)
      );
    }

    return undefined;
  }

  function mergeObjectPair(
    left: ObjectResolution | undefined,
    right: ObjectResolution | undefined
  ): ObjectResolution | undefined {
    if (!left) return right;
    if (!right) return left;
    return mergeObjects(left, right);
  }

  /**
   * Resolves what a symbol holds from its variable initializer, indexed parameter inputs and
   * destructuring source, memoized per symbol in objectSymbolCache.
   *
   * A symbol already being resolved yields `undefined` to cut cycles, and the symbol that closed
   * the cycle caches that partial answer. Results therefore depend on resolution order, so
   * lookahead must run inside withScratchObjectCaches. Each symbol starts a fresh `seen` set
   * because the in-progress set already bounds recursion across symbols.
   */
  function resolveObjectSymbol(symbol: TsSymbol): ObjectResolution | undefined {
    const cached = objectSymbolCache.get(symbol);
    if (cached !== undefined) return cached ?? undefined;
    if (resolvingObjectSymbols.has(symbol)) return undefined;
    resolvingObjectSymbols.add(symbol);
    const seen = new Set<Node>();

    try {
      const dictionaryIds = new Set<string>();
      for (const { id, info } of dictionaries) {
        if (symbol === info.symbol) dictionaryIds.add(id);
      }
      if (dictionaryIds.size > 0) {
        const result = { ...exact(''), origin: 'dictionary' as const, dictionaryIds };
        objectSymbolCache.set(symbol, result);
        return result;
      }

      let result: ObjectResolution | undefined;
      const variable = semantic.declarations(symbol).find(isVariableDeclaration);
      if (variable?.initializer) result = resolveObject(variable.initializer, seen);
      for (const input of objectInputs.get(symbol) ?? []) {
        const candidate = resolveObjectInput(input, seen);
        if (candidate) result = result ? mergeObjects(result, candidate) : candidate;
      }
      const binding = semantic.declarations(symbol).find(isBindingElement);
      const declaration = binding?.parent.parent;
      if (binding && declaration && isVariableDeclaration(declaration) && declaration.initializer) {
        const property = staticBindingElementName(binding);
        const candidate = property
          ? resolveProjectedObject(declaration.initializer, property, seen)
          : undefined;
        if (candidate) result = result ? mergeObjects(result, candidate) : candidate;
      }
      objectSymbolCache.set(symbol, result ?? null);
      return result;
    } finally {
      resolvingObjectSymbols.delete(symbol);
    }
  }

  function resolvesDictionaryLeaf(base: ObjectResolution): boolean {
    for (const value of base.values) {
      for (const { id, info } of dictionaries) {
        if (base.dictionaryIds && !base.dictionaryIds.has(id)) continue;
        if (!info.keys.has(value)) continue;
        let hasChild = false;
        for (const key of info.keys) {
          if (key.startsWith(`${value}.`)) {
            hasChild = true;
            break;
          }
        }
        if (!hasChild) return true;
      }
    }
    return false;
  }

  function scalarDictionaryLeaves(base: ObjectResolution): ObjectResolution | undefined {
    const values = new Set<string>();
    for (const value of base.values) {
      if (dictionary.keys.has(value)) values.add(value);
    }
    if (values.size === 0) return undefined;
    return {
      values,
      patterns: new Set(),
      complete: true,
      origin: base.origin,
      ...(base.dictionaryIds ? { dictionaryIds: base.dictionaryIds } : {})
    };
  }

  function appendObject(base: ObjectResolution, segment: StringResolution): ObjectResolution {
    const result = prepend(base, segment);
    const unboundedRuntimeKey = !segment.complete && segment.patterns.size === 0;
    if (unboundedRuntimeKey) {
      for (const value of base.values) result.patterns.add(joinKey(value, '*'));
      for (const pattern of base.patterns) result.patterns.add(joinKey(pattern, '*'));
    }
    return {
      ...result,
      origin: base.origin,
      ...(base.unboundedRuntimeKey || unboundedRuntimeKey ? { unboundedRuntimeKey: true } : {}),
      ...(base.dictionaryIds ? { dictionaryIds: base.dictionaryIds } : {})
    };
  }

  function mergeObjects(a: ObjectResolution, b: ObjectResolution): ObjectResolution {
    const dictionaryIds = new Set([...(a.dictionaryIds ?? []), ...(b.dictionaryIds ?? [])]);
    return {
      ...merge(a, b),
      origin: a.origin === b.origin ? a.origin : 'translation',
      ...(a.unboundedRuntimeKey || b.unboundedRuntimeKey ? { unboundedRuntimeKey: true } : {}),
      ...(dictionaryIds.size > 0 ? { dictionaryIds } : {})
    };
  }

  /**
   * Returns the key prefix a translator expression applies, or `undefined` when it is not a
   * translator. Known translator symbols answer first; otherwise `getFixedT` calls, `hook().t`,
   * `hook()[0]`, `i18next.t`, imported `t` and values typed as i18next's TFunction qualify.
   */
  function translatorPrefix(expression: Expression): StringResolution | undefined {
    const symbol = semantic.symbol(expression);
    const known = symbol ? translators.get(symbol) : undefined;
    if (known) return known;

    const unwrapped = unwrapExpression(expression);
    if (isCallExpression(unwrapped) && isGetFixedTCall(unwrapped)) {
      // i18next defines the third getFixedT argument as keyPrefix; language and namespace are separate.
      const prefix = unwrapped.arguments[2];
      return prefix ? strings.resolve(prefix) : empty();
    }
    if (isPropertyAccessExpression(unwrapped) && unwrapped.name.text === 't') {
      const hookPrefix = translationHookPrefix(unwrapped.expression);
      if (hookPrefix) return hookPrefix;
      const symbol = semantic.symbol(unwrapped.name);
      if (
        isLibrarySymbol(symbol, 't', 'i18next') ||
        isDefaultImportFrom(unwrapped.expression, 'i18next')
      ) {
        return empty();
      }
    }
    if (
      isElementAccessExpression(unwrapped) &&
      unwrapped.argumentExpression &&
      strings.resolve(unwrapped.argumentExpression).values.has('0')
    ) {
      const hookPrefix = translationHookPrefix(unwrapped.expression);
      if (hookPrefix) return hookPrefix;
    }
    const directSymbol = semantic.symbol(unwrapped);
    if (
      isImportedName(directSymbol, 't', 'i18next') ||
      isLibrarySymbol(directSymbol, 't', 'i18next') ||
      isI18nextTFunction(unwrapped)
    ) {
      return empty();
    }
    return undefined;
  }

  /** Recognizes `useTranslation` by react-i18next import provenance, including namespaces. */
  function isUseTranslationCall(expression: Expression): boolean {
    const unwrapped = unwrapExpression(expression);
    if (!isCallExpression(unwrapped)) return false;
    const callee = unwrapExpression(unwrapped.expression);
    const target = isPropertyAccessExpression(callee) ? callee.name : callee;
    const symbol = semantic.symbol(target);
    // Name-only matching would let unrelated application hooks suppress valid unused diagnostics.
    if (isImportedName(symbol, 'useTranslation', 'react-i18next')) return true;
    if (isLibrarySymbol(symbol, 'useTranslation', 'react-i18next')) return true;
    return (
      isPropertyAccessExpression(callee) &&
      callee.name.text === 'useTranslation' &&
      isNamespaceImportFrom(callee.expression, 'react-i18next')
    );
  }

  /**
   * Returns the prefix a `useTranslation` call or project hook wrapper binds, following local
   * aliases of the hook result. Cached per call; the `null` entry stored before resolving stops
   * recursion through wrappers that call each other.
   */
  function translationHookPrefix(
    expression: Expression,
    seen = new Set<Node>()
  ): StringResolution | undefined {
    const unwrapped = unwrapExpression(expression);
    if (seen.has(unwrapped)) return undefined;
    const nextSeen = new Set(seen).add(unwrapped);
    if (isIdentifier(unwrapped)) {
      // Follow local result aliases so later destructuring retains the prefix proven at hook creation.
      const declaration = semantic
        .declarations(semantic.symbol(unwrapped))
        .find(isVariableDeclaration);
      return declaration?.initializer
        ? translationHookPrefix(declaration.initializer, nextSeen)
        : undefined;
    }
    if (!isCallExpression(unwrapped)) return undefined;
    const cached = translationHookCache.get(unwrapped);
    if (cached !== undefined) return cached ?? undefined;

    translationHookCache.set(unwrapped, null);
    if (isUseTranslationCall(unwrapped)) {
      const prefix = keyPrefixFromUseTranslation(unwrapped);
      translationHookCache.set(unwrapped, prefix);
      return prefix;
    }

    const symbol = semantic.symbol(unwrapped.expression);
    const wrapper = symbol ? translationHookWrappers.get(symbol) : undefined;
    if (!wrapper) return undefined;
    let result: StringResolution | undefined;
    for (const prefix of wrapper.staticPrefixes) result = result ? merge(result, prefix) : prefix;
    for (const prefixExpression of wrapper.prefixExpressions) {
      const prefix =
        prefixExpression === null
          ? unresolved()
          : prefixExpression
            ? resolveHookPrefixArgument(prefixExpression, wrapper.owner, unwrapped)
            : empty();
      result = result ? merge(result, prefix) : prefix;
    }

    translationHookCache.set(unwrapped, result ?? null);
    return result;
  }

  /** An unreadable options argument makes the prefix unresolved; an absent one makes it empty. */
  function keyPrefixFromUseTranslation(call: CallExpression): StringResolution {
    const expression = keyPrefixExpressionFromUseTranslation(call);
    return expression === null ? unresolved() : expression ? strings.resolve(expression) : empty();
  }

  /**
   * Returns the `keyPrefix` expression of a `useTranslation` call, kept unresolved so hook
   * wrappers can resolve it per call site; `null` when unreadable, `undefined` when absent.
   */
  function keyPrefixExpressionFromUseTranslation(
    call: CallExpression
  ): Expression | null | undefined {
    const options = call.arguments[1];
    return options ? optionExpression(options, 'keyPrefix') : undefined;
  }

  /** A wrapper prefix taken from one of its parameters resolves to the argument at this call. */
  function resolveHookPrefixArgument(
    expression: Expression,
    wrapper: FunctionLikeDeclaration,
    call: CallExpression
  ): StringResolution {
    const value = unwrapExpression(expression);
    if (!isIdentifier(value)) return strings.resolve(value);
    const parameterIndex = wrapper.parameters.findIndex(
      (parameter) =>
        isIdentifier(parameter.name) && semantic.symbol(parameter.name) === semantic.symbol(value)
    );
    if (parameterIndex < 0) return strings.resolve(value);
    const argument = call.arguments[parameterIndex];
    return argument ? strings.resolve(argument) : empty();
  }

  /**
   * Finds the expression an i18next option such as `keyPrefix` or `count` is set to: `undefined`
   * when provably absent, `null` when it cannot be determined. Members are read from the last,
   * since later properties and spreads override earlier ones.
   */
  function optionExpression(
    expression: Expression,
    option: string,
    seen = new Set<Node>()
  ): Expression | null | undefined {
    const value = unwrapExpression(expression);
    if (seen.has(value)) return undefined;
    const nextSeen = new Set(seen).add(value);
    if (isIdentifier(value)) {
      const declaration = semantic.declarations(semantic.symbol(value)).find(isVariableDeclaration);
      return declaration?.initializer
        ? optionExpression(declaration.initializer, option, nextSeen)
        : null;
    }
    if (isCallExpression(value)) {
      const target = functionLikeForCall(value);
      if (!target?.body) return null;
      let returned = false;
      for (const result of returnExpressionsCached(target)) {
        returned = true;
        // Absence must hold for every branch; any concrete or unresolved option keeps the call
        // conservative because runtime interpolation helpers may also construct i18next options.
        if (optionExpression(result, option, nextSeen) !== undefined) return null;
      }
      return returned ? undefined : null;
    }
    if (!isObjectLiteralExpression(value)) return null;
    for (let index = value.properties.length - 1; index >= 0; index -= 1) {
      const property = value.properties[index]!;
      if (isSpreadAssignment(property)) {
        const spread = optionExpression(property.expression, option, nextSeen);
        if (spread !== undefined) return spread;
        continue;
      }
      if (isShorthandPropertyAssignment(property) && shorthandName(property).text === option) {
        // The value symbol stays unaliased. An imported binding is declared by its import
        // specifier, so the shorthand name itself becomes the option expression; following the
        // alias would return a declaration from the exporting module.
        const valueSymbol = semantic.shorthandValueSymbol(property);
        for (const declaration of semantic.declarations(valueSymbol)) {
          if (
            (isParameterDeclaration(declaration) || isVariableDeclaration(declaration)) &&
            isIdentifier(declaration.name)
          ) {
            return declaration.name;
          }
        }
        return shorthandName(property);
      }
      if (!isPropertyAssignment(property)) continue;
      const name = staticPropertyName(property.name);
      if (name === option) return property.initializer;
      if (name === undefined && isComputedPropertyName(property.name)) return null;
    }
    return undefined;
  }

  /**
   * Reads a boolean option such as `returnObjects` across every options argument of a call;
   * `'unknown'` when any argument may set it at runtime.
   */
  function callBooleanOption(call: CallExpression, option: string): BooleanOptionResolution {
    let unresolvedOption = false;
    for (const argument of call.arguments.slice(1)) {
      const value = unwrapExpression(argument);
      if (isIdentifier(value)) {
        const declaration = semantic
          .declarations(semantic.symbol(value))
          .find(isVariableDeclaration);
        if (declaration?.initializer) {
          const configured = booleanOption(declaration.initializer, option);
          if (configured === 'true') return 'true';
          if (configured === 'false' || configured === 'absent') continue;
          if (configured === 'unknown') unresolvedOption = true;
        } else {
          unresolvedOption = true;
        }
      } else {
        const configured = booleanOption(value, option);
        if (configured === 'true') return 'true';
        if (configured === 'false' || configured === 'absent') continue;
        if (
          isObjectLiteralExpression(value) ||
          isCallExpression(value) ||
          isPropertyAccessExpression(value) ||
          isElementAccessExpression(value)
        ) {
          unresolvedOption = true;
        }
      }
    }
    return unresolvedOption ? 'unknown' : 'absent';
  }

  /**
   * Reads one boolean option from an options expression, following variables to their
   * initializers. Members are read from the last, so later definitions win.
   */
  function booleanOption(expression: Expression, option: string): BooleanOptionResolution {
    const value = unwrapExpression(expression);
    if (isIdentifier(value)) {
      const declaration = semantic.declarations(semantic.symbol(value)).find(isVariableDeclaration);
      return declaration?.initializer ? booleanOption(declaration.initializer, option) : 'unknown';
    }
    if (!isObjectLiteralExpression(value)) {
      return isStringLiteralLikeNode(value) || isNumericLiteral(value) ? 'absent' : 'unknown';
    }
    let unresolvedSpread = false;
    for (let index = value.properties.length - 1; index >= 0; index -= 1) {
      const property = value.properties[index]!;
      if (isSpreadAssignment(property)) {
        const spread = booleanOption(property.expression, option);
        if (spread === 'true' || spread === 'false') return spread;
        if (spread === 'unknown') unresolvedSpread = true;
        continue;
      }
      if (isShorthandPropertyAssignment(property) && shorthandName(property).text === option) {
        if (unresolvedSpread) return 'unknown';
        const declaration = semantic
          .declarations(semantic.symbol(property.name))
          .find(isVariableDeclaration);
        if (!declaration?.initializer) return 'unknown';
        const initializer = unwrapExpression(declaration.initializer);
        if (initializer.kind === SyntaxKind.TrueKeyword) return 'true';
        if (initializer.kind === SyntaxKind.FalseKeyword) return 'false';
        return 'unknown';
      }
      if (!isPropertyAssignment(property)) continue;
      const name = staticPropertyName(property.name);
      if (name === option) {
        if (unresolvedSpread) return 'unknown';
        if (property.initializer.kind === SyntaxKind.TrueKeyword) return 'true';
        if (property.initializer.kind === SyntaxKind.FalseKeyword) return 'false';
        return 'unknown';
      }
      if (name === undefined) unresolvedSpread = true;
    }
    return unresolvedSpread ? 'unknown' : 'absent';
  }

  /** Keys translators by alias-resolved symbol, so an import and its target share one entry. */
  function addTranslator(symbol: TsSymbol | undefined, prefix: StringResolution): void {
    const normalized = semantic.aliased(symbol);
    if (normalized) translators.set(normalized, prefix);
  }

  /** Marks a resolved `<Trans i18nKey>`; an unbounded key becomes an unresolved warning. */
  function markResolution(resolution: StringResolution, node: Node, reason: string): void {
    markKeys([...resolution.values], 'used', node, reason);
    for (const pattern of resolution.patterns)
      markPattern(pattern, node, `${reason}: dynamic pattern`);
    if (!resolution.complete && resolution.patterns.size === 0) {
      // An unbounded runtime value has no defensible candidate set, so it remains a warning rather
      // than globally weakening unrelated `unused` classifications.
      const evidence = evidenceFor(node, 'possibly-used', `${reason}: unresolved runtime key`);
      addUnresolved(factsForNode(node), evidence);
    }
  }

  /**
   * Marks the keys of a translator or wrapper call. With count, context or ordinal options,
   * i18next looks up suffixed variants, so candidates are expanded per dictionary and locale.
   */
  function markTranslationResolution(
    resolution: StringResolution,
    variants: TranslationVariantOptions,
    node: Node,
    reason: string
  ): void {
    const facts = factsForNode(node);
    let unresolvedOptions = false;
    if (Object.keys(variants).length === 0) {
      markKeys(resolution.values, resolution.complete ? 'used' : 'possibly-used', node, reason);
    } else {
      const expansion = expandI18nextCandidates(
        { ...resolution, patterns: new Set() },
        variants,
        dictionaries.map(({ id, locale, info }) => ({ id, locale, keys: info.keys }))
      );
      unresolvedOptions = expansion.unresolved;
      const grouped = new Map<
        string,
        { key: string; confidence: 'used' | 'possibly-used'; ids: string[] }
      >();
      for (const observation of expansion.observations) {
        const identity = JSON.stringify([observation.key, observation.confidence]);
        const existing = grouped.get(identity);
        if (existing) existing.ids.push(observation.dictionaryId);
        else {
          grouped.set(identity, {
            key: observation.key,
            confidence: observation.confidence,
            ids: [observation.dictionaryId]
          });
        }
      }
      for (const observation of grouped.values()) {
        addObservation(facts, {
          kind: 'exact',
          value: observation.key,
          confidence: observation.confidence,
          evidence: evidenceFor(node, observation.confidence, reason),
          dictionaryIds: observation.ids
        });
      }
    }
    for (const pattern of resolution.patterns) {
      markPattern(pattern, node, `${reason}: dynamic pattern`);
    }
    if (unresolvedOptions) {
      const evidence = evidenceFor(node, 'possibly-used', `${reason}: unresolved runtime options`);
      addUnresolved(facts, evidence);
    }
    if (!resolution.complete && resolution.patterns.size === 0) {
      const evidence = evidenceFor(node, 'possibly-used', `${reason}: unresolved runtime key`);
      addUnresolved(facts, evidence);
    }
  }

  /**
   * Extracts the options that select i18next key variants. A `count` that is not number-typed
   * selects no plural forms, and one that may be anything marks all of them possibly used.
   */
  function translationOptions(call: CallExpression): TranslationVariantOptions {
    const options = call.arguments[1];
    if (!options) return {};
    const count = optionExpression(options, 'count');
    const context = optionExpression(options, 'context');
    const ordinal = optionExpression(options, 'ordinal');
    return {
      ...(count === undefined
        ? {}
        : count === null
          ? { count: null }
          : countType(semantic.typeAt(count)) === 'number'
            ? { count: strings.resolve(count) }
            : countType(semantic.typeAt(count)) === 'unknown'
              ? { count: null }
              : {}),
      ...(context === undefined
        ? {}
        : { context: context === null ? null : strings.resolve(context) }),
      ...(ordinal === undefined
        ? {}
        : {
            ordinal:
              ordinal === null
                ? null
                : ordinal.kind === SyntaxKind.TrueKeyword
                  ? true
                  : ordinal.kind === SyntaxKind.FalseKeyword
                    ? false
                    : null
          })
    };
  }

  /**
   * Classifies a `count` option's type for plural expansion: `'number'` selects plural forms
   * from the count's values and `'none'` selects none. `any`, `unknown`, or numbers mixed with
   * other members give `'unknown'`, which marks every plural form possibly used.
   */
  function countType(type: Type): 'number' | 'none' | 'unknown' {
    if (type.flags & (TypeFlags.Any | TypeFlags.Unknown)) return 'unknown';
    if (type.isUnionType()) {
      const kinds = new Set(type.getTypes().map(countType));
      if (kinds.has('unknown') || (kinds.has('number') && kinds.has('none'))) return 'unknown';
      return kinds.has('number') ? 'number' : 'none';
    }
    return type.flags & (TypeFlags.Number | TypeFlags.NumberLiteral) ? 'number' : 'none';
  }

  /** Used when a translation object escapes key-level analysis: everything below may be read. */
  function markSubtrees(
    resolution: StringResolution & { dictionaryIds?: ReadonlySet<string> },
    node: Node,
    reason: string
  ): void {
    for (const value of resolution.values)
      markSubtree(value, node, reason, resolution.dictionaryIds);
    for (const pattern of resolution.patterns)
      markPattern(`${pattern}*`, node, reason, resolution.dictionaryIds);
  }

  function emitStage(stage: 'discovery' | 'usage' | 'replay', status: 'start' | 'end'): void {
    try {
      options.onStage?.(stage, status);
    } catch {
      // Instrumentation cannot change source classification or cache contents.
    }
  }

  /** Records a possibly used prefix observation that covers every key below `prefix`. */
  function markSubtree(
    prefix: string,
    node: Node,
    reason: string,
    dictionaryIds?: ReadonlySet<string>
  ): void {
    const normalized = prefix ? `${prefix}.` : '';
    addObservation(factsForNode(node), {
      kind: 'prefix',
      value: normalized,
      confidence: 'possibly-used',
      evidence: evidenceFor(node, 'possibly-used', reason),
      ...(dictionaryIds ? { dictionaryIds: [...dictionaryIds] } : {})
    });
  }

  /** Records a possibly used wildcard observation, as produced by dynamic key segments. */
  function markPattern(
    pattern: string,
    node: Node,
    reason: string,
    dictionaryIds?: ReadonlySet<string>
  ): void {
    addObservation(factsForNode(node), {
      kind: 'pattern',
      value: pattern,
      confidence: 'possibly-used',
      evidence: evidenceFor(node, 'possibly-used', reason),
      ...(dictionaryIds ? { dictionaryIds: [...dictionaryIds] } : {})
    });
  }

  /** Records exact key observations that share one evidence location. */
  function markKeys(
    candidateKeys: Iterable<string>,
    confidence: 'used' | 'possibly-used',
    node: Node,
    reason: string,
    dictionaryIds?: ReadonlySet<string>
  ): void {
    const evidence = evidenceFor(node, confidence, reason);
    const facts = factsForNode(node);
    for (const key of candidateKeys) {
      addObservation(facts, {
        kind: 'exact',
        value: key,
        confidence,
        evidence,
        ...(dictionaryIds ? { dictionaryIds: [...dictionaryIds] } : {})
      });
    }
  }

  function addObservation(facts: SourceUsageFacts, observation: UsageObservation): void {
    const normalized = observation.dictionaryIds
      ? { ...observation, dictionaryIds: [...new Set(observation.dictionaryIds)].sort() }
      : observation;
    let identities = observationIdentities.get(facts);
    if (!identities) {
      identities = new Set();
      observationIdentities.set(facts, identities);
    }
    const identity = observationIdentity(normalized);
    if (identities.has(identity)) return;
    identities.add(identity);
    facts.observations.push(normalized);
  }

  function addUnresolved(facts: SourceUsageFacts, evidence: UsageEvidence): void {
    let identities = unresolvedIdentities.get(facts);
    if (!identities) {
      identities = new Set();
      unresolvedIdentities.set(facts, identities);
    }
    const identity = evidenceIdentity(evidence);
    if (identities.has(identity)) return;
    identities.add(identity);
    facts.unresolvedReferences.push(evidence);
  }

  function addTranslationObjectCast(facts: SourceUsageFacts, evidence: UsageEvidence): void {
    let identities = translationObjectCastIdentities.get(facts);
    if (!identities) {
      identities = new Set();
      translationObjectCastIdentities.set(facts, identities);
    }
    const identity = evidenceIdentity(evidence);
    if (identities.has(identity)) return;
    identities.add(identity);
    facts.translationObjectCasts.push(evidence);
  }

  /**
   * Files facts under the file of the node that produced them, so the cache can replay them
   * per file. A file outside the analyzed set gets its bucket on first use.
   */
  function factsForNode(node: Node): SourceUsageFacts {
    const fileName = path.resolve(node.getSourceFile().fileName);
    let facts = freshFacts.get(fileName);
    if (!facts) {
      facts = {
        fileName,
        observations: [],
        unresolvedReferences: [],
        translationObjectCasts: []
      };
      freshFacts.set(fileName, facts);
    }
    return facts;
  }

  /**
   * Evidence holds a project-relative path and 1-based line and column, so it survives the
   * cache and lint can relocate it after the compiler process closes.
   */
  function evidenceFor(
    node: Node,
    confidence: 'used' | 'possibly-used',
    reason: string
  ): UsageEvidence {
    const source = node.getSourceFile();
    const location = source.getLineAndCharacterOfPosition(node.getStart(source));
    return {
      confidence,
      file: path.relative(projectRoot, source.fileName),
      line: location.line + 1,
      column: location.character + 1,
      reason
    };
  }

  /** Uses the inventory's return index and walks the body only for functions outside it. */
  function returnExpressionsCached(node: FunctionLikeDeclaration): readonly Expression[] {
    const cached = returnExpressionCache.get(node);
    if (cached) return cached;
    const indexed = indexedReturns.get(node);
    const expressions = indexed ?? returnExpressions(node);
    returnExpressionCache.set(node, expressions);
    return expressions;
  }

  /**
   * A reassigned parameter no longer carries the caller's key, which disqualifies its function
   * as a wrapper. Uses the assignment index for inventoried functions and a body walk otherwise.
   */
  function parameterIsReassignedCached(
    parameter: ParameterDeclaration,
    owner: FunctionLikeDeclaration
  ): boolean {
    const cached = reassignmentCache.get(parameter);
    if (cached !== undefined) return cached;
    const symbol = isIdentifier(parameter.name) ? semantic.symbol(parameter.name) : undefined;
    const indexed = symbol
      ? (assignmentIndex.get(symbol) ?? []).some((assignment) => assignment.owner === owner)
      : false;
    const result =
      indexed || (!inventoriedFunctions.has(owner) && parameterIsReassigned(parameter, owner));
    reassignmentCache.set(parameter, result);
    return result;
  }

  /** Resolves the function a call invokes; see functionLikeForExpression. */
  function functionLikeForCall(call: CallExpression): FunctionLikeDeclaration | undefined {
    return functionLikeForExpression(call.expression);
  }

  /**
   * Resolves a callee or JSX tag to a function: a function-like declaration, a function or arrow
   * initializer, or the render callback of `forwardRef`. Its answers depend only on Semantic,
   * so prefetch lookahead may call it in any order.
   */
  function functionLikeForExpression(expression: Node): FunctionLikeDeclaration | undefined {
    const cached = functionLikeCache.get(expression);
    if (cached !== undefined) return cached ?? undefined;
    const symbol = semantic.symbol(expression);
    for (const declaration of semantic.declarations(symbol)) {
      if (isConcreteFunctionLike(declaration)) {
        functionLikeCache.set(expression, declaration);
        return declaration;
      }
      if (isVariableDeclaration(declaration) && declaration.initializer) {
        const initializer = unwrapExpression(declaration.initializer);
        if (isArrowFunction(initializer) || isFunctionExpression(initializer)) {
          functionLikeCache.set(expression, initializer);
          return initializer;
        }
        if (isCallExpression(initializer) && isReactForwardRefCall(initializer)) {
          const render = initializer.arguments[0]
            ? unwrapExpression(initializer.arguments[0])
            : undefined;
          if (render && (isArrowFunction(render) || isFunctionExpression(render))) {
            // Restrict this to proven transparent React wrappers. Arbitrary higher-order functions
            // may store, transform, or ignore callbacks, so matching callback and response types is
            // not enough to prove value provenance. Resolving signatures for every call also added
            // material checker time on giant projects; JSX inputs therefore bind only through
            // wrapper contracts whose runtime identity semantics are known.
            functionLikeCache.set(expression, render);
            return render;
          }
        }
      }
    }
    functionLikeCache.set(expression, null);
    return undefined;
  }

  /**
   * Returns the symbol hooks and wrappers are registered under: the function's own name, or the
   * variable an anonymous function initializes. Callers reach the same symbol through their
   * callee, so lookups by call site match.
   */
  function symbolForFunction(node: FunctionLikeDeclaration): TsSymbol | undefined {
    const name = functionName(node);
    if (name) return semantic.symbol(name);
    if (isVariableDeclaration(node.parent) && isIdentifier(node.parent.name)) {
      return semantic.symbol(node.parent.name);
    }
    return undefined;
  }

  /** Declaration-only factories are rare enough to resolve without typing every arbitrary call. */
  function dictionaryIdsForDeclaredType(typeNode: TypeNode): ReadonlySet<string> {
    return dictionaryIdsForType(semantic.typeFromTypeNode(typeNode));
  }

  /** Matches a function's declared or inferred return type to dictionaries, once per function. */
  function dictionaryIdsForFunctionReturn(target: FunctionLikeDeclaration): ReadonlySet<string> {
    const cached = dictionaryReturnIdsCache.get(target);
    if (cached) return cached;
    // Dictionary identity belongs to the function contract, not each invocation; resolving the
    // declaration once avoids re-checking large call expressions throughout the project.
    const ids = dictionaryIdsForType(
      semantic.returnType(semantic.signatureFromDeclaration(target))
    );
    dictionaryReturnIdsCache.set(target, ids);
    return ids;
  }

  /**
   * Matches a type to dictionaries by identity or by its alias-resolved alias or type symbol.
   * Unresolvable aliases map to `undefined`, so they never match each other.
   */
  function dictionaryIdsForType(type: Type): ReadonlySet<string> {
    const typeSymbol = semantic.aliased(type.getAliasSymbol() ?? type.getSymbol());
    const ids = new Set<string>();
    for (const target of dictionaries) {
      const dictionaryType = target.info.declaredType;
      const dictionarySymbol = semantic.aliased(
        dictionaryType.getAliasSymbol() ?? dictionaryType.getSymbol()
      );
      if (type === dictionaryType || (typeSymbol && typeSymbol === dictionarySymbol)) {
        ids.add(target.id);
      }
    }
    return ids;
  }

  function hasDescendants(prefix: string): boolean {
    return dictionaryPrefixes.has(prefix);
  }

  function dictionaryLeaves(values: ReadonlySet<string>): string[] {
    const leaves: string[] = [];
    for (const value of values) {
      if (dictionary.keys.has(value)) leaves.push(value);
    }
    return leaves;
  }

  /**
   * Reports an import of `importedName` from `moduleName`. The import statement proves package
   * origin even when the package's own declarations are never resolved.
   */
  function isImportedName(
    symbol: TsSymbol | undefined,
    importedName: string,
    moduleName: string
  ): boolean {
    // Only alias symbols carry ImportSpecifier declarations. Checking the flag first avoids
    // resolving the declarations of every callee, which would transfer lib.dom.d.ts for a lone
    // `console.log` call.
    if (!symbol || (symbol.flags & SymbolFlags.Alias) === 0) return false;
    return Boolean(
      semantic.declarations(symbol).some((declaration) => {
        if (!isImportSpecifier(declaration)) return false;
        const originalName = declaration.propertyName?.text ?? declaration.name.text;
        const importDeclaration = declaration.parent.parent.parent;
        return (
          originalName === importedName &&
          isImportDeclaration(importDeclaration) &&
          isStringLiteral(importDeclaration.moduleSpecifier) &&
          importDeclaration.moduleSpecifier.text === moduleName
        );
      })
    );
  }

  /**
   * Recognizes i18next `getFixedT` calls. The callee symbol stays raw because isImportedName
   * needs the ImportSpecifier, and isLibrarySymbol unwraps on its own.
   */
  function isGetFixedTCall(call: CallExpression): boolean {
    const callee = unwrapExpression(call.expression);
    const target = isPropertyAccessExpression(callee) ? callee.name : callee;
    const symbol = semantic.rawSymbol(target);
    if (isImportedName(symbol, 'getFixedT', 'i18next')) return true;
    if (isLibrarySymbol(symbol, 'getFixedT', 'i18next')) return true;
    return (
      isPropertyAccessExpression(callee) &&
      callee.name.text === 'getFixedT' &&
      (isDefaultImportFrom(callee.expression, 'i18next') ||
        isNamespaceImportFrom(callee.expression, 'i18next'))
    );
  }

  /** Recognizes React `useMemo` calls, keeping the raw callee symbol as isGetFixedTCall does. */
  function isReactUseMemoCall(call: CallExpression): boolean {
    const callee = unwrapExpression(call.expression);
    const target = isPropertyAccessExpression(callee) ? callee.name : callee;
    const symbol = semantic.rawSymbol(target);
    if (isImportedName(symbol, 'useMemo', 'react') || isLibrarySymbol(symbol, 'useMemo', 'react')) {
      return true;
    }
    return (
      isPropertyAccessExpression(callee) &&
      callee.name.text === 'useMemo' &&
      (isDefaultImportFrom(callee.expression, 'react') ||
        isNamespaceImportFrom(callee.expression, 'react'))
    );
  }

  /** Recognizes React `forwardRef`, whose render callback receives the wrapper's props as-is. */
  function isReactForwardRefCall(call: CallExpression): boolean {
    const callee = unwrapExpression(call.expression);
    const target = isPropertyAccessExpression(callee) ? callee.name : callee;
    // Keep the import alias here: @types/react declares `forwardRef` under namespace React, so
    // unwrapping first loses the ImportSpecifier that proves its package origin.
    const symbol = semantic.rawSymbol(target);
    if (
      isImportedName(symbol, 'forwardRef', 'react') ||
      isLibrarySymbol(symbol, 'forwardRef', 'react')
    ) {
      return true;
    }
    return (
      isPropertyAccessExpression(callee) &&
      callee.name.text === 'forwardRef' &&
      (isDefaultImportFrom(callee.expression, 'react') ||
        isNamespaceImportFrom(callee.expression, 'react'))
    );
  }

  /**
   * Reports a value typed as i18next's TFunction, for translators that come from declarations
   * only, such as a typed prop. A syntactic provenance check runs first, so arbitrary callees
   * are never typed; the type must then have a call signature and lead to i18next's `TFunction`
   * or a `t` member. Cached per expression.
   */
  function isI18nextTFunction(expression: Expression): boolean {
    const cached = i18nextTFunctionCache.get(expression);
    if (cached !== undefined) return cached;
    if (!hasPlausibleI18nextTProvenance(expression)) {
      i18nextTFunctionCache.set(expression, false);
      return false;
    }
    // Type provenance supports declaration-only TFunction values without accepting structural lookalikes.
    const type = semantic.typeAt(expression);
    if (type.getCallSignatures().length === 0) {
      i18nextTFunctionCache.set(expression, false);
      return false;
    }
    const symbols = [type.getAliasSymbol(), type.getSymbol()];
    if (
      symbols.some(
        (symbol) =>
          symbol?.name === 'TFunction' &&
          semantic
            .declarations(symbol)
            .some((declaration) => declarationBelongsToPackage(declaration, 'i18next'))
      )
    ) {
      i18nextTFunctionCache.set(expression, true);
      return true;
    }
    if (
      symbols.some((symbol) =>
        semantic
          .declarations(symbol)
          .some((declaration) => declarationHasI18nextTProvenance(declaration, new Set()))
      )
    ) {
      i18nextTFunctionCache.set(expression, true);
      return true;
    }
    const result = type.getCallSignatures().some((signature) => {
      const declaration = semantic.signatureDeclaration(signature);
      if (!declaration || !declarationBelongsToPackage(declaration, 'i18next')) return false;
      let current: Node | undefined = declaration;
      while (current) {
        if (
          ((isInterfaceDeclaration(current) || isTypeAliasDeclaration(current)) &&
            current.name.text === 'TFunction') ||
          (isPropertySignatureDeclaration(current) && current.name.getText() === 't')
        ) {
          return true;
        }
        current = current.parent;
      }
      return false;
    });
    i18nextTFunctionCache.set(expression, result);
    return result;
  }

  /** Syntactic gate in front of the type lookup in isI18nextTFunction. */
  function hasPlausibleI18nextTProvenance(expression: Expression): boolean {
    return expressionHasI18nextTProvenance(unwrapExpression(expression), new Set());
  }

  /**
   * Follows calls, returned values, forwarded parameters and declarations to a value that could
   * come from i18next. `seen` is shared across the walk to stop cycles.
   */
  function expressionHasI18nextTProvenance(expression: Expression, seen: Set<Node>): boolean {
    const value = unwrapExpression(expression);
    if (seen.has(value)) return false;
    seen.add(value);

    if (isCallExpression(value)) {
      if (isGetFixedTCall(value)) return true;
      const target = functionLikeForCall(value);
      if (!target) return false;
      if (target.type && typeNodeHasI18nextTProvenance(target.type, seen)) return true;
      for (const returned of returnExpressionsCached(target)) {
        const returnedValue = unwrapExpression(returned);
        if (isIdentifier(returnedValue)) {
          const parameterIndex = target.parameters.findIndex(
            (parameter) =>
              isIdentifier(parameter.name) &&
              semantic.symbol(parameter.name) === semantic.symbol(returnedValue)
          );
          const argument = parameterIndex >= 0 ? value.arguments[parameterIndex] : undefined;
          if (argument && expressionHasI18nextTProvenance(argument, seen)) return true;
        }
        if (expressionHasI18nextTProvenance(returnedValue, seen)) return true;
      }
      return false;
    }

    const symbol = semantic.symbol(value);
    if (!symbol) return false;
    if (translators.has(symbol)) return true;
    return semantic
      .declarations(symbol)
      .some((declaration) => declarationHasI18nextTProvenance(declaration, seen));
  }

  /**
   * Checks a declaration's annotation, initializer, destructuring source, alias target or
   * heritage for i18next translator provenance. Untyped callback parameters pass, since only the
   * checker knows their contextual type.
   */
  function declarationHasI18nextTProvenance(declaration: Declaration, seen: Set<Node>): boolean {
    if (seen.has(declaration)) return false;
    seen.add(declaration);
    if (isI18nextTranslatorDeclaration(declaration)) return true;
    if (
      isParameterDeclaration(declaration) &&
      !writtenType(declaration.type) &&
      (isArrowFunction(declaration.parent) || isFunctionExpression(declaration.parent)) &&
      isCallExpression(declaration.parent.parent) &&
      declaration.parent.parent.arguments.includes(declaration.parent)
    ) {
      // Contextual callback types are available only through the checker at the call site.
      return true;
    }

    const annotation =
      isVariableDeclaration(declaration) ||
      isParameterDeclaration(declaration) ||
      isPropertyDeclaration(declaration) ||
      isPropertySignatureDeclaration(declaration)
        ? writtenType(declaration.type)
        : undefined;
    if (annotation && typeNodeHasI18nextTProvenance(annotation, seen)) return true;
    if (isVariableDeclaration(declaration) && declaration.initializer) {
      return expressionHasI18nextTProvenance(declaration.initializer, seen);
    }
    if (isBindingElement(declaration)) {
      const variable = declaration.parent.parent;
      return isVariableDeclaration(variable) && variable.initializer
        ? expressionHasI18nextTProvenance(variable.initializer, seen)
        : false;
    }
    if (isTypeAliasDeclaration(declaration)) {
      return typeNodeHasI18nextTProvenance(declaration.type, seen);
    }
    if (isInterfaceDeclaration(declaration)) {
      return (
        declaration.heritageClauses?.some((clause) =>
          clause.types.some((type) => typeNodeHasI18nextTProvenance(type, seen))
        ) ?? false
      );
    }
    return false;
  }

  /** Reports a declaration in i18next's typings that is, or sits inside, TFunction or `t`. */
  function isI18nextTranslatorDeclaration(declaration: Declaration): boolean {
    if (!declarationBelongsToPackage(declaration, 'i18next')) return false;
    let current: Node | undefined = declaration;
    while (current) {
      if (
        ((isInterfaceDeclaration(current) || isTypeAliasDeclaration(current)) &&
          current.name.text === 'TFunction') ||
        ((isVariableDeclaration(current) || isFunctionDeclaration(current)) &&
          current.name &&
          isIdentifier(current.name) &&
          current.name.text === 't') ||
        ((isPropertyDeclaration(current) ||
          isPropertySignatureDeclaration(current) ||
          isMethodDeclaration(current) ||
          isMethodSignatureDeclaration(current)) &&
          current.name &&
          staticPropertyName(current.name) === 't')
      ) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  /**
   * Follows type references and heritage expressions to an i18next translator declaration.
   * Heritage clause entries are typed apart from type nodes, so both are accepted.
   */
  function typeNodeHasI18nextTProvenance(
    typeNode: TypeNode | HeritageClauseElement,
    seen: Set<Node>
  ): boolean {
    if (seen.has(typeNode)) return false;
    seen.add(typeNode);
    if (isParenthesizedTypeNode(typeNode)) {
      return typeNodeHasI18nextTProvenance(typeNode.type, seen);
    }
    if (isUnionTypeNode(typeNode) || isIntersectionTypeNode(typeNode)) {
      return typeNode.types.some((type) => typeNodeHasI18nextTProvenance(type, seen));
    }
    const typeName = isTypeReferenceNode(typeNode)
      ? typeNode.typeName
      : isExpressionWithTypeArguments(typeNode)
        ? typeNode.expression
        : undefined;
    if (!typeName) return false;
    // The lookup must target the type name node as written. semantic.symbol would query only
    // the `B` of an `extends a.B` property access, so the alias is unwrapped here instead.
    const symbol = semantic.aliased(semantic.rawSymbol(typeName));
    return semantic
      .declarations(symbol)
      .some((declaration) => declarationHasI18nextTProvenance(declaration, seen));
  }

  /**
   * Cheap gate in front of translationHookPrefix: a `useTranslation` call, a call to a known
   * hook wrapper, or a variable initialized with either.
   */
  function couldBeTranslationHookResult(expression: Expression, seen = new Set<Node>()): boolean {
    const value = unwrapExpression(expression);
    if (seen.has(value)) return false;
    seen.add(value);
    if (isIdentifier(value)) {
      const declaration = semantic.declarations(semantic.symbol(value)).find(isVariableDeclaration);
      return Boolean(
        declaration?.initializer && couldBeTranslationHookResult(declaration.initializer, seen)
      );
    }
    if (!isCallExpression(value)) return false;
    if (isUseTranslationCall(value)) return true;
    const symbol = semantic.symbol(value.expression);
    return Boolean(symbol && translationHookWrappers.has(symbol));
  }

  /**
   * Gate in front of translatorPrefix for variable initializers and call arguments, so only
   * values with plausible translator provenance pay for full prefix resolution.
   */
  function isPotentialTranslatorExpression(expression: Expression): boolean {
    const value = unwrapExpression(expression);
    if (
      !isIdentifier(value) &&
      !isCallExpression(value) &&
      !isPropertyAccessExpression(value) &&
      !isElementAccessExpression(value)
    ) {
      return false;
    }
    if (isCallExpression(value)) {
      return isGetFixedTCall(value) || expressionHasI18nextTProvenance(value, new Set());
    }
    const symbol = semantic.symbol(value);
    if (symbol && translators.has(symbol)) return true;
    if (isPropertyAccessExpression(value) && value.name.text === 't') {
      return (
        couldBeTranslationHookResult(value.expression) ||
        isDefaultImportFrom(value.expression, 'i18next') ||
        isLibrarySymbol(semantic.rawSymbol(value.name), 't', 'i18next') ||
        expressionHasI18nextTProvenance(value, new Set())
      );
    }
    if (
      isElementAccessExpression(value) &&
      value.argumentExpression &&
      ((isNumericLiteral(value.argumentExpression) && value.argumentExpression.text === '0') ||
        (isStringLiteral(value.argumentExpression) && value.argumentExpression.text === '0'))
    ) {
      return couldBeTranslationHookResult(value.expression);
    }
    return (
      isImportedName(semantic.rawSymbol(value), 't', 'i18next') ||
      expressionHasI18nextTProvenance(value, new Set())
    );
  }

  /** Applies a call-level `keyPrefix`; a literal `null` or `undefined` keeps the bound prefix. */
  function mergePrefixOverride(
    boundPrefix: StringResolution,
    expression: Expression
  ): StringResolution {
    const value = unwrapExpression(expression);
    if (
      value.kind === SyntaxKind.NullKeyword ||
      (isIdentifier(value) && value.text === 'undefined')
    ) {
      return boundPrefix;
    }
    const override = strings.resolve(value);
    // An optional runtime override may fall back to the bound prefix, so neither branch is discarded.
    return override.complete ? override : merge(boundPrefix, override);
  }

  /**
   * Reports whether `symbol`, after alias resolution, is `exportedName` declared by `packageName`.
   * Callers may pass raw symbols, so the unwrap happens here.
   */
  function isLibrarySymbol(
    symbol: TsSymbol | undefined,
    exportedName: string,
    packageName: string
  ): boolean {
    const normalized = semantic.aliased(symbol);
    return Boolean(
      normalized?.name === exportedName &&
        semantic
          .declarations(normalized)
          .some((declaration) => declarationBelongsToPackage(declaration, packageName))
    );
  }

  /**
   * Reports a declaration from `packageName`: installed typings under
   * `node_modules/<package>/`, or an ambient `declare module '<package>'` block, as tests and
   * projects without the package installed use. Reads only the node and its file path.
   */
  function declarationBelongsToPackage(declaration: Node, packageName: string): boolean {
    const marker = `${path.sep}node_modules${path.sep}${packageName}${path.sep}`;
    if (path.resolve(declaration.getSourceFile().fileName).includes(marker)) return true;
    let current: Node | undefined = declaration;
    while (current) {
      if (
        isModuleDeclaration(current) &&
        isStringLiteral(current.name) &&
        current.name.text === packageName
      ) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  /**
   * Reports a default import binding from `packageName`. The lookup stays raw because the import
   * clause declares the alias symbol, never its target.
   */
  function isDefaultImportFrom(expression: Expression, packageName: string): boolean {
    const symbol = semantic.rawSymbol(unwrapExpression(expression));
    return Boolean(
      semantic.declarations(symbol).some((declaration) => {
        if (!isImportClause(declaration)) return false;
        const importDeclaration = declaration.parent;
        return (
          isImportDeclaration(importDeclaration) &&
          isStringLiteral(importDeclaration.moduleSpecifier) &&
          importDeclaration.moduleSpecifier.text === packageName
        );
      })
    );
  }

  /**
   * Reports a namespace import binding from `packageName`. The lookup stays raw because the
   * namespace import declares the alias symbol, never its target.
   */
  function isNamespaceImportFrom(expression: Expression, packageName: string): boolean {
    const symbol = semantic.rawSymbol(unwrapExpression(expression));
    return Boolean(
      semantic.declarations(symbol).some((declaration) => {
        if (!isNamespaceImport(declaration)) return false;
        const importDeclaration = declaration.parent.parent;
        return (
          isImportDeclaration(importDeclaration) &&
          isStringLiteral(importDeclaration.moduleSpecifier) &&
          importDeclaration.moduleSpecifier.text === packageName
        );
      })
    );
  }
}

/** Returns a member name known without the checker, including literal computed names. */
function staticPropertyName(name: PropertyName): string | undefined {
  if (isIdentifier(name) || isStringLiteral(name) || isNumericLiteral(name)) {
    return name.text;
  }
  if (isComputedPropertyName(name)) {
    const expression = unwrapExpression(name.expression);
    if (isStringLiteral(expression) || isNumericLiteral(expression)) return expression.text;
  }
  return undefined;
}

/** Returns the property a binding element reads: its property name, else its own name. */
function staticBindingElementName(element: BindingElement): string | undefined {
  if (element.propertyName) return staticPropertyName(element.propertyName);
  return element.name && isIdentifier(element.name) ? element.name.text : undefined;
}

/**
 * Returns the identifier of a shorthand property. The parser only produces identifiers there,
 * but the AST types the name through the shared member base as any property name.
 */
function shorthandName(property: ShorthandPropertyAssignment): Identifier {
  return property.name as Identifier;
}

/**
 * Returns the declared name of a function-like node. Constructor and arrow function types have
 * no `name` member, so they are excluded before reading it.
 */
function functionName(node: FunctionLikeDeclaration): PropertyName | undefined {
  return isConstructorDeclaration(node) || isArrowFunction(node) ? undefined : node.name;
}

/**
 * Reports a type whose values are all strings. An access on such a base, as in
 * `dictionary.title.length`, reads a string member, so it marks the dictionary leaf instead of
 * appending `length` as a key segment. `any` and `unknown` never qualify; a union needs every
 * member to qualify and an intersection one.
 */
function isDefinitelyStringLike(type: Type): boolean {
  if (type.flags & (TypeFlags.Any | TypeFlags.Unknown)) return false;
  if (type.flags & TypeFlags.StringLike) return true;
  if (type.isUnionType()) {
    const types = type.getTypes();
    return types.length > 0 && types.every(isDefinitelyStringLike);
  }
  if (type.isIntersectionType()) return type.getTypes().some(isDefinitelyStringLike);
  return false;
}

/** Returns the `t` member of a returned object literal, which makes its function a hook. */
function returnedTranslatorProperty(
  property: ObjectLiteralElementLike,
  source: SourceFile
): Expression | undefined {
  if (isShorthandPropertyAssignment(property) && shorthandName(property).text === 't')
    return shorthandName(property);
  if (!isPropertyAssignment(property)) return undefined;
  const name = property.name.getText(source).replaceAll(/['"]/g, '');
  return name === 't' ? property.initializer : undefined;
}

/** `Object.keys`, `values` and `entries` read every key of their argument at runtime. */
function isEnumerationCall(call: CallExpression): boolean {
  const expression = unwrapExpression(call.expression);
  return (
    isPropertyAccessExpression(expression) &&
    expression.expression.getText() === 'Object' &&
    ['keys', 'values', 'entries'].includes(expression.name.text)
  );
}

/** Reports the receiver of a further access; only the outermost access of a chain is analyzed. */
function isObjectChainBase(node: Expression): boolean {
  const parent = node.parent;
  return (
    (isPropertyAccessExpression(parent) && parent.expression === node) ||
    (isElementAccessExpression(parent) && parent.expression === node)
  );
}

/** Reports a value that is only stored or returned; it is analyzed where it is later read. */
function isAliasOrReturn(node: Expression): boolean {
  const parent = node.parent;
  return (
    (isVariableDeclaration(parent) && parent.initializer === node) ||
    (isBinaryExpression(parent) &&
      parent.right === node &&
      parent.operatorToken.kind === SyntaxKind.EqualsToken) ||
    isReturnStatement(parent) ||
    (isArrowFunction(parent) && parent.body === node)
  );
}

/**
 * Returns the outermost source cast around a `returnObjects` call, looking through parentheses,
 * `!` and `satisfies`, so `--remove` deletes every chained cast.
 */
function translationObjectCast(call: CallExpression): AsExpression | TypeAssertion | undefined {
  let expression: Expression = call;
  let result: AsExpression | TypeAssertion | undefined;
  while (true) {
    const parent = expression.parent;
    if ((isAsExpression(parent) || isTypeAssertion(parent)) && parent.expression === expression) {
      if (isSourceAssertion(parent)) result = parent;
      expression = parent;
      continue;
    }
    if (
      (isParenthesizedExpression(parent) ||
        isNonNullExpression(parent) ||
        isSatisfiesExpression(parent)) &&
      parent.expression === expression
    ) {
      expression = parent;
      continue;
    }
    return result;
  }
}

/**
 * Returns an options argument cast through `any`, `unknown` or `never`, which hides
 * `returnObjects: true` from the call's type and is reported for removal.
 */
function unsafeTranslationArgumentCast(
  argument: Expression
): AsExpression | TypeAssertion | undefined {
  let expression = skipCastWrappers(argument);
  if (!isSourceAssertion(expression)) return undefined;
  const outermost = expression;
  while (isSourceAssertion(expression)) {
    if (
      expression.type.kind === SyntaxKind.AnyKeyword ||
      expression.type.kind === SyntaxKind.UnknownKeyword ||
      expression.type.kind === SyntaxKind.NeverKeyword
    ) {
      return outermost;
    }
    expression = skipCastWrappers(expression.expression);
  }
  return undefined;
}

/**
 * Skips wrappers that sit between casts without being casts themselves: parentheses, `!`,
 * `satisfies`, and JSDoc type comments that JavaScript files parse as assertions.
 */
function skipCastWrappers(input: Expression): Expression {
  let expression = input;
  while (
    isParenthesizedExpression(expression) ||
    isNonNullExpression(expression) ||
    isSatisfiesExpression(expression) ||
    ((isAsExpression(expression) || isTypeAssertion(expression)) && !isSourceAssertion(expression))
  ) {
    expression = expression.expression;
  }
  return expression;
}

/**
 * Reports a `returnObjects` call whose object escapes property-level analysis. Storing it in a
 * variable, accessing it, or returning it from a non-exported function keeps it analyzable,
 * since the variable, the access or the function's callers are analyzed instead.
 */
function isUnconsumedObjectCall(call: CallExpression): boolean {
  let value: Expression = call;
  while (
    isParenthesizedExpression(value.parent) ||
    isAsExpression(value.parent) ||
    isTypeAssertion(value.parent) ||
    isNonNullExpression(value.parent) ||
    isSatisfiesExpression(value.parent)
  ) {
    value = value.parent;
  }
  const parent = value.parent;
  if (isReturnStatement(parent) || (isArrowFunction(parent) && parent.body === value)) {
    const owner = enclosingFunction(call);
    return !owner || isExported(owner);
  }
  return !(
    (isVariableDeclaration(parent) && parent.initializer === value) ||
    (isPropertyAccessExpression(parent) && parent.expression === value) ||
    (isElementAccessExpression(parent) && parent.expression === value)
  );
}

/** Returns the innermost concrete function around a node, which scopes wrapper checks. */
function enclosingFunction(node: Node): FunctionLikeDeclaration | undefined {
  let current: Node | undefined = node.parent;
  while (current) {
    if (isConcreteFunctionLike(current)) return current;
    current = current.parent;
  }
  return undefined;
}

/**
 * Name-based reassignment check for functions outside the assignment index. Nested functions
 * are not searched.
 */
function parameterIsReassigned(
  parameter: ParameterDeclaration,
  owner: FunctionLikeDeclaration
): boolean {
  if (!isIdentifier(parameter.name) || !owner.body) return false;
  const sourceName = parameter.name.text;
  let reassigned = false;
  /** Stops at the first matching assignment and at nested function boundaries. */
  function visit(node: Node): void {
    const left = isBinaryExpression(node) ? unwrapExpression(node.left) : undefined;
    if (
      isBinaryExpression(node) &&
      node.operatorToken.kind === SyntaxKind.EqualsToken &&
      left &&
      isIdentifier(left) &&
      left.text === sourceName
    ) {
      reassigned = true;
      return;
    }
    if (node !== owner.body && isSignatureDeclaration(node)) return;
    node.forEachChild(visit);
  }
  visit(owner.body);
  return reassigned;
}

/**
 * Reports a direct `export` modifier. The modifier list also holds decorators, which the kind
 * check skips. Only the node's own modifiers count, so the arrow function of
 * `export const f = () => ...` is not reported as exported.
 */
function isExported(node: FunctionLikeDeclaration): boolean {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword));
}

/**
 * Collects a function's returned values, mirroring the inventory's return index for functions
 * that were not inventoried.
 */
function returnExpressions(node: FunctionLikeDeclaration): Expression[] {
  if (!node.body) return [];
  if (!isBlock(node.body)) return [node.body];
  const expressions: Expression[] = [];
  /** Skips nested functions, whose returns belong to them. */
  function visit(child: Node): void {
    if (isReturnStatement(child) && child.expression) {
      expressions.push(child.expression);
      return;
    }
    if (child !== node.body && isSignatureDeclaration(child)) return;
    child.forEachChild(visit);
  }
  visit(node.body);
  return expressions;
}

/** Returns the expression of a `{...}` attribute value; string attributes have none. */
function jsxAttributeExpression(initializer: JsxAttributeValue): Expression | undefined {
  return isJsxExpression(initializer) ? initializer.expression : undefined;
}

function signatureOf(resolution: StringResolution): string {
  return JSON.stringify({
    values: [...resolution.values].sort(),
    patterns: [...resolution.patterns].sort(),
    complete: resolution.complete
  });
}

function sameResolution(left: StringResolution, right: StringResolution): boolean {
  return (
    left.complete === right.complete &&
    left.values.size === right.values.size &&
    left.patterns.size === right.patterns.size &&
    [...left.values].every((value) => right.values.has(value)) &&
    [...left.patterns].every((pattern) => right.patterns.has(pattern))
  );
}

function evidenceIdentity(evidence: UsageEvidence): string {
  return JSON.stringify([
    evidence.confidence,
    evidence.file,
    evidence.line,
    evidence.column,
    evidence.reason
  ]);
}

function observationIdentity(observation: UsageObservation): string {
  return JSON.stringify([
    observation.kind,
    observation.value,
    observation.confidence,
    observation.dictionaryIds,
    evidenceIdentity(observation.evidence)
  ]);
}

/** Function-like nodes that can own a body; signatures and function types are excluded. */
function isConcreteFunctionLike(node: Node): node is FunctionLikeDeclaration {
  return (
    isFunctionDeclaration(node) ||
    isMethodDeclaration(node) ||
    isConstructorDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node) ||
    isFunctionExpression(node) ||
    isArrowFunction(node)
  );
}

/**
 * Lists the nodes that discovery and usage analysis later hand to `semantic.symbol` or
 * `semantic.rawSymbol`, so one batched request answers them before the first lookup.
 *
 * Every entry must be the exact node a later lookup receives, because the caches are keyed by
 * node identity. `semantic.symbol` reads a property access through its name, so the name is
 * collected in that case. A missed node falls back to a single request, so this list affects
 * request count and never results. Extra entries still cost server time: resolving a property
 * name type-checks its receiver, so property accesses are listed only where a lookup always
 * follows.
 *
 * Key types are not prefetched. No key type lookup is unconditional, and string resolution
 * deliberately skips typing keys declared with expensive i18next types; batching key types up
 * front would force exactly those computations. Other types are batched elsewhere:
 * `objectChainTypeTargets` collects the base types of access chains rooted in a dictionary or
 * translation object, and `prefetchCallTargetTypes` the return types of call targets.
 */
function collectSemanticTargets(inventory: SourceInventory): Node[] {
  const targets: Node[] = [];
  const addSymbolSite = (node: Node): void => {
    targets.push(isPropertyAccessExpression(node) ? node.name : node);
  };
  const addIdentifier = (node: Node | undefined): void => {
    if (node && isIdentifier(node)) targets.push(node);
  };
  // expressionHasI18nextTProvenance looks up non-call initializers and returned values. Property
  // accesses are left out: resolving their names type-checks the receiver, which costs more
  // than the single requests it would save.
  const addProvenanceSite = (expression: Expression): void => {
    const value = unwrapExpression(expression);
    if (!isCallExpression(value) && !isPropertyAccessExpression(value)) targets.push(value);
  };
  const addParameterNames = (owner: FunctionLikeDeclaration): void => {
    for (const parameter of owner.parameters) {
      addIdentifier(parameter.name);
      if (!isObjectBindingPattern(parameter.name)) continue;
      for (const element of parameter.name.elements) addIdentifier(element.name);
    }
  };

  for (const call of inventory.calls) {
    // Wrapper, translator, and target lookups use the callee as written; library checks such as
    // isGetFixedTCall use it unwrapped. Both forms are usually the same node.
    addSymbolSite(call.expression);
    addSymbolSite(unwrapExpression(call.expression));
    // Arguments reach resolveObject for external calls and translator propagation for local ones.
    // Property access arguments are prefetched by propagateTranslatorParameters instead, and
    // only for calls with a local target.
    for (const argument of call.arguments) addIdentifier(unwrapExpression(argument));
  }

  for (const node of inventory.usageNodes) {
    if (isJsxOpeningElement(node) || isJsxSelfClosingElement(node)) {
      addSymbolSite(node.tagName);
    } else if (isPropertyAccessExpression(node) || isElementAccessExpression(node)) {
      // resolveObject walks an access chain down to its root before any symbol lookup.
      let base = unwrapExpression(node.expression);
      while (isPropertyAccessExpression(base) || isElementAccessExpression(base)) {
        base = unwrapExpression(base.expression);
      }
      addIdentifier(base);
    } else if (
      isSpreadAssignment(node) ||
      isSpreadElement(node) ||
      isJsxSpreadAttribute(node) ||
      isForInStatement(node) ||
      isForOfStatement(node)
    ) {
      addIdentifier(unwrapExpression(node.expression));
    } else if (isVariableDeclaration(node) && node.initializer) {
      addIdentifier(unwrapExpression(node.initializer));
    }
  }

  for (const node of inventory.translatorCandidates) {
    if (!node.initializer) continue;
    const initializer = unwrapExpression(node.initializer);
    addSymbolSite(initializer);
    // isPotentialTranslatorExpression also looks up a property access as a whole.
    if (isPropertyAccessExpression(initializer)) targets.push(initializer);
    addIdentifier(node.name);
    if (isObjectBindingPattern(node.name)) {
      for (const element of node.name.elements) addIdentifier(element.name);
    } else if (isArrayBindingPattern(node.name)) {
      const first = node.name.elements[0];
      if (first && isBindingElement(first)) addIdentifier(first.name);
    }
  }

  for (const assignment of inventory.assignments) addIdentifier(unwrapExpression(assignment.left));
  for (const initializer of inventory.variableInitializers) addProvenanceSite(initializer);
  for (const returned of inventory.returnsByFunction.values()) {
    for (const expression of returned) addProvenanceSite(expression);
  }

  for (const owner of inventory.functions) {
    // symbolForFunction keys hooks and wrappers by the function name, or by the variable name
    // for anonymous function and arrow initializers.
    const name = functionName(owner);
    if (name) targets.push(name);
    else if (isVariableDeclaration(owner.parent)) addIdentifier(owner.parent.name);
    addParameterNames(owner);
  }

  return targets;
}

/**
 * Lists the shorthand properties whose value symbol analysis reads: those of returned object
 * literals, which hook wrapper discovery inspects for `t`, and those of object literal call
 * arguments, which option and projected-object resolution read. Like
 * {@link collectSemanticTargets}, this list affects request count and never results.
 */
function collectShorthandTargets(inventory: SourceInventory): Node[] {
  const targets: Node[] = [];
  const addObject = (expression: Expression): void => {
    const value = unwrapExpression(expression);
    if (!isObjectLiteralExpression(value)) return;
    for (const property of value.properties) {
      if (isShorthandPropertyAssignment(property)) targets.push(property);
    }
  };
  for (const returned of inventory.returnsByFunction.values()) returned.forEach(addObject);
  for (const call of inventory.calls) call.arguments.forEach(addObject);
  return targets;
}
