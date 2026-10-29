import { useTranslation } from 'react-i18next';

export function useLabel() {
  const { t } = useTranslation();
  return t('fromLib') as string;
}
