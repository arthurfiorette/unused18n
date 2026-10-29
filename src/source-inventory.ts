import {
  type BinaryExpression,
  type CallExpression,
  type ElementAccessExpression,
  type Expression,
  type ForInStatement,
  type ForOfStatement,
  type FunctionLikeDeclaration,
  isArrayBindingPattern,
  isArrowFunction,
  isAsExpression,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isConstructorDeclaration,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isJsxOpeningElement,
  isJsxSelfClosingElement,
  isJsxSpreadAttribute,
  isMethodDeclaration,
  isNonNullExpression,
  isObjectBindingPattern,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isReturnStatement,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isSpreadAssignment,
  isSpreadElement,
  isTypeAssertion,
  isVariableDeclaration,
  type JsxOpeningElement,
  type JsxSelfClosingElement,
  type JsxSpreadAttribute,
  type Node,
  type PropertyAccessExpression,
  type SourceFile,
  type SpreadAssignment,
  type SpreadElement,
  SyntaxKind,
  type VariableDeclaration
} from 'typescript/ast';

export interface AssignmentEntry {
  node: BinaryExpression;
  owner: FunctionLikeDeclaration | undefined;
  left: Expression;
  right: Expression;
}

export interface CallEdge {
  call: CallExpression;
  owner: FunctionLikeDeclaration | undefined;
}

export type SourceUsageNode =
  | CallExpression
  | VariableDeclaration
  | JsxOpeningElement
  | JsxSelfClosingElement
  | PropertyAccessExpression
  | ElementAccessExpression
  | SpreadAssignment
  | SpreadElement
  | JsxSpreadAttribute
  | ForInStatement
  | ForOfStatement;

export interface SourceInventory {
  sourceFile: SourceFile;
  calls: CallExpression[];
  callEdges: CallEdge[];
  functions: FunctionLikeDeclaration[];
  returnsByFunction: ReadonlyMap<FunctionLikeDeclaration, readonly Expression[]>;
  assignments: AssignmentEntry[];
  translatorCandidates: VariableDeclaration[];
  usageNodes: SourceUsageNode[];
  /** Initializers of every variable declaration, as written, for symbol prefetching. */
  variableInitializers: Expression[];
}

/** Collects syntax-only facts in source order without invoking the type checker. */
export function inventorySource(sourceFile: SourceFile): SourceInventory {
  const calls: CallExpression[] = [];
  const callEdges: CallEdge[] = [];
  const functions: FunctionLikeDeclaration[] = [];
  const returnsByFunction = new Map<FunctionLikeDeclaration, Expression[]>();
  const assignments: AssignmentEntry[] = [];
  const translatorCandidates: VariableDeclaration[] = [];
  const usageNodes: SourceUsageNode[] = [];
  const variableInitializers: Expression[] = [];
  const functionStack: FunctionLikeDeclaration[] = [];

  /** Walks in source order; the function stack attributes each fact to its innermost function. */
  function visit(node: Node): void {
    const owner = functionStack.at(-1);
    const isFunction = isConcreteFunctionLike(node);
    if (isFunction) {
      functions.push(node);
      functionStack.push(node);
      if (isArrowFunction(node) && !isBlock(node.body)) {
        addReturn(node, node.body);
      }
    }

    if (isCallExpression(node)) {
      calls.push(node);
      callEdges.push({ call: node, owner });
      usageNodes.push(node);
    } else if (isVariableDeclaration(node)) {
      if (node.initializer) variableInitializers.push(node.initializer);
      if (node.initializer && hasTranslatorCandidateShape(node)) translatorCandidates.push(node);
      if (isObjectBindingPattern(node.name) && node.initializer) usageNodes.push(node);
    } else if (isJsxOpeningElement(node) || isJsxSelfClosingElement(node)) {
      usageNodes.push(node);
    } else if (
      isPropertyAccessExpression(node) ||
      isElementAccessExpression(node) ||
      isSpreadAssignment(node) ||
      isSpreadElement(node) ||
      isJsxSpreadAttribute(node) ||
      isForInStatement(node) ||
      isForOfStatement(node)
    ) {
      usageNodes.push(node);
    }

    if (isReturnStatement(node) && node.expression && owner) addReturn(owner, node.expression);
    if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken) {
      assignments.push({ node, owner, left: node.left, right: node.right });
    }

    node.forEachChild(visit);
    if (isFunction) functionStack.pop();
  }

  /**
   * Indexes a returned value under its innermost function. An arrow's expression body counts as
   * its return, so the analyzer never walks the body of an inventoried function to find returns.
   */
  function addReturn(owner: FunctionLikeDeclaration, expression: Expression): void {
    const expressions = returnsByFunction.get(owner) ?? [];
    expressions.push(expression);
    returnsByFunction.set(owner, expressions);
  }

  visit(sourceFile);
  return {
    sourceFile,
    calls,
    callEdges,
    functions,
    returnsByFunction,
    assignments,
    translatorCandidates,
    usageNodes,
    variableInitializers
  };
}

/**
 * Keeps only the variable shapes hook translator discovery can bind from, so it skips the rest
 * without a symbol lookup.
 */
function hasTranslatorCandidateShape(node: VariableDeclaration): boolean {
  if (!node.initializer) return false;
  const expression = unwrapSyntax(node.initializer);
  if (isObjectBindingPattern(node.name) || isArrayBindingPattern(node.name)) {
    return isCallExpression(expression) || isIdentifier(expression);
  }
  return (
    isIdentifier(node.name) &&
    (isIdentifier(expression) ||
      isCallExpression(expression) ||
      isPropertyAccessExpression(expression) ||
      isElementAccessExpression(expression))
  );
}

/**
 * Strips the same wrappers as `unwrapExpression` in dictionary.ts, so candidate shapes agree
 * with what discovery later sees. A local copy keeps this module free of imports beyond the
 * AST.
 */
function unwrapSyntax(input: Expression): Expression {
  let expression = input;
  while (
    isParenthesizedExpression(expression) ||
    isAsExpression(expression) ||
    isTypeAssertion(expression) ||
    isNonNullExpression(expression) ||
    isSatisfiesExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

/** Matches the analyzer's predicate, so inventoried functions are the ones it resolves. */
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
