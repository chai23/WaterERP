import { MoneyInput } from "../../../shared-ui/MoneyInput";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { moneyText } from "../adminUtils";

type Order = {
  id: string; day: string; billing: string; completed: boolean; received: number; outstanding: number;
  monthlyKind?: "statement" | "mixed"; disposition: string; finalAmount: number; dueDate: string; invoiceMode: string; note: string;
};
type Allocation = { products: {code:string; barrels:number}[]; unassignedReason:string; allowOverdraft:boolean };
type Options = {products: {productCode:string; name:string}[]; candidates:string[]};
const emptyAllocation: Allocation = {products:[],unassignedReason:"",allowOverdraft:false};
const orderLabels: Record<string,string> = {cash:"一般未收款",monthly_pending:"月結尚未出帳",monthly_billed:"月結已出帳未收",exclude:"排除／另行處理"};

function OrderEvidence({id,date}: {id:string; date:string}) {
  const [evidence,setEvidence] = useState<{lines:{productName:string; billingLabel:string; collected:boolean; subtotal:number}[]; remittances:{id:number; remittanceDay:string|null; money:number}[]}>();
  const [error,setError] = useState("");
  const load = async () => {
    if (evidence) return;
    try {
      const response = await fetch("/api/legacy-history/orders/" + encodeURIComponent(id),{cache:"no-store"});
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message ?? "舊單讀取失敗");
      setEvidence(result.data);setError("");
    } catch(e) {setError(e instanceof Error ? e.message : "舊單讀取失敗");}
  };
  return <details onToggle={e=>{if(e.currentTarget.open)void load();}}>
    <summary>查看舊單明細與收款流水</summary>
    {error && <p role="alert">{error}</p>}
    {!evidence && !error && <p>讀取中…</p>}
    {evidence && <>
      <div className="method-report-table-wrap"><table className="method-report-table">
        <thead><tr><th>品項</th><th>結帳方式</th><th>已收</th><th>小計</th></tr></thead>
        <tbody>{evidence.lines.map((line,index)=><tr key={index}><td>{line.productName || "—"}</td><td>{line.billingLabel || "空白"}</td><td>{line.collected ? "是" : "否"}</td><td>{moneyText(line.subtotal)}</td></tr>)}</tbody>
      </table></div>
      <h4>收款流水</h4>
      {evidence.remittances.length ? <ul>{evidence.remittances.map(r=><li key={r.id}>{r.remittanceDay ?? "無日期"} · {moneyText(r.money)}{r.remittanceDay && r.remittanceDay > date ? "（截止日後）" : ""}</li>)}</ul> : <p>沒有收款流水。</p>}
    </>}
  </details>;
}

type Customer = {
  prepaidAllocation?: Allocation;
  sourceAddresses?: {legacyId:string; label:string; barrels:number}[];
  code: string; name: string; key: string; version: string; customerId: string | null; startDate: string;
  sourceOverShort: number; prepayment: number | null; sourcePrepaidBarrels: number; prepaidBarrels: number;
  legacyBarrels: number; addresses: {id:string; label:string; barrels:number}[]; orders: Order[];
  warnings: string[]; note: string; handedOver?: boolean;
};
type State = {revision:number; snapshot: {rows:Customer[]} | null};

async function request(path = "", method = "GET", body?: unknown): Promise<State> {
  const response = await fetch("/api/legacy-cutover/handover" + path, {
    method, cache:"no-store", headers: {"Content-Type":"application/json"}, body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.message ?? "人工交接操作失敗");
  return result.data;
}

async function loadOptions(code:string, date:string): Promise<Options> {
  const response = await fetch("/api/legacy-cutover/manual/options?" + new URLSearchParams({code,date}), {cache:"no-store"});
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.message ?? "商品選項讀取失敗");
  return result.data;
}

export default function ManualHandoverPage({code,date,reason,onCompleted}: {code:string; date:string; reason:string; onCompleted:(code:string)=>void}) {
  const [options,setOptions] = useState<Options>();
  const [row,setRow] = useState<Customer>();
  const [busy,setBusy] = useState(true);
  const [message,setMessage] = useState("");
  const [error,setError] = useState("");
  const [needsRefresh,setNeedsRefresh] = useState(false);
  const [dirty,setDirty] = useState(false);
  const [confirm,setConfirm] = useState(false);
  const [sourceRevision,setSourceRevision] = useState(0);

  const find = (state:State) => state.snapshot?.rows.find(item=>item.code===code);
  useEffect(()=>{
    let live=true;
    async function load() {
      try {
        const current = await request();
        const productOptions = await loadOptions(code,date);
        if (live) setOptions(productOptions);
        const existing = find(current);
        const loaded = existing ?? find(await request("/draft","POST",{startDate:date,customerCode:code,customerVersion:null}));
        if (!loaded) throw new Error("找不到客戶的交接資料");
        if (live) {
          setRow(loaded);
          setNeedsRefresh(!loaded.handedOver && loaded.startDate !== date);
        }
      } catch(e) {if(live)setError(e instanceof Error ? e.message : "載入失敗");}
      finally {if(live)setBusy(false);}
    }
    void load();
    return ()=>{live=false;};
  },[code,date]);

  const edit = (fields:Partial<Customer>) => {
    setRow(old=>old ? {...old,...fields} : old);
    setDirty(true);setMessage("");
  };
  const allocation = row?.prepaidAllocation ?? emptyAllocation;
  const allocationTotal = allocation.products.reduce((sum,p)=>sum+p.barrels,0);
  const allocationValid = !row || (allocation.products.length
    ? allocationTotal === row.prepaidBarrels && allocation.products.every(p=>p.code && Number.isInteger(p.barrels) && p.barrels !== 0 && Math.sign(p.barrels)===Math.sign(row.prepaidBarrels))
    : (!row.prepaidBarrels || allocation.unassignedReason.trim()) && !allocation.allowOverdraft);
  const perform = async (action:"refresh" | "save" | "finish") => {
    if (!row) return;
    setBusy(true);setError("");setMessage("");
    try {
      let state:State;
      if (action === "refresh") {
        const latestOptions = await loadOptions(code,date);
        state=await request("/draft","POST",{startDate:date,customerCode:code,customerVersion:row.version});
        setOptions(latestOptions);
        setSourceRevision(version=>version+1);
      } else {
        state=await request("/draft","PUT",{customerVersions:true,snapshot:{rows:[{...row,prepaidAllocation:allocation,included:true,reviewed:action==="finish"}]}});
        const saved=find(state);
        if (!saved) throw new Error("找不到已儲存的資料");
        setRow(saved);setDirty(false);
        if (action==="finish") {
          state=await request("/apply-customer","POST",{customerCode:code,customerVersion:saved.version,revision:state.revision});
          if (!find(state)?.handedOver) throw new Error("未確認入帳成功，請重新整理查看狀態");
          onCompleted(code);
        }
      }
      setRow(find(state));setNeedsRefresh(false);setDirty(false);setConfirm(false);
      setMessage(action==="finish" ? "已完成交接並入帳" : action==="refresh" ? "已更新這位客戶的交接預覽" : "處理進度已儲存");
    } catch(e) {setError(e instanceof Error ? e.message : "操作失敗");}
    finally {setBusy(false);}
  };

  const addProduct = (code: string) => {
    if (!code || allocation.products.some(product => product.code === code)) return;
    edit({prepaidAllocation:{...allocation,products:[...allocation.products,{code,barrels:0}]}});
  };
  const availableProducts = options?.products.filter(product => !allocation.products.some(p => p.code === product.productCode)) ?? [];
  const candidates = options?.products.filter(product => options.candidates.includes(product.productCode)) ?? [];

  const editOrder = (id:string, fields:Partial<Order>) => {
    if(row) edit({orders:row.orders.map(order=>order.id===id ? {...order,...fields} : order)});
  };

  return <section className="handover-page">
    <header className="handover-header">
      <div><h2>人工交接 · {code} {row?.name}</h2><p>承接截至 {date}（含當天）</p></div>
      <Link className="btn" to={{search:""}} onClick={e=>{if(dirty&&!window.confirm("處理進度尚未儲存，確定返回？"))e.preventDefault();}}>返回交接工作區</Link>
    </header>
    {reason && <p className="handover-note">{reason}</p>}
    {error && <p className="alert alert--error" role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {busy && !row && <p role="status">正在讀取客戶交接資料…</p>}
    {row?.handedOver && <p className="handover-note">此客戶已完成交接。</p>}
    {row && !row.handedOver && <>
      {needsRefresh && <p className="alert alert--error">儲存的草稿使用 {row.startDate}。請重新載入後再處理。</p>}
      <button className="btn" disabled={busy} onClick={()=>{if(window.confirm("重新讀取舊系統會覆蓋此客戶的處理草稿，確定繼續？"))void perform("refresh");}}>更新此戶預覽</button>
      {row.warnings.length>0 && <ul>{row.warnings.map(w=><li key={w}>{w}</li>)}</ul>}
      <fieldset className="card handover-panel" disabled={busy || needsRefresh}>
        <legend>核對客戶餘額</legend>
        <div className="handover-toolbar">
          <label className="handover-field">短溢收（來源 {moneyText(row.sourceOverShort ?? 0)}）<MoneyInput value={row.prepayment ?? ""} onChange={e=>edit({prepayment:e.target.value==="" ? null : Number(e.target.value)})}/></label>
          <label className="handover-field">預付桶總數（來源 {row.sourcePrepaidBarrels}）<input type="number" step="1" value={row.prepaidBarrels} onChange={e=>edit({prepaidBarrels:Number(e.target.value)})}/></label>
        </div>
        <div className="manual-allocation">
          <h3>商品別預付桶</h3>
          <dl className="manual-barrel-summary">
            <div><dt>需承接</dt><dd>{row.prepaidBarrels} <small>桶</small></dd></div>
            <div><dt>已分配</dt><dd>{allocationTotal} <small>桶</small></dd></div>
            <div data-pending={allocationTotal !== row.prepaidBarrels}><dt>分配差額</dt><dd>{row.prepaidBarrels-allocationTotal} <small>桶</small></dd></div>
          </dl>
          <div className="manual-candidates">
            <h4>從舊訂單辨識的商品</h4>
            {candidates.length ? <div className="manual-candidate-list">
              {candidates.map(product => {
                const selected = allocation.products.some(p=>p.code===product.productCode);
                return <button key={product.productCode} type="button" className="manual-candidate" disabled={selected} onClick={()=>addProduct(product.productCode)}>
                  <span><small>{product.productCode}</small><strong>{product.name}</strong></span>
                  <span>{selected ? "已加入" : "＋ 加入分配"}</span>
                </button>;
              })}
            </div> : <p>舊訂單沒有可辨識的預付商品。</p>}
            <label className="handover-field manual-other-product">加入其他商品
              <select value="" onChange={e=>addProduct(e.target.value)} disabled={!availableProducts.length}>
                <option value="">從商品主檔選擇</option>
                {availableProducts.map(product=><option key={product.productCode} value={product.productCode}>{product.productCode} · {product.name}</option>)}
              </select>
            </label>
          </div>
          {allocation.products.length > 0 && <h4>輸入各商品承接桶數</h4>}
          {allocation.products.map((p,index)=><div key={index} className="manual-allocation-row">
            <div className="manual-selected-product"><small>{p.code}</small><strong>{options?.products.find(product=>product.productCode===p.code)?.name ?? "商品主檔無法對應"}</strong></div>
            <label className="handover-field">承接桶數<input type="number" step="1" value={p.barrels} onChange={e=>edit({prepaidAllocation:{...allocation,products:allocation.products.map((x,i)=>i===index ? {...x,barrels:Number(e.target.value)} : x)}})}/></label>
            <button type="button" className="btn" onClick={()=>edit({prepaidAllocation:{...allocation,products:allocation.products.filter((_,i)=>i!==index)}})} aria-label={"移除商品 " + p.code}>移除</button>
          </div>)}

          {!allocation.products.length && row.prepaidBarrels!==0 && <label className="handover-field">不掛商品的原因<textarea maxLength={400} value={allocation.unassignedReason} onChange={e=>edit({prepaidAllocation:{...allocation,unassignedReason:e.target.value}})}/></label>}
          <label><input type="checkbox" checked={allocation.allowOverdraft} onChange={e=>edit({prepaidAllocation:{...allocation,allowOverdraft:e.target.checked}})}/> 預付桶不足時仍可核銷送達</label>
          {!allocationValid && <p className="handover-note">請分配與總數一致的商品桶數，或填寫不掛商品的原因。若允許透支，須指定商品。</p>}
        </div>
        <h3>配送地址空桶（來源合計 {row.legacyBarrels}）</h3>
        {Boolean(row.sourceAddresses?.length) && <details>
          <summary>查看舊地址與空桶來源</summary>
          <ul>{row.sourceAddresses?.map(a=><li key={a.legacyId}>{a.legacyId} · {a.label || "地址空白"} · {a.barrels} 桶</li>)}</ul>
        </details>}
        <p>新地址承接合計 {row.addresses.reduce((sum,a)=>sum+a.barrels,0)} 桶</p>
        {row.addresses.map(a=><label key={a.id} className="handover-field">{a.label}<input type="number" step="1" value={a.barrels} onChange={e=>edit({addresses:row.addresses.map(addr=>addr.id===a.id ? {...addr,barrels:Number(e.target.value)} : addr)})}/></label>)}
        <label className="handover-field">核對與調整原因<textarea maxLength={400} value={row.note} onChange={e=>edit({note:e.target.value})}/></label>
      </fieldset>
      <fieldset className="card handover-panel" disabled={busy || needsRefresh}>
        <legend>逐單處理（{row.orders.length} 筆）</legend>
        {row.orders.length===0 && <p>此客戶沒有待處理的舊單。</p>}
        {row.orders.map(o=><div key={o.id} className="card handover-panel">
          <strong>{o.id}</strong>
          <p>{o.day} · {o.billing || "結帳方式空白"} · {o.monthlyKind === "statement" ? "正式月結單" : o.monthlyKind === "mixed" ? "月結單夾有其他商品" : o.completed ? "已送達" : "未完成配送"} · 已收 {moneyText(o.received)} · 來源餘額 {moneyText(o.outstanding)}</p>
          <div className="handover-toolbar">
            <label className="handover-field">處理方式<select value={o.disposition} onChange={e=>editOrder(o.id,{disposition:e.target.value})}>
              {!o.monthlyKind && <><option value="cash">一般未收款</option><option value="monthly_pending">月結尚未出帳</option></>}{o.monthlyKind !== "mixed" && <option value="monthly_billed">月結已出帳未收</option>}<option value="exclude">排除／另行處理</option>
            </select></label>
            <label className="handover-field">承接金額<MoneyInput min="0" value={o.finalAmount} onChange={e=>editOrder(o.id,{finalAmount:Number(e.target.value)})}/></label>
            <label className="handover-field">到期日<input type="date" value={o.dueDate} onChange={e=>editOrder(o.id,{dueDate:e.target.value})}/></label>
            {o.disposition==="monthly_pending" && <label className="handover-field">發票方式<select value={o.invoiceMode} onChange={e=>editOrder(o.id,{invoiceMode:e.target.value})}><option value="none">免開</option><option value="tax_inclusive">含稅</option><option value="tax_exclusive">外加稅</option></select></label>}
          </div>
          <OrderEvidence key={sourceRevision} id={o.id} date={date}/>
          <label className="handover-field">處理原因<input maxLength={400} value={o.note} onChange={e=>editOrder(o.id,{note:e.target.value})}/></label>
        </div>)}
      </fieldset>
      <div className="handover-footer">
        <button className="btn" disabled={busy || needsRefresh || !dirty} onClick={()=>void perform("save")}>儲存處理進度</button>
        <button className="btn btn--primary" disabled={busy || needsRefresh || !row.customerId || !allocationValid} onClick={()=>setConfirm(true)}>核對並完成交接</button>
      </div>
      {confirm && <div className="card handover-panel" role="group" aria-label="確認人工入帳">
        <h3>本戶入帳確認</h3>
        <ul>
          <li>短溢收 {moneyText(row.prepayment ?? 0)}</li>
          <li>預付桶 {row.prepaidBarrels} · {allocation.products.map(p=>p.code+" "+p.barrels+" 桶").join("、") || "不掛商品"} · {allocation.allowOverdraft ? "允許透支" : "關閉透支"}</li>
          {row.addresses.map(a=><li key={a.id}>{a.label} · 空桶 {a.barrels}</li>)}
          {row.orders.map(o=><li key={o.id}>{o.id} · {orderLabels[o.disposition]}{o.disposition==="exclude" ? "" : " · "+moneyText(o.finalAmount)}</li>)}
        </ul>
        <button className="btn" disabled={busy} onClick={()=>setConfirm(false)}>返回核對</button>
        <button className="btn btn--primary" disabled={busy || !allocationValid || row.prepayment===null} onClick={()=>void perform("finish")}>確認入帳</button>
      </div>}
    </>}
  </section>;
}
