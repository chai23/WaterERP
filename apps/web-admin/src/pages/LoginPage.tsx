import { useState } from "react";
import type { FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { useTheme, type AdminTheme } from "../ThemeContext";

export default function LoginPage() {
  const { user, login, bootstrapAdmin } = useAuth();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"login" | "bootstrap">("login");
  const [employeeCode, setEmployeeCode] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  if (user) return <Navigate to="/overview" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMessage("");
    setSaving(true);
    try {
      if (mode === "login") {
        await login(employeeCode.trim().toUpperCase(), password);
      } else {
        await bootstrapAdmin({
          name: name.trim(),
          employeeCode: employeeCode.trim().toUpperCase(),
          phone: phone.trim(),
          password,
        });
      }
      navigate("/overview", { replace: true });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "操作失敗");
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="login-shell">
      <div className="login-theme">
        <div className="theme-switch" role="group" aria-label="配色版本">
          {(["light", "dark"] as AdminTheme[]).map((option) => (
            <button
              key={option}
              type="button"
              className={`theme-switch__option${theme === option ? " theme-switch__option--active" : ""}`}
              onClick={() => setTheme(option)}
              aria-pressed={theme === option}
            >
              {option === "light" ? "淺色" : "暗色"}
            </button>
          ))}
        </div>
      </div>
      <section className="login-panel">
        <div className="login-brand">
          <h1>WaterERP</h1>
          <p>{mode === "login" ? "營運後台登入" : "建立第一位管理員"}</p>
        </div>

        <form className="login-form" onSubmit={submit}>
          {mode === "bootstrap" ? (
            <label className="field">
              <span>姓名</span>
              <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
            </label>
          ) : null}
          <label className="field">
            <span>帳號 / 員編</span>
            <input
              value={employeeCode}
              onChange={(e) => setEmployeeCode(e.target.value.toUpperCase())}
              autoComplete="username"
              required
            />
          </label>
          {mode === "bootstrap" ? (
            <label className="field">
              <span>聯絡手機</span>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" />
            </label>
          ) : null}
          <label className="field">
            <span>密碼</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={6} />
          </label>

          {message ? <div className="alert alert--error">{message}</div> : null}

          <button type="submit" className="btn btn--primary login-submit" disabled={saving}>
            {saving ? "處理中…" : mode === "login" ? "登入後台" : "建立管理員並登入"}
          </button>
        </form>

        <button type="button" className="login-link" onClick={() => setMode((m) => (m === "login" ? "bootstrap" : "login"))}>
          {mode === "login" ? "第一次使用？建立管理員帳號" : "已有帳號，返回登入"}
        </button>
      </section>
    </main>
  );
}
