import { useTranslation } from 'react-i18next';

const { t: translate } = useTranslation();
const labels = <{ used: string }>translate('typeAssertionCastFlow', { returnObjects: true });
labels.used;
