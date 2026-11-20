import type { ReactNode } from "react";

export type DescriptionItem = {
  term: string;
  detail: ReactNode;
};

/** Term/value pairs on hairline rows; stacks on small screens. */
export function DescriptionList({ items }: { items: DescriptionItem[] }) {
  return (
    <dl className="border-t border-line-subtle">
      {items.map((item) => (
        <div
          key={item.term}
          className="grid grid-cols-1 gap-1 border-b border-line-subtle py-3 sm:grid-cols-[minmax(8rem,14rem)_1fr] sm:gap-6"
        >
          <dt className="text-ui text-ink-muted">{item.term}</dt>
          <dd className="min-w-0 break-words text-ui text-ink-body">{item.detail}</dd>
        </div>
      ))}
    </dl>
  );
}
