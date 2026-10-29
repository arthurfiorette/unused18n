import path from 'node:path';
import {
  type CallExpression,
  type Declaration,
  isPropertyAccessExpression,
  type Node,
  type PathKey,
  type SourceFile,
  type TypeNode
} from 'typescript/ast';
import {
  type API,
  type APIRequestGenerator,
  type Checker,
  type NodeHandle,
  type Program,
  type Signature,
  SymbolFlags,
  type Symbol as TsSymbol,
  type Type
} from 'typescript/sync';

/** Generators per `api.batch` call; far below the engine's argument-spread limit. */
const BATCH_CHUNK_SIZE = 4_096;

/**
 * Lookup accounting used by debug output and tests to spot per-node IPC regressions.
 *
 * The counts approximate compiler traffic without matching it exactly. Methods called on
 * `Type`, `Symbol` and `Signature` objects, such as `getTypes` or `getCallSignatures`, bypass
 * this class and are not counted. Declaration lookups are counted even when the declaring file
 * is already in this process and no request is sent.
 */
export interface SemanticStats {
  /** Lookups through this class that missed its caches and were resolved one at a time. */
  singleRequests: number;
  /** Batched lookups issued by prefetching, one per batch chunk, each covering many nodes. */
  batchRequests: number;
}

/**
 * Cached facade over the TypeScript 7 checker for one program.
 *
 * Every checker call is a synchronous IPC round trip to the compiler process, so analysis code
 * must never call the checker directly. Each lookup is memoized here, and the `prefetch*` methods
 * fill the same caches with one batched request per stage. Prefetching only moves cost: a lookup
 * that was not prefetched still produces the identical result through a single request.
 *
 * Results stay valid only while the owning program is alive, so the facade is created and
 * disposed together with the loaded project.
 */
export class Semantic {
  readonly stats: SemanticStats = { singleRequests: 0, batchRequests: 0 };

  private readonly rawSymbols = new WeakMap<Node, TsSymbol | null>();
  private readonly aliasTargets = new Map<TsSymbol, TsSymbol | null>();
  private readonly types = new WeakMap<Node, Type>();
  private readonly declarationLists = new Map<TsSymbol, readonly Declaration[]>();
  private readonly valueDeclarations = new Map<TsSymbol, Declaration | null>();
  private readonly shorthandSymbols = new WeakMap<Node, TsSymbol | null>();
  private readonly resolvedSignatures = new WeakMap<Node, Signature | null>();
  private readonly signatureDeclarations = new Map<Signature, Declaration | null>();
  private readonly signaturesFromDeclarations = new WeakMap<Node, Signature>();
  private readonly returnTypes = new Map<Signature, Type>();
  private readonly typeNodeTypes = new WeakMap<Node, Type>();
  private readonly arrayTypes = new Map<Type, boolean>();
  private readonly propertyLists = new Map<Type, readonly TsSymbol[]>();
  private readonly namedProperties = new Map<Type, Map<string, TsSymbol | null>>();
  private readonly defaultLibraries = new Map<SourceFile, boolean>();
  private readonly sourceFiles = new Map<string, SourceFile | null>();
  /** Paths of files already transferred to this process; declarations there resolve locally. */
  private readonly loadedPaths = new Set<PathKey>();

  /** The API instance that owns the compiler process, used for batched requests. */
  readonly api: API;
  /** The program every lookup is answered against. */
  readonly program: Program;

  /**
   * @param api The API instance that owns the compiler process.
   * @param program The program every lookup is answered against.
   */
  constructor(api: API, program: Program) {
    this.api = api;
    this.program = program;
  }

  /** The checker of {@link program}; every query goes through a method of this class. */
  private get checker(): Checker {
    return this.program.getProject().checker;
  }

  /**
   * Returns a program source file by absolute or relative path.
   *
   * @param fileName Any path form; it is resolved against the process working directory.
   */
  sourceFile(fileName: string): SourceFile | undefined {
    const key = path.resolve(fileName);
    const cached = this.sourceFiles.get(key);
    if (cached !== undefined) return cached ?? undefined;
    this.stats.singleRequests += 1;
    const sourceFile = this.program.getSourceFile(key);
    this.sourceFiles.set(key, sourceFile ?? null);
    if (sourceFile) this.loadedPaths.add(sourceFile.path);
    return sourceFile;
  }

  /**
   * Runs one request generator per item through `api.batch`, in chunks.
   *
   * `api.batch` takes generators as rest arguments, and spreading a large project's lookups
   * (tens of thousands of declaration handles) into one call overflows the JS call stack.
   * Each chunk is still a single round trip, so request counts stay proportional to chunks.
   *
   * @param items Inputs in result order.
   * @param toGenerator Creates the `.gen` request for one item; called lazily per chunk.
   * @returns One result per item, in the same order as `items`.
   */
  batch<Item, Result>(
    items: readonly Item[],
    toGenerator: (item: Item) => APIRequestGenerator<Result>
  ): Result[] {
    const results: Result[] = [];
    for (let start = 0; start < items.length; start += BATCH_CHUNK_SIZE) {
      const chunk = items.slice(start, start + BATCH_CHUNK_SIZE).map(toGenerator);
      // A one-item chunk, such as one lazily resolved symbol, is an ordinary single request.
      if (chunk.length === 1) this.stats.singleRequests += 1;
      else this.stats.batchRequests += 1;
      for (const result of this.api.batch(...chunk)) results.push(result as Result);
    }
    return results;
  }

  /**
   * Fetches many source files in one batched request.
   *
   * @param fileNames Absolute or relative paths; files outside the program map to `undefined`.
   * @returns Source files in the same order as `fileNames`.
   */
  prefetchSourceFiles(fileNames: readonly string[]): (SourceFile | undefined)[] {
    const keys = fileNames.map((fileName) => path.resolve(fileName));
    const missing = [...new Set(keys.filter((key) => !this.sourceFiles.has(key)))];
    if (missing.length > 0) {
      const fetched = this.batch(missing, (key) => this.program.getSourceFile.gen(key));
      missing.forEach((key, index) => {
        const sourceFile = fetched[index];
        this.sourceFiles.set(key, sourceFile ?? null);
        if (sourceFile) this.loadedPaths.add(sourceFile.path);
      });
    }
    return keys.map((key) => this.sourceFiles.get(key) ?? undefined);
  }

  /** Returns the checker's symbol at `node` without following import aliases. */
  rawSymbol(node: Node): TsSymbol | undefined {
    const cached = this.rawSymbols.get(node);
    if (cached !== undefined) return cached ?? undefined;
    this.stats.singleRequests += 1;
    const symbol = this.checker.getSymbolAtLocation(node);
    this.rawSymbols.set(node, symbol ?? null);
    return symbol;
  }

  /**
   * Follows an alias symbol to its target.
   *
   * Unresolvable aliases yield `undefined` rather than the checker's shared "unknown" symbol,
   * so separate unresolved imports never compare equal or share map entries.
   */
  aliased(symbol: TsSymbol | undefined): TsSymbol | undefined {
    if (!symbol || (symbol.flags & SymbolFlags.Alias) === 0) return symbol;
    const cached = this.aliasTargets.get(symbol);
    if (cached !== undefined) return cached ?? undefined;
    this.stats.singleRequests += 1;
    const target = this.checker.getAliasedSymbol(symbol);
    const resolved = this.checker.isUnknownSymbol(target) ? null : target;
    this.aliasTargets.set(symbol, resolved);
    return resolved ?? undefined;
  }

  /**
   * Returns the alias-resolved symbol for a node, reading property accesses through their name
   * because the checker attaches member symbols to the name rather than the whole expression.
   */
  symbol(node: Node): TsSymbol | undefined {
    return this.aliased(this.rawSymbol(isPropertyAccessExpression(node) ? node.name : node));
  }

  /** Returns the checker's type at `node`; failures surface as the error type, never `undefined`. */
  typeAt(node: Node): Type {
    const cached = this.types.get(node);
    if (cached) return cached;
    this.stats.singleRequests += 1;
    const type = this.checker.getTypeAtLocation(node);
    this.types.set(node, type);
    return type;
  }

  /** Returns the declaration nodes of a symbol, resolved from their remote handles. */
  declarations(symbol: TsSymbol | undefined): readonly Declaration[] {
    if (!symbol) return [];
    const cached = this.declarationLists.get(symbol);
    if (cached) return cached;
    this.resolveDeclarations([symbol]);
    return this.declarationLists.get(symbol) ?? [];
  }

  /** Returns the value declaration of a symbol, if the binder recorded one. */
  valueDeclaration(symbol: TsSymbol | undefined): Declaration | undefined {
    if (!symbol?.valueDeclaration) return undefined;
    const cached = this.valueDeclarations.get(symbol);
    if (cached !== undefined) return cached ?? undefined;
    this.stats.singleRequests += 1;
    const declaration = symbol.valueDeclaration.resolve();
    this.valueDeclarations.set(symbol, declaration ?? null);
    return declaration;
  }

  /** Returns the value symbol a shorthand property assignment reads from. */
  shorthandValueSymbol(node: Node): TsSymbol | undefined {
    const cached = this.shorthandSymbols.get(node);
    if (cached !== undefined) return cached ?? undefined;
    this.stats.singleRequests += 1;
    const symbol = this.checker.getShorthandAssignmentValueSymbol(node);
    this.shorthandSymbols.set(node, symbol ?? null);
    return symbol;
  }

  /** Returns the signature a call resolves to, or `undefined` when overload resolution fails. */
  resolvedSignature(call: CallExpression): Signature | undefined {
    const cached = this.resolvedSignatures.get(call);
    if (cached !== undefined) return cached ?? undefined;
    this.stats.singleRequests += 1;
    const signature = this.checker.getResolvedSignature(call);
    const resolved = this.checker.isUnknownSignature(signature) ? null : signature;
    this.resolvedSignatures.set(call, resolved);
    return resolved ?? undefined;
  }

  /** Returns the declaration a signature was created from, if any. */
  signatureDeclaration(signature: Signature): Declaration | undefined {
    const cached = this.signatureDeclarations.get(signature);
    if (cached !== undefined) return cached ?? undefined;
    const handle = signature.declaration;
    if (handle) this.stats.singleRequests += 1;
    const declaration = handle?.resolve();
    this.signatureDeclarations.set(signature, declaration ?? null);
    return declaration;
  }

  /** Returns the signature of a function-like declaration. */
  signatureFromDeclaration(declaration: Node): Signature {
    const cached = this.signaturesFromDeclarations.get(declaration);
    if (cached) return cached;
    this.stats.singleRequests += 1;
    const signature = this.checker.getSignatureFromDeclaration(declaration);
    this.signaturesFromDeclarations.set(declaration, signature);
    return signature;
  }

  /** Returns the return type of a signature. */
  returnType(signature: Signature): Type {
    const cached = this.returnTypes.get(signature);
    if (cached) return cached;
    this.stats.singleRequests += 1;
    const type = this.checker.getReturnTypeOfSignature(signature);
    this.returnTypes.set(signature, type);
    return type;
  }

  /** Returns the type a type node denotes. */
  typeFromTypeNode(node: TypeNode): Type {
    const cached = this.typeNodeTypes.get(node);
    if (cached) return cached;
    this.stats.singleRequests += 1;
    const type = this.checker.getTypeFromTypeNode(node);
    this.typeNodeTypes.set(node, type);
    return type;
  }

  /** Returns whether the checker treats `type` as an `Array<T>` instance. */
  isArrayType(type: Type): boolean {
    const cached = this.arrayTypes.get(type);
    if (cached !== undefined) return cached;
    this.stats.singleRequests += 1;
    const result = this.checker.isArrayType(type);
    this.arrayTypes.set(type, result);
    return result;
  }

  /** Returns the properties of `type`. */
  propertiesOfType(type: Type): readonly TsSymbol[] {
    const cached = this.propertyLists.get(type);
    if (cached) return cached;
    this.stats.singleRequests += 1;
    const properties = this.checker.getPropertiesOfType(type);
    this.propertyLists.set(type, properties);
    return properties;
  }

  /**
   * Returns the named property of `type`. This can differ from {@link propertiesOfType}, which
   * omits apparent members such as `toString`, so it is never answered from that list.
   */
  propertyOfType(type: Type, name: string): TsSymbol | undefined {
    let byName = this.namedProperties.get(type);
    if (!byName) {
      byName = new Map();
      this.namedProperties.set(type, byName);
    }
    const cached = byName.get(name);
    if (cached !== undefined) return cached ?? undefined;
    this.stats.singleRequests += 1;
    const property = this.checker.getPropertyOfType(type, name);
    byName.set(name, property ?? null);
    return property;
  }

  /**
   * Returns the symbol the binder declared for `node`, such as the module symbol of a JSON file,
   * which has no name node to look up. Uncached: dictionary reading asks once per dictionary.
   */
  symbolOfNode(node: Node): TsSymbol | undefined {
    this.stats.singleRequests += 1;
    return this.checker.getSymbolOfNode(node);
  }

  /** Returns the exports of a module symbol. Uncached for the same reason as {@link symbolOfNode}. */
  exportsOfModule(symbol: TsSymbol): readonly TsSymbol[] {
    this.stats.singleRequests += 1;
    return this.checker.getExportsOfModule(symbol);
  }

  /**
   * Returns the type of `symbol` as seen at `location`. Uncached for the same reason as
   * {@link symbolOfNode}.
   */
  typeOfSymbolAtLocation(symbol: TsSymbol, location: Node): Type {
    this.stats.singleRequests += 1;
    return this.checker.getTypeOfSymbolAtLocation(symbol, location);
  }

  /** Returns whether a source file is one of the compiler's bundled `lib.*.d.ts` files. */
  isDefaultLibrary(sourceFile: SourceFile): boolean {
    const cached = this.defaultLibraries.get(sourceFile);
    if (cached !== undefined) return cached;
    this.stats.singleRequests += 1;
    const result = this.program.isSourceFileDefaultLibrary(sourceFile);
    this.defaultLibraries.set(sourceFile, result);
    return result;
  }

  /**
   * Resolves symbols for many nodes in a fixed number of batched requests, then resolves their
   * alias targets and declarations so later {@link symbol} and {@link declarations} calls are local.
   *
   * @param nodes Lookup sites in any order; duplicates and already-cached nodes are skipped.
   */
  prefetchSymbols(nodes: Iterable<Node>): void {
    const pending = [...new Set(nodes)].filter((node) => !this.rawSymbols.has(node));
    if (pending.length === 0) return;
    this.stats.batchRequests += 1;
    const symbols = this.checker.getSymbolAtLocation(pending);
    pending.forEach((node, index) => {
      this.rawSymbols.set(node, symbols[index] ?? null);
    });
    this.resolveFetchedSymbols(symbols);
  }

  /**
   * Resolves the value symbols of many shorthand property assignments in one batched request,
   * then their alias targets and declarations as {@link prefetchSymbols} does.
   *
   * @param nodes Shorthand property assignments; duplicates and already-cached nodes are skipped.
   */
  prefetchShorthandSymbols(nodes: Iterable<Node>): void {
    const pending = [...new Set(nodes)].filter((node) => !this.shorthandSymbols.has(node));
    if (pending.length === 0) return;
    const symbols = this.batch(pending, (node) =>
      this.checker.getShorthandAssignmentValueSymbol.gen(node)
    );
    pending.forEach((node, index) => {
      this.shorthandSymbols.set(node, symbols[index] ?? null);
    });
    this.resolveFetchedSymbols(symbols);
  }

  /**
   * Fills the alias and declaration caches for symbols a prefetch just returned, so the lookups
   * that typically follow a symbol lookup are local too.
   */
  private resolveFetchedSymbols(symbols: readonly (TsSymbol | undefined)[]): void {
    const resolved = new Set<TsSymbol>();
    const aliases = new Set<TsSymbol>();
    for (const symbol of symbols) {
      if (!symbol) continue;
      resolved.add(symbol);
      if (symbol.flags & SymbolFlags.Alias && !this.aliasTargets.has(symbol)) aliases.add(symbol);
    }
    if (aliases.size > 0) {
      const ordered = [...aliases];
      const targets = this.batch(ordered, (symbol) => this.checker.getAliasedSymbol.gen(symbol));
      ordered.forEach((symbol, index) => {
        const target = targets[index];
        // The unknown-symbol identity is fetched once per checker, so this check stays local.
        const known = target && !this.checker.isUnknownSymbol(target) ? target : null;
        this.aliasTargets.set(symbol, known);
        if (known) resolved.add(known);
      });
    }
    // Only declarations inside already-transferred files are resolved here. Resolving the rest
    // would fetch every package typing file any symbol touches (React, icon sets, lib.dom),
    // most of which analysis never reads; those resolve lazily through `declarations`.
    this.resolveDeclarations(
      [...resolved].filter((symbol) =>
        symbol.declarations.every((handle) => this.loadedPaths.has(handle.path))
      )
    );
  }

  /**
   * Batches {@link typeFromTypeNode} for many type nodes.
   *
   * @param nodes Type nodes in any order; duplicates and already-cached nodes are skipped.
   */
  prefetchTypesFromTypeNodes(nodes: Iterable<TypeNode>): void {
    this.prefetchInto<TypeNode, Type>(this.typeNodeTypes, nodes, (node) =>
      this.checker.getTypeFromTypeNode.gen(node)
    );
  }

  /**
   * Batches {@link signatureFromDeclaration} and then {@link returnType} for many declarations,
   * one round trip each.
   *
   * @param declarations Function-like declarations; duplicates and cached entries are skipped.
   */
  prefetchReturnTypes(declarations: Iterable<Node>): void {
    const unique = [...new Set(declarations)];
    this.prefetchInto(this.signaturesFromDeclarations, unique, (declaration) =>
      this.checker.getSignatureFromDeclaration.gen(declaration)
    );
    const signatures = unique.flatMap((declaration) => {
      const signature = this.signaturesFromDeclarations.get(declaration);
      return signature ? [signature] : [];
    });
    this.prefetchInto(this.returnTypes, signatures, (signature) =>
      this.checker.getReturnTypeOfSignature.gen(signature)
    );
  }

  /** Fills `cache` for every key it lacks through {@link batch}. */
  private prefetchInto<Key, Value>(
    cache: { has(key: Key): boolean; set(key: Key, value: Value): unknown },
    keys: Iterable<Key>,
    toGenerator: (key: Key) => APIRequestGenerator<Value>
  ): void {
    const pending = [...new Set(keys)].filter((key) => !cache.has(key));
    const values = this.batch(pending, toGenerator);
    pending.forEach((key, index) => {
      cache.set(key, values[index] as Value);
    });
  }

  /**
   * Resolves types for many nodes in one batched request.
   *
   * @param nodes Lookup sites in any order; duplicates and already-cached nodes are skipped.
   */
  prefetchTypes(nodes: Iterable<Node>): void {
    const pending = [...new Set(nodes)].filter((node) => !this.types.has(node));
    if (pending.length === 0) return;
    this.stats.batchRequests += 1;
    const types = this.checker.getTypeAtLocation(pending);
    pending.forEach((node, index) => {
      const type = types[index];
      if (type) this.types.set(node, type);
    });
  }

  /**
   * Resolves the declaration handles of several symbols together.
   *
   * Requests inside one `api.batch` run concurrently, so every handle whose file is not yet in
   * this process would transfer that whole file again. Only the first handle per declaring file
   * goes into the batch; the rest resolve afterwards against the file it brought in.
   */
  private resolveDeclarations(symbols: Iterable<TsSymbol>): void {
    const pending = [...symbols].filter((symbol) => !this.declarationLists.has(symbol));
    const firstPerFile = new Map<PathKey, NodeHandle<Declaration>>();
    for (const symbol of pending) {
      for (const handle of symbol.declarations) {
        if (!firstPerFile.has(handle.path)) firstPerFile.set(handle.path, handle);
      }
    }
    const leaders = [...firstPerFile.values()];
    const leaderNodes = this.batch(leaders, (handle) => handle.resolve.gen());
    const resolved = new Map(leaders.map((handle, index) => [handle, leaderNodes[index]]));
    for (const symbol of pending) {
      const declarations: Declaration[] = [];
      for (const handle of symbol.declarations) {
        const node = resolved.has(handle) ? resolved.get(handle) : handle.resolve();
        if (node) declarations.push(node);
      }
      this.declarationLists.set(symbol, declarations);
    }
  }
}
