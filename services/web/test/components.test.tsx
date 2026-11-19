import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../src/components/ui/Button";
import { FormField } from "../src/components/ui/FormField";
import { Input } from "../src/components/ui/Input";
import { StatusIndicator } from "../src/components/ui/StatusIndicator";

describe("Button", () => {
  it("defaults to type=button so it never submits a form by accident", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("type", "button");
  });

  it("does not fire onClick when disabled", async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("FormField", () => {
  it("links the label, helper and error to the control", () => {
    render(
      <FormField label="Amount" helper="In US dollars." error="Enter an amount.">
        {({ invalid, ...control }) => <Input {...control} invalid={invalid} />}
      </FormField>,
    );
    const input = screen.getByLabelText("Amount");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Enter an amount. In US dollars.");
  });

  it("is not marked invalid without an error", () => {
    render(<FormField label="Amount">{({ invalid, ...control }) => <Input {...control} invalid={invalid} />}</FormField>);
    expect(screen.getByLabelText("Amount")).not.toHaveAttribute("aria-invalid");
  });
});

describe("StatusIndicator", () => {
  it("always carries a text label, not colour alone", () => {
    render(<StatusIndicator tone="danger" label="Unavailable" />);
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
  });
});
