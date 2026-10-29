import {
  type AsExpression,
  isAsExpression,
  isTypeAssertion,
  type Node,
  NodeFlags,
  type TypeAssertion,
  type TypeNode
} from 'typescript/ast';

/**
 * Returns whether `node` is an `as` or angle-bracket assertion written in TypeScript syntax.
 *
 * In JavaScript files the parser turns `/** @type {T} *\/ (value)` comments into assertion
 * nodes whose type carries `NodeFlags.JSDoc`. Those are comments: they hide no dictionary
 * shape from the type checker and have no source range a fix could delete, so callers treat
 * them as transparent wrappers like parentheses.
 */
export function isSourceAssertion(node: Node): node is AsExpression | TypeAssertion {
  return (isAsExpression(node) || isTypeAssertion(node)) && !isJSDocType(node.type);
}

/**
 * Returns a declaration's type annotation when it is written in TypeScript syntax.
 *
 * JavaScript declarations get `type` filled from JSDoc `@type` and `@param` tags. Analysis that
 * distinguishes annotated from contextually typed declarations reads only written annotations.
 */
export function writtenType<T extends TypeNode>(type: T | undefined): T | undefined {
  return type && !isJSDocType(type) ? type : undefined;
}

/** Returns whether a type node was reparsed from a JSDoc comment. */
function isJSDocType(type: TypeNode): boolean {
  return (type.flags & NodeFlags.JSDoc) !== 0;
}
