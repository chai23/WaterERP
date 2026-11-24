import type { ComponentPropsWithRef } from "react";

type MoneyInputProps = Omit<ComponentPropsWithRef<"input">, "type" | "step" | "inputMode">;

/** Whole-dollar entry only; never silently round an existing financial value. */
export function MoneyInput({ onChange, onKeyDown, onPaste, value, ...props }: MoneyInputProps) {
  return (
    <input
      {...props}
      value={value}
      type="number"
      step={1}
      inputMode="numeric"
      title={props.title ?? "金額請輸入整數元"}
      onKeyDown={(event) => {
        if (!event.ctrlKey && !event.metaKey && !event.altKey && [".", ",", "e", "E", "+"].includes(event.key)) {
          event.preventDefault();
          return;
        }
        onKeyDown?.(event);
      }}
      onPaste={(event) => {
        if (!/^-?\d+$/.test(event.clipboardData.getData("text").trim())) {
          event.preventDefault();
          return;
        }
        onPaste?.(event);
      }}
      onChange={(event) => {
        const next = event.currentTarget.value;
        if (next !== "" && (!/^-?\d+$/.test(next) || !Number.isSafeInteger(Number(next)))) {
          event.currentTarget.value = String(value ?? "");
          return;
        }
        onChange?.(event);
      }}
    />
  );
}
