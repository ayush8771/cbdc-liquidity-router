import { useId, type ReactNode } from "react";
import { Label } from "./Label";
import { Icon } from "./Icon";

export type FieldControlProps = {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  invalid: boolean;
  required?: boolean;
};

type FormFieldProps = {
  label: string;
  helper?: ReactNode;
  error?: string | null;
  required?: boolean;
  /** Renders the control with the ids and ARIA attributes that link it to its label, helper and error. */
  children: (control: FieldControlProps) => ReactNode;
};

export function FormField({ label, helper, error, required, children }: FormFieldProps) {
  const id = useId();
  const helperId = helper ? `${id}-helper` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, helperId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="space-y-2">
      <Label htmlFor={id} required={required}>
        {label}
      </Label>
      {children({
        id,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
        invalid: Boolean(error),
        required,
      })}
      {error ? (
        <p id={errorId} className="flex items-start gap-1.5 px-1 text-ui text-status-danger">
          <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
      {helper ? (
        <p id={helperId} className="px-1 text-ui text-ink-muted">
          {helper}
        </p>
      ) : null}
    </div>
  );
}
