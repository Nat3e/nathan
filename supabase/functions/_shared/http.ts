// ─────────────────────────────────────────────────────────────────────────────
//  Shared between nathan-brain and nathan-memory: CORS, JSON responses, and
//  the access-key comparison. Fix things here, both functions get it.
// ─────────────────────────────────────────────────────────────────────────────

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-nathan-key, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

/* constant-time-ish compare so the gate key can't be probed byte by byte */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
