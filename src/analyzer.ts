import path from 'node:path';
import ts from '@typescript/typescript6';
import type { DictionaryTarget } from './dictionaries.js';
import { readDictionary, unwrapAlias, unwrapExpression } from './dictionary.js';
import { DictionaryIndex } from './dictionary-index.js';
import { expandI18nextCandidates, type TranslationVariantOptions } from './i18next-candidates.js';
import { type LoadedProject, loadProject } from './project.js';
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
}

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

/** Dictionary-expanded observation that can be serialized without compiler object identities. */
export interface UsageFact {
  dictionaryId: string;
  key: string;
  confidence: 'used' | 'possibly-used';
  evidence: UsageEvidence;
}

/** Ordered facts preserve evidence selection when replayed in Program source order. */
export interface SourceUsageFacts {
  fileName: string;
  facts: UsageFact[];
  unresolvedReferences: UsageEvidence[];
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
  },
  reuse: AnalysisReuse = {}
): LoadedProjectManyAnalysis {
  const includeEvidence = options.includeEvidence ?? true;
  const dictionaries = reuse.dictionaries ?? targets;
  const firstDictionary = dictionaries[0];
  if (!firstDictionary) throw new Error('At least one dictionary is required');
  const dictionaryKeys = [...new Set(dictionaries.flatMap(({ info }) => [...info.keys]))];
  // Existing object-resolution code needs a union shape; final facts remain dictionary-targeted.
  const dictionary = {
    ...firstDictionary.info,
    keys: new Set(dictionaryKeys),
    keySources: new Map(dictionaries.flatMap(({ info }) => [...info.keySources]))
  };
  const dictionaryPrefixes = new Set<string>();
  const keysByTopLevel = new Map<string, string[]>();
  for (const key of dictionaryKeys) {
    const segments = key.split('.');
    for (let index = 1; index < segments.length; index += 1) {
      dictionaryPrefixes.add(segments.slice(0, index).join('.'));
    }
    const topLevel = segments[0] ?? '';
    const group = keysByTopLevel.get(topLevel) ?? [];
    group.push(key);
    keysByTopLevel.set(topLevel, group);
  }
  const maxExpansions = options.maxExpansions ?? 1_000;
  const strings = createStringResolver(checker, maxExpansions);
  const projectRoot = path.dirname(configPath);
  const sourceFiles = program.getSourceFiles().filter((source) => {
    const file = path.resolve(source.fileName);
    return !source.isDeclarationFile && !file.includes(`${path.sep}node_modules${path.sep}`);
  });
  const analysisSourceFiles = reuse.filesToAnalyze
    ? sourceFiles.filter((source) => reuse.filesToAnalyze?.has(path.resolve(source.fileName)))
    : sourceFiles;

  const translators = new Map<ts.Symbol, StringResolution>();
  const translationHookWrappers = new Map<ts.Symbol, TranslationHookWrapper>();
  const wrappers = new Map<ts.Symbol, TranslationWrapper>();
  const wrapperCalls = new Map<ts.Symbol, number>();
  // Discovery still uses live Symbols, but only dirty connected components need new observations.
  const freshFacts = new Map<string, SourceUsageFacts>();
  for (const sourceFile of analysisSourceFiles) {
    const fileName = path.resolve(sourceFile.fileName);
    freshFacts.set(fileName, { fileName, facts: [], unresolvedReferences: [] });
  }
  const objectCache = new WeakMap<ts.Expression, ObjectResolution | null>();
  const dictionaryTypeCache = new WeakMap<ts.Type, ReadonlySet<string>>();
  let translationHookCache = new WeakMap<ts.CallExpression, StringResolution | null>();

  // The first pass establishes direct translator provenance needed to recognize hooks that expose
  // `t` inside a returned object. Resetting the call cache lets the second pass observe new wrappers.
  discoverHookTranslators();
  discoverTranslationHookWrappers();
  translationHookCache = new WeakMap();
  discoverHookTranslators();
  propagateTranslatorParameters();
  discoverTranslationWrappers();
  countWrapperCalls();

  analysisSourceFiles.forEach((sourceFile, index) => {
    visitSource(sourceFile);
    try {
      options.onFileAnalyzed?.(
        path.resolve(sourceFile.fileName),
        index + 1,
        analysisSourceFiles.length
      );
    } catch {
      // Instrumentation cannot change source classification or cache contents.
    }
  });

  // Fresh and cached runs share this replay boundary so classification joins remain identical.
  const dictionaryIndexes = new Map(
    dictionaries.map((target) => [
      target.id,
      DictionaryIndex.create([...target.info.keys], includeEvidence)
    ])
  );
  const unresolvedReferences: UsageEvidence[] = [];
  const unresolvedIdentities = new Set<string>();
  const sourceFacts = sourceFiles.map((sourceFile) => {
    const fileName = path.resolve(sourceFile.fileName);
    const facts = freshFacts.get(fileName) ??
      reuse.cachedFacts?.get(fileName) ?? {
        fileName,
        facts: [],
        unresolvedReferences: []
      };
    for (const fact of facts.facts) {
      dictionaryIndexes
        .get(fact.dictionaryId)
        ?.markExact(fact.key, fact.confidence, includeEvidence ? fact.evidence : undefined);
    }
    for (const evidence of facts.unresolvedReferences) {
      const identity = evidenceIdentity(evidence);
      if (unresolvedIdentities.has(identity)) continue;
      unresolvedIdentities.add(identity);
      unresolvedReferences.push(evidence);
    }
    return facts;
  });

  return {
    sourceFacts,
    unresolvedReferences,
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
    for (const sourceFile of analysisSourceFiles) {
      walk(sourceFile, (node) => {
        if (!ts.isCallExpression(node) || !isUseTranslationCall(node)) return;
        const owner = enclosingFunction(node);
        if (
          !owner ||
          !returnExpressions(owner).some((expression) => unwrapExpression(expression) === node)
        ) {
          return;
        }
        const symbol = symbolForFunction(owner);
        if (!symbol) return;
        const wrapper = translationHookWrappers.get(symbol) ?? {
          owner,
          prefixExpressions: [],
          staticPrefixes: []
        };
        wrapper.prefixExpressions.push(keyPrefixExpressionFromUseTranslation(node));
        translationHookWrappers.set(symbol, wrapper);
      });
      walk(sourceFile, (node) => {
        if (!isConcreteFunctionLike(node)) return;
        const symbol = symbolForFunction(node);
        if (!symbol) return;
        for (const returned of returnExpressions(node)) {
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
      });
    }
  }

  function discoverHookTranslators(): void {
    for (const sourceFile of analysisSourceFiles) {
      walk(sourceFile, (node) => {
        if (!ts.isVariableDeclaration(node) || !node.initializer) return;

        const hookPrefix = translationHookPrefix(node.initializer);
        if (ts.isObjectBindingPattern(node.name) && hookPrefix) {
          for (const element of node.name.elements) {
            const sourceName =
              element.propertyName?.getText(sourceFile) ?? element.name.getText(sourceFile);
            if (sourceName !== 't' || !ts.isIdentifier(element.name)) continue;
            addTranslator(checker.getSymbolAtLocation(element.name), hookPrefix);
          }
          return;
        }

        if (ts.isArrayBindingPattern(node.name) && hookPrefix) {
          const first = node.name.elements[0];
          if (first && ts.isBindingElement(first) && ts.isIdentifier(first.name)) {
            addTranslator(checker.getSymbolAtLocation(first.name), hookPrefix);
          }
          return;
        }

        if (ts.isIdentifier(node.name)) {
          const initializer = unwrapExpression(node.initializer);
          const aliasedPrefix = translatorPrefix(initializer);
          if (aliasedPrefix) {
            addTranslator(checker.getSymbolAtLocation(node.name), aliasedPrefix);
            return;
          }
          if (
            ts.isPropertyAccessExpression(initializer) &&
            initializer.name.text === 't' &&
            translationHookPrefix(initializer.expression)
          ) {
            addTranslator(
              checker.getSymbolAtLocation(node.name),
              translationHookPrefix(initializer.expression) ?? empty()
            );
          }
        }
      });
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
      for (const sourceFile of analysisSourceFiles) {
        walk(sourceFile, (node) => {
          if (!ts.isCallExpression(node)) return;
          const target = functionLikeForCall(node);
          if (!target) return;
          node.arguments.forEach((argument, index) => {
            const prefix = translatorPrefix(argument);
            const parameter = target.parameters[index];
            if (!prefix || !parameter || !ts.isIdentifier(parameter.name)) return;
            const symbol = normalizedSymbol(parameter.name);
            if (!symbol) return;
            const before = translators.get(symbol);
            const after = before ? merge(before, prefix) : prefix;
            if (!before || signatureOf(before) !== signatureOf(after)) {
              translators.set(symbol, after);
              changed = true;
            }
          });
        });
      }
    }
  }

  function discoverTranslationWrappers(): void {
    for (const sourceFile of analysisSourceFiles) {
      walk(sourceFile, (node) => {
        if (!ts.isCallExpression(node) || !translatorPrefix(node.expression)) return;
        const key = node.arguments[0] ? unwrapExpression(node.arguments[0]) : undefined;
        if (!key || !ts.isIdentifier(key)) return;
        const owner = enclosingFunction(node);
        if (!owner) return;
        const parameterIndex = owner.parameters.findIndex(
          (parameter) =>
            ts.isIdentifier(parameter.name) &&
            normalizedSymbol(parameter.name) === normalizedSymbol(key)
        );
        if (parameterIndex < 0) return;
        const parameter = owner.parameters[parameterIndex];
        if (!parameter || parameterIsReassigned(parameter, owner)) return;
        const ownerSymbol = symbolForFunction(owner);
        if (!ownerSymbol) return;
        wrappers.set(ownerSymbol, {
          keyParameter: parameterIndex,
          prefix: translatorPrefix(node.expression) ?? empty()
        });
      });
    }
  }

  function countWrapperCalls(): void {
    for (const sourceFile of analysisSourceFiles) {
      walk(sourceFile, (node) => {
        if (!ts.isCallExpression(node)) return;
        const symbol = normalizedSymbol(node.expression);
        if (symbol && wrappers.has(symbol)) {
          wrapperCalls.set(symbol, (wrapperCalls.get(symbol) ?? 0) + 1);
        }
      });
    }
  }

  function visitSource(sourceFile: ts.SourceFile): void {
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) analyzeCall(node);
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer
      ) {
        const object = resolveObject(node.initializer);
        if (object) analyzeBindingPattern(node.name, object, node);
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
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
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
      if (callHasTrueOption(call, 'returnObjects')) {
        if (isUnconsumedObjectCall(call)) {
          markSubtrees(
            resolution,
            call,
            'Translation object escapes without property-level analysis'
          );
        }
        return;
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

    if (isEnumerationCall(call)) {
      const object = call.arguments[0] ? resolveObject(call.arguments[0]) : undefined;
      if (object) markSubtrees(object, call, 'Runtime enumeration of translation object');
      return;
    }

    for (const argument of call.arguments) {
      const object = resolveObject(argument);
      if (object) markSubtrees(object, argument, 'Translation object passed to another function');
    }
  }

  function analyzeTrans(node: ts.JsxOpeningLikeElement): void {
    const tagTarget = ts.isPropertyAccessExpression(node.tagName)
      ? node.tagName.name
      : node.tagName;
    const tagSymbol = checker.getSymbolAtLocation(tagTarget);
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

    const exactLeaves = [...object.values].filter((key) => dictionary.keys.has(key));
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
        !parameterIsReassigned(parameter, owner) &&
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
        const leaves = [...child.values].filter((key) => dictionary.keys.has(key));
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
      if (prefix && callHasTrueOption(expression, 'returnObjects') && expression.arguments[0]) {
        return {
          ...prepend(prefix, strings.resolve(expression.arguments[0])),
          origin: 'translation'
        };
      }

      const target = functionLikeForCall(expression);
      if (target?.body) {
        const returns = returnExpressions(target);
        let result: ObjectResolution | undefined;
        for (const returned of returns) {
          const candidate = resolveObject(returned, nextSeen);
          if (!candidate) continue;
          result = result ? mergeObjects(result, candidate) : candidate;
        }
        if (result) return result;
      }

      const dictionaryIds = dictionaryIdsForType(checker.getTypeAtLocation(expression));
      if (dictionaryIds.size > 0) {
        return { ...exact(''), origin: 'dictionary', dictionaryIds };
      }
    }

    if (ts.isIdentifier(expression)) {
      const symbol = normalizedSymbol(expression);
      const dictionaryIds = new Set(
        dictionaries.filter(({ info }) => symbol === info.symbol).map(({ id }) => id)
      );
      if (dictionaryIds.size > 0) {
        return { ...exact(''), origin: 'dictionary', dictionaryIds };
      }
      const declaration = normalizedSymbol(expression)?.declarations?.find(
        ts.isVariableDeclaration
      );
      if (declaration?.initializer) return resolveObject(declaration.initializer, nextSeen);
    }

    if (ts.isPropertyAccessExpression(expression)) {
      const base = resolveObject(expression.expression, nextSeen);
      if (!base) return undefined;
      if (resolvesDictionaryLeaf(base)) return base;
      return appendObject(base, exact(expression.name.text));
    }

    if (ts.isElementAccessExpression(expression)) {
      const base = resolveObject(expression.expression, nextSeen);
      if (!base || !expression.argumentExpression) return base;
      if (resolvesDictionaryLeaf(base)) return base;
      return appendObject(base, strings.resolve(expression.argumentExpression));
    }

    return undefined;
  }

  function resolvesDictionaryLeaf(base: ObjectResolution): boolean {
    const candidates = base.dictionaryIds
      ? dictionaries.filter(({ id }) => base.dictionaryIds?.has(id))
      : dictionaries;
    return [...base.values].some((value) =>
      candidates.some(
        ({ info }) =>
          info.keys.has(value) && ![...info.keys].some((key) => key.startsWith(`${value}.`))
      )
    );
  }

  function appendObject(base: ObjectResolution, segment: StringResolution): ObjectResolution {
    const result = prepend(base, segment);
    if (!segment.complete && segment.patterns.size === 0) {
      for (const value of base.values) result.patterns.add(joinKey(value, '*'));
      for (const pattern of base.patterns) result.patterns.add(joinKey(pattern, '*'));
    }
    return {
      ...result,
      origin: base.origin,
      ...(base.dictionaryIds ? { dictionaryIds: base.dictionaryIds } : {})
    };
  }

  function mergeObjects(a: ObjectResolution, b: ObjectResolution): ObjectResolution {
    const dictionaryIds = new Set([...(a.dictionaryIds ?? []), ...(b.dictionaryIds ?? [])]);
    return {
      ...merge(a, b),
      origin: a.origin === b.origin ? a.origin : 'translation',
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
      const symbol = checker.getSymbolAtLocation(unwrapped.name);
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
    const directSymbol = checker.getSymbolAtLocation(unwrapped);
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
    const symbol = checker.getSymbolAtLocation(target);
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
    if (!ts.isObjectLiteralExpression(value)) return null;
    for (const property of [...value.properties].reverse()) {
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

  function callHasTrueOption(call: ts.CallExpression, option: string): boolean {
    for (const argument of call.arguments.slice(1)) {
      const value = unwrapExpression(argument);
      if (ts.isIdentifier(value)) {
        const declaration = normalizedSymbol(value)?.declarations?.find(ts.isVariableDeclaration);
        if (declaration?.initializer) {
          const configured = booleanOption(declaration.initializer, option);
          if (configured !== undefined) {
            if (configured) return true;
            continue;
          }
        }
      } else {
        const configured = booleanOption(value, option);
        if (configured !== undefined) {
          if (configured) return true;
          continue;
        }
      }

      const type = checker.getTypeAtLocation(argument);
      const property = checker.getPropertyOfType(type, option);
      if (property) {
        const propertyType = checker.getTypeOfSymbolAtLocation(property, argument);
        if (checker.typeToString(propertyType) === 'true') return true;
      }
    }
    return false;
  }

  function booleanOption(expression: ts.Expression, option: string): boolean | undefined {
    const value = unwrapExpression(expression);
    if (ts.isIdentifier(value)) {
      const declaration = normalizedSymbol(value)?.declarations?.find(ts.isVariableDeclaration);
      return declaration?.initializer ? booleanOption(declaration.initializer, option) : undefined;
    }
    if (!ts.isObjectLiteralExpression(value)) return undefined;
    for (const property of [...value.properties].reverse()) {
      if (ts.isSpreadAssignment(property)) {
        const spread = booleanOption(property.expression, option);
        if (spread !== undefined) return spread;
      }
      if (!ts.isPropertyAssignment(property)) continue;
      const name = staticPropertyName(property.name);
      if (name === option) return property.initializer.kind === ts.SyntaxKind.TrueKeyword;
    }
    return undefined;
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
      const facts = factsForNode(node);
      if (
        !facts.unresolvedReferences.some(
          (entry) => evidenceIdentity(entry) === evidenceIdentity(evidence)
        )
      )
        facts.unresolvedReferences.push(evidence);
    }
  }

  function markTranslationResolution(
    resolution: StringResolution,
    variants: TranslationVariantOptions,
    node: ts.Node,
    reason: string
  ): void {
    const expansion = expandI18nextCandidates(
      resolution,
      variants,
      dictionaries.map(({ id, locale, info }) => ({ id, locale, keys: info.keys }))
    );
    const facts = factsForNode(node);
    for (const observation of expansion.observations) {
      facts.facts.push({
        dictionaryId: observation.dictionaryId,
        key: observation.key,
        confidence: observation.confidence,
        evidence: evidenceFor(node, observation.confidence, reason)
      });
    }
    if (expansion.unresolved) {
      const evidence = evidenceFor(node, 'possibly-used', `${reason}: unresolved runtime options`);
      if (
        !facts.unresolvedReferences.some(
          (entry) => evidenceIdentity(entry) === evidenceIdentity(evidence)
        )
      ) {
        facts.unresolvedReferences.push(evidence);
      }
    }
    if (!resolution.complete && resolution.patterns.size === 0) {
      const evidence = evidenceFor(node, 'possibly-used', `${reason}: unresolved runtime key`);
      if (
        !facts.unresolvedReferences.some(
          (entry) => evidenceIdentity(entry) === evidenceIdentity(evidence)
        )
      ) {
        facts.unresolvedReferences.push(evidence);
      }
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
          : countType(checker.getTypeAtLocation(count)) === 'number'
            ? { count: strings.resolve(count) }
            : countType(checker.getTypeAtLocation(count)) === 'unknown'
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

  function markSubtree(
    prefix: string,
    node: ts.Node,
    reason: string,
    dictionaryIds?: ReadonlySet<string>
  ): void {
    const normalized = prefix ? `${prefix}.` : '';
    markKeys(
      candidatesForPrefix(prefix).filter((key) => key.startsWith(normalized)),
      'possibly-used',
      node,
      reason,
      dictionaryIds
    );
  }

  function markPattern(
    pattern: string,
    node: ts.Node,
    reason: string,
    dictionaryIds?: ReadonlySet<string>
  ): void {
    const matcher = globMatcher(pattern);
    const staticPrefix = pattern.slice(
      0,
      pattern.indexOf('*') < 0 ? pattern.length : pattern.indexOf('*')
    );
    markKeys(
      candidatesForPrefix(staticPrefix).filter((key) => matcher.test(key)),
      'possibly-used',
      node,
      reason,
      dictionaryIds
    );
  }

  function markKeys(
    candidateKeys: string[],
    confidence: 'used' | 'possibly-used',
    node: ts.Node,
    reason: string,
    dictionaryIds?: ReadonlySet<string>
  ): void {
    const evidence = evidenceFor(node, confidence, reason);
    const facts = factsForNode(node);
    for (const key of candidateKeys) {
      for (const target of dictionaries) {
        if (dictionaryIds && !dictionaryIds.has(target.id)) continue;
        if (!target.info.keys.has(key)) continue;
        facts.facts.push({ dictionaryId: target.id, key, confidence, evidence });
      }
    }
  }

  function factsForNode(node: ts.Node): SourceUsageFacts {
    const fileName = path.resolve(node.getSourceFile().fileName);
    let facts = freshFacts.get(fileName);
    if (!facts) {
      facts = { fileName, facts: [], unresolvedReferences: [] };
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
    const target = ts.isPropertyAccessExpression(node) ? node.name : node;
    return unwrapAlias(checker, checker.getSymbolAtLocation(target));
  }

  function functionLikeForCall(call: ts.CallExpression): ts.FunctionLikeDeclaration | undefined {
    const symbol = normalizedSymbol(call.expression);
    for (const declaration of symbol?.declarations ?? []) {
      if (isConcreteFunctionLike(declaration)) return declaration;
      if (
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        (ts.isArrowFunction(declaration.initializer) ||
          ts.isFunctionExpression(declaration.initializer))
      ) {
        return declaration.initializer;
      }
    }
    return undefined;
  }

  function symbolForFunction(node: ts.FunctionLikeDeclaration): ts.Symbol | undefined {
    if (node.name) return normalizedSymbol(node.name);
    if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
      return normalizedSymbol(node.parent.name);
    }
    return undefined;
  }

  function dictionaryIdsForType(type: ts.Type): ReadonlySet<string> {
    const cached = dictionaryTypeCache.get(type);
    if (cached !== undefined) return cached;
    const result = computeDictionaryIdsForType(type);
    dictionaryTypeCache.set(type, result);
    return result;
  }

  function computeDictionaryIdsForType(type: ts.Type): ReadonlySet<string> {
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never))
      return new Set();
    const ids = new Set<string>();
    for (const target of dictionaries) {
      if (type === target.info.type) ids.add(target.id);

      const typeSymbol = unwrapAlias(checker, type.aliasSymbol ?? type.getSymbol());
      const dictionarySymbol = unwrapAlias(
        checker,
        target.info.type.aliasSymbol ?? target.info.type.getSymbol()
      );
      if (typeSymbol && dictionarySymbol && typeSymbol === dictionarySymbol) ids.add(target.id);
    }

    return ids;
  }

  function hasDescendants(prefix: string): boolean {
    return dictionaryPrefixes.has(prefix);
  }

  function candidatesForPrefix(prefix: string): string[] {
    const topLevel = prefix.split('.')[0];
    if (!topLevel) return dictionaryKeys;
    if (prefix.includes('.')) return keysByTopLevel.get(topLevel) ?? [];
    const candidates: string[] = [];
    for (const [name, keys] of keysByTopLevel) {
      if (name.startsWith(topLevel)) candidates.push(...keys);
    }
    return candidates;
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

  function isI18nextTFunction(expression: ts.Expression): boolean {
    // Type provenance supports declaration-only TFunction values without accepting structural lookalikes.
    const type = checker.getTypeAtLocation(expression);
    if (type.getCallSignatures().length === 0) return false;
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
      return true;
    }
    return type.getCallSignatures().some((signature) => {
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

function globMatcher(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`);
}

function walk(node: ts.Node, visitor: (node: ts.Node) => void): void {
  visitor(node);
  ts.forEachChild(node, (child) => walk(child, visitor));
}

function signatureOf(resolution: StringResolution): string {
  return JSON.stringify({
    values: [...resolution.values].sort(),
    patterns: [...resolution.patterns].sort(),
    complete: resolution.complete
  });
}

function evidenceIdentity(evidence: UsageEvidence): string {
  return `${evidence.confidence}:${evidence.file}:${evidence.line}:${evidence.column}:${evidence.reason}`;
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
