import path from 'node:path';
import ts from '@typescript/typescript6';
import type { DictionaryTarget } from './dictionaries.js';
import { readDictionary, unwrapAlias, unwrapExpression } from './dictionary.js';
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
import type { AnalysisResult, AnalyzeOptions, UsageEvidence } from './types.js';

interface TranslationWrapper {
  keyParameter: number;
  prefix: StringResolution;
}

interface TranslationHookWrapper {
  owner: ts.FunctionLikeDeclaration;
  prefixExpressions: Array<ts.Expression | null | undefined>;
  staticPrefixes: StringResolution[];
}

interface ObjectResolution extends StringResolution {
  origin: 'translation' | 'dictionary';
  dictionaryIds?: ReadonlySet<string>;
  unboundedRuntimeKey?: boolean;
}

interface ObjectInput {
  expression: ts.Expression;
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

/** Creates the compatibility Program for API callers that do not already own one. */
export function analyzeProject(options: AnalyzeOptions): AnalysisResult {
  const dictionaryPath = path.resolve(options.dictionary);
  const loaded = loadProject(options.project ?? './tsconfig.json', [dictionaryPath]);
  return analyzeLoadedProject(loaded, options).result;
}

/**
 * Reuses one caller-owned Program so linting, diagnostics, and removal never build competing
 * compiler graphs in the same process.
 */
export function analyzeLoadedProject(
  { program, checker, configPath }: LoadedProject,
  options: AnalyzeOptions,
  reuse: AnalysisReuse = {}
): LoadedProjectAnalysis {
  const dictionaryPath = path.resolve(options.dictionary);
  const info =
    reuse.dictionary ?? readDictionary(program, checker, dictionaryPath, options.dictionaryExport);
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
  const many = analyzeLoadedProjectMany({ program, checker, configPath }, [target], options, {
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
  { program, checker, configPath }: LoadedProject,
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
  const sourceFiles = program.getSourceFiles().filter((source) => {
    const file = path.resolve(source.fileName);
    return !source.isDeclarationFile && !file.includes(`${path.sep}node_modules${path.sep}`);
  });
  const analysisSourceFiles = reuse.filesToAnalyze
    ? sourceFiles.filter((source) => reuse.filesToAnalyze?.has(path.resolve(source.fileName)))
    : sourceFiles;
  const inventories = analysisSourceFiles.map(inventorySource);
  const indexedReturns = new Map<ts.FunctionLikeDeclaration, readonly ts.Expression[]>();
  const inventoriedFunctions = new Set<ts.FunctionLikeDeclaration>();
  for (const inventory of inventories) {
    for (const owner of inventory.functions) inventoriedFunctions.add(owner);
    for (const [owner, expressions] of inventory.returnsByFunction) {
      indexedReturns.set(owner, expressions);
    }
  }

  const normalizedSymbolCache = new WeakMap<ts.Node, ts.Symbol | null>();
  const functionLikeCache = new WeakMap<ts.Node, ts.FunctionLikeDeclaration | null>();
  const expressionTypeCache = new WeakMap<ts.Node, ts.Type>();
  const dictionaryReturnIdsCache = new WeakMap<ts.FunctionLikeDeclaration, ReadonlySet<string>>();
  const i18nextTFunctionCache = new WeakMap<ts.Expression, boolean>();
  const returnExpressionCache = new WeakMap<ts.FunctionLikeDeclaration, readonly ts.Expression[]>();
  const reassignmentCache = new WeakMap<ts.ParameterDeclaration, boolean>();
  const assignmentIndex = new Map<
    ts.Symbol,
    Array<{ owner: ts.FunctionLikeDeclaration | undefined; right: ts.Expression }>
  >();
  for (const inventory of inventories) {
    for (const assignment of inventory.assignments) {
      const left = unwrapExpression(assignment.left);
      if (!ts.isIdentifier(left)) continue;
      const symbol = normalizedSymbol(left);
      if (!symbol) continue;
      const entries = assignmentIndex.get(symbol) ?? [];
      entries.push({ owner: assignment.owner, right: assignment.right });
      assignmentIndex.set(symbol, entries);
    }
  }
  const strings = createStringResolver(checker, maxExpansions, {
    assignments: assignmentIndex,
    returns: indexedReturns,
    typeAtLocation
  });

  const translators = new Map<ts.Symbol, StringResolution>();
  const translationHookWrappers = new Map<ts.Symbol, TranslationHookWrapper>();
  const wrappers = new Map<ts.Symbol, TranslationWrapper>();
  const wrapperCalls = new Map<ts.Symbol, number>();
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
  const objectCache = new WeakMap<ts.Expression, ObjectResolution | null>();
  // Parameter inputs are indexed before usage analysis, making symbol provenance immutable here;
  // cache misses too so ordinary non-translation property accesses stay cheap.
  const objectSymbolCache = new Map<ts.Symbol, ObjectResolution | null>();
  const resolvingObjectSymbols = new Set<ts.Symbol>();
  const objectInputs = new Map<ts.Symbol, ObjectInput[]>();
  const objectPropertyInputs = new Map<ts.Symbol, Map<string, ObjectInput[]>>();
  let translationHookCache = new WeakMap<ts.CallExpression, StringResolution | null>();

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
    discoverTranslationWrappers();
    countWrapperCalls();
  } finally {
    emitStage('discovery', 'end');
  }

  emitStage('usage', 'start');
  try {
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
          if (!ts.isObjectLiteralExpression(value)) continue;
          for (const property of value.properties) {
            const shorthandSymbol = ts.isShorthandPropertyAssignment(property)
              ? unwrapAlias(checker, checker.getShorthandAssignmentValueSymbol(property))
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

  function discoverHookTranslators(): void {
    for (const inventory of inventories) {
      const sourceFile = inventory.sourceFile;
      for (const node of inventory.translatorCandidates) {
        if (!node.initializer) continue;

        const hookPrefix = couldBeTranslationHookResult(node.initializer)
          ? translationHookPrefix(node.initializer)
          : undefined;
        if (ts.isObjectBindingPattern(node.name) && hookPrefix) {
          for (const element of node.name.elements) {
            const sourceName =
              element.propertyName?.getText(sourceFile) ?? element.name.getText(sourceFile);
            if (sourceName !== 't' || !ts.isIdentifier(element.name)) continue;
            addTranslator(normalizedSymbol(element.name), hookPrefix);
          }
          continue;
        }

        if (ts.isArrayBindingPattern(node.name) && hookPrefix) {
          const first = node.name.elements[0];
          if (first && ts.isBindingElement(first) && ts.isIdentifier(first.name)) {
            addTranslator(normalizedSymbol(first.name), hookPrefix);
          }
          continue;
        }

        if (ts.isIdentifier(node.name)) {
          const initializer = unwrapExpression(node.initializer);
          if (!isPotentialTranslatorExpression(initializer)) continue;
          const aliasedPrefix = translatorPrefix(initializer);
          if (aliasedPrefix) {
            addTranslator(normalizedSymbol(node.name), aliasedPrefix);
            continue;
          }
          if (
            ts.isPropertyAccessExpression(initializer) &&
            initializer.name.text === 't' &&
            translationHookPrefix(initializer.expression)
          ) {
            addTranslator(
              normalizedSymbol(node.name),
              translationHookPrefix(initializer.expression) ?? empty()
            );
          }
        }
      }
    }
  }

  function propagateTranslatorParameters(): void {
    let changed = true;
    let iteration = 0;
    // The compatibility engine historically bounds convergence here; retaining the cap avoids
    // allowing pathological call cycles to make the baseline analysis non-terminating.
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
            if (!prefix || !parameter || !ts.isIdentifier(parameter.name)) return;
            const symbol = normalizedSymbol(parameter.name);
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
        if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) continue;
        const target = functionLikeForExpression(node.tagName);
        const parameter = target?.parameters[0];
        if (!parameter) continue;
        if (ts.isObjectBindingPattern(parameter.name)) {
          for (const element of parameter.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const property = staticBindingElementName(element);
            if (!property) continue;
            const source = jsxPropertyInput(node, property);
            if (source.input) addObjectInput(normalizedSymbol(element.name), source.input);
            if (!source.found && element.initializer) {
              addObjectInput(normalizedSymbol(element.name), {
                expression: element.initializer,
                path: []
              });
            }
          }
        } else if (ts.isIdentifier(parameter.name)) {
          const symbol = normalizedSymbol(parameter.name);
          if (!symbol) continue;
          for (const property of checker.getPropertiesOfType(typeAtLocation(parameter.name))) {
            const source = jsxPropertyInput(node, property.name);
            if (source.input) addObjectPropertyInput(symbol, property.name, source.input);
          }
        }
      }
    }
  }

  function jsxPropertyInput(
    node: ts.JsxOpeningLikeElement,
    property: string
  ): { found: boolean; input?: ObjectInput } {
    // JSX applies props left-to-right; walking backward selects the value that actually reaches the
    // component instead of retaining translation objects hidden by later attributes or spreads.
    const properties = node.attributes.properties;
    for (let index = properties.length - 1; index >= 0; index -= 1) {
      const attribute = properties[index]!;
      if (ts.isJsxAttribute(attribute)) {
        if (attribute.name.getText() !== property) continue;
        const expression = attribute.initializer
          ? jsxAttributeExpression(attribute.initializer)
          : undefined;
        return expression ? { found: true, input: { expression, path: [] } } : { found: true };
      }
      if (checker.getPropertyOfType(typeAtLocation(attribute.expression), property)) {
        return {
          found: true,
          input: { expression: attribute.expression, path: [property] }
        };
      }
    }
    return { found: false };
  }

  function indexParameterInput(parameter: ts.ParameterDeclaration, input: ObjectInput): void {
    if (ts.isIdentifier(parameter.name)) {
      addObjectInput(normalizedSymbol(parameter.name), input);
      return;
    }
    if (!ts.isObjectBindingPattern(parameter.name)) return;
    for (const element of parameter.name.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      const property = staticBindingElementName(element);
      if (!property) continue;
      addObjectInput(normalizedSymbol(element.name), {
        expression: input.expression,
        path: [...input.path, property]
      });
    }
  }

  function addObjectInput(symbol: ts.Symbol | undefined, input: ObjectInput): void {
    if (!symbol) return;
    const inputs = objectInputs.get(symbol) ?? [];
    inputs.push(input);
    objectInputs.set(symbol, inputs);
  }

  function addObjectPropertyInput(symbol: ts.Symbol, property: string, input: ObjectInput): void {
    const properties = objectPropertyInputs.get(symbol) ?? new Map<string, ObjectInput[]>();
    const inputs = properties.get(property) ?? [];
    inputs.push(input);
    properties.set(property, inputs);
    objectPropertyInputs.set(symbol, properties);
  }

  function discoverTranslationWrappers(): void {
    for (const inventory of inventories) {
      for (const node of inventory.calls) {
        if (!translatorPrefix(node.expression)) continue;
        const key = node.arguments[0] ? unwrapExpression(node.arguments[0]) : undefined;
        if (!key || !ts.isIdentifier(key)) continue;
        const owner = enclosingFunction(node);
        if (!owner) continue;
        const parameterIndex = owner.parameters.findIndex(
          (parameter) =>
            ts.isIdentifier(parameter.name) &&
            normalizedSymbol(parameter.name) === normalizedSymbol(key)
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

  function countWrapperCalls(): void {
    for (const inventory of inventories) {
      for (const node of inventory.calls) {
        const symbol = normalizedSymbol(node.expression);
        if (symbol && wrappers.has(symbol)) {
          wrapperCalls.set(symbol, (wrapperCalls.get(symbol) ?? 0) + 1);
        }
      }
    }
  }

  function visitSource(inventory: SourceInventory): void {
    for (const node of inventory.usageNodes) {
      if (ts.isCallExpression(node)) analyzeCall(node);
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer
      ) {
        const object = resolveObject(node.initializer);
        if (object) analyzeBindingPattern(node.name, object, node);
        else analyzeProjectedBindingPattern(node.name, node.initializer);
      }
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) analyzeTrans(node);
      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        !isObjectChainBase(node)
      ) {
        analyzeObjectExpression(node);
      }
      if (
        ts.isSpreadAssignment(node) ||
        ts.isSpreadElement(node) ||
        ts.isJsxSpreadAttribute(node)
      ) {
        analyzeSpread(node);
      }
      if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
        const object = resolveObject(node.expression);
        if (object) markSubtrees(object, node.expression, 'Iteration over translation object');
      }
    }
  }

  function analyzeCall(call: ts.CallExpression): void {
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

    const wrapper = wrappers.get(normalizedSymbol(call.expression) as ts.Symbol);
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

  function analyzeArrayReceiverCall(call: ts.CallExpression): boolean {
    const expression = unwrapExpression(call.expression);
    if (
      !ts.isPropertyAccessExpression(expression) ||
      !ARRAY_ITERATION_METHODS.has(expression.name.text)
    ) {
      return false;
    }

    const receiver = expression.expression;
    const object = resolveObject(receiver);
    if (!object || !isArrayLikeType(typeAtLocation(receiver))) return false;

    // Mark the receiver, not `.map`/`.find`, so a dictionary key with that name stays ordinary data.
    markSubtrees(object, call, 'Translation array iteration');
    return true;
  }

  function isArrayLikeType(type: ts.Type): boolean {
    if (type.isUnion()) return type.types.every(isArrayLikeType);
    if (checker.isArrayType(type) || checker.isTupleType(type)) return true;

    // ReadonlyArray references are not consistently reported by isArrayType across TS versions.
    const reference = type as ts.TypeReference;
    const symbol = type.getSymbol() ?? reference.target?.getSymbol();
    return Boolean(
      symbol?.getName() === 'ReadonlyArray' &&
        symbol.declarations?.some(({ getSourceFile }) => getSourceFile().hasNoDefaultLib)
    );
  }

  function analyzeTrans(node: ts.JsxOpeningLikeElement): void {
    const tagTarget = ts.isPropertyAccessExpression(node.tagName)
      ? node.tagName.name
      : node.tagName;
    const tagSymbol = normalizedSymbol(tagTarget);
    if (
      !isImportedName(tagSymbol, 'Trans', 'react-i18next') &&
      !isLibrarySymbol(tagSymbol, 'Trans', 'react-i18next')
    ) {
      return;
    }
    const keyAttribute = node.attributes.properties.find(
      (attribute): attribute is ts.JsxAttribute =>
        ts.isJsxAttribute(attribute) && attribute.name.getText() === 'i18nKey'
    );
    if (!keyAttribute?.initializer) return;

    const keyExpression = jsxAttributeExpression(keyAttribute.initializer);
    const key = ts.isStringLiteral(keyAttribute.initializer)
      ? exact(keyAttribute.initializer.text)
      : keyExpression
        ? strings.resolve(keyExpression)
        : empty();
    const tAttribute = node.attributes.properties.find(
      (attribute): attribute is ts.JsxAttribute =>
        ts.isJsxAttribute(attribute) && attribute.name.getText() === 't'
    );
    const suppliedTranslator = tAttribute?.initializer
      ? jsxAttributeExpression(tAttribute.initializer)
      : undefined;
    const prefix = suppliedTranslator ? translatorPrefix(suppliedTranslator) : empty();
    markResolution(prepend(prefix ?? empty(), key), node, '<Trans i18nKey>');
  }

  function analyzeObjectExpression(expression: ts.Expression): void {
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

  function isAnalyzedWrapperParameter(key: ts.Expression, call: ts.CallExpression): boolean {
    const value = unwrapExpression(key);
    if (!ts.isIdentifier(value)) return false;
    const owner = enclosingFunction(call);
    if (!owner) return false;
    const ownerSymbol = symbolForFunction(owner);
    if (!ownerSymbol || !wrappers.has(ownerSymbol) || isExported(owner)) return false;
    const parameter = owner.parameters.find(
      (candidate) =>
        ts.isIdentifier(candidate.name) &&
        normalizedSymbol(candidate.name) === normalizedSymbol(value)
    );
    return Boolean(
      parameter &&
        !parameterIsReassignedCached(parameter, owner) &&
        (wrapperCalls.get(ownerSymbol) ?? 0) > 0
    );
  }

  function analyzeSpread(
    node: ts.SpreadAssignment | ts.SpreadElement | ts.JsxSpreadAttribute
  ): void {
    const object = resolveObject(node.expression);
    if (object) markSubtrees(object, node, 'Spread of translation object');
  }

  function analyzeBindingPattern(
    pattern: ts.ObjectBindingPattern,
    object: ObjectResolution,
    node: ts.Node
  ): void {
    for (const element of pattern.elements) {
      if (element.dotDotDotToken) {
        markSubtrees(object, element, 'Rest destructuring of translation object');
        continue;
      }
      const rawName = element.propertyName?.getText(node.getSourceFile()) ?? element.name.getText();
      const child = appendObject(object, exact(rawName.replaceAll(/['"]/g, '')));
      if (ts.isObjectBindingPattern(element.name)) {
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

  function analyzeProjectedBindingPattern(
    pattern: ts.ObjectBindingPattern,
    initializer: ts.Expression
  ): void {
    for (const element of pattern.elements) {
      if (element.dotDotDotToken) continue;
      const property = staticBindingElementName(element);
      if (!property) continue;
      const object = resolveProjectedObject(initializer, property, new Set());
      if (!object) continue;
      if (ts.isObjectBindingPattern(element.name)) {
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

  function resolveObject(
    input: ts.Expression,
    seen = new Set<ts.Node>()
  ): ObjectResolution | undefined {
    if (seen.size === 0) {
      const cached = objectCache.get(input);
      if (cached !== undefined) return cached ?? undefined;
      const result = resolveObjectUncached(input, seen);
      objectCache.set(input, result ?? null);
      return result;
    }
    return resolveObjectUncached(input, seen);
  }

  function resolveObjectUncached(
    input: ts.Expression,
    seen: Set<ts.Node>
  ): ObjectResolution | undefined {
    const expression = unwrapExpression(input);
    if (seen.has(expression)) return undefined;
    const nextSeen = new Set(seen).add(expression);

    if (ts.isCallExpression(expression)) {
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
        if (value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))) {
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

    if (ts.isIdentifier(expression)) {
      const symbol = normalizedSymbol(expression);
      return symbol ? resolveObjectSymbol(symbol, nextSeen) : undefined;
    }

    if (ts.isPropertyAccessExpression(expression)) {
      const base = resolveObject(expression.expression, nextSeen);
      if (base) {
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

    if (ts.isElementAccessExpression(expression)) {
      const base = resolveObject(expression.expression, nextSeen);
      if (!base || !expression.argumentExpression) return base;
      if (resolvesDictionaryLeaf(base)) return base;
      return appendObject(base, strings.resolve(expression.argumentExpression));
    }

    if (ts.isConditionalExpression(expression)) {
      return mergeObjectPair(
        resolveObject(expression.whenTrue, nextSeen),
        resolveObject(expression.whenFalse, nextSeen)
      );
    }

    if (
      ts.isBinaryExpression(expression) &&
      (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      return mergeObjectPair(
        resolveObject(expression.left, nextSeen),
        resolveObject(expression.right, nextSeen)
      );
    }

    return undefined;
  }

  function resolveObjectInput(
    input: ObjectInput,
    seen: Set<ts.Node>
  ): ObjectResolution | undefined {
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

  function resolveProjectedObject(
    input: ts.Expression,
    property: string,
    seen: Set<ts.Node>
  ): ObjectResolution | undefined {
    // Returned prop bags are heterogeneous, so resolving the whole object would conflate unrelated
    // prefixes. Project the requested property through each observed return/call edge instead.
    const expression = unwrapExpression(input);
    if (seen.has(expression)) return undefined;
    const nextSeen = new Set(seen).add(expression);

    if (ts.isObjectLiteralExpression(expression)) {
      let result: ObjectResolution | undefined;
      for (const member of expression.properties) {
        if (ts.isSpreadAssignment(member)) {
          const candidate = resolveProjectedObject(member.expression, property, nextSeen);
          if (checker.getPropertyOfType(typeAtLocation(member.expression), property)) {
            result = candidate;
          }
          continue;
        }
        if (staticPropertyName(member.name) !== property) continue;
        let candidate: ObjectResolution | undefined;
        if (ts.isPropertyAssignment(member)) {
          candidate = resolveObject(member.initializer, nextSeen);
        } else if (ts.isShorthandPropertyAssignment(member)) {
          const valueSymbol = unwrapAlias(
            checker,
            checker.getShorthandAssignmentValueSymbol(member)
          );
          candidate = valueSymbol
            ? resolveObjectSymbol(valueSymbol, nextSeen)
            : resolveObject(member.name, nextSeen);
        }
        // Explicit properties always overwrite earlier spreads/properties, including with a
        // non-translation value whose unresolved candidate intentionally clears provenance.
        result = candidate;
      }
      return result;
    }

    if (ts.isCallExpression(expression)) {
      if (isReactUseMemoCall(expression)) {
        const factory = expression.arguments[0];
        const value = factory ? unwrapExpression(factory) : undefined;
        if (value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))) {
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

    if (ts.isIdentifier(expression)) {
      const symbol = normalizedSymbol(expression);
      const declaration = symbol?.declarations?.find(ts.isVariableDeclaration);
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

    if (ts.isConditionalExpression(expression)) {
      return mergeObjectPair(
        resolveProjectedObject(expression.whenTrue, property, nextSeen),
        resolveProjectedObject(expression.whenFalse, property, nextSeen)
      );
    }

    if (
      ts.isBinaryExpression(expression) &&
      (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)
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

  function resolveObjectSymbol(
    symbol: ts.Symbol,
    _seen: Set<ts.Node>
  ): ObjectResolution | undefined {
    const cached = objectSymbolCache.get(symbol);
    if (cached !== undefined) return cached ?? undefined;
    if (resolvingObjectSymbols.has(symbol)) return undefined;
    resolvingObjectSymbols.add(symbol);
    const seen = new Set<ts.Node>();

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
      const variable = symbol.declarations?.find(ts.isVariableDeclaration);
      if (variable?.initializer) result = resolveObject(variable.initializer, seen);
      for (const input of objectInputs.get(symbol) ?? []) {
        const candidate = resolveObjectInput(input, seen);
        if (candidate) result = result ? mergeObjects(result, candidate) : candidate;
      }
      const binding = symbol.declarations?.find(ts.isBindingElement);
      const declaration = binding?.parent.parent;
      if (
        binding &&
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer
      ) {
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

  function translatorPrefix(expression: ts.Expression): StringResolution | undefined {
    const symbol = normalizedSymbol(expression);
    const known = symbol ? translators.get(symbol) : undefined;
    if (known) return known;

    const unwrapped = unwrapExpression(expression);
    if (ts.isCallExpression(unwrapped) && isGetFixedTCall(unwrapped)) {
      // i18next defines the third getFixedT argument as keyPrefix; language and namespace are separate.
      const prefix = unwrapped.arguments[2];
      return prefix ? strings.resolve(prefix) : empty();
    }
    if (ts.isPropertyAccessExpression(unwrapped) && unwrapped.name.text === 't') {
      const hookPrefix = translationHookPrefix(unwrapped.expression);
      if (hookPrefix) return hookPrefix;
      const symbol = normalizedSymbol(unwrapped.name);
      if (
        isLibrarySymbol(symbol, 't', 'i18next') ||
        isDefaultImportFrom(unwrapped.expression, 'i18next')
      ) {
        return empty();
      }
    }
    if (
      ts.isElementAccessExpression(unwrapped) &&
      unwrapped.argumentExpression &&
      strings.resolve(unwrapped.argumentExpression).values.has('0')
    ) {
      const hookPrefix = translationHookPrefix(unwrapped.expression);
      if (hookPrefix) return hookPrefix;
    }
    const directSymbol = normalizedSymbol(unwrapped);
    if (
      isImportedName(directSymbol, 't', 'i18next') ||
      isLibrarySymbol(directSymbol, 't', 'i18next') ||
      isI18nextTFunction(unwrapped)
    ) {
      return empty();
    }
    return undefined;
  }

  function isUseTranslationCall(expression: ts.Expression): boolean {
    const unwrapped = unwrapExpression(expression);
    if (!ts.isCallExpression(unwrapped)) return false;
    const callee = unwrapExpression(unwrapped.expression);
    const target = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
    const symbol = normalizedSymbol(target);
    // Name-only matching would let unrelated application hooks suppress valid unused diagnostics.
    if (isImportedName(symbol, 'useTranslation', 'react-i18next')) return true;
    if (isLibrarySymbol(symbol, 'useTranslation', 'react-i18next')) return true;
    return (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === 'useTranslation' &&
      isNamespaceImportFrom(callee.expression, 'react-i18next')
    );
  }

  function translationHookPrefix(
    expression: ts.Expression,
    seen = new Set<ts.Node>()
  ): StringResolution | undefined {
    const unwrapped = unwrapExpression(expression);
    if (seen.has(unwrapped)) return undefined;
    const nextSeen = new Set(seen).add(unwrapped);
    if (ts.isIdentifier(unwrapped)) {
      // Follow local result aliases so later destructuring retains the prefix proven at hook creation.
      const declaration = normalizedSymbol(unwrapped)?.declarations?.find(ts.isVariableDeclaration);
      return declaration?.initializer
        ? translationHookPrefix(declaration.initializer, nextSeen)
        : undefined;
    }
    if (!ts.isCallExpression(unwrapped)) return undefined;
    const cached = translationHookCache.get(unwrapped);
    if (cached !== undefined) return cached ?? undefined;

    translationHookCache.set(unwrapped, null);
    if (isUseTranslationCall(unwrapped)) {
      const prefix = keyPrefixFromUseTranslation(unwrapped);
      translationHookCache.set(unwrapped, prefix);
      return prefix;
    }

    const symbol = normalizedSymbol(unwrapped.expression);
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

  function keyPrefixFromUseTranslation(call: ts.CallExpression): StringResolution {
    const expression = keyPrefixExpressionFromUseTranslation(call);
    return expression === null ? unresolved() : expression ? strings.resolve(expression) : empty();
  }

  function keyPrefixExpressionFromUseTranslation(
    call: ts.CallExpression
  ): ts.Expression | null | undefined {
    const options = call.arguments[1];
    return options ? optionExpression(options, 'keyPrefix') : undefined;
  }

  function resolveHookPrefixArgument(
    expression: ts.Expression,
    wrapper: ts.FunctionLikeDeclaration,
    call: ts.CallExpression
  ): StringResolution {
    const value = unwrapExpression(expression);
    if (!ts.isIdentifier(value)) return strings.resolve(value);
    const parameterIndex = wrapper.parameters.findIndex(
      (parameter) =>
        ts.isIdentifier(parameter.name) &&
        normalizedSymbol(parameter.name) === normalizedSymbol(value)
    );
    if (parameterIndex < 0) return strings.resolve(value);
    const argument = call.arguments[parameterIndex];
    return argument ? strings.resolve(argument) : empty();
  }

  function optionExpression(
    expression: ts.Expression,
    option: string,
    seen = new Set<ts.Node>()
  ): ts.Expression | null | undefined {
    const value = unwrapExpression(expression);
    if (seen.has(value)) return undefined;
    const nextSeen = new Set(seen).add(value);
    if (ts.isIdentifier(value)) {
      const declaration = normalizedSymbol(value)?.declarations?.find(ts.isVariableDeclaration);
      return declaration?.initializer
        ? optionExpression(declaration.initializer, option, nextSeen)
        : null;
    }
    if (ts.isCallExpression(value)) {
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
    if (!ts.isObjectLiteralExpression(value)) return null;
    for (let index = value.properties.length - 1; index >= 0; index -= 1) {
      const property = value.properties[index]!;
      if (ts.isSpreadAssignment(property)) {
        const spread = optionExpression(property.expression, option, nextSeen);
        if (spread !== undefined) return spread;
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === option) {
        const valueSymbol = checker.getShorthandAssignmentValueSymbol(property);
        for (const declaration of valueSymbol?.declarations ?? []) {
          if (
            (ts.isParameter(declaration) || ts.isVariableDeclaration(declaration)) &&
            ts.isIdentifier(declaration.name)
          ) {
            return declaration.name;
          }
        }
        return property.name;
      }
      if (!ts.isPropertyAssignment(property)) continue;
      const name = staticPropertyName(property.name);
      if (name === option) return property.initializer;
      if (name === undefined && ts.isComputedPropertyName(property.name)) return null;
    }
    return undefined;
  }

  function callBooleanOption(call: ts.CallExpression, option: string): BooleanOptionResolution {
    let unresolvedOption = false;
    for (const argument of call.arguments.slice(1)) {
      const value = unwrapExpression(argument);
      if (ts.isIdentifier(value)) {
        const declaration = normalizedSymbol(value)?.declarations?.find(ts.isVariableDeclaration);
        if (declaration?.initializer) {
          const configured = booleanOption(declaration.initializer, option);
          if (configured !== 'absent' && configured !== 'unknown') {
            if (configured === 'true') return 'true';
            continue;
          }
          if (configured === 'unknown') unresolvedOption = true;
        } else {
          unresolvedOption = true;
        }
      } else {
        const configured = booleanOption(value, option);
        if (configured !== 'absent' && configured !== 'unknown') {
          if (configured === 'true') return 'true';
          continue;
        }
        if (
          ts.isObjectLiteralExpression(value) ||
          ts.isCallExpression(value) ||
          ts.isPropertyAccessExpression(value) ||
          ts.isElementAccessExpression(value)
        ) {
          unresolvedOption = true;
        }
      }
    }
    return unresolvedOption ? 'unknown' : 'absent';
  }

  function booleanOption(expression: ts.Expression, option: string): BooleanOptionResolution {
    const value = unwrapExpression(expression);
    if (ts.isIdentifier(value)) {
      const declaration = normalizedSymbol(value)?.declarations?.find(ts.isVariableDeclaration);
      return declaration?.initializer ? booleanOption(declaration.initializer, option) : 'unknown';
    }
    if (!ts.isObjectLiteralExpression(value)) {
      return ts.isStringLiteralLike(value) || ts.isNumericLiteral(value) ? 'absent' : 'unknown';
    }
    let unresolvedSpread = false;
    for (const property of [...value.properties].reverse()) {
      if (ts.isSpreadAssignment(property)) {
        const spread = booleanOption(property.expression, option);
        if (spread === 'true' || spread === 'false') return spread;
        if (spread === 'unknown') unresolvedSpread = true;
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === option) {
        if (unresolvedSpread) return 'unknown';
        const declaration = normalizedSymbol(property.name)?.declarations?.find(
          ts.isVariableDeclaration
        );
        if (!declaration?.initializer) return 'unknown';
        const initializer = unwrapExpression(declaration.initializer);
        if (initializer.kind === ts.SyntaxKind.TrueKeyword) return 'true';
        if (initializer.kind === ts.SyntaxKind.FalseKeyword) return 'false';
        return 'unknown';
      }
      if (!ts.isPropertyAssignment(property)) continue;
      const name = staticPropertyName(property.name);
      if (name === option) {
        if (unresolvedSpread) return 'unknown';
        if (property.initializer.kind === ts.SyntaxKind.TrueKeyword) return 'true';
        if (property.initializer.kind === ts.SyntaxKind.FalseKeyword) return 'false';
        return 'unknown';
      }
      if (name === undefined) unresolvedSpread = true;
    }
    return unresolvedSpread ? 'unknown' : 'absent';
  }

  function addTranslator(symbol: ts.Symbol | undefined, prefix: StringResolution): void {
    const normalized = unwrapAlias(checker, symbol);
    if (normalized) translators.set(normalized, prefix);
  }

  function markResolution(resolution: StringResolution, node: ts.Node, reason: string): void {
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

  function markTranslationResolution(
    resolution: StringResolution,
    variants: TranslationVariantOptions,
    node: ts.Node,
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

  function translationOptions(call: ts.CallExpression): TranslationVariantOptions {
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
          : countType(typeAtLocation(count)) === 'number'
            ? { count: strings.resolve(count) }
            : countType(typeAtLocation(count)) === 'unknown'
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
                : ordinal.kind === ts.SyntaxKind.TrueKeyword
                  ? true
                  : ordinal.kind === ts.SyntaxKind.FalseKeyword
                    ? false
                    : null
          })
    };
  }

  function countType(type: ts.Type): 'number' | 'none' | 'unknown' {
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return 'unknown';
    if (type.isUnion()) {
      const kinds = new Set(type.types.map(countType));
      if (kinds.has('unknown') || (kinds.has('number') && kinds.has('none'))) return 'unknown';
      return kinds.has('number') ? 'number' : 'none';
    }
    return type.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral) ? 'number' : 'none';
  }

  function markSubtrees(
    resolution: StringResolution & { dictionaryIds?: ReadonlySet<string> },
    node: ts.Node,
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

  function markSubtree(
    prefix: string,
    node: ts.Node,
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

  function markPattern(
    pattern: string,
    node: ts.Node,
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

  function markKeys(
    candidateKeys: Iterable<string>,
    confidence: 'used' | 'possibly-used',
    node: ts.Node,
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

  function factsForNode(node: ts.Node): SourceUsageFacts {
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

  function evidenceFor(
    node: ts.Node,
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

  function normalizedSymbol(node: ts.Node): ts.Symbol | undefined {
    const cached = normalizedSymbolCache.get(node);
    if (cached !== undefined) return cached ?? undefined;
    const target = ts.isPropertyAccessExpression(node) ? node.name : node;
    const symbol = unwrapAlias(checker, checker.getSymbolAtLocation(target));
    normalizedSymbolCache.set(node, symbol ?? null);
    return symbol;
  }

  function typeAtLocation(node: ts.Node): ts.Type {
    const cached = expressionTypeCache.get(node);
    if (cached) return cached;
    const type = checker.getTypeAtLocation(node);
    expressionTypeCache.set(node, type);
    return type;
  }

  function returnExpressionsCached(node: ts.FunctionLikeDeclaration): readonly ts.Expression[] {
    const cached = returnExpressionCache.get(node);
    if (cached) return cached;
    const indexed = indexedReturns.get(node);
    const expressions = indexed ?? returnExpressions(node);
    returnExpressionCache.set(node, expressions);
    return expressions;
  }

  function parameterIsReassignedCached(
    parameter: ts.ParameterDeclaration,
    owner: ts.FunctionLikeDeclaration
  ): boolean {
    const cached = reassignmentCache.get(parameter);
    if (cached !== undefined) return cached;
    const symbol = ts.isIdentifier(parameter.name) ? normalizedSymbol(parameter.name) : undefined;
    const indexed = symbol
      ? (assignmentIndex.get(symbol) ?? []).some((assignment) => assignment.owner === owner)
      : false;
    const result =
      indexed || (!inventoriedFunctions.has(owner) && parameterIsReassigned(parameter, owner));
    reassignmentCache.set(parameter, result);
    return result;
  }

  function functionLikeForCall(call: ts.CallExpression): ts.FunctionLikeDeclaration | undefined {
    return functionLikeForExpression(call.expression);
  }

  function functionLikeForExpression(expression: ts.Node): ts.FunctionLikeDeclaration | undefined {
    const cached = functionLikeCache.get(expression);
    if (cached !== undefined) return cached ?? undefined;
    const symbol = normalizedSymbol(expression);
    for (const declaration of symbol?.declarations ?? []) {
      if (isConcreteFunctionLike(declaration)) {
        functionLikeCache.set(expression, declaration);
        return declaration;
      }
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        const initializer = unwrapExpression(declaration.initializer);
        if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
          functionLikeCache.set(expression, initializer);
          return initializer;
        }
        if (ts.isCallExpression(initializer) && isReactForwardRefCall(initializer)) {
          const render = initializer.arguments[0]
            ? unwrapExpression(initializer.arguments[0])
            : undefined;
          if (render && (ts.isArrowFunction(render) || ts.isFunctionExpression(render))) {
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

  function symbolForFunction(node: ts.FunctionLikeDeclaration): ts.Symbol | undefined {
    if (node.name) return normalizedSymbol(node.name);
    if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
      return normalizedSymbol(node.parent.name);
    }
    return undefined;
  }

  /** Declaration-only factories are rare enough to resolve without typing every arbitrary call. */
  function dictionaryIdsForDeclaredType(typeNode: ts.TypeNode): ReadonlySet<string> {
    return dictionaryIdsForType(checker.getTypeFromTypeNode(typeNode));
  }

  function dictionaryIdsForFunctionReturn(target: ts.FunctionLikeDeclaration): ReadonlySet<string> {
    const cached = dictionaryReturnIdsCache.get(target);
    if (cached) return cached;
    // Dictionary identity belongs to the function contract, not each invocation; resolving the
    // declaration once avoids re-checking large call expressions throughout the project.
    const signature = checker.getSignatureFromDeclaration(target);
    const ids = signature
      ? dictionaryIdsForType(checker.getReturnTypeOfSignature(signature))
      : new Set<string>();
    dictionaryReturnIdsCache.set(target, ids);
    return ids;
  }

  function dictionaryIdsForType(type: ts.Type): ReadonlySet<string> {
    const typeSymbol = unwrapAlias(checker, type.aliasSymbol ?? type.getSymbol());
    const ids = new Set<string>();
    for (const target of dictionaries) {
      const dictionaryType = target.info.declaredType;
      const dictionarySymbol = unwrapAlias(
        checker,
        dictionaryType.aliasSymbol ?? dictionaryType.getSymbol()
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

  function isImportedName(
    symbol: ts.Symbol | undefined,
    importedName: string,
    moduleName: string
  ): boolean {
    return Boolean(
      symbol?.declarations?.some((declaration) => {
        if (!ts.isImportSpecifier(declaration)) return false;
        const originalName = declaration.propertyName?.text ?? declaration.name.text;
        const importDeclaration = declaration.parent.parent.parent;
        return (
          originalName === importedName &&
          ts.isImportDeclaration(importDeclaration) &&
          ts.isStringLiteral(importDeclaration.moduleSpecifier) &&
          importDeclaration.moduleSpecifier.text === moduleName
        );
      })
    );
  }

  function isGetFixedTCall(call: ts.CallExpression): boolean {
    const callee = unwrapExpression(call.expression);
    const target = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
    const symbol = checker.getSymbolAtLocation(target);
    if (isImportedName(symbol, 'getFixedT', 'i18next')) return true;
    if (isLibrarySymbol(symbol, 'getFixedT', 'i18next')) return true;
    return (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === 'getFixedT' &&
      (isDefaultImportFrom(callee.expression, 'i18next') ||
        isNamespaceImportFrom(callee.expression, 'i18next'))
    );
  }

  function isReactUseMemoCall(call: ts.CallExpression): boolean {
    const callee = unwrapExpression(call.expression);
    const target = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
    const symbol = checker.getSymbolAtLocation(target);
    if (isImportedName(symbol, 'useMemo', 'react') || isLibrarySymbol(symbol, 'useMemo', 'react')) {
      return true;
    }
    return (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === 'useMemo' &&
      (isDefaultImportFrom(callee.expression, 'react') ||
        isNamespaceImportFrom(callee.expression, 'react'))
    );
  }

  function isReactForwardRefCall(call: ts.CallExpression): boolean {
    const callee = unwrapExpression(call.expression);
    const target = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
    // Keep the import alias here: @types/react declares `forwardRef` under namespace React, so
    // unwrapping first loses the ImportSpecifier that proves its package origin.
    const symbol = checker.getSymbolAtLocation(target);
    if (
      isImportedName(symbol, 'forwardRef', 'react') ||
      isLibrarySymbol(symbol, 'forwardRef', 'react')
    ) {
      return true;
    }
    return (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === 'forwardRef' &&
      (isDefaultImportFrom(callee.expression, 'react') ||
        isNamespaceImportFrom(callee.expression, 'react'))
    );
  }

  function isI18nextTFunction(expression: ts.Expression): boolean {
    const cached = i18nextTFunctionCache.get(expression);
    if (cached !== undefined) return cached;
    if (!hasPlausibleI18nextTProvenance(expression)) {
      i18nextTFunctionCache.set(expression, false);
      return false;
    }
    // Type provenance supports declaration-only TFunction values without accepting structural lookalikes.
    const type = typeAtLocation(expression);
    if (type.getCallSignatures().length === 0) {
      i18nextTFunctionCache.set(expression, false);
      return false;
    }
    const symbols = [type.aliasSymbol, type.getSymbol()];
    if (
      symbols.some(
        (symbol) =>
          symbol?.name === 'TFunction' &&
          symbol.declarations?.some((declaration) =>
            declarationBelongsToPackage(declaration, 'i18next')
          )
      )
    ) {
      i18nextTFunctionCache.set(expression, true);
      return true;
    }
    if (
      symbols.some((symbol) =>
        symbol?.declarations?.some((declaration) =>
          declarationHasI18nextTProvenance(declaration, new Set())
        )
      )
    ) {
      i18nextTFunctionCache.set(expression, true);
      return true;
    }
    const result = type.getCallSignatures().some((signature) => {
      const declaration = signature.getDeclaration();
      if (!declaration || !declarationBelongsToPackage(declaration, 'i18next')) return false;
      let current: ts.Node | undefined = declaration;
      while (current) {
        if (
          ((ts.isInterfaceDeclaration(current) || ts.isTypeAliasDeclaration(current)) &&
            current.name.text === 'TFunction') ||
          (ts.isPropertySignature(current) && current.name.getText() === 't')
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

  function hasPlausibleI18nextTProvenance(expression: ts.Expression): boolean {
    return expressionHasI18nextTProvenance(unwrapExpression(expression), new Set());
  }

  function expressionHasI18nextTProvenance(expression: ts.Expression, seen: Set<ts.Node>): boolean {
    const value = unwrapExpression(expression);
    if (seen.has(value)) return false;
    seen.add(value);

    if (ts.isCallExpression(value)) {
      if (isGetFixedTCall(value)) return true;
      const target = functionLikeForCall(value);
      if (!target) return false;
      if (target.type && typeNodeHasI18nextTProvenance(target.type, seen)) return true;
      for (const returned of returnExpressionsCached(target)) {
        const returnedValue = unwrapExpression(returned);
        if (ts.isIdentifier(returnedValue)) {
          const parameterIndex = target.parameters.findIndex(
            (parameter) =>
              ts.isIdentifier(parameter.name) &&
              normalizedSymbol(parameter.name) === normalizedSymbol(returnedValue)
          );
          const argument = parameterIndex >= 0 ? value.arguments[parameterIndex] : undefined;
          if (argument && expressionHasI18nextTProvenance(argument, seen)) return true;
        }
        if (expressionHasI18nextTProvenance(returnedValue, seen)) return true;
      }
      return false;
    }

    const symbol = normalizedSymbol(value);
    if (!symbol) return false;
    if (translators.has(symbol)) return true;
    return (
      symbol.declarations?.some((declaration) =>
        declarationHasI18nextTProvenance(declaration, seen)
      ) ?? false
    );
  }

  function declarationHasI18nextTProvenance(
    declaration: ts.Declaration,
    seen: Set<ts.Node>
  ): boolean {
    if (seen.has(declaration)) return false;
    seen.add(declaration);
    if (isI18nextTranslatorDeclaration(declaration)) return true;
    if (
      ts.isParameter(declaration) &&
      !declaration.type &&
      (ts.isArrowFunction(declaration.parent) || ts.isFunctionExpression(declaration.parent)) &&
      ts.isCallExpression(declaration.parent.parent) &&
      declaration.parent.parent.arguments.includes(declaration.parent)
    ) {
      // Contextual callback types are available only through the checker at the call site.
      return true;
    }

    if (
      (ts.isVariableDeclaration(declaration) ||
        ts.isParameter(declaration) ||
        ts.isPropertyDeclaration(declaration) ||
        ts.isPropertySignature(declaration)) &&
      declaration.type &&
      typeNodeHasI18nextTProvenance(declaration.type, seen)
    ) {
      return true;
    }
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      return expressionHasI18nextTProvenance(declaration.initializer, seen);
    }
    if (ts.isBindingElement(declaration)) {
      const variable = declaration.parent.parent;
      return ts.isVariableDeclaration(variable) && variable.initializer
        ? expressionHasI18nextTProvenance(variable.initializer, seen)
        : false;
    }
    if (ts.isTypeAliasDeclaration(declaration)) {
      return typeNodeHasI18nextTProvenance(declaration.type, seen);
    }
    if (ts.isInterfaceDeclaration(declaration)) {
      return (
        declaration.heritageClauses?.some((clause) =>
          clause.types.some((type) => typeNodeHasI18nextTProvenance(type, seen))
        ) ?? false
      );
    }
    return false;
  }

  function isI18nextTranslatorDeclaration(declaration: ts.Declaration): boolean {
    if (!declarationBelongsToPackage(declaration, 'i18next')) return false;
    let current: ts.Node | undefined = declaration;
    while (current) {
      if (
        ((ts.isInterfaceDeclaration(current) || ts.isTypeAliasDeclaration(current)) &&
          current.name.text === 'TFunction') ||
        ((ts.isVariableDeclaration(current) || ts.isFunctionDeclaration(current)) &&
          current.name &&
          ts.isIdentifier(current.name) &&
          current.name.text === 't') ||
        ((ts.isPropertyDeclaration(current) ||
          ts.isPropertySignature(current) ||
          ts.isMethodDeclaration(current) ||
          ts.isMethodSignature(current)) &&
          current.name &&
          staticPropertyName(current.name) === 't')
      ) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  function typeNodeHasI18nextTProvenance(typeNode: ts.TypeNode, seen: Set<ts.Node>): boolean {
    if (seen.has(typeNode)) return false;
    seen.add(typeNode);
    if (ts.isParenthesizedTypeNode(typeNode)) {
      return typeNodeHasI18nextTProvenance(typeNode.type, seen);
    }
    if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
      return typeNode.types.some((type) => typeNodeHasI18nextTProvenance(type, seen));
    }
    const typeName = ts.isTypeReferenceNode(typeNode)
      ? typeNode.typeName
      : ts.isExpressionWithTypeArguments(typeNode)
        ? typeNode.expression
        : undefined;
    if (!typeName) return false;
    const symbol = unwrapAlias(checker, checker.getSymbolAtLocation(typeName));
    return (
      symbol?.declarations?.some((declaration) =>
        declarationHasI18nextTProvenance(declaration, seen)
      ) ?? false
    );
  }

  function couldBeTranslationHookResult(
    expression: ts.Expression,
    seen = new Set<ts.Node>()
  ): boolean {
    const value = unwrapExpression(expression);
    if (seen.has(value)) return false;
    seen.add(value);
    if (ts.isIdentifier(value)) {
      const declaration = normalizedSymbol(value)?.declarations?.find(ts.isVariableDeclaration);
      return Boolean(
        declaration?.initializer && couldBeTranslationHookResult(declaration.initializer, seen)
      );
    }
    if (!ts.isCallExpression(value)) return false;
    if (isUseTranslationCall(value)) return true;
    const symbol = normalizedSymbol(value.expression);
    return Boolean(symbol && translationHookWrappers.has(symbol));
  }

  function isPotentialTranslatorExpression(expression: ts.Expression): boolean {
    const value = unwrapExpression(expression);
    if (
      !ts.isIdentifier(value) &&
      !ts.isCallExpression(value) &&
      !ts.isPropertyAccessExpression(value) &&
      !ts.isElementAccessExpression(value)
    ) {
      return false;
    }
    if (ts.isCallExpression(value)) {
      return isGetFixedTCall(value) || expressionHasI18nextTProvenance(value, new Set());
    }
    const symbol = normalizedSymbol(value);
    if (symbol && translators.has(symbol)) return true;
    if (ts.isPropertyAccessExpression(value) && value.name.text === 't') {
      return (
        couldBeTranslationHookResult(value.expression) ||
        isDefaultImportFrom(value.expression, 'i18next') ||
        isLibrarySymbol(checker.getSymbolAtLocation(value.name), 't', 'i18next') ||
        expressionHasI18nextTProvenance(value, new Set())
      );
    }
    if (
      ts.isElementAccessExpression(value) &&
      value.argumentExpression &&
      ((ts.isNumericLiteral(value.argumentExpression) && value.argumentExpression.text === '0') ||
        (ts.isStringLiteral(value.argumentExpression) && value.argumentExpression.text === '0'))
    ) {
      return couldBeTranslationHookResult(value.expression);
    }
    return (
      isImportedName(checker.getSymbolAtLocation(value), 't', 'i18next') ||
      expressionHasI18nextTProvenance(value, new Set())
    );
  }

  function mergePrefixOverride(
    boundPrefix: StringResolution,
    expression: ts.Expression
  ): StringResolution {
    const value = unwrapExpression(expression);
    if (
      value.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(value) && value.text === 'undefined')
    ) {
      return boundPrefix;
    }
    const override = strings.resolve(value);
    // An optional runtime override may fall back to the bound prefix, so neither branch is discarded.
    return override.complete ? override : merge(boundPrefix, override);
  }

  function isLibrarySymbol(
    symbol: ts.Symbol | undefined,
    exportedName: string,
    packageName: string
  ): boolean {
    const normalized = unwrapAlias(checker, symbol);
    return Boolean(
      normalized?.name === exportedName &&
        normalized.declarations?.some((declaration) =>
          declarationBelongsToPackage(declaration, packageName)
        )
    );
  }

  function declarationBelongsToPackage(declaration: ts.Node, packageName: string): boolean {
    // Installed declarations and ambient test/consumer declarations encode package ownership differently.
    const marker = `${path.sep}node_modules${path.sep}${packageName}${path.sep}`;
    if (path.resolve(declaration.getSourceFile().fileName).includes(marker)) return true;
    let current: ts.Node | undefined = declaration;
    while (current) {
      if (
        ts.isModuleDeclaration(current) &&
        ts.isStringLiteral(current.name) &&
        current.name.text === packageName
      ) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  function isDefaultImportFrom(expression: ts.Expression, packageName: string): boolean {
    const symbol = checker.getSymbolAtLocation(unwrapExpression(expression));
    return Boolean(
      symbol?.declarations?.some((declaration) => {
        if (!ts.isImportClause(declaration)) return false;
        const importDeclaration = declaration.parent;
        return (
          ts.isImportDeclaration(importDeclaration) &&
          ts.isStringLiteral(importDeclaration.moduleSpecifier) &&
          importDeclaration.moduleSpecifier.text === packageName
        );
      })
    );
  }

  function isNamespaceImportFrom(expression: ts.Expression, packageName: string): boolean {
    const symbol = checker.getSymbolAtLocation(unwrapExpression(expression));
    return Boolean(
      symbol?.declarations?.some((declaration) => {
        if (!ts.isNamespaceImport(declaration)) return false;
        const importDeclaration = declaration.parent.parent;
        return (
          ts.isImportDeclaration(importDeclaration) &&
          ts.isStringLiteral(importDeclaration.moduleSpecifier) &&
          importDeclaration.moduleSpecifier.text === packageName
        );
      })
    );
  }
}

function staticPropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    const expression = unwrapExpression(name.expression);
    if (ts.isStringLiteral(expression) || ts.isNumericLiteral(expression)) return expression.text;
  }
  return undefined;
}

function staticBindingElementName(element: ts.BindingElement): string | undefined {
  if (element.propertyName) return staticPropertyName(element.propertyName);
  return ts.isIdentifier(element.name) ? element.name.text : undefined;
}

function returnedTranslatorProperty(
  property: ts.ObjectLiteralElementLike,
  source: ts.SourceFile
): ts.Expression | undefined {
  if (ts.isShorthandPropertyAssignment(property) && property.name.text === 't')
    return property.name;
  if (!ts.isPropertyAssignment(property)) return undefined;
  const name = property.name.getText(source).replaceAll(/['"]/g, '');
  return name === 't' ? property.initializer : undefined;
}

function isEnumerationCall(call: ts.CallExpression): boolean {
  const expression = unwrapExpression(call.expression);
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.expression.getText() === 'Object' &&
    ['keys', 'values', 'entries'].includes(expression.name.text)
  );
}

function isObjectChainBase(node: ts.Expression): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.expression === node) ||
    (ts.isElementAccessExpression(parent) && parent.expression === node)
  );
}

function isAliasOrReturn(node: ts.Expression): boolean {
  const parent = node.parent;
  return (
    (ts.isVariableDeclaration(parent) && parent.initializer === node) ||
    (ts.isBinaryExpression(parent) &&
      parent.right === node &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) ||
    ts.isReturnStatement(parent) ||
    (ts.isArrowFunction(parent) && parent.body === node)
  );
}

function translationObjectCast(
  call: ts.CallExpression
): ts.AsExpression | ts.TypeAssertion | undefined {
  let expression: ts.Expression = call;
  let result: ts.AsExpression | ts.TypeAssertion | undefined;
  while (true) {
    const parent = expression.parent;
    if (
      (ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent)) &&
      parent.expression === expression
    ) {
      result = parent;
      expression = parent;
      continue;
    }
    if (
      (ts.isParenthesizedExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        ts.isSatisfiesExpression(parent)) &&
      parent.expression === expression
    ) {
      expression = parent;
      continue;
    }
    return result;
  }
}

function unsafeTranslationArgumentCast(
  argument: ts.Expression
): ts.AsExpression | ts.TypeAssertion | undefined {
  let expression = argument;
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    expression = expression.expression;
  }
  if (!ts.isAsExpression(expression) && !ts.isTypeAssertionExpression(expression)) return undefined;
  const outermost = expression;
  while (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
    if (
      expression.type.kind === ts.SyntaxKind.AnyKeyword ||
      expression.type.kind === ts.SyntaxKind.UnknownKeyword ||
      expression.type.kind === ts.SyntaxKind.NeverKeyword
    ) {
      return outermost;
    }
    expression = expression.expression;
    while (
      ts.isParenthesizedExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    ) {
      expression = expression.expression;
    }
  }
  return undefined;
}

function isUnconsumedObjectCall(call: ts.CallExpression): boolean {
  let value: ts.Expression = call;
  while (
    ts.isParenthesizedExpression(value.parent) ||
    ts.isAsExpression(value.parent) ||
    ts.isTypeAssertionExpression(value.parent) ||
    ts.isNonNullExpression(value.parent) ||
    ts.isSatisfiesExpression(value.parent)
  ) {
    value = value.parent;
  }
  const parent = value.parent;
  if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === value)) {
    const owner = enclosingFunction(call);
    return !owner || isExported(owner);
  }
  return !(
    (ts.isVariableDeclaration(parent) && parent.initializer === value) ||
    (ts.isPropertyAccessExpression(parent) && parent.expression === value) ||
    (ts.isElementAccessExpression(parent) && parent.expression === value)
  );
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (isConcreteFunctionLike(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function parameterIsReassigned(
  parameter: ts.ParameterDeclaration,
  owner: ts.FunctionLikeDeclaration
): boolean {
  if (!ts.isIdentifier(parameter.name) || !owner.body) return false;
  const sourceName = parameter.name.text;
  let reassigned = false;
  function visit(node: ts.Node): void {
    const left = ts.isBinaryExpression(node) ? unwrapExpression(node.left) : undefined;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      left &&
      ts.isIdentifier(left) &&
      left.text === sourceName
    ) {
      reassigned = true;
      return;
    }
    if (node !== owner.body && ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  }
  visit(owner.body);
  return reassigned;
}

function isExported(node: ts.Node): boolean {
  return Boolean(
    ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function returnExpressions(node: ts.FunctionLikeDeclaration): ts.Expression[] {
  if (!node.body) return [];
  if (!ts.isBlock(node.body)) return [node.body];
  const expressions: ts.Expression[] = [];
  function visit(child: ts.Node): void {
    if (ts.isReturnStatement(child) && child.expression) {
      expressions.push(child.expression);
      return;
    }
    if (child !== node.body && ts.isFunctionLike(child)) return;
    ts.forEachChild(child, visit);
  }
  visit(node.body);
  return expressions;
}

function jsxAttributeExpression(initializer: ts.JsxAttributeValue): ts.Expression | undefined {
  return ts.isJsxExpression(initializer) ? initializer.expression : undefined;
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

function isConcreteFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  );
}
