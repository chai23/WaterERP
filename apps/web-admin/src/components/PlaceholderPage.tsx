export default function PlaceholderPage({ title, description }: { title: string; description: string }) {
  return (
    <section className="card">
      <h2 className="card__title">{title}</h2>
      <p className="card__hint">{description}</p>
      <p style={{ color: "var(--text-muted)", fontSize: "0.9rem" }}>此功能尚未接上後端或仍在規劃中，後續可於 Agent 模式請協助實作。</p>
    </section>
  );
}
