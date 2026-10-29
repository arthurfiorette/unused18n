import {
  type Declaration,
  type Expression,
  type FunctionLikeDeclaration,
  isArrowFunction,
  isBinaryExpression,
  isCallExpression,
  isConditionalExpression,
  isConditionalTypeNode,
  isConstructorDeclaration,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isIndexedAccessTypeNode,
  isLiteralTypeNode,
  isMappedTypeNode,
  isMethodDeclaration,
  isNumericLiteral,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isPropertySignatureDeclaration,
  isReturnStatement,
  isSetAccessorDeclaration,
  isSignatureDeclaration,
  isStringLiteral,
  isStringLiteralLikeNode,
  isTemplateExpression,
  isTypeAliasDeclaration,
  isTypeOperatorNode,
  isTypeReferenceNode,
  isUnionTypeNode,
  isVariableDeclaration,
  type Node,
  SyntaxKind,
  type TemplateExpression,
  type TypeNode
} from 'typescript/ast';
import type { Symbol as TsSymbol, Type } from 'typescript/sync';
import { unwrapExpression } from './dictionary.js';
import type { Semantic } from './semantic.js';
import { isSourceAssertion, writtenType } from './syntax.js';

export interface StringResolution {
  values: Set<string>;
  patterns: Set<string>;
  complete: boolean;
}

export interface StringResolver {
  resolve(expression: Expression): StringResolution;
}

export interface StringResolverIndexes {
  assignments?: ReadonlyMap<
    TsSymbol,
    readonly { owner: FunctionLikeDeclaration | undefined; right: Expression }[]
  >;
  returns?: ReadonlyMap<FunctionLikeDeclaration, readonly Expression[]>;
}

/**
 * Creates a resolver that computes the static string values an expression can produce.
 *
 * @param semantic Checker facade; every symbol, type and signature lookup goes through its caches.
 * @param maxExpansions Upper bound on union members and concatenation products before giving up
 *   on exact values.
 * @param indexes Precomputed assignment and return sites; without them the resolver walks the
 *   enclosing function or source file on each lookup.
 */
export function createStringResolver(
  semantic: Semantic,
  maxExpansions: number,
  indexes: StringResolverIndexes = {}
): StringResolver {
  const cache = new WeakMap<Expression, StringResolution>();

  /**
   * Entry point for every key, prefix and option expression the analyzer resolves. Only
   * top-level calls are cached: a nested result depends on `seen`, which cuts recursion through
   * mutually referencing declarations.
   */
  function resolve(input: Expression, seen = new Set<Node>()): StringResolution {
    if (seen.size === 0) {
      const cached = cache.get(input);
      if (cached) return cached;
      const result = resolveUncached(input, seen);
      cache.set(input, result);
      return result;
    }
    return resolveUncached(input, seen);
  }

  /**
   * Tries the cheapest source of values first: literal syntax, templates, conditionals and `+`
   * need no checker. Next comes the checker type, skipped for values declared with expensive
   * i18next types. When the type yields no complete value set, it follows declarations,
   * assignments, element accesses and call returns. Asserted types merge into every branch.
   */
  function resolveUncached(input: Expression, seen: Set<Node>): StringResolution {
    const expression = unwrapExpression(input);
    if (seen.has(expression)) return unresolved();
    const nextSeen = new Set(seen).add(expression);
    const assertedType = expression !== input ? resolveAssertedType(input) : empty();
    const asserted =
      assertedType.values.size > 0 || assertedType.patterns.size > 0 ? assertedType : empty();

    if (isStringLiteralLikeNode(expression) || isNumericLiteral(expression)) {
      return merge(asserted, exact(String(expression.text)));
    }

    if (isTemplateExpression(expression)) {
      return merge(asserted, resolveTemplate(expression, nextSeen));
    }

    if (isConditionalExpression(expression)) {
      return merge(
        asserted,
        merge(resolve(expression.whenTrue, nextSeen), resolve(expression.whenFalse, nextSeen))
      );
    }

    if (isBinaryExpression(expression) && expression.operatorToken.kind === SyntaxKind.PlusToken) {
      return merge(
        asserted,
        concatenate(resolve(expression.left, nextSeen), resolve(expression.right, nextSeen))
      );
    }

    const semanticType = shouldAvoidSemanticType(expression)
      ? unresolved()
      : resolveType(semantic.typeAt(expression));
    const typeResolution = merge(asserted, semanticType);
    if (typeResolution.values.size > 0 && typeResolution.complete) return typeResolution;

    if (isIdentifier(expression) || isPropertyAccessExpression(expression)) {
      const symbol = semantic.symbol(expression);
      let declared = empty();
      for (const declaration of semantic.declarations(symbol)) {
        if (isVariableDeclaration(declaration) && declaration.initializer) {
          declared = merge(declared, resolve(declaration.initializer, nextSeen));
          continue;
        }
        if (isPropertyAssignment(declaration)) {
          return merge(typeResolution, resolve(declaration.initializer, nextSeen));
        }
        if (isParameterDeclaration(declaration) && declaration.initializer) {
          return merge(typeResolution, resolve(declaration.initializer, nextSeen));
        }
      }

      if (isIdentifier(expression) && symbol) {
        let assigned = empty();
        if (indexes.assignments) {
          for (const assignment of indexes.assignments.get(symbol) ?? []) {
            assigned = merge(assigned, resolve(assignment.right, nextSeen));
          }
        } else {
          // Resolved only on this branch because the indexed path never needs the owner.
          const declaration = semantic.valueDeclaration(symbol) ?? semantic.declarations(symbol)[0];
          const owner = declaration ? enclosingFunction(declaration) : undefined;
          const body = owner?.body ?? expression.getSourceFile();
          /** Collects `symbol = value` assignments; used only when no assignment index exists. */
          function visitAssignment(node: Node): void {
            if (
              isBinaryExpression(node) &&
              node.operatorToken.kind === SyntaxKind.EqualsToken &&
              isIdentifier(unwrapExpression(node.left)) &&
              semantic.aliased(semantic.rawSymbol(unwrapExpression(node.left))) === symbol
            ) {
              assigned = merge(assigned, resolve(node.right, nextSeen));
              return;
            }
            node.forEachChild(visitAssignment);
          }
          visitAssignment(body);
        }
        if (assigned.values.size > 0 || assigned.patterns.size > 0 || !assigned.complete) {
          return merge(declared, assigned);
        }
      }
      if (declared.values.size > 0 || declared.patterns.size > 0) return declared;
    }

    if (isElementAccessExpression(expression)) {
      return typeResolution.values.size > 0 ? typeResolution : unresolved();
    }

    if (isCallExpression(expression)) {
      // A failed overload resolution maps to `undefined` and falls through to the declaration
      // walk, the same as a resolved signature whose return type yields no string.
      const signature = semantic.resolvedSignature(expression);
      const returnType = signature ? semantic.returnType(signature) : undefined;
      const returnResolution = returnType ? resolveType(returnType) : unresolved();
      if (returnResolution.values.size > 0) return returnResolution;

      const functionLike = resolveFunctionLike(expression.expression, semantic);
      if (functionLike?.body) {
        let result = unresolved();
        if (indexes.returns) {
          for (const returned of indexes.returns.get(functionLike) ?? []) {
            result = merge(result, resolve(returned, nextSeen));
          }
        } else {
          /** Collects return values outside nested functions when no return index exists. */
          function visit(node: Node): void {
            if (isReturnStatement(node) && node.expression) {
              result = merge(result, resolve(node.expression, nextSeen));
              return;
            }
            if (node !== functionLike && isSignatureDeclaration(node)) return;
            node.forEachChild(visit);
          }
          visit(functionLike.body);
        }
        return result;
      }
    }

    return typeResolution.values.size > 0 ? typeResolution : unresolved();
  }

  /**
   * Reads the values of a source cast such as `key as 'a' | 'b'` from its written type, so a
   * cast key resolves even when the expression's own type is wider.
   */
  function resolveAssertedType(input: Expression): StringResolution {
    if (!isSourceAssertion(input)) return empty();
    return resolveTypeNode(input.type, new Set());
  }

  /**
   * Reads literal unions from type syntax, following type aliases through their declarations.
   * Asserted types are read this way so a cast never asks the checker to compute a type;
   * `seen` stops recursive aliases.
   */
  function resolveTypeNode(node: TypeNode, seen: Set<Node>): StringResolution {
    if (seen.has(node)) return unresolved();
    seen.add(node);
    if (isLiteralTypeNode(node)) {
      const literal = node.literal;
      if (isStringLiteral(literal) || isNumericLiteral(literal)) return exact(literal.text);
      return unresolved();
    }
    if (isUnionTypeNode(node)) {
      if (node.types.length > maxExpansions) return unresolved();
      let result = empty();
      for (const member of node.types) result = merge(result, resolveTypeNode(member, seen));
      return result;
    }
    if (isTypeReferenceNode(node)) {
      const symbol = semantic.aliased(semantic.rawSymbol(node.typeName));
      const alias = semantic.declarations(symbol).find(isTypeAliasDeclaration);
      if (alias) return resolveTypeNode(alias.type, seen);
    }
    return unresolved();
  }

  /**
   * Reports a value declared with i18next's conditional or mapped key types. Typing such a
   * value makes the checker expand those types over the whole dictionary, so resolveUncached
   * skips the type and follows declarations instead. Only identifiers and property accesses
   * reach a declaration here; other expressions have no symbol, so they return early without a
   * lookup.
   */
  function shouldAvoidSemanticType(expression: Expression): boolean {
    if (!isIdentifier(expression) && !isPropertyAccessExpression(expression)) return false;
    return semantic.declarations(semantic.symbol(expression)).some((declaration) => {
      const type = declaredTypeNode(declaration);
      return type ? isExpensiveTypeNode(type, new Set()) : false;
    });
  }

  /**
   * Reports conditional, mapped, indexed access or `keyof` type syntax declared in i18next's own
   * files, reached directly or through type aliases. The same syntax in application code is
   * typed normally. `seen` stops recursive aliases.
   */
  function isExpensiveTypeNode(node: TypeNode, seen: Set<Node>): boolean {
    if (seen.has(node)) return false;
    seen.add(node);
    if (
      isConditionalTypeNode(node) ||
      isMappedTypeNode(node) ||
      isIndexedAccessTypeNode(node) ||
      (isTypeOperatorNode(node) && node.operator === SyntaxKind.KeyOfKeyword)
    ) {
      return node.getSourceFile().fileName.includes('i18next');
    }
    if (isTypeReferenceNode(node)) {
      const symbol = semantic.aliased(semantic.rawSymbol(node.typeName));
      const alias = semantic.declarations(symbol).find(isTypeAliasDeclaration);
      return alias ? isExpensiveTypeNode(alias.type, seen) : false;
    }
    return false;
  }

  /** Unresolved spans become `*` wildcards, so a template still yields a matchable pattern. */
  function resolveTemplate(expression: TemplateExpression, seen: Set<Node>): StringResolution {
    let result = exact(expression.head.text);
    for (const span of expression.templateSpans) {
      const value = resolve(span.expression, seen);
      const segment = value.values.size > 0 ? value : wildcard();
      result = concatenate(result, segment);
      result = concatenate(result, exact(span.literal.text));
    }
    return result;
  }

  /** Reads literal values out of a type; the `seen` guard relies on types being interned. */
  function resolveType(type: Type, seen = new Set<Type>()): StringResolution {
    if (seen.has(type)) return unresolved();
    seen.add(type);

    if (type.isStringLiteralType() || type.isNumberLiteralType()) return exact(String(type.value));
    if (type.isUnionType()) {
      const members = type.getTypes();
      if (members.length > maxExpansions) return unresolved();
      let result = empty();
      for (const member of members) result = merge(result, resolveType(member, seen));
      return result;
    }
    return unresolved();
  }

  function concatenate(left: StringResolution, right: StringResolution): StringResolution {
    const leftParts = [...left.values, ...left.patterns];
    const rightParts = [...right.values, ...right.patterns];
    if (leftParts.length === 0 || rightParts.length === 0) return unresolved();
    if (leftParts.length * rightParts.length > maxExpansions) {
      return {
        values: new Set(),
        patterns: new Set([`${commonPrefix(leftParts)}*${commonSuffix(rightParts)}`]),
        complete: false
      };
    }

    const values = new Set<string>();
    const patterns = new Set<string>();
    for (const a of leftParts) {
      for (const b of rightParts) {
        const combined = `${a}${b}`;
        if (a.includes('*') || b.includes('*')) patterns.add(combined);
        else values.add(combined);
      }
    }
    return { values, patterns, complete: left.complete && right.complete && patterns.size === 0 };
  }

  return { resolve };
}

/** Returns the written annotation of the declaration kinds that can carry one, if present. */
function declaredTypeNode(declaration: Declaration): TypeNode | undefined {
  if (
    isVariableDeclaration(declaration) ||
    isParameterDeclaration(declaration) ||
    isPropertyDeclaration(declaration) ||
    isPropertySignatureDeclaration(declaration)
  ) {
    return writtenType(declaration.type);
  }
  return undefined;
}

/** Returns the function whose body scopes the assignment scan for an unindexed variable. */
function enclosingFunction(node: Node): FunctionLikeDeclaration | undefined {
  let current: Node | undefined = node.parent;
  while (current) {
    if (isConcreteFunctionLike(current)) return current;
    current = current.parent;
  }
  return undefined;
}

/** Returns the function body a callee expression refers to, including `const f = () => ...`. */
function resolveFunctionLike(
  expression: Expression,
  semantic: Semantic
): FunctionLikeDeclaration | undefined {
  for (const declaration of semantic.declarations(semantic.symbol(expression))) {
    if (isConcreteFunctionLike(declaration)) return declaration;
    if (
      isVariableDeclaration(declaration) &&
      declaration.initializer &&
      (isArrowFunction(declaration.initializer) || isFunctionExpression(declaration.initializer))
    ) {
      return declaration.initializer;
    }
  }
  return undefined;
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

export function exact(value: string): StringResolution {
  return { values: new Set([value]), patterns: new Set(), complete: true };
}

export function empty(): StringResolution {
  return { values: new Set(), patterns: new Set(), complete: true };
}

export function unresolved(): StringResolution {
  return { values: new Set(), patterns: new Set(), complete: false };
}

function wildcard(): StringResolution {
  return { values: new Set(), patterns: new Set(['*']), complete: false };
}

export function merge(a: StringResolution, b: StringResolution): StringResolution {
  return {
    values: new Set([...a.values, ...b.values]),
    patterns: new Set([...a.patterns, ...b.patterns]),
    complete: a.complete && b.complete
  };
}

export function prepend(prefix: StringResolution, key: StringResolution): StringResolution {
  const values = new Set<string>();
  const patterns = new Set<string>();
  // Only a proven empty prefix may preserve an exact unprefixed key; unknown prefixes stay unknown.
  const prefixes =
    prefix.values.size > 0
      ? prefix.values
      : prefix.complete && prefix.patterns.size === 0
        ? new Set([''])
        : new Set<string>();
  for (const left of prefixes) {
    for (const right of key.values) values.add(joinKey(left, right));
    for (const right of key.patterns) patterns.add(joinKey(left, right));
    if (!key.complete && key.patterns.size === 0 && left) {
      patterns.add(joinKey(left, '*'));
    }
  }
  for (const left of prefix.patterns) {
    for (const right of key.values) patterns.add(joinKey(left, right));
    for (const right of key.patterns) patterns.add(joinKey(left, right));
    if (!key.complete && key.patterns.size === 0) {
      patterns.add(joinKey(left, '*'));
    }
  }
  return { values, patterns, complete: prefix.complete && key.complete };
}

export function joinKey(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  return `${left}.${right}`;
}

function commonPrefix(values: string[]): string {
  if (values.length === 0) return '';
  let prefix = values[0] ?? '';
  for (const value of values.slice(1)) {
    while (!value.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

function commonSuffix(values: string[]): string {
  if (values.length === 0) return '';
  let suffix = values[0] ?? '';
  for (const value of values.slice(1)) {
    while (!value.endsWith(suffix)) suffix = suffix.slice(1);
  }
  return suffix;
}
