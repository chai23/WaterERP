import { useRef } from "react";
import type { OrderPrintLayoutV1 } from "./layoutTypes";

type Props = {
  html: string;
  layout: OrderPrintLayoutV1;
  labels: Record<string, string>;
  onMove: (key: string, dx: number, dy: number) => void;
  onStatus: (message: string) => void;
};

/** Pointer coordinates belong to the iframe viewport, so CSS preview scaling does not change mm deltas. */
export function DraggableSlipPreview({ html, layout, labels, onMove, onStatus }: Props) {
  const latest = useRef({ layout, labels, onMove });
  latest.current = { layout, labels, onMove };
  const setStatus = onStatus;
  const focusedKey = useRef<string | null>(null);

  return <>
    <iframe title="套印預覽" srcDoc={html} className="order-print-preview-iframe"
      style={{ width: `${layout.pageWidthMm}mm`, height: `${layout.pageHeightMm}mm`, border: 0 }}
      onLoad={(event) => {
        const doc = event.currentTarget.contentDocument;
        const slip = doc?.getElementById("slip");
        if (!doc || !slip) return;
        const style = doc.createElement("style");
        style.textContent = `html,body { overflow:hidden; } body { padding:0!important; background:white!important; } .no-print { display:none!important; }
          .slip-wrap { margin:0!important; box-shadow:none!important; }
          #slip { background-image:linear-gradient(#dbeafe66 1px,transparent 1px),linear-gradient(90deg,#dbeafe66 1px,transparent 1px); background-size:5mm 5mm; }
          [data-drag-key] { cursor:grab; touch-action:none; user-select:none; min-width:2mm; min-height:3mm; outline:1px dashed #93b4d9; }
          [data-drag-key]:hover,[data-drag-key]:focus { outline:2px solid #2563eb; background-color:#dbeafe88; z-index:10; }
          [data-drag-key]:active { cursor:grabbing; }`;
        doc.head.appendChild(style);
        const nodes = Array.from(doc.querySelectorAll<HTMLElement>("[data-drag-key]"));
        for (const node of nodes) {
          const key = node.dataset.dragKey!;
          const label = latest.current.labels[key] ?? key;
          node.tabIndex = 0;
          node.setAttribute("role", "button");
          node.setAttribute("aria-label", `移動${label}`);
          node.title = label;
          if (focusedKey.current === key) node.focus({ preventScroll: true });
          node.onfocus = () => { focusedKey.current = key; };
          node.onkeydown = (e) => {
            const step = e.shiftKey ? 1 : 0.1;
            const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
            if (!delta[e.key]) return;
            e.preventDefault();
            move(...delta[e.key]);
          };
          const move = (dx: number, dy: number) => {
            latest.current.onMove(key, dx, dy);
            setStatus(`${label}：位置已更新，請按「儲存設定」。`);
          };
          node.onpointerdown = (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            node.focus();
            node.setPointerCapture(e.pointerId);
            const pxPerMm = slip.getBoundingClientRect().width / latest.current.layout.pageWidthMm;
            const startX = e.clientX, startY = e.clientY;
            const group = key.split(":")[0];
            const affected = nodes.filter(n => n === node || ((group === "line" || group === "footer") && n.dataset.dragKey!.startsWith(`${group}:`)));
            const originals = affected.map(n => ({ node: n, x: parseFloat(n.style.left), y: parseFloat(n.style.top) }));
            let dx = 0, dy = 0;
            node.onpointermove = (p) => {
              dx = Math.round((p.clientX - startX) / pxPerMm * 100) / 100;
              dy = Math.round((p.clientY - startY) / pxPerMm * 100) / 100;
              const horizontal = originals.filter(o => o.node.dataset.dragKey === key);
              dx = Math.max(-Math.min(...horizontal.map(o => o.x)), Math.min(dx, latest.current.layout.pageWidthMm - 2 - Math.max(...horizontal.map(o => o.x))));
              dy = Math.max(-Math.min(...originals.map(o => o.y)), Math.min(dy, latest.current.layout.pageHeightMm - 2 - Math.max(...originals.map(o => o.y))));
              for (const o of originals) {
                o.node.style.left = `${o.x + (o.node.dataset.dragKey === key ? dx : 0)}mm`;
                o.node.style.top = `${o.y + dy}mm`;
              }
              setStatus(`${label}：左右 ${dx.toFixed(2)} mm，上下 ${dy.toFixed(2)} mm`);
            };
            const finish = (commit: boolean) => {
              node.onpointermove = node.onpointerup = node.onpointercancel = node.onlostpointercapture = null;
              if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId);
              if (commit) move(dx, dy);
              else for (const o of originals) { o.node.style.left = `${o.x}mm`; o.node.style.top = `${o.y}mm`; }
            };
            node.onpointerup = () => finish(true);
            node.onpointercancel = node.onlostpointercapture = () => finish(false);
          };
        }
      }} />
  </>;
}
