import ts from '@typescript/typescript6';

export interface AssignmentEntry {
  node: ts.BinaryExpression;
  owner: ts.FunctionLikeDeclaration | undefined;
  left: ts.Expression;
  right: ts.Expression;
}

export interface CallEdge {
  call: ts.CallExpression;
  owner: ts.FunctionLikeDeclaration | undefined;
}

export type SourceUsageNode =
  | ts.CallExpression
  | ts.VariableDeclaration
  | ts.JsxOpeningElement
  | ts.JsxSelfClosingElement
  | ts.PropertyAccessExpression
  | ts.ElementAccessExpression
  | ts.SpreadAssignment
  | ts.SpreadElement
  | ts.JsxSpreadAttribute
  | ts.ForInStatement
  | ts.ForOfStatement;

export interface SourceInventory {
  sourceFile: ts.SourceFile;
  calls: ts.CallExpression[];
  callEdges: CallEdge[];
  functions: ts.FunctionLikeDeclaration[];
  returnsByFunction: ReadonlyMap<ts.FunctionLikeDeclaration, readonly ts.Expression[]>;
  assignments: AssignmentEntry[];
  translatorCandidates: ts.VariableDeclaration[];
  usageNodes: SourceUsageNode[];
}

/** Collects syntax-only facts in source order without invoking the type checker. */
export function inventorySource(sourceFile: ts.SourceFile): SourceInventory {
  const calls: ts.CallExpression[] = [];
  const callEdges: CallEdge[] = [];
  const functions: ts.FunctionLikeDeclaration[] = [];
  const returnsByFunction = new Map<ts.FunctionLikeDeclaration, ts.Expression[]>();
  const assignments: AssignmentEntry[] = [];
  const translatorCandidates: ts.VariableDeclaration[] = [];
  const usageNodes: SourceUsageNode[] = [];
  const functionStack: ts.FunctionLikeDeclaration[] = [];

  function visit(node: ts.Node): void {
    const owner = functionStack.at(-1);
    const isFunction = isConcreteFunctionLike(node);
    if (isFunction) {
      functions.push(node);
      functionStack.push(node);
      if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
        addReturn(node, node.body);
      }
    }

    if (ts.isCallExpression(node)) {
      calls.push(node);
      callEdges.push({ call: node, owner });
      usageNodes.push(node);
    } else if (ts.isVariableDeclaration(node)) {
      if (node.initializer && hasTranslatorCandidateShape(node)) translatorCandidates.push(node);
      if (ts.isObjectBindingPattern(node.name) && node.initializer) usageNodes.push(node);
    } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      usageNodes.push(node);
    } else if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node) ||
      ts.isSpreadAssignment(node) ||
      ts.isSpreadElement(node) ||
      ts.isJsxSpreadAttribute(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node)
    ) {
      usageNodes.push(node);
    }

    if (ts.isReturnStatement(node) && node.expression && owner) addReturn(owner, node.expression);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      assignments.push({ node, owner, left: node.left, right: node.right });
    }

    ts.forEachChild(node, visit);
    if (isFunction) functionStack.pop();
  }

  function addReturn(owner: ts.FunctionLikeDeclaration, expression: ts.Expression): void {
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
    usageNodes
  };
}

function hasTranslatorCandidateShape(node: ts.VariableDeclaration): boolean {
  if (!node.initializer) return false;
  const expression = unwrapSyntax(node.initializer);
  if (ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name)) {
    return ts.isCallExpression(expression) || ts.isIdentifier(expression);
  }
  return (
    ts.isIdentifier(node.name) &&
    (ts.isIdentifier(expression) ||
      ts.isCallExpression(expression) ||
      ts.isPropertyAccessExpression(expression) ||
      ts.isElementAccessExpression(expression))
  );
}

function unwrapSyntax(input: ts.Expression): ts.Expression {
  let expression = input;
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
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
