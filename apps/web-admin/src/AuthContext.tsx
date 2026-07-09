import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";

export type AuthUser = {
  id: string;
  employeeCode: string;
  phone: string | null;
  name: string;
  role: string;
  isActive: boolean;
  driverId: string | null;
};

type AuthContextValue = {
  token: string;
  user: AuthUser | null;
  loading: boolean;
  login: (employeeCode: string, password: string) => Promise<void>;
  bootstrapAdmin: (args: { name: string; employeeCode: string; phone: string; password: string }) => Promise<void>;
  logout: () => void;
  refreshMe: () => Promise<void>;
};

const TOKEN_KEY = "watererp.admin.token";
const USER_KEY = "watererp.admin.user";

const AuthContext = createContext<AuthContextValue | null>(null);

function readStoredUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

function storeSession(token: string, user: AuthUser) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function getAdminToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

async function readApiError(res: Response): Promise<string> {
  try {
    const payload = (await res.json()) as { message?: string };
    return payload.message ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState(() => getAdminToken());
  const [user, setUser] = useState<AuthUser | null>(() => readStoredUser());
  const [loading, setLoading] = useState(Boolean(token));

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setToken("");
    setUser(null);
  }, []);

  useLayoutEffect(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = rawUrl.startsWith(window.location.origin) ? rawUrl.slice(window.location.origin.length) : rawUrl;
      const isApi = url.startsWith("/api/");
      const isAuthCall = url.startsWith("/api/auth/login") || url.startsWith("/api/auth/bootstrap");
      const currentToken = getAdminToken();
      const nextInit: RequestInit = { ...(init ?? {}) };
      if (isApi && !isAuthCall && currentToken) {
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${currentToken}`);
        nextInit.headers = headers;
      }
      const res = await originalFetch(input, nextInit);
      if (isApi && !isAuthCall && res.status === 401) {
        logout();
        if (window.location.pathname !== "/login") window.location.assign("/login");
      }
      return res;
    };
    return () => {
      window.fetch = originalFetch;
    };
  }, [logout]);

  const refreshMe = useCallback(async () => {
    const currentToken = getAdminToken();
    if (!currentToken) {
      setLoading(false);
      return;
    }
    try {
      const res = await fetch("/api/auth/me");
      if (!res.ok) throw new Error(await readApiError(res));
      const payload = (await res.json()) as { ok?: boolean; user?: AuthUser };
      if (!payload.ok || !payload.user) throw new Error("登入狀態無效");
      storeSession(currentToken, payload.user);
      setToken(currentToken);
      setUser(payload.user);
    } catch {
      logout();
    } finally {
      setLoading(false);
    }
  }, [logout]);

  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);

  const login = useCallback(async (employeeCode: string, password: string) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employeeCode, password }),
    });
    if (!res.ok) throw new Error(await readApiError(res));
    const payload = (await res.json()) as { ok?: boolean; token?: string; user?: AuthUser; message?: string };
    if (!payload.ok || !payload.token || !payload.user) throw new Error(payload.message ?? "登入失敗");
    if (payload.user.role === "driver") throw new Error("司機帳號請使用司機端登入");
    storeSession(payload.token, payload.user);
    setToken(payload.token);
    setUser(payload.user);
  }, []);

  const bootstrapAdmin = useCallback(async (args: { name: string; employeeCode: string; phone: string; password: string }) => {
    const res = await fetch("/api/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(await readApiError(res));
    const payload = (await res.json()) as { ok?: boolean; token?: string; user?: AuthUser; message?: string };
    if (!payload.ok || !payload.token || !payload.user) throw new Error(payload.message ?? "建立管理員失敗");
    storeSession(payload.token, payload.user);
    setToken(payload.token);
    setUser(payload.user);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ token, user, loading, login, bootstrapAdmin, logout, refreshMe }),
    [token, user, loading, login, bootstrapAdmin, logout, refreshMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
