import { Link } from "react-router-dom";
import { useAuth } from "../AuthContext";

const modules = [
  { key: "overview", label: "總覽", admin: true, dispatcher: true, warehouse: true, driver: false },
  { key: "orders", label: "訂單新增/查詢/修改", admin: true, dispatcher: true, warehouse: false, driver: false },
  { key: "assign", label: "派車與核銷", admin: true, dispatcher: true, warehouse: false, driver: false },
  { key: "masters", label: "客戶/商品/車輛主檔", admin: true, dispatcher: true, warehouse: true, driver: false },
  { key: "accounting", label: "AR 沖帳與會計報表", admin: true, dispatcher: true, warehouse: false, driver: false },
  { key: "users", label: "使用者與密碼重設", admin: true, dispatcher: false, warehouse: false, driver: false },
  { key: "settings", label: "系統設定", admin: true, dispatcher: false, warehouse: false, driver: false },
  { key: "driverApp", label: "司機端任務回報", admin: false, dispatcher: false, warehouse: false, driver: true },
];

const roles = [
  { key: "admin", label: "管理員", note: "完整後台權限，可維護帳號與重設密碼。" },
  { key: "dispatcher", label: "調度/後台", note: "日常訂單、派車、核銷、報表作業。" },
  { key: "warehouse", label: "倉管", note: "主檔與庫存相關作業，避免接觸帳號與收款設定。" },
  { key: "driver", label: "司機", note: "只能登入司機端，只能回報自己的派單。" },
] as const;

function Mark({ enabled }: { enabled: boolean }) {
  return <span className={enabled ? "perm-mark perm-mark--on" : "perm-mark perm-mark--off"}>{enabled ? "允許" : "限制"}</span>;
}

export default function SettingsPermissionsPage() {
  const { user } = useAuth();

  return (
    <section className="settings-stack">
      <div className="page-card">
        <div className="page-card__header">
          <div>
            <h2>權限設定</h2>
            <p>目前採角色權限控管；帳號角色由「使用者資料」維護。</p>
          </div>
          <Link className="btn btn--primary" to="/data/users">
            管理使用者
          </Link>
        </div>

        <div className="permission-summary">
          {roles.map((role) => (
            <article key={role.key} className={`permission-role permission-role--${role.key}`}>
              <div className="permission-role__title">{role.label}</div>
              <p>{role.note}</p>
            </article>
          ))}
        </div>
      </div>

      <div className="page-card">
        <div className="page-card__header">
          <div>
            <h2>角色權限矩陣</h2>
            <p>這張表反映目前後端與前端登入流程的權限規則。</p>
          </div>
          <span className="pill pill--subtle">目前角色：{user?.role ?? "—"}</span>
        </div>

        <div className="table-wrap">
          <table className="data-table permission-table">
            <thead>
              <tr>
                <th>功能</th>
                {roles.map((role) => (
                  <th key={role.key}>{role.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {modules.map((mod) => (
                <tr key={mod.key}>
                  <td>{mod.label}</td>
                  {roles.map((role) => (
                    <td key={role.key}>
                      <Mark enabled={Boolean(mod[role.key])} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="page-card page-card--narrow">
        <div className="page-card__header">
          <div>
            <h2>帳號維護規則</h2>
            <p>建議日常操作時遵守下列分工。</p>
          </div>
        </div>
        <ul className="settings-list">
          <li>管理員帳號只保留給少數人，用於新增使用者、停用帳號、重設密碼。</li>
          <li>一般後台人員使用「調度/後台」角色，不共用 admin 帳號。</li>
          <li>司機帳號由「司機資料」建立，登入司機端後只能看到自己的任務。</li>
          <li>離職或停用人員請到「使用者資料」停用帳號，不要刪除歷史帳務關聯。</li>
        </ul>
      </div>
    </section>
  );
}
