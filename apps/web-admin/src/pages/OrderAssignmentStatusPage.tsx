import { useCallback, useEffect, useRef, useState } from "react";
import { useDashboard } from "../DashboardContext";
import { driverEmployeeCode, driverIsActive, fmtLocalYmd, deliveryAssignmentStatusLabel, orderStatusLabel } from "../adminUtils";
import { OrderDetailModal } from "../components/OrderDetailModal";
type PoolOrder = {
    id: string;
    orderNo: string;
    status: string;
    scheduledDeliveryDate?: string | null;
    customerId?: string;
    preferredTimeNote?: string | null;
    deliveryWindowStart?: string | null;
    deliveryWindowEnd?: string | null;
    dispatchPriority?: string | null;
    source?: string;
    remark?: string | null;
    customer?: {
        id?: string;
        name?: string;
        customerCode?: string;
    };
    deliveryAddress?: {
        addressLine?: string;
        label?: string;
    };
    lines?: Array<{
        qtyOrdered?: number;
        linePurpose?: string;
        product?: {
            name?: string;
            unit?: string;
            countsDepositBarrel?: boolean;
        };
    }>;
};
type Task = {
    id: string;
    status: string;
    estimatedDeliverySlot?: string | null;
    vehicle?: {
        id: string;
        plateNo: string;
        description?: string;
    };
    salesOrder: PoolOrder;
};
type Fleet = {
    tasks: Task[];
    error?: string;
};
const time = (v?: string | null) => v?.match(/(?:T|^)(\d{2}:\d{2})/)?.[1] ?? '';
const orderDay = (o: PoolOrder) => o.scheduledDeliveryDate ? fmtLocalYmd(o.scheduledDeliveryDate) : "";
const windowLabel = (o: PoolOrder) => o.preferredTimeNote || ([time(o.deliveryWindowStart), time(o.deliveryWindowEnd)].filter(Boolean).join('–')) || '時段未指定';
const barrels = (o: PoolOrder) => (o.lines ?? []).reduce((n, l) => n + (l.linePurpose !== 'prepaid_barrel_topup' && l.product?.countsDepositBarrel ? Number(l.qtyOrdered || 0) : 0), 0);
const goods = (o: PoolOrder) => (o.lines ?? []).map(l => `${l.product?.name || '商品'} × ${l.qtyOrdered ?? 0}${l.product?.unit || ''}${l.linePurpose === 'prepaid_barrel_topup' ? '（儲值）' : ''}`).join('、') || '無商品明細';
export default function AssignmentStatusPanel() {
    const { drivers, vehicles, loadOrders } = useDashboard();
    const [date, setDate] = useState(() => fmtLocalYmd(new Date()));
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState('all');
    const [orders, setOrders] = useState<PoolOrder[]>([]);
    const [fleet, setFleet] = useState<Record<string, Fleet>>({});
    const [selected, setSelected] = useState<string[]>([]);
    const [vehicleIds, setVehicleIds] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);
    const [hover, setHover] = useState('');
    const dragIds = useRef<string[]>([]);
    const [detail, setDetail] = useState<PoolOrder | null>(null);
    const [pending, setPending] = useState<{
        driverId: string;
        ids: string[];
        vehicleId: string;
        date: string;
    } | null>(null);
    const [returnTask, setReturnTask] = useState<Task | null>(null);
    const returnDrag = useRef<Task | null>(null);
    const [poolHover, setPoolHover] = useState(false);
    const [selectedDriverIds, setSelectedDriverIds] = useState<string[]>([]);
    const returnToPool = async () => {
      if (!returnTask || busy) return; setBusy(true);
      try { const r=await fetch(`/api/delivery-assignments/${returnTask.id}/return-to-pool`,{method:"POST"}); const p=await r.json(); if(!r.ok || !p.ok)throw new Error(p.message || "拉回失敗"); setNotice(`訂單 ${returnTask.salesOrder.orderNo} 已拉回待分配訂單池。`); setReturnTask(null); setQuery(""); setFilter("all"); await load(); await loadOrders(); }
      catch(e){setNotice(e instanceof Error?e.message:"拉回失敗，請重新整理確認狀態");setReturnTask(null);await load();} finally {setBusy(false);}
    };
    const generation = useRef(0);
    const enabled = drivers.filter(driverIsActive);
    const driverKey = enabled.map(d => String(d.id)).sort().join(',');
    useEffect(() => {
        const ids = driverKey.split(',').filter(Boolean);
        setSelectedDriverIds((prev) => {
            const kept = prev.filter((id) => ids.includes(id));
            if (kept.length) return kept;
            return ids[0] ? [ids[0]] : [];
        });
    }, [driverKey]);
    const load = useCallback(async () => {
        const gen = ++generation.current;
        setLoading(true);
        setError('');
        setFleet({});
        setSelected([]);
        try {
            const res = await fetch('/api/sales-orders/assignment-queue?scope=unassigned&limit=500');
            const payload = await res.json();
            if (!res.ok || !payload.ok)
                throw new Error(payload.message || '訂單池載入失敗');
            if (gen !== generation.current)
                return;
            setOrders(payload.data.orders);
            const snapshots = await Promise.all(driverKey.split(',').filter(Boolean).map(async (id) => {
                try {
                    const r = await fetch(`/api/delivery-assignments/by-driver-date?${new URLSearchParams({ driverId: id, assignmentDate: date })}`);
                    const p = await r.json();
                    if (!r.ok || !p.ok)
                        throw new Error();
                    return [id, { tasks: p.data.assignments }] as [
                        string,
                        Fleet
                    ];
                }
                catch {
                    return [id, { tasks: [], error: '任務載入失敗，請重新整理' }] as [
                        string,
                        Fleet
                    ];
                }
            }));
            if (gen === generation.current)
                setFleet(Object.fromEntries(snapshots));
        }
        catch (e) {
            if (gen === generation.current) {
                setOrders([]);
                setError(e instanceof Error ? e.message : '資料載入失敗');
            }
        }
        finally {
            if (gen === generation.current)
                setLoading(false);
        }
    }, [date, driverKey]);
    useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
    const visible = orders.filter(o => {
        const day = orderDay(o);
        const matches = filter === 'all' || (filter === 'today' ? day === date : filter === 'future' ? day > date : !!day && day < date);
        return matches && `${o.orderNo} ${o.customer?.name} ${o.customer?.customerCode} ${o.deliveryAddress?.addressLine}`.toLowerCase().includes(query.trim().toLowerCase());
    });
    const prepare = (driverId: string, ids: string[]) => {
        if (loading || busy || !date || fleet[driverId]?.error || !fleet[driverId])
            return;
        const valid = ids.filter(id => orders.some(o => String(o.id) === id));
        if (!valid.length) {
            setNotice('請先勾選訂單，或將訂單拖曳到司機卡片。');
            return;
        }
        const d = enabled.find(d => String(d.id) === driverId);
        setPending({ driverId, ids: valid, vehicleId: vehicleIds[driverId] ?? String(d?.vehicle?.id ?? ''), date });
    };
    const assign = async () => {
        if (!pending || busy)
            return;
        setBusy(true);
        setNotice('');
        try {
            const r = await fetch('/api/orders/batch-assign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ salesOrderIds: pending.ids, driverId: pending.driverId, vehicleId: pending.vehicleId || undefined, assignmentDate: pending.date }) });
            const p = await r.json();
            if (!r.ok || !p.ok)
                throw new Error(p.message || '指派失敗');
            const skipped = p.data.skipped ?? [];
            setNotice(`指派完成：成功 ${p.data.succeeded.length} 筆，略過 ${skipped.length} 筆。${skipped.map((s: {
                id: string;
                reason: string;
            }) => `${orders.find(o => String(o.id) === s.id)?.orderNo || s.id}：${s.reason}`).join('；')}`);
            setPending(null);
            await load();
            await loadOrders();
        }
        catch (e) {
            setNotice(e instanceof Error ? e.message : '連線中斷，請重新整理確認指派結果。');
        }
        finally {
            setBusy(false);
        }
    };
    const target = enabled.find(d => String(d.id) === pending?.driverId);
    const pendingTasks = pending ? fleet[pending.driverId]?.tasks ?? [] : [];
    const pendingQty = pending ? pending.ids.reduce((n, id) => n + (orders.find(o => String(o.id) === id) ? barrels(orders.find(o => String(o.id) === id)!) : 0), 0) : 0;
    const overCapacity = !!target && ((target.maxOrderCount != null && pendingTasks.length + (pending?.ids.length ?? 0) > target.maxOrderCount) || (target.maxBarrelQty != null && pendingTasks.reduce((n, t) => n + barrels(t.salesOrder), 0) + pendingQty > target.maxBarrelQty));
    return <div className="dispatch-board">
    <div className="dispatch-toolbar"><div><h3>調度工作台</h3><p>勾選訂單後，從右側勾選要顯示的司機再指派，或拖曳訂單至司機卡片。</p></div><label>派送日期<input aria-label="派送日期" type="date" value={date} disabled={busy || !!pending} onInput={e => { if (e.currentTarget.value) {
        setDate(e.currentTarget.value);
        setFleet({});
        setSelected([]);
    } }}/></label><button className="btn btn--secondary" disabled={loading || busy || !!pending} onClick={() => void load()}>重新整理</button></div>
    {error && <p role="alert" className="feedback feedback--err">{error}</p>}
    {notice && <p role="status" className="feedback">{notice}</p>}
    <div className="dispatch-columns">
      <section data-order-pool="true" className={`dispatch-pool${poolHover ? " is-return-target" : ""}`} aria-label="待分配訂單池" onDragOver={e=>{if(returnDrag.current && !busy){e.preventDefault();setPoolHover(true);}}} onDragLeave={()=>setPoolHover(false)} onDrop={e=>{e.preventDefault();if(returnDrag.current && !busy)setReturnTask(returnDrag.current);returnDrag.current=null;setPoolHover(false);}}>
        <header className="dispatch-section-head"><div><span className="design-eyebrow">ORDERS POOL</span><h3>待分配訂單池 <span>{visible.length}</span></h3></div><span>已選 {selected.length} 筆</span></header>
        <div className="dispatch-filters"><input aria-label="搜尋訂單池" type="search" placeholder="搜尋單號、客戶或地址" value={query} onChange={e => { setQuery(e.target.value); setSelected([]); }}/><select aria-label="訂單日期範圍" value={filter} onChange={e => { setFilter(e.target.value); setSelected([]); }}><option value="all">全部待派</option><option value="today">當日訂單</option><option value="future">未來預約</option><option value="overdue">逾期待處理</option></select></div>
        <label className="dispatch-select-all"><input type="checkbox" aria-label="全選顯示訂單" disabled={loading || busy} checked={visible.length > 0 && visible.every(o => selected.includes(String(o.id)))} onChange={e => setSelected(e.target.checked ? visible.map(o => String(o.id)) : [])}/>全選目前顯示訂單 <span>拖曳已勾選訂單可整批移動</span></label>
        {orders.length === 500 && <p className="dispatch-hint">目前載入前 500 筆待派訂單；完成指派後重新整理以載入後續訂單。</p>}
        <div className="dispatch-pool-list" aria-busy={loading}>
          {loading ? <p className="dispatch-empty">載入訂單與司機任務中…</p> : !visible.length ? <p className="dispatch-empty">目前沒有符合條件的待派訂單</p> : visible.map(o => {
            const id = String(o.id);
            const day = orderDay(o);
            return <article key={id} className={`dispatch-order${selected.includes(id) ? ' is-selected' : ''}`} draggable={!busy} title="拖曳至司機卡片指派" onDragStart={e => { if ((e.target as HTMLElement).closest('button, input, a')) {
                e.preventDefault();
                return;
            } const ids = selected.includes(id) ? selected : [id]; dragIds.current = ids; e.dataTransfer.setData('application/x-watererp-orders', JSON.stringify(ids)); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => { dragIds.current = []; setHover(''); }}>
            <div className="dispatch-order__main">
            <div className="dispatch-order-top"><label><input type="checkbox" aria-label={`選取 ${o.orderNo}`} disabled={busy} checked={selected.includes(id)} onChange={e => setSelected(s => e.target.checked ? [...s, id] : s.filter(x => x !== id))}/><span className="dispatch-order-title"><h4>{o.customer?.name || '未提供客戶'} <small>{o.customer?.customerCode}</small></h4><p className="dispatch-address">{o.deliveryAddress?.addressLine || '未提供地址'}</p></span></label></div>
            <p className="dispatch-goods">{goods(o)}</p>
            <dl className="dispatch-order-facts">
              <div><dt>單號</dt><dd title={o.orderNo}>{o.orderNo}</dd></div>
              <div><dt>日期</dt><dd>{day || '未指定'}</dd></div>
              <div><dt>時段</dt><dd>{windowLabel(o) === '時段未指定' ? '未指定' : windowLabel(o)}</dd></div>
              <div><dt>桶數</dt><dd>{barrels(o)} 桶</dd></div>
            </dl>
            {o.remark && <p className="dispatch-hint">備註：{o.remark}</p>}
            </div>
            <footer>
              <span className={day && day < date ? 'dispatch-tag is-warning' : 'dispatch-tag'}>{day && day < date ? '逾期' : day > date ? '預約' : orderStatusLabel(o.status)}</span>
              <button type="button" className="btn btn--ghost btn--sm" draggable={false} onClick={() => setDetail(o)}>詳情</button>
            </footer>
          </article>;
        })}
        </div>
      </section>
      <section className="dispatch-fleet" aria-label="司機動態與車隊狀態">
        <header className="dispatch-section-head"><div><span className="design-eyebrow">DRIVERS & FLEET</span><h3>司機與當日任務 <span>{enabled.length}</span></h3></div><span>{date}</span></header>
        <p className="dispatch-hint">勾選要顯示的司機，可同時選多位。即時上線狀態未提供。額度以當日已派單量與桶數估算，並非車輛即時剩餘載重。</p>
        <div className="dispatch-driver-picker">
          <div className="dispatch-driver-picker__head">
            <span>選擇司機（已選 {selectedDriverIds.length} / {enabled.length}）</span>
            <span className="dispatch-driver-picker__actions">
              <button type="button" className="btn btn--ghost btn--sm" disabled={busy || !!pending || !enabled.length} onClick={() => setSelectedDriverIds(enabled.map(d => String(d.id)))}>全選</button>
              <button type="button" className="btn btn--ghost btn--sm" disabled={busy || !!pending || !selectedDriverIds.length} onClick={() => setSelectedDriverIds([])}>清除</button>
            </span>
          </div>
          <div className="dispatch-driver-picker__list" role="group" aria-label="選擇司機">
            {enabled.map(d => {
              const id = String(d.id);
              const checked = selectedDriverIds.includes(id);
              return <label key={id} className={checked ? "is-on" : undefined}>
                <input type="checkbox" aria-label={`顯示司機 ${d.user?.name || driverEmployeeCode(d)}`} disabled={busy || !!pending} checked={checked} onChange={() => setSelectedDriverIds(s => checked ? s.filter(x => x !== id) : [...s, id])}/>
                <span>{d.user?.name || "未命名司機"}</span>
                <small>{driverEmployeeCode(d)}</small>
              </label>;
            })}
          </div>
        </div>
        <div className="dispatch-driver-grid">{!enabled.length ? <p className="dispatch-empty">目前沒有啟用中的司機</p> : !selectedDriverIds.length ? <p className="dispatch-empty">請勾選要顯示的司機</p> : enabled.filter(d => selectedDriverIds.includes(String(d.id))).map(d => {
            const id = String(d.id), state = fleet[id], tasks = state?.tasks ?? [], qty = tasks.reduce((n, t) => n + barrels(t.salesOrder), 0), max = d.maxBarrelQty ?? 0;
            const vId = vehicleIds[id] ?? String(d.vehicle?.id ?? ''), vehicle = vehicles.find(v => String(v.id) === vId);
            const remaining = typeof d.maxOrderCount === 'number' ? Math.max(0, d.maxOrderCount - tasks.length) : null;
            return <article key={id} data-driver-id={id} className={`dispatch-driver${hover === id ? ' is-drop-target' : ''}`} onDragOver={e => { if (dragIds.current.length && !loading && !busy && state && !state.error) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setHover(id);
            } }} onDragLeave={() => setHover('')} onDrop={e => { e.preventDefault(); setHover(''); prepare(id, dragIds.current); dragIds.current = []; }} aria-label={`司機 ${d.user?.name || driverEmployeeCode(d)}`}>
            <header><div className="dispatch-avatar">{d.user?.name?.slice(0, 1) || '駕'}</div><div><h4>{d.user?.name || '未命名司機'}</h4><small>{driverEmployeeCode(d)}</small></div><span className="dispatch-tag">{state?.error ? '資料異常' : tasks.some(t => t.status === 'delivering') ? '配送中' : '啟用中'}</span></header>
            <label className="dispatch-vehicle">指派車輛<select aria-label={`${d.user?.name}指派車輛`} value={vId} disabled={busy} onChange={e => setVehicleIds(s => ({ ...s, [id]: e.target.value }))}><option value="">不指定車輛</option>{vehicles.map(v => <option key={String(v.id)} value={String(v.id)}>{v.plateNo}</option>)}</select></label><p className="dispatch-hint">{vehicle?.description || '車型未設定'}</p>
            {state?.error ? <p role="alert">{state.error}</p> : !state ? <p>載入排程中…</p> : <><div className="dispatch-capacity"><div><strong>{tasks.length}</strong><span>當日任務{remaining !== null ? ` · 剩餘 ${remaining} 單` : ''}</span></div><div><strong>{max > 0 ? Math.max(0, max - qty) : '—'}</strong><span>剩餘桶數額度{max > 0 ? ` / ${max}` : ' · 未設定上限'}</span></div></div>{max > 0 && <progress max={max} value={Math.min(qty, max)} aria-label={`${d.user?.name}已分配桶數 ${qty} / ${max}`}/>}{max > 0 && qty > max && <p className="dispatch-hint">已超出桶數額度 {qty - max} 桶</p>}
            <h5>任務時間軸 <small>依期望時段排序，非預估到達時間</small></h5><ol className="dispatch-timeline">{[...tasks].sort((a, b) => (time(a.salesOrder.deliveryWindowStart) || '99:99').localeCompare(time(b.salesOrder.deliveryWindowStart) || '99:99')).map(t => <li key={t.id} draggable={t.status === "assigned" && !busy} onDragStart={e=>{returnDrag.current=t;e.dataTransfer.setData("application/x-watererp-assignment",t.id);e.dataTransfer.effectAllowed="move";}} onDragEnd={()=>{returnDrag.current=null;setPoolHover(false);}}><time>{t.estimatedDeliverySlot || windowLabel(t.salesOrder)}</time><button onClick={() => setDetail(t.salesOrder)}>{t.salesOrder.customer?.name || t.salesOrder.orderNo}</button><small>{t.salesOrder.orderNo} · {deliveryAssignmentStatusLabel(t.status)}</small><small>{t.salesOrder.deliveryAddress?.addressLine}</small>{t.status === "assigned" ? <div className="dispatch-return-actions"><button type="button" disabled={busy} onClick={()=>setReturnTask(t)}>拉回訂單池</button><button type="button" className="dispatch-return-handle" aria-label={`拖回訂單池 ${t.salesOrder.orderNo}`} disabled={busy} onPointerDown={e=>{e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);returnDrag.current=t;}} onPointerMove={e=>{if(e.currentTarget.hasPointerCapture(e.pointerId))setPoolHover(!!document.elementFromPoint(e.clientX,e.clientY)?.closest("[data-order-pool]"));}} onPointerUp={e=>{if(!e.currentTarget.hasPointerCapture(e.pointerId))return;e.currentTarget.releasePointerCapture(e.pointerId);if(document.elementFromPoint(e.clientX,e.clientY)?.closest("[data-order-pool]"))setReturnTask(t);returnDrag.current=null;setPoolHover(false);}} onPointerCancel={()=>{returnDrag.current=null;setPoolHover(false);}}>⠿ 拖回</button></div> : <small>已開始處理，不可拉回</small>}</li>)}</ol>{!tasks.length && <p className="dispatch-empty">當日尚無配送任務</p>}</>}
            <button className="btn btn--primary dispatch-assign" disabled={loading || busy || !state || !!state.error || !selected.length} onClick={() => prepare(id, selected)}>將所選 {selected.length} 筆指派給此司機</button><p className="dispatch-drop-note">或將左側訂單拖放至此</p>
          </article>;
        })}</div>
      </section>
    </div>
    {pending && <div className="modal-backdrop"><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="dispatch-confirm-title" style={{ maxWidth: 540 }}><h3 id="dispatch-confirm-title">確認指派 {pending.ids.length} 筆訂單</h3><p>司機：{target?.user?.name} · {pending.date}</p><p>車輛：{vehicles.find(v => String(v.id) === pending.vehicleId)?.plateNo || '不指定'}</p><ul>{pending.ids.map(id => <li key={id}>{orders.find(o => String(o.id) === id)?.orderNo}</li>)}</ul>{overCapacity && <p role="alert" className="feedback feedback--err">本次指派將超出司機設定的每日單量或桶數上限，請核對承載能力或改派其他司機。</p>}<p>請核對司機可用時間與載運條件；無法指派的訂單會保留在訂單池並顯示原因。</p><div className="dispatch-confirm-actions"><button className="btn btn--secondary" disabled={busy} onClick={() => setPending(null)}>取消</button><button className="btn btn--primary" disabled={busy} onClick={() => void assign()}>{busy ? '指派中…' : '確認指派'}</button></div></section></div>}
    {returnTask && <div className="modal-backdrop"><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="return-pool-title" style={{maxWidth:520}}><h3 id="return-pool-title">拉回待分配訂單池</h3><p>確認取消 {returnTask.salesOrder.orderNo} 的目前司機指派？</p><p>訂單會恢復為待分配，司機任務與當日額度會更新。保留原指派紀錄，不刪除訂單或帳務。</p><div className="dispatch-confirm-actions"><button className="btn btn--secondary" disabled={busy} onClick={()=>setReturnTask(null)}>取消</button><button className="btn btn--primary" disabled={busy} onClick={()=>void returnToPool()}>{busy?"處理中…":"確認拉回"}</button></div></section></div>}
    {detail && <OrderDetailModal order={detail} onClose={() => setDetail(null)}/>}
  </div>;
}
