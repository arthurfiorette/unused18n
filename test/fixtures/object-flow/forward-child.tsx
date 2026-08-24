import { forwardRef } from 'react';

export const ForwardChild = forwardRef<unknown, { labels: any }>(function ForwardChild(
  { labels },
  _ref
) {
  return <span>{labels.used}</span>;
});
