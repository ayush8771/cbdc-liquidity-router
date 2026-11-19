import { Notice } from "../components/ui/Notice";

/** Shown on every page that renders preview data, so it is never mistaken for real results. */
export function PreviewNotice() {
  return (
    <Notice title="Preview data — illustrative, not from the API">
      These values exist only to review the layout. They will be replaced by live data once the shared API contracts
      are merged and integrated.
    </Notice>
  );
}
