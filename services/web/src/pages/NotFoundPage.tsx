import { ButtonLink } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { PageHeading } from "../components/ui/PageHeading";

export function NotFoundPage() {
  return (
    <div className="space-y-8">
      <PageHeading eyebrow="Error 404" title="Page not found" />
      <Card padded={false}>
        <EmptyState
          icon="alert"
          title="There's nothing at this address"
          actions={
            <ButtonLink to="/" variant="secondary">
              Go to the dashboard
            </ButtonLink>
          }
        >
          Check the link, or use the navigation to find the screen you need.
        </EmptyState>
      </Card>
    </div>
  );
}
