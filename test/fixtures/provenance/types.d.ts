declare module 'i18next' {
  type TFunctionStrict = (key: string, options?: { keyPrefix?: string }) => unknown;
  export interface TFunction extends TFunctionStrict {}
  export const t: TFunction;
  export function getFixedT(lng: string | null, ns: string | null, keyPrefix?: string): TFunction;
  export interface i18n {
    t: TFunction;
    getFixedT: typeof getFixedT;
    use(plugin: unknown): this;
    init(options: unknown): Promise<TFunction>;
    on(event: string, listener: (value: string) => void): this;
    hasResourceBundle(locale: string, namespace: string): boolean;
    addResourceBundle(locale: string, namespace: string, resources: unknown): this;
  }
  const i18n: i18n;
  export default i18n;
}

declare module 'react-i18next' {
  import type { TFunction } from 'i18next';

  export type UseTranslationResponse = { t: TFunction } & [TFunction];
  export function useTranslation(
    namespace?: string,
    options?: { keyPrefix?: string }
  ): UseTranslationResponse;
  export function Trans(props: { i18nKey: string; t?: TFunction }): unknown;
}
