import { useTranslation } from 'react-i18next';

export function useLocalTranslation(keyPrefix?: string) {
  return useTranslation(undefined, { keyPrefix });
}

export function useBoundTranslation() {
  return useTranslation(undefined, {});
}

export function useExposedTranslation() {
  const { t } = useTranslation(undefined, { keyPrefix: 'customExposedHook' });
  return { t };
}
