import { useTranslation } from 'react-i18next';

const { t } = useTranslation();

export function translateUnknown(key: string) {
  return t(key);
}

function consume(value: unknown) {
  return value;
}

const copy = t('escaped', { returnObjects: true });
consume(copy);
