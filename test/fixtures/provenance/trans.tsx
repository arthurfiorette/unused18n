import { getFixedT, t } from 'i18next';
import { Trans } from 'react-i18next';

declare const itemType: 'page' | 'message' | 'offer';

const literal = <Trans i18nKey="transLiteral" />;
const finite = (
  <Trans
    t={t}
    i18nKey={
      itemType === 'page'
        ? 'Project.Card.Page.removeTooltip'
        : itemType === 'message'
          ? 'Project.Card.Message.removeTooltip'
          : 'Project.Card.Offer.removeTooltip'
    }
  />
);
const prefixed = <Trans t={getFixedT(null, null, 'Project.Card.Page')} i18nKey="removeTooltip" />;

void literal;
void finite;
void prefixed;
