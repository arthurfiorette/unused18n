export default {
  named: 'Named',
  aliased: 'Aliased',
  fixed: {
    named: 'Named',
    aliased: 'Aliased',
    property: 'Property',
    immediate: 'Immediate',
    optional: 'Optional override'
  },
  override: 'Override',
  object: { value: 'Value', later: 'Later' },
  tuple: { value: 'Value', indexed: 'Indexed' },
  direct: { value: 'Value' },
  namespaceImport: { value: 'Value' },
  computed: { value: 'Value' },
  declared: 'Declared',
  declaredAlias: 'Declared alias',
  factory: 'Factory',
  returnedFactory: 'Returned factory',
  contextual: 'Contextual translator',
  callbackInstruction: 'Adjacent callback instruction',
  callbackLiteral: 'Translator closed over by an object callback',
  typedHelper: 'Translator passed to a typed helper',
  transLiteral: 'Literal Trans key',
  Project: {
    Card: {
      Page: { removeTooltip: 'Remove page' },
      Message: { removeTooltip: 'Remove message' },
      Offer: { removeTooltip: 'Remove offer' }
    }
  },
  spreadReturn: { child: 'Runtime spread may enable object return' },
  knownSpread: { child: 'Known trailing false disables object return' },
  inherited: 'Inherited declaration',
  dynamic: 'Dynamic',
  unknownOptions: 'Unknown options',
  known: { spread: 'Unknown trailing spread' },
  unrelatedHook: 'Unrelated hook',
  unrelatedNamed: 'Unrelated named function',
  unrelatedHookMethod: 'Unrelated hook method',
  unrelatedFixed: 'Unrelated fixed translator',
  unrelatedMethod: 'Unrelated method',
  stale: 'Stale'
};
