import i18n from 'i18next';
import { useTranslation } from 'react-i18next';

export function Component() {
  const { t } = useTranslation();
  t('a');
  const value = /** @type {any} */ (t('nested', { returnObjects: true }));
  return value;
}

/** @param {(key: string) => unknown} translate */
function helper(translate) {
  return translate('b');
}
helper(i18n.t);

export function Other() {
  const { t } = useTranslation();
  const obj = /** @type {Record<string, string>} */ (t('other', { returnObjects: true }));
  return obj.p;
}
