import { useEffect, useMemo, useState } from "react";
import type { Address } from "../adminUtils";
import { geocodeStatusMeta } from "../adminUtils";

type GeoPatch = Pick<
  Address,
  | "latitude"
  | "longitude"
  | "geocodeStatus"
  | "geocodedAddress"
  | "geocodedAt"
  | "locationAccuracy"
  | "manualLocationConfirmed"
>;

type Candidate = { latitude: number; longitude: number; label: string };

type Props = {
  address: Address;
  onUpdated: (patch: GeoPatch) => void;
  /** 概覽區可收合；編輯區預設展開未確認地址 */
  defaultOpen?: boolean;
};

function toCoord(v: unknown): string {
  if (v == null || v === "") return "";
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : "";
}

function mapEmbedSrc(lat: number, lng: number): string {
  const dLng = 0.004;
  const dLat = 0.003;
  return `https://www.openstreetmap.org/export/embed.html?bbox=${lng - dLng}%2C${lat - dLat}%2C${lng + dLng}%2C${lat + dLat}&layer=mapnik&marker=${lat}%2C${lng}`;
}

function googleMapsHref(addressLine: string, lat: string, lng: string): string {
  const la = Number(lat);
  const ln = Number(lng);
  if (Number.isFinite(la) && Number.isFinite(ln)) {
    return `https://www.google.com/maps?q=${la},${ln}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addressLine)}`;
}

export default function AddressGeocodePanel({ address, onUpdated, defaultOpen }: Props) {
  const status = geocodeStatusMeta(address.geocodeStatus);
  const confirmed = address.geocodeStatus === "ok" || address.geocodeStatus === "manual_confirmed";
  const [open, setOpen] = useState(defaultOpen ?? !confirmed);
  const [lat, setLat] = useState(() => toCoord(address.latitude));
  const [lng, setLng] = useState(() => toCoord(address.longitude));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);

  useEffect(() => {
    setLat(toCoord(address.latitude));
    setLng(toCoord(address.longitude));
  }, [address.id, address.latitude, address.longitude]);

  const preview = useMemo(() => {
    const la = Number(lat);
    const ln = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
    return { lat: la, lng: ln };
  }, [lat, lng]);

  const applyPatch = (patch: GeoPatch) => {
    if (patch.latitude != null) setLat(toCoord(patch.latitude));
    if (patch.longitude != null) setLng(toCoord(patch.longitude));
    onUpdated(patch);
  };

  const lookup = async () => {
    setBusy(true);
    setMessage("");
    setCandidates([]);
    try {
      const r = await fetch(`/api/delivery-addresses/${address.id}/geocode`, { method: "POST" });
      const payload = await r.json();
      if (!r.ok || !payload.ok) {
        setMessage(payload.message ?? "查詢失敗");
        return;
      }
      const result = payload.data?.result as {
        status?: string;
        message?: string;
        latitude?: number;
        longitude?: number;
        geocodedAddress?: string;
        candidates?: Candidate[];
      };
      const saved = payload.data?.address as GeoPatch | null | undefined;
      if (result?.status === "ok" && saved) {
        applyPatch(saved);
        setMessage(result.geocodedAddress ? `已定位：${result.geocodedAddress}` : "已自動定位，請核對地圖後可再確認");
        setOpen(true);
        return;
      }
      if (result?.status === "ambiguous" && Array.isArray(result.candidates) && result.candidates.length > 0) {
        setCandidates(result.candidates);
        const first = result.candidates[0]!;
        setLat(String(first.latitude));
        setLng(String(first.longitude));
        if (saved) onUpdated(saved);
        setMessage(result.message ?? "有多個候選，請選一筆後按確認座標");
        setOpen(true);
        return;
      }
      if (saved) onUpdated(saved);
      setOpen(true);
      setMessage(result?.message ?? "無法自動定位，請在 Google 地圖核對後手動填入座標");
    } catch {
      setMessage("無法連線 API");
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (nextLat = lat, nextLng = lng, label?: string) => {
    const latitude = Number(nextLat);
    const longitude = Number(nextLng);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      setMessage("請填入有效的緯度／經度");
      return;
    }
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      setMessage("緯度須為 -90～90、經度須為 -180～180");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const r = await fetch(`/api/delivery-addresses/${address.id}/location`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          latitude,
          longitude,
          geocodedAddress: label ?? address.geocodedAddress ?? address.addressLine,
        }),
      });
      const payload = await r.json();
      if (!r.ok || !payload.ok) {
        setMessage(payload.message ?? "確認失敗");
        return;
      }
      const saved = payload.data as GeoPatch;
      applyPatch(saved);
      setCandidates([]);
      setMessage("已確認地圖座標");
    } catch {
      setMessage("無法連線 API");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="address-geocode">
      <div className="address-geocode__row">
        <span className={status.className}>{status.text}</span>
        {preview ? (
          <span className="muted small mono-text">
            {Number(preview.lat).toFixed(6)}, {Number(preview.lng).toFixed(6)}
          </span>
        ) : null}
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen((v) => !v)}>
          {open ? "收起地圖" : "確認地圖座標"}
        </button>
      </div>

      {open ? (
        <div className="address-geocode__panel">
          <p className="muted small" style={{ margin: "0.35rem 0 0.5rem" }}>
            先「依地址查詢」，再對照地圖；不準可改緯經度後按確認。一鍵排程僅接受「已自動定位」或「已確認座標」。
          </p>
          <div className="address-geocode__actions">
            <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void lookup()}>
              {busy ? "處理中…" : "依地址查詢"}
            </button>
            <a
              className="btn btn--sm btn--ghost"
              href={googleMapsHref(address.addressLine, lat, lng)}
              target="_blank"
              rel="noreferrer"
            >
              在 Google 地圖開啟
            </a>
            <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => void confirm()}>
              確認座標
            </button>
          </div>
          <div className="address-geocode__coords">
            <label className="field">
              <span>緯度</span>
              <input
                type="text"
                inputMode="decimal"
                value={lat}
                onChange={(e) => setLat(e.target.value)}
                placeholder="25.033964"
              />
            </label>
            <label className="field">
              <span>經度</span>
              <input
                type="text"
                inputMode="decimal"
                value={lng}
                onChange={(e) => setLng(e.target.value)}
                placeholder="121.564468"
              />
            </label>
          </div>
          {candidates.length > 0 ? (
            <ul className="address-geocode__candidates">
              {candidates.map((c, i) => (
                <li key={`${c.latitude}-${c.longitude}-${i}`}>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={busy}
                    onClick={() => {
                      setLat(String(c.latitude));
                      setLng(String(c.longitude));
                      void confirm(String(c.latitude), String(c.longitude), c.label);
                    }}
                  >
                    選用此點
                  </button>
                  <span>{c.label}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {preview ? (
            <iframe
              className="address-geocode__map"
              title="地圖預覽"
              src={mapEmbedSrc(preview.lat, preview.lng)}
            />
          ) : (
            <p className="card__hint">尚無座標可預覽地圖</p>
          )}
          {address.geocodedAddress ? (
            <p className="muted small">正規化地址：{address.geocodedAddress}</p>
          ) : null}
          {message ? (
            <p className={message.includes("失敗") || message.includes("無法") ? "feedback feedback--err" : "feedback feedback--ok"}>
              {message}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
