import i18n, { t as aliasedT, getFixedT as getFixedTranslator, type TFunction } from 'i18next';
import * as ReactI18next from 'react-i18next';
import { useTranslation as useI18n } from 'react-i18next';

aliasedT('aliased');
getFixedTranslator(null, null, 'fixed')('aliased');
i18n.getFixedT(null, null, 'fixed')('property');
const immediate = getFixedTranslator(null, null, 'fixed');
immediate('immediate');
immediate('override', { keyPrefix: '' });
declare const maybePrefix: string | undefined;
immediate('optional', { keyPrefix: maybePrefix });

const result = useI18n(undefined, { keyPrefix: 'object' });
result.t('value');
const { t: laterT } = result;
laterT('later');

const [tupleT] = useI18n(undefined, { keyPrefix: 'tuple' });
tupleT('value');
useI18n(undefined, { keyPrefix: 'tuple' })[0]('indexed');
useI18n(undefined, { keyPrefix: 'direct' }).t('value');
ReactI18next.useTranslation(undefined, { keyPrefix: 'namespaceImport' }).t('value');
const { t: computedT } = useI18n(undefined, { ['keyPrefix' as string]: 'computed' });
computedT('value');

declare const declaredT: TFunction;
declaredT('declared');

declare const runtimePrefix: string;
const { t: dynamicT } = useI18n(undefined, { keyPrefix: runtimePrefix });
dynamicT('dynamic');
declare const runtimeOptions: { keyPrefix?: string };
const { t: runtimeOptionsT } = useI18n(undefined, runtimeOptions);
runtimeOptionsT('unknownOptions');
const { t: spreadOptionsT } = useI18n(undefined, {
  keyPrefix: 'known',
  ...runtimeOptions
});
spreadOptionsT('spread');

function useTranslation() {
  return { t: (key: string) => key };
}
const { t: unrelatedT } = useTranslation();
unrelatedT('unrelatedHook');
function t(key: string) {
  return key;
}
t('unrelatedNamed');
const unrelatedHooks = { useTranslation };
const { t: unrelatedMethodT } = unrelatedHooks.useTranslation();
unrelatedMethodT('unrelatedHookMethod');
function getFixedT() {
  return t;
}
getFixedT()('unrelatedFixed');
const unrelated = { t: (key: string) => key };
unrelated.t('unrelatedMethod');
