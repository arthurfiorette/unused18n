import { useTranslation } from 'react-i18next';
import { useLabel } from '../lib/labels.js';

export function C() {
  const { t } = useTranslation();
  t('fromApp');
  return useLabel();
}
