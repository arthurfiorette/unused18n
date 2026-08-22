declare module 'react-i18next' {
  type TFunction = (key: string, options?: Record<string, unknown>) => unknown;
  export function useTranslation(): { t: TFunction };
}
