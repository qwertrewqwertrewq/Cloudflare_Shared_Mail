const API_BASE = (window.CFMAIL_CONFIG && window.CFMAIL_CONFIG.apiBaseUrl) || "";

export async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "请求失败");
  }
  return data;
}

export function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}
