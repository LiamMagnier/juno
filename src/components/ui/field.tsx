"use client";

import * as React from "react";
import { StatusIcons } from "@/lib/app-icons";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * A labelled text field that carries its own error.
 *
 * Three criteria are the reason this exists rather than the hand-rolled
 * `<div className="space-y-2"><Label/><Input/></div>` it replaces:
 *
 * - SC 3.3.1 Error Identification requires the field in error to be identified
 *   in TEXT. Errors were delivered only as sonner toasts, which are transient,
 *   are not associated with any field, and are gone before a screen-reader user
 *   navigating the form ever reaches the input that caused them. `aria-invalid`
 *   appeared zero times in the tree.
 * - SC 3.3.2 Labels or Instructions: `required` was set on the inputs but
 *   nothing said so, visually or to assistive tech.
 * - SC 1.4.1 Use of Colour: hence an icon and a sentence, not just a red border.
 *
 * Consumers own validation timing. The rule: validate on submit, and on blur
 * only AFTER the first submit — never on the first keystroke, which flags a
 * half-typed email as wrong while the user is still typing it.
 */
export interface FieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Required — it wires the label, the input and the error message together. */
  id: string;
  label: React.ReactNode;
  /** Present = the field is in error. The string is rendered, not just used as a flag. */
  error?: string | null;
  /** Optional trailing control on the label row (e.g. "Forgot your password?"). */
  labelAction?: React.ReactNode;
  /** Classes for the wrapper; `className` goes to the input, as callers expect. */
  fieldClassName?: string;
}

const Field = React.forwardRef<HTMLInputElement, FieldProps>(
  ({ id, label, error, labelAction, required, className, fieldClassName, ...props }, ref) => {
    const errorId = `${id}-error`;
    return (
      <div className={cn("space-y-2", fieldClassName)}>
        <div className={cn(labelAction && "flex items-center justify-between gap-3")}>
          <Label htmlFor={id}>
            {label}
            {required && (
              <>
                {/* The asterisk is decoration for AT — the word is what gets announced. */}
                <span aria-hidden className="text-destructive">
                  {" *"}
                </span>
                <span className="sr-only"> (required)</span>
              </>
            )}
          </Label>
          {labelAction}
        </div>
        <Input
          id={id}
          ref={ref}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={cn(
            "aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:border-destructive",
            className
          )}
          {...props}
        />
        {error && (
          // role="alert" so the message is announced when it appears mid-form,
          // and it sits AFTER the input so `aria-describedby` reads in order.
          <p id={errorId} role="alert" className="flex items-center gap-1.5 text-caption text-destructive">
            <StatusIcons.error className="size-3.5 shrink-0" aria-hidden />
            {error}
          </p>
        )}
      </div>
    );
  }
);
Field.displayName = "Field";

export { Field };
