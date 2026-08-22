const base = {
  overwritten: {
    stale: 'Stale'
  }
};

export const dictionary = {
  ...base,
  overwritten: {
    live: 'Live'
  },
  direct: 'Direct',
  conditional: {
    one: 'One',
    many: 'Many'
  },
  asserted: 'Asserted',
  temperature: {
    cold: 'Cold',
    hot: 'Hot'
  },
  prefixed: {
    label: 'Label',
    options: {
      first: 'First',
      second: 'Second'
    }
  },
  trans: 'Trans',
  transPrefixed: {
    body: 'Body'
  },
  transDynamic: {
    one: 'One',
    two: 'Two'
  },
  objects: {
    used: 'Used',
    unused: 'Unused',
    dynamicA: 'Dynamic A',
    dynamicB: 'Dynamic B'
  },
  keyofObject: {
    first: 'First',
    second: 'Second'
  },
  prefixFirst: 'Prefix first',
  prefixSecond: 'Prefix second',
  configuredObject: {
    used: 'Used',
    stale: 'Stale'
  },
  destructured: {
    used: 'Used',
    stale: 'Stale'
  },
  aliases: {
    hook: 'Hook',
    trans: 'Trans'
  },
  customHook: {
    label: 'Custom hook label',
    stale: 'Custom hook stale'
  },
  customDynamicHook: {
    first: 'Custom dynamic hook first',
    second: 'Custom dynamic hook second'
  },
  customAssertedDynamicHook: {
    first: 'Custom asserted dynamic hook first',
    second: 'Custom asserted dynamic hook second'
  },
  customBound: 'Custom bound hook',
  customExposedHook: {
    label: 'Custom exposed hook label',
    stale: 'Custom exposed hook stale'
  },
  wrapped: {
    title: 'Wrapped title',
    stale: 'Wrapped stale'
  },
  helper: {
    alpha: 'Alpha',
    beta: 'Beta'
  },
  runtime: {
    first: 'Runtime first',
    second: 'Runtime second'
  },
  errorCodes: {
    fallback: 'Fallback',
    first: 'First error',
    second: 'Second error'
  },
  forwarded: {
    one: 'Forwarded one',
    two: 'Forwarded two'
  },
  catalog: {
    first: 'Catalog first',
    second: 'Catalog second'
  },
  booleanOverride: 'Boolean override',
  reassigned: {
    initial: 'Initial',
    active: 'Active'
  },
  trulyUnused: 'Unused'
};
