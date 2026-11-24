import type { ComponentPropsWithRef } from "react";

type MoneyInputProps = Omit<ComponentPropsWithRef<"input">, "type" | "step" | "inputMode">;

/** Text entry prevents native wheel/arrow stepping, including while focused. */
export function MoneyInput({ onChange, onKeyDown, onPaste, value, ...props }: MoneyInputProps) {
  return (
    <input
      {...props}
      value={value}
      type="text"
      data-money-input="true"
      inputMode="numeric"
      pattern={props.min != null && Number(props.min) >= 0 ? "[0-9]*" : "-?[0-9]*"}
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
        if (next !== "" && (
          !/^-?\d+$/.test(next) ||
          !Number.isSafeInteger(Number(next)) ||
          (props.min != null && Number(next) < Number(props.min)) ||
          (props.max != null && Number(next) > Number(props.max))
        )) {
          event.currentTarget.value = String(value ?? "");
          return;
        }
        onChange?.(event);
      }}
    />
  );
}
