import path from 'node:path';
import {
  type CallExpression,
  type Declaration,
  isPropertyAccessExpression,
  type Node,
  type SourceFile,
  type TypeNode
} from 'typescript/ast';
import {
  type API,
  type Checker,
  type Program,
  type Signature,
  SymbolFlags,
  type Symbol as TsSymbol,
  type Type
} from 'typescript/sync';

/** Request accounting used by debug output and tests to spot per-node IPC regressions. */
export interface SemanticStats {
  /** Lookups that missed every cache and paid one IPC round trip on their own. */
  singleRequests: number;
  /** Batched requests issued by prefetching, each covering many lookups. */
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
  private readonly defaultLibraries = new Map<SourceFile, boolean>();
  private readonly sourceFiles = new Map<string, SourceFile | null>();

  /**
   * @param api The API instance that owns the compiler process, used for batched requests.
   * @param program The program every lookup is answered against.
   */
  constructor(
    readonly api: API,
    readonly program: Program
  ) {}

  /** The checker of {@link program}, exposed for the few uncached, cold-path queries. */
  get checker(): Checker {
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
    return sourceFile;
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
      this.stats.batchRequests += 1;
      const fetched = this.api.batch(...missing.map((key) => this.program.getSourceFile.gen(key)));
      missing.forEach((key, index) => this.sourceFiles.set(key, fetched[index] ?? null));
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

  /** Returns the named property of `type`, reading the cached property list when one exists. */
  propertyOfType(type: Type, name: string): TsSymbol | undefined {
    const properties = this.propertyLists.get(type);
    if (properties) return properties.find((property) => property.name === name);
    this.stats.singleRequests += 1;
    return this.checker.getPropertyOfType(type, name);
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
    pending.forEach((node, index) => this.rawSymbols.set(node, symbols[index] ?? null));

    const resolved = new Set<TsSymbol>();
    const aliases = new Set<TsSymbol>();
    for (const symbol of symbols) {
      if (!symbol) continue;
      resolved.add(symbol);
      if (symbol.flags & SymbolFlags.Alias && !this.aliasTargets.has(symbol)) aliases.add(symbol);
    }
    if (aliases.size > 0) {
      const ordered = [...aliases];
      this.stats.batchRequests += 1;
      const targets = this.api.batch(
        ...ordered.map((symbol) => this.checker.getAliasedSymbol.gen(symbol))
      );
      ordered.forEach((symbol, index) => {
        const target = targets[index];
        // The unknown-symbol identity is fetched once per checker, so this check stays local.
        const known = target && !this.checker.isUnknownSymbol(target) ? target : null;
        this.aliasTargets.set(symbol, known);
        if (known) resolved.add(known);
      });
    }
    this.resolveDeclarations(resolved);
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
   * Resolves the declaration handles of several symbols together. Handles in already-fetched
   * files resolve locally, so the batch only pays for the first fetch of each declaring file.
   */
  private resolveDeclarations(symbols: Iterable<TsSymbol>): void {
    const pending = [...symbols].filter((symbol) => !this.declarationLists.has(symbol));
    const handles = pending.flatMap((symbol) => symbol.declarations);
    if (handles.length > 0) this.stats.batchRequests += 1;
    const nodes = handles.length > 0 ? this.api.batch(...handles.map((h) => h.resolve.gen())) : [];
    let offset = 0;
    for (const symbol of pending) {
      const count = symbol.declarations.length;
      const declarations = nodes
        .slice(offset, offset + count)
        .filter((node): node is Declaration => node !== undefined);
      offset += count;
      this.declarationLists.set(symbol, declarations);
    }
  }
}
