import i18n from 'i18next';

declare const plugin: unknown;
declare const options: unknown;
declare const locale: string;
declare const resources: unknown;

void i18n.use(plugin).init(options);
i18n.on('languageChanged', () => {});
i18n.hasResourceBundle(locale, 'translation');
i18n.addResourceBundle(locale, 'translation', resources);
i18n.t('named');
