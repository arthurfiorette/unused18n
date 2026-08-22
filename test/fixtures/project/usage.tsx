import i18n from 'i18next';
import {
  Trans as I18nTrans,
  Trans,
  useTranslation as useI18n,
  useTranslation
} from 'react-i18next';
import { dictionary } from './dictionary.js';
import { useBoundTranslation, useExposedTranslation, useLocalTranslation } from './hooks.js';

const { t } = useTranslation();
const { t: prefixed } = useTranslation(undefined, { keyPrefix: 'prefixed' });
const { t: transPrefix } = useTranslation(undefined, { keyPrefix: 'transPrefixed' });
const { t: aliasedT } = useI18n();
const objectOptions = { returnObjects: true } as const;
const { t: localT } = useLocalTranslation('customHook');
const { t: dynamicLocalT } = useLocalTranslation('customDynamicHook');
const { t: assertedDynamicLocalT } = useLocalTranslation('customAssertedDynamicHook');
const boundT = useBoundTranslation().t;
const { t: exposedT } = useExposedTranslation();

t('direct');
t(Math.random() > 0.5 ? 'conditional.one' : 'conditional.many');
t('asserted' as never);

export function renderTemperature(temperature: 'cold' | 'hot') {
  return t(`temperature.${temperature}`);
}

prefixed('label');

export function renderOption(option: 'first' | 'second') {
  return prefixed(`options.${option}`);
}

const copy = t('objects', { returnObjects: true }) as typeof dictionary.objects;
copy.used;
const configuredCopy = t('configuredObject', objectOptions) as typeof dictionary.configuredObject;
configuredCopy.used;
const { used: destructuredCopy } = t('destructured', {
  returnObjects: true
}) as typeof dictionary.destructured;
String(destructuredCopy);
aliasedT('aliases.hook');
t('overwritten.live');
localT('label');
boundT('customBound');
exposedT('label');

export function renderCustomDynamic(key: string) {
  return dynamicLocalT(key);
}

export function renderCustomAssertedDynamic(key: string) {
  return assertedDynamicLocalT(key as 'first');
}

export function renderDynamicCopy(key: 'dynamicA' | 'dynamicB') {
  return copy[key];
}

const keyofCopy = t('keyofObject', { returnObjects: true }) as typeof dictionary.keyofObject;
export function renderKeyofCopy(key: keyof typeof dictionary.keyofObject) {
  return keyofCopy[key];
}

export function renderPartialPrefix(suffix: string) {
  return t(`prefix${suffix}`);
}

function useWrappedCopy() {
  return t('wrapped', { returnObjects: true }) as typeof dictionary.wrapped;
}

useWrappedCopy().title;

function helperKey(value: boolean): 'alpha' | 'beta' {
  return value ? 'alpha' : 'beta';
}

t(`helper.${helperKey(true)}`);

export function renderRuntime(code: string) {
  return t(`runtime.${code}`);
}

export function renderError(code: string) {
  if (!code.startsWith('errorCodes.')) code = `errorCodes.${code}`;
  return i18n.t(code as 'errorCodes.fallback');
}

function translateForwarded(translate: typeof t, key: 'forwarded.one' | 'forwarded.two') {
  return translate(key);
}

translateForwarded(t, 'forwarded.one');

function getDictionary(): typeof dictionary {
  return dictionary;
}

Object.keys(getDictionary().catalog);
i18n.t('direct');

const objectDefaults = { returnObjects: true } as const;
t('booleanOverride', { ...objectDefaults, returnObjects: false });

let reassignedKey = 'reassigned.initial';
reassignedKey = 'reassigned.active';
t(reassignedKey);

export function View() {
  const dynamicTransKey = Math.random() > 0.5 ? 'transDynamic.one' : 'transDynamic.two';
  return (
    <>
      <Trans i18nKey="trans" />
      <Trans t={transPrefix} i18nKey="body" />
      <Trans i18nKey={dynamicTransKey} />
      <I18nTrans i18nKey="aliases.trans" />
    </>
  );
}
