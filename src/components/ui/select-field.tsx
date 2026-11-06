"use client";

import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { fieldClass } from "@/components/ui-bits";

const EMPTY_VALUE = "__none__";

export type SelectFieldOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type SelectFieldProps = {
  options: SelectFieldOption[];
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
  required?: boolean;
  disabled?: boolean;
  id?: string;
  name?: string;
  "aria-label"?: string;
};

export function SelectField({
  options,
  value,
  onValueChange,
  className,
  required,
  disabled,
  ...triggerProps
}: SelectFieldProps) {
  return (
    <Select.Root
      value={value}
      onValueChange={(nextValue) => onValueChange(nextValue === EMPTY_VALUE ? "" : nextValue)}
      required={required}
      disabled={disabled}
      name={triggerProps.name}
    >
      <Select.Trigger
        {...triggerProps}
        className={cn(fieldClass, "flex items-center justify-between gap-2 text-sm", className)}
      >
        <Select.Value placeholder={options.find((option) => option.value === "")?.label} />
        <Select.Icon asChild>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          className="z-[100] max-h-60 w-[var(--radix-select-trigger-width)] min-w-[var(--radix-select-trigger-width)] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          <Select.Viewport>
            {options.map((option) => (
              <Select.Item
                key={option.value || EMPTY_VALUE}
                value={option.value || EMPTY_VALUE}
                disabled={option.disabled}
                className="relative flex min-h-10 cursor-pointer select-none items-center rounded-md py-2 pl-3 pr-9 text-sm outline-none max-[480px]:min-h-11 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
              >
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator className="absolute right-3 inline-flex items-center">
                  <Check className="h-4 w-4" aria-hidden="true" />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
