import { useTranslation } from 'react-i18next';

const { t } = useTranslation();
declare const count: number;
declare const anyCount: any;

t('item', { count });
t('anyItem', { count: anyCount });
t('friend', { context: 'male', count: 1 });
t('status_one');
