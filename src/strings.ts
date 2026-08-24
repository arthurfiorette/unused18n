import ts from '@typescript/typescript6';
import { unwrapAlias, unwrapExpression } from './dictionary.js';

export interface StringResolution {
  values: Set<string>;
  patterns: Set<string>;
  complete: boolean;
}

export interface StringResolver {
  resolve(expression: ts.Expression): StringResolution;
}

export interface StringResolverIndexes {
  assignments?: ReadonlyMap<
    ts.Symbol,
    readonly { owner: ts.FunctionLikeDeclaration | undefined; right: ts.Expression }[]
  >;
  returns?: ReadonlyMap<ts.FunctionLikeDeclaration, readonly ts.Expression[]>;
  typeAtLocation?: (node: ts.Node) => ts.Type;
}

export function createStringResolver(
  checker: ts.TypeChecker,
  maxExpansions: number,
  indexes: StringResolverIndexes = {}
): StringResolver {
  const cache = new WeakMap<ts.Expression, StringResolution>();

  function resolve(input: ts.Expression, seen = new Set<ts.Node>()): StringResolution {
    if (seen.size === 0) {
      const cached = cache.get(input);
      if (cached) return cached;
      const result = resolveUncached(input, seen);
      cache.set(input, result);
      return result;
    }
    return resolveUncached(input, seen);
  }

  function resolveUncached(input: ts.Expression, seen: Set<ts.Node>): StringResolution {
    const expression = unwrapExpression(input);
    if (seen.has(expression)) return unresolved();
    const nextSeen = new Set(seen).add(expression);
    const assertedType = expression !== input ? resolveAssertedType(input) : empty();
    const asserted =
      assertedType.values.size > 0 || assertedType.patterns.size > 0 ? assertedType : empty();

    if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) {
      return merge(asserted, exact(String(expression.text)));
    }

    if (ts.isTemplateExpression(expression)) {
      return merge(asserted, resolveTemplate(expression, nextSeen));
    }

    if (ts.isConditionalExpression(expression)) {
      return merge(
        asserted,
        merge(resolve(expression.whenTrue, nextSeen), resolve(expression.whenFalse, nextSeen))
      );
    }

    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      return merge(
        asserted,
        concatenate(resolve(expression.left, nextSeen), resolve(expression.right, nextSeen))
      );
    }

    const semanticType = shouldAvoidSemanticType(expression)
      ? unresolved()
      : resolveType(
          (indexes.typeAtLocation ?? checker.getTypeAtLocation.bind(checker))(expression)
        );
    const typeResolution = merge(asserted, semanticType);
    if (typeResolution.values.size > 0 && typeResolution.complete) return typeResolution;

    if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
      const symbolNode = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
      const symbol = unwrapAlias(checker, checker.getSymbolAtLocation(symbolNode));
      let declared = empty();
      for (const declaration of symbol?.declarations ?? []) {
        if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
          declared = merge(declared, resolve(declaration.initializer, nextSeen));
          continue;
        }
        if (ts.isPropertyAssignment(declaration)) {
          return merge(typeResolution, resolve(declaration.initializer, nextSeen));
        }
        if (ts.isParameter(declaration) && declaration.initializer) {
          return merge(typeResolution, resolve(declaration.initializer, nextSeen));
        }
      }

      if (ts.isIdentifier(expression) && symbol) {
        let assigned = empty();
        const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
        const owner = declaration ? enclosingFunction(declaration) : undefined;
        if (indexes.assignments) {
          for (const assignment of indexes.assignments.get(symbol) ?? []) {
            assigned = merge(assigned, resolve(assignment.right, nextSeen));
          }
        } else {
          const body = owner?.body ?? expression.getSourceFile();
          function visitAssignment(node: ts.Node): void {
            if (
              ts.isBinaryExpression(node) &&
              node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
              ts.isIdentifier(unwrapExpression(node.left)) &&
              unwrapAlias(checker, checker.getSymbolAtLocation(unwrapExpression(node.left))) ===
                symbol
            ) {
              assigned = merge(assigned, resolve(node.right, nextSeen));
              return;
            }
            ts.forEachChild(node, visitAssignment);
          }
          visitAssignment(body);
        }
        if (assigned.values.size > 0 || assigned.patterns.size > 0 || !assigned.complete) {
          return merge(declared, assigned);
        }
      }
      if (declared.values.size > 0 || declared.patterns.size > 0) return declared;
    }

    if (ts.isElementAccessExpression(expression)) {
      return typeResolution.values.size > 0 ? typeResolution : unresolved();
    }

    if (ts.isCallExpression(expression)) {
      const signature = checker.getResolvedSignature(expression);
      const returnType = signature ? checker.getReturnTypeOfSignature(signature) : undefined;
      const returnResolution = returnType ? resolveType(returnType) : unresolved();
      if (returnResolution.values.size > 0) return returnResolution;

      const functionLike = resolveFunctionLike(expression.expression, checker);
      if (functionLike?.body) {
        let result = unresolved();
        if (indexes.returns) {
          for (const returned of indexes.returns.get(functionLike) ?? []) {
            result = merge(result, resolve(returned, nextSeen));
          }
        } else {
          function visit(node: ts.Node): void {
            if (ts.isReturnStatement(node) && node.expression) {
              result = merge(result, resolve(node.expression, nextSeen));
              return;
            }
            if (node !== functionLike && ts.isFunctionLike(node)) return;
            ts.forEachChild(node, visit);
          }
          visit(functionLike.body);
        }
        return result;
      }
    }

    return typeResolution.values.size > 0 ? typeResolution : unresolved();
  }

  function resolveAssertedType(input: ts.Expression): StringResolution {
    if (!ts.isAsExpression(input) && !ts.isTypeAssertionExpression(input)) return empty();
    return resolveTypeNode(input.type, new Set());
  }

  function resolveTypeNode(node: ts.TypeNode, seen: Set<ts.Node>): StringResolution {
    if (seen.has(node)) return unresolved();
    seen.add(node);
    if (ts.isLiteralTypeNode(node)) {
      const literal = node.literal;
      if (ts.isStringLiteral(literal) || ts.isNumericLiteral(literal)) return exact(literal.text);
      return unresolved();
    }
    if (ts.isUnionTypeNode(node)) {
      if (node.types.length > maxExpansions) return unresolved();
      let result = empty();
      for (const member of node.types) result = merge(result, resolveTypeNode(member, seen));
      return result;
    }
    if (ts.isTypeReferenceNode(node)) {
      const symbol = unwrapAlias(checker, checker.getSymbolAtLocation(node.typeName));
      const alias = symbol?.declarations?.find(ts.isTypeAliasDeclaration);
      if (alias) return resolveTypeNode(alias.type, seen);
    }
    return unresolved();
  }

  function shouldAvoidSemanticType(expression: ts.Expression): boolean {
    const target = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
    const symbol = unwrapAlias(checker, checker.getSymbolAtLocation(target));
    return Boolean(
      symbol?.declarations?.some((declaration) => {
        const type = declaredTypeNode(declaration);
        return type ? isExpensiveTypeNode(type, new Set()) : false;
      })
    );
  }

  function isExpensiveTypeNode(node: ts.TypeNode, seen: Set<ts.Node>): boolean {
    if (seen.has(node)) return false;
    seen.add(node);
    if (
      ts.isConditionalTypeNode(node) ||
      ts.isMappedTypeNode(node) ||
      ts.isIndexedAccessTypeNode(node) ||
      (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.KeyOfKeyword)
    ) {
      return node.getSourceFile().fileName.includes('i18next');
    }
    if (ts.isTypeReferenceNode(node)) {
      const symbol = unwrapAlias(checker, checker.getSymbolAtLocation(node.typeName));
      const alias = symbol?.declarations?.find(ts.isTypeAliasDeclaration);
      return alias ? isExpensiveTypeNode(alias.type, seen) : false;
    }
    return false;
  }

  function resolveTemplate(
    expression: ts.TemplateExpression,
    seen: Set<ts.Node>
  ): StringResolution {
    let result = exact(expression.head.text);
    for (const span of expression.templateSpans) {
      const value = resolve(span.expression, seen);
      const segment = value.values.size > 0 ? value : wildcard();
      result = concatenate(result, segment);
      result = concatenate(result, exact(span.literal.text));
    }
    return result;
  }

  function resolveType(type: ts.Type, seen = new Set<ts.Type>()): StringResolution {
    if (seen.has(type)) return unresolved();
    seen.add(type);

    if (type.isStringLiteral() || type.isNumberLiteral()) return exact(String(type.value));
    if (type.isUnion()) {
      if (type.types.length > maxExpansions) return unresolved();
      let result = empty();
      for (const member of type.types) result = merge(result, resolveType(member, seen));
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

function declaredTypeNode(declaration: ts.Declaration): ts.TypeNode | undefined {
  if (
    ts.isVariableDeclaration(declaration) ||
    ts.isParameter(declaration) ||
    ts.isPropertyDeclaration(declaration) ||
    ts.isPropertySignature(declaration)
  ) {
    return declaration.type;
  }
  return undefined;
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (isConcreteFunctionLike(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function resolveFunctionLike(
  expression: ts.Expression,
  checker: ts.TypeChecker
): ts.FunctionLikeDeclaration | undefined {
  const target = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
  const symbol = unwrapAlias(checker, checker.getSymbolAtLocation(target));
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
