import { splitLocalDateTime } from "../adminUtils";

export function DateTimeCell({ value }: { value: string | null | undefined }) {
  const parts = splitLocalDateTime(value);
  if (!parts) return <>—</>;
  return (
    <div className="cell-datetime">
      <span className="cell-datetime__date">{parts.date}</span>
      <span className="cell-datetime__time">{parts.time}</span>
    </div>
  );
}
