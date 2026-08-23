declare module 'i18next' {
  type TFunctionStrict = (key: string, options?: { keyPrefix?: string }) => unknown;
  export interface TFunction extends TFunctionStrict {}
  export const t: TFunction;
  export function getFixedT(lng: string | null, ns: string | null, keyPrefix?: string): TFunction;
  const i18n: { t: TFunction; getFixedT: typeof getFixedT };
  export default i18n;
}

declare module 'react-i18next' {
  import type { TFunction } from 'i18next';

  export type UseTranslationResponse = { t: TFunction } & [TFunction];
  export function useTranslation(
    namespace?: string,
    options?: { keyPrefix?: string }
  ): UseTranslationResponse;
}
