declare module 'react-i18next' {
  type TFunction = (key: string, options?: Record<string, unknown>) => unknown;
  export function useTranslation(
    namespace?: string,
    options?: { keyPrefix?: string }
  ): { t: TFunction };
  export const Trans: unknown;
}

declare module 'i18next' {
  type TFunction = (key: string, options?: Record<string, unknown>) => unknown;
  const i18n: { t: TFunction };
  export default i18n;
}
