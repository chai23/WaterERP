import { useCallback, useEffect, useState } from "react";

export type PrintSlogan = {
  id: string;
  title: string;
  body: string;
  sortOrder?: number;
  isActive?: boolean;
};

function appendRemarkSegment(current: string, segment: string): string {
  const t = segment.trim();
  if (!t) return current;
  const cur = current.trim();
  if (!cur) return t;
  if (cur.includes(t)) return cur;
  return `${cur}；${t}`;
}

function removeRemarkSegment(current: string, segment: string): string {
  const t = segment.trim();
  if (!t || !current.includes(t)) return current;
  return current
    .split("；")
    .map((s) => s.trim())
    .filter((s) => s && s !== t)
    .join("；");
}

type Props = {
  value: string;
  onChange: (next: string) => void;
  className?: string;
};

export function RemarkSloganPicker({ value, onChange, className }: Props) {
  const [slogans, setSlogans] = useState<PrintSlogan[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/print-slogans");
      const rows = (await res.json()) as PrintSlogan[];
      setSlogans(Array.isArray(rows) ? rows : []);
    } catch {
      setSlogans([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return <p className={`card__hint remark-slogan-picker${className ? ` ${className}` : ""}`}>讀取套印標語…</p>;
  }

  if (slogans.length === 0) {
    return (
      <p className={`card__hint remark-slogan-picker${className ? ` ${className}` : ""}`}>
        尚無套印標語。管理員可至「系統設定 → 套印標語」新增。
      </p>
    );
  }

  return (
    <div className={`remark-slogan-picker${className ? ` ${className}` : ""}`}>
      <span className="remark-slogan-picker__label">快速選取標語</span>
      <div className="remark-slogan-picker__chips" role="group" aria-label="套印標語">
        {slogans.map((s) => {
          const active = value.includes(s.body.trim());
          return (
            <button
              key={String(s.id)}
              type="button"
              className={`remark-slogan-chip${active ? " remark-slogan-chip--active" : ""}`}
              title={s.body}
              onClick={() => onChange(active ? removeRemarkSegment(value, s.body) : appendRemarkSegment(value, s.body))}
            >
              {s.title}
            </button>
          );
        })}
      </div>
      <p className="remark-slogan-picker__hint">點選加入備註；已選項目再點一次可移除。滑鼠停留可預覽完整文字。</p>
    </div>
  );
}
