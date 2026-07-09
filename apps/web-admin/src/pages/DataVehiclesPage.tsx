import { useDashboard } from "../DashboardContext";

export default function DataVehiclesPage() {
  const { vehicles, vehicleSaving, vehicleMessage, vehicleForm, setVehicleForm, onSubmitNewVehicle } = useDashboard();

  return (
    <>
      <section className="card">
        <h2 className="card__title">新增車輛</h2>
        <form onSubmit={onSubmitNewVehicle} className="form-grid">
          <div className="field">
            <span>車牌</span>
            <input
              type="text"
              value={vehicleForm.plateNo}
              onChange={(e) => setVehicleForm({ ...vehicleForm, plateNo: e.target.value.toUpperCase() })}
              placeholder="例如 ABC-1234"
              required
            />
          </div>
          <div className="field">
            <span>備註（選填）</span>
            <input type="text" value={vehicleForm.description} onChange={(e) => setVehicleForm({ ...vehicleForm, description: e.target.value })} />
          </div>
          <div className="form-actions">
            <button type="submit" className="btn btn--primary" disabled={vehicleSaving}>
              {vehicleSaving ? "建立中..." : "建立車輛"}
            </button>
            {vehicleMessage ? (
              <span className={vehicleMessage.includes("成功") ? "feedback feedback--ok" : "feedback feedback--err"}>{vehicleMessage}</span>
            ) : null}
          </div>
        </form>
      </section>

      <section className="card">
        <h2 className="card__title">
          車輛列表 <span className="card__title-count">{vehicles.length} 筆</span>
        </h2>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>車牌</th>
                <th>備註</th>
              </tr>
            </thead>
            <tbody>
              {vehicles.map((v) => (
                <tr key={String(v.id)}>
                  <td className="num">{String(v.id)}</td>
                  <td>
                    <strong>{v.plateNo}</strong>
                  </td>
                  <td>{v.description ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
