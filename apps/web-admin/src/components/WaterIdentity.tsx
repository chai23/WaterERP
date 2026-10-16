/** Shared, code-native water motif: no image requests or animation runtime. */
export function WaterMark({ className = "" }: { className?: string }) {
  return (
    <svg className={`water-mark ${className}`} width="36" height="36" viewBox="0 0 36 36" fill="none" aria-hidden="true">
      <path d="M18 3C14 9 7 15 7 22a11 11 0 0 0 22 0C29 15 22 9 18 3Z" stroke="currentColor" strokeWidth="1.7" />
      <path d="M8 23c5-7 15 7 20-1M11 28c4-4 9 3 14-1" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export function WaterRipple() {
  return (
    <svg className="water-ripple" viewBox="0 0 600 600" fill="none" aria-hidden="true">
      {Array.from({ length: 19 }, (_, i) => (
        <ellipse key={i} cx="300" cy="300" rx={42 + i * 13} ry={58 + i * 12} transform={`rotate(${i * 3 - 27} 300 300)`} />
      ))}
      <path d="M300 205c-18 28-52 58-52 90a52 52 0 0 0 104 0c0-32-34-62-52-90Z" />
    </svg>
  );
}

export function InterfaceIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    overview: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
    orders: "M6 3h12v18H6z M9 8h6 M9 12h6 M9 16h3",
    "barrel-pickup": "M7 4h10v16H7z M7 8h10 M7 16h10 M10 4V2h4v2",
    "service-tickets": "M14 4a5 5 0 0 0-6 6L3 15a3 3 0 0 0 4 4l5-5a5 5 0 0 0 6-6l-3 3-3-3 3-3Z",
    data: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M18 8a3 3 0 0 1 0 6 M22 21v-2a4 4 0 0 0-3-4",
    reports: "M4 3v18h17 M9 16v-5 M14 16V7 M19 16V4",
    expenses: "M3 6h17v15H3z M3 6V3h14v3 M15 11h6v5h-6z",
    print: "M7 8V3h10v5 M7 17H3V8h18v9h-4 M7 14h10v7H7z M17 11h1",
    settings: "M4 7h16 M4 17h16 M8 4v6 M16 14v6",
    arrow: "M5 12h14 M13 6l6 6-6 6",
    search: "M21 21l-5-5 M18 10a8 8 0 1 0-16 0 8 8 0 0 0 16 0",
    plus: "M12 5v14 M5 12h14",
  };
  return <svg className="interface-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.orders} /></svg>;
}
