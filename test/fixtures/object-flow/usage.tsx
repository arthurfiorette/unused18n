import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ForwardChild } from './forward-child.js';

const { t: translate } = useTranslation();

const jsxLabels = translate('jsxFlow', { returnObjects: true });
function Child({ labels }: { labels: any }) {
  return <button type="button" aria-label={labels.used} />;
}
const child = <Child labels={jsxLabels} />;
void child;

const parameterLabels = translate('parameterFlow', { returnObjects: true });
function consume(labels: any) {
  return labels.used;
}
consume(parameterLabels);

const returnedLabels = translate('returnedFlow', { returnObjects: true });
function useReturnedLabels() {
  return { labels: returnedLabels };
}
useReturnedLabels().labels.used;

const destructuredLabels = translate('destructuredFlow', { returnObjects: true });
function useDestructuredLabels() {
  return { labels: destructuredLabels };
}
const { labels } = useDestructuredLabels();
labels.used;

const jsxReturnedLabels = translate('jsxReturnedFlow', { returnObjects: true });
function useWizard() {
  return { labels: jsxReturnedLabels };
}
function WizardStep({ wizard }: { wizard: ReturnType<typeof useWizard> }) {
  return <span>{wizard.labels.used}</span>;
}
const wizard = useWizard();
const wizardStep = <WizardStep wizard={wizard} />;
void wizardStep;

const jsxSpreadLabels = translate('jsxSpreadFlow', { returnObjects: true });
const spreadProps = { labels: jsxSpreadLabels };
function SpreadChild({ labels }: { labels: any }) {
  return <span>{labels.used}</span>;
}
const spreadChild = <SpreadChild {...spreadProps} />;
void spreadChild;

const memoLabels = useMemo(() => translate('memoFlow', { returnObjects: true }), []);
const memoChild = <Child labels={memoLabels} />;
void memoChild;

const memoNamespaces = useMemo(() => {
  const productList = translate('memoBagFlow.productList', { returnObjects: true });
  const funnelActions = translate('memoBagFlow.funnelActions', { returnObjects: true });
  return { productList, funnelActions };
}, []);
memoNamespaces.productList?.used;
memoNamespaces.productList?.nested?.used;
memoNamespaces.funnelActions?.used;

declare const runtimeIndex: number;
const arrayLabels = translate('arrayFlow', { returnObjects: true });
const arrayProps = { values: arrayLabels };
function ArrayChild({ values }: { values: any }) {
  return <span>{values[runtimeIndex]}</span>;
}
const arrayChild = <ArrayChild {...arrayProps} />;
void arrayChild;

const castLabels = translate('castFlow', { returnObjects: true } as never) as unknown as {
  used: string;
};
castLabels.used;

const constOptionsLabels = translate('constOptionsFlow', { returnObjects: true } as const);
constOptionsLabels.used;

const billingLabels = translate('billingHistory', { returnObjects: true });
const billingFallbacks = {
  page_templates: billingLabels.page_templates ?? billingLabels.page_templates ?? 'Page templates'
};
void billingFallbacks;

declare const runtimeKey: string;
const indexedLabels = translate('indexedFlow', { returnObjects: true });
indexedLabels[runtimeKey];

const defaultLabels = translate('defaultFlow', { returnObjects: true });
function consumeDefault(labels = defaultLabels) {
  return labels.used;
}
consumeDefault();

declare function consumeExternal(labels: unknown): void;
const externalLabels = translate('externalFlow', { returnObjects: true });
consumeExternal(externalLabels);

const forwardRefLabels = translate('forwardRefFlow', { returnObjects: true });
const forwardRefChild = <ForwardChild labels={forwardRefLabels} />;
void forwardRefChild;

const hiddenJsxLabels = translate('hiddenJsxFlow', { returnObjects: true });
const visibleJsxLabels = translate('visibleJsxFlow', { returnObjects: true });
const hiddenJsxProps = { labels: hiddenJsxLabels };
const overwrittenChild = <Child {...hiddenJsxProps} labels={visibleJsxLabels} />;
void overwrittenChild;

const hiddenReturnLabels = translate('hiddenReturnFlow', { returnObjects: true });
const visibleReturnLabels = translate('visibleReturnFlow', { returnObjects: true });
function useOverwrittenLabels() {
  return { ...{ labels: hiddenReturnLabels }, labels: visibleReturnLabels };
}
useOverwrittenLabels().labels.used;
