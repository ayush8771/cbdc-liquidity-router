import type { SVGProps } from "react";
import { Button } from "../../components/ui/Button";

// Local icons: the shared Icon component is deliberately not modified.
function MotionIcon({ paused, ...rest }: SVGProps<SVGSVGElement> & { paused: boolean }) {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {paused ? <path d="M8 5.5v13l10.5-6.5z" /> : <path d="M8.5 5.5v13M15.5 5.5v13" />}
    </svg>
  );
}

type GlobeControlsProps = {
  paused: boolean;
  onToggle: () => void;
};

/**
 * One control for all the globe's motion. The label changes with the state,
 * and a polite status message announces the change to assistive technology.
 */
export function GlobeControls({ paused, onToggle }: GlobeControlsProps) {
  return (
    <div className="flex flex-col items-center gap-2">
      <Button variant="secondary" size="sm" onClick={onToggle} iconStart={<MotionIcon paused={paused} />}>
        {paused ? "Resume rotation" : "Pause rotation"}
      </Button>
      <p className="text-ui text-ink-muted">Drag the globe to rotate it.</p>
      <span role="status" className="sr-only">
        {paused ? "Globe motion paused" : "Globe motion running"}
      </span>
    </div>
  );
}
