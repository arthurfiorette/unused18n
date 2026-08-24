declare module 'react-i18next' {
  import type { TFunction } from 'i18next';
  export function useTranslation(): { t: TFunction };
}

declare module 'i18next' {
  export type TFunction = (key: string, options?: { returnObjects?: boolean }) => unknown;
}

declare module 'react' {
  export function useMemo<T>(factory: () => T, dependencies: readonly unknown[]): T;
  export function forwardRef<T, P>(
    render: (props: P, ref: unknown) => unknown
  ): (props: P & { ref?: unknown }) => unknown;
}
