export default {
  jsxFlow: { used: 'Used through JSX props', unused: 'Unused through JSX props' },
  parameterFlow: { used: 'Used through a parameter', unused: 'Unused through a parameter' },
  returnedFlow: {
    used: 'Used through a returned object',
    unused: 'Unused through a returned object'
  },
  destructuredFlow: {
    used: 'Used through a destructured return',
    unused: 'Unused through a destructured return'
  },
  jsxReturnedFlow: { used: 'Used through a returned JSX prop', unused: 'Unused returned JSX prop' },
  jsxSpreadFlow: { used: 'Used through a JSX spread', unused: 'Unused through a JSX spread' },
  memoFlow: { used: 'Used through React useMemo', unused: 'Unused through React useMemo' },
  memoBagFlow: {
    productList: {
      used: 'Used product label',
      unused: 'Unused product label',
      nested: { used: 'Used nested product label', unused: 'Unused nested product label' }
    },
    funnelActions: { used: 'Used funnel action', unused: 'Unused funnel action' }
  },
  arrayFlow: ['First array value', 'Second array value'],
  castFlow: { used: 'Used despite an invalid cast' },
  constOptionsFlow: { used: 'Used with narrowed options' },
  billingHistory: { page_templates: 'Page templates', stale: 'Stale billing label' },
  scalarFlow: { tooltip: 'Tooltip for {{name}}' },
  contaminatedFlow: { unused: 'Must remain unused' },
  indexedFlow: { first: 'First dynamic label', second: 'Second dynamic label' },
  typeAssertionCastFlow: { used: 'Used despite an invalid type assertion' },
  defaultFlow: { used: 'Used through a default parameter', unused: 'Unused default sibling' },
  externalFlow: { used: 'Passed to declaration-only external code' },
  forwardRefFlow: { used: 'Used through an imported forwardRef component', unused: 'Unused' },
  hiddenJsxFlow: { used: 'Overwritten JSX value' },
  visibleJsxFlow: { used: 'Winning JSX value' },
  hiddenReturnFlow: { used: 'Overwritten return value' },
  visibleReturnFlow: { used: 'Winning return value' }
};
