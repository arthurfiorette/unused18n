declare const runtime: Record<string, string>;

export default {
  complete: {
    first: 'First',
    nested: {
      second: 'Second'
    }
  },
  mixed: {
    used: 'Used',
    unused: 'Unused'
  },
  list: ['First', 'Second'],
  single: {
    only: 'Only'
  },
  spreadComplete: {
    first: 'First',
    second: 'Second',
    ...runtime
  },
  spreadMixed: {
    used: 'Used',
    unused: 'Unused',
    ...runtime
  }
};
