export function isMonthlyStatementAmount(name: unknown, subtotal: number) {
  const label = String(name ?? "").trim();
  return label === "月結單" || (subtotal <= 0 && ["稅金折讓費", "稅金折讓金"].includes(label));
}

export function legacyMonthlyKind(lines: {name:unknown; subtotal:number}[]) {
  const names = lines.map(line => String(line.name ?? "").trim());
  if (names.includes("月結單")) {
    return lines.some((line,index)=>!isMonthlyStatementAmount(names[index],line.subtotal) && (line.subtotal!==0 || names[index]!.startsWith("未收款")))
      ? "mixed" : "statement";
  }
  if (names.some(name=>name.startsWith("未收款月結單"))) return "monthly_reminder";
  if (names.some(name=>name.startsWith("未收款項"))) return "payment_reminder";
  return "ordinary";
}

// Without receipt allocation, only classify orders whose entire unpaid value is unambiguous.
export function isUnpaidPrepaidInvoice(lines: {
  name: unknown; subtotal: number; completed: boolean; collected: boolean; billing: string;
}[], received: number) {
  const isInvoice = (line: typeof lines[number]) => line.billing === "預收" &&
    /\(請款\)|（請款）/.test(String(line.name ?? "")) && !line.collected && line.subtotal > 0;
  return received === 0 && lines.some(isInvoice) && lines.every(line => line.completed &&
    (line.subtotal === 0 || isInvoice(line) ||
      (line.billing === "現金" && !line.collected && line.subtotal > 0)));
}
