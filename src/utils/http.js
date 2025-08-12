// utils/http.js
export async function parseMaybeJson(res) {
  if (res.status === 204) return null; // No Content
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    return res.json();
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
