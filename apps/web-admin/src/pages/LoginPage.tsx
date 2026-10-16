import { useState } from "react";
import type { FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { useTheme, type AdminTheme } from "../ThemeContext";
import { InterfaceIcon, WaterMark, WaterRipple } from "../components/WaterIdentity";

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
  const [showPassword, setShowPassword] = useState(false);

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
    <main className="login-shell login-shell--refined">
      <section className="login-story" aria-label="超好企業營運管理">
        <div className="login-story__brand"><WaterMark /><span>超好企業<small>WATER ERP / 營運管理</small></span></div>
        <div className="login-story__art"><WaterRipple /><span className="login-story__art-label">EVERY DROP, CONNECTED.</span></div>
        <div className="login-story__copy"><span className="design-eyebrow">讓日常，順流而行</span><h2>每一滴用心，<br />都有好去向。</h2><p>從一張訂單，到每一次安心送達。<br />串起團隊的日常，讓服務持續流動。</p></div>
        <div className="login-story__foot"><span>訂單 · 配送 · 帳務</span><span>一處掌握，從容營運</span></div>
      </section>
      <div className="login-workspace">
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
          <span className="design-eyebrow">{mode === "login" ? "WELCOME BACK" : "GET STARTED"}</span>
          <h1>{mode === "login" ? "美好的一天，從這裡開始。" : "一起，開始更好的日常。"}</h1>
          <p>{mode === "login" ? "登入營運後台，接續今天的每一份託付。" : "建立第一位管理員，啟用營運後台。"}</p>
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
              placeholder="請輸入員工編號"
              spellCheck={false}
              autoCapitalize="characters"
              required
            />
          </label>
          {mode === "bootstrap" ? (
            <label className="field">
              <span>聯絡手機</span>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" />
            </label>
          ) : null}
          <div className="field">
            <label htmlFor="login-password">密碼</label>
            <div className="login-password">
              <input id="login-password" type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder="請輸入密碼" required />
              <button type="button" aria-label={showPassword ? "隱藏密碼" : "顯示密碼"} aria-pressed={showPassword} onClick={() => setShowPassword((value) => !value)}>{showPassword ? "隱藏" : "顯示"}</button>
            </div>
          </div>

          {message ? <div className="alert alert--error" role="alert">{message}</div> : null}

          <button type="submit" className="btn btn--primary login-submit" disabled={saving}>
            {saving ? "處理中…" : mode === "login" ? "登入後台" : "建立管理員並登入"}
            {!saving && <InterfaceIcon name="arrow" />}
          </button>
        </form>

        <button type="button" className="login-link" disabled={saving} onClick={() => { setMode((m) => (m === "login" ? "bootstrap" : "login")); setMessage(""); setShowPassword(false); }}>
          {mode === "login" ? "第一次使用？建立管理員帳號" : "已有帳號，返回登入"}
        </button>
      </section>
      <footer className="login-workspace__foot"><WaterMark />超好企業進銷存系統<span>用心服務，日日如常。</span></footer>
      </div>
    </main>
  );
}
