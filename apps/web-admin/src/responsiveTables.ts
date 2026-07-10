const CARD_CLASS = "data-table--card";
const SKIP_SELECTOR = ".data-table--no-card, .permission-table, .order-print-layout-table";

function isMobileViewport(): boolean {
  return window.matchMedia("(max-width: 768px)").matches;
}

export function labelResponsiveTables(root: ParentNode = document): void {
  const mobile = isMobileViewport();
  const tables = root.querySelectorAll<HTMLTableElement>(".table-wrap table.data-table");

  tables.forEach((table) => {
    if (table.matches(SKIP_SELECTOR) || table.closest(".order-print-editor, .order-print-preview")) {
      table.classList.remove(CARD_CLASS);
      table.closest(".table-wrap")?.classList.remove("table-wrap--card-mobile");
      return;
    }

    const headers = [...table.querySelectorAll("thead th")].map((th) => th.textContent?.trim() ?? "");

    table.querySelectorAll("tbody tr").forEach((tr) => {
      const cells = [...tr.querySelectorAll(":scope > td")];
      cells.forEach((td, index) => {
        const label = headers[index];
        if (label) td.setAttribute("data-label", label);
      });
    });

    const wrap = table.closest(".table-wrap");
    if (mobile) {
      table.classList.add(CARD_CLASS);
      wrap?.classList.add("table-wrap--card-mobile");
    } else {
      table.classList.remove(CARD_CLASS);
      wrap?.classList.remove("table-wrap--card-mobile");
    }
  });
}

export function setupResponsiveTables(mainRoot: ParentNode): () => void {
  const run = () => requestAnimationFrame(() => labelResponsiveTables(mainRoot));

  run();

  const observer = new MutationObserver(run);
  observer.observe(mainRoot, { childList: true, subtree: true });

  const mq = window.matchMedia("(max-width: 768px)");
  mq.addEventListener("change", run);
  window.addEventListener("resize", run);

  return () => {
    observer.disconnect();
    mq.removeEventListener("change", run);
    window.removeEventListener("resize", run);
  };
}
