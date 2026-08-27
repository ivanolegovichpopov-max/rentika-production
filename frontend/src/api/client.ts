/**
 * Тонкая обёртка над fetch. Access-токен хранится ТОЛЬКО в памяти (модульная
 * переменная), не в localStorage — при перезагрузке страницы он теряется, и
 * это осознанно: XSS-уязвимость где-нибудь на странице не сможет вытащить
 * долгоживущий токен из хранилища браузера. Взамен при старте приложения
 * (AuthContext) мы сразу вызываем /auth/refresh — он использует httpOnly
 * refresh-cookie (недоступную JS вообще) и восстанавливает сессию.
 */

// В docker-compose и локальной разработке frontend и backend на одном origin
// (Caddy / Vite proxy), поэтому относительного "/api" достаточно. Когда они
// развёрнуты как отдельные сервисы на разных доменах (например два разных
// сервиса на Render), нужен полный URL backend — он задаётся на этапе сборки
// через VITE_API_BASE (см. .env.production / переменные окружения static site).
const API_BASE = import.meta.env.VITE_API_BASE || "/api";

let accessToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function getAccessToken() {
  return accessToken;
}

export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function rawFetch(path: string, options: RequestInit): Promise<Response> {
  const headers = new Headers(options.headers);
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: "include", // отправлять refresh-cookie
  });
}

/** Пытается обновить access-токен через httpOnly refresh-cookie. */
async function tryRefresh(): Promise<boolean> {
  const resp = await rawFetch("/auth/refresh", { method: "POST" });
  if (!resp.ok) return false;
  const data = await resp.json();
  setAccessToken(data.access_token);
  return true;
}

/**
 * Основная точка входа для запросов к API. При 401 один раз пытается
 * прозрачно обновить access-токен и повторить запрос — пользователь не
 * замечает истечения 30-минутного access-токена, пока жив refresh-токен.
 */
export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  let resp = await rawFetch(path, options);

  if (resp.status === 401 && path !== "/auth/refresh" && path !== "/auth/login") {
    const refreshed = await tryRefresh();
    if (refreshed) {
      resp = await rawFetch(path, options);
    } else {
      onUnauthorized?.();
    }
  }

  if (!resp.ok) {
    let message = `Ошибка запроса (${resp.status})`;
    try {
      const body = await resp.json();
      message = body.detail || body.error || message;
    } catch {
      // тело не JSON — оставляем сообщение по умолчанию
    }
    throw new ApiError(resp.status, message);
  }

  if (resp.status === 204) return undefined as T;
  return resp.json();
}

export const api = {
  get: <T>(path: string) => apiFetch<T>(path, { method: "GET" }),
  post: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => apiFetch<T>(path, { method: "DELETE" }),
  tryRefresh,
};
