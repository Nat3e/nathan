// ─────────────────────────────────────────────────────────────────────────────
//  NATHAN VOICE
//  Nathan's real voice: ElevenLabs text-to-speech, streamed back as MP3.
//  Works on every device — the phone included — because the audio is a plain
//  <audio> element on the page, not the browser's built-in robot voice.
//
//  Required Supabase secret:
//    ELEVENLABS_API_KEY   from elevenlabs.io → profile → API keys
//  Optional:
//    ELEVENLABS_VOICE     voice id, defaults to Nataniel's chosen voice
//    ELEVENLABS_MODEL     defaults to eleven_turbo_v2_5 (fast + half price)
//
//  POST { text } → audio/mpeg bytes.
//  503 {error:"setup"} until the key is set — the app then quietly falls
//  back to the browser voice, so nothing breaks without it.
// ─────────────────────────────────────────────────────────────────────────────
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { CORS, json, safeEqual } from "../_shared/http.ts";

/* phones autocapitalize hand-typed secret names — accept common spellings */
function elevenKey(): string | undefined {
  for (const n of ["ELEVENLABS_API_KEY", "Elevenlabs_api_key", "elevenlabs_api_key", "ElevenLabs_API_KEY", "XI_API_KEY"]) {
    const v = Deno.env.get(n);
    if (v) return v.trim();
  }
  return undefined;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const gate = Deno.env.get("NATHAN_ACCESS_KEY");
  if (!gate) return json({ error: "setup", detail: "NATHAN_ACCESS_KEY is not set." }, 503);
  if (!safeEqual(req.headers.get("x-nathan-key") ?? "", gate)) {
    return json({ error: "unauthorized", detail: "Wrong or missing access key." }, 401);
  }

  const apiKey = elevenKey();
  if (!apiKey) {
    return json({ error: "setup", detail: "ELEVENLABS_API_KEY is not set — add it in Supabase → Edge Functions → Secrets." }, 503);
  }

  let body: { text?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request", detail: "Body must be JSON." }, 400);
  }
  const text = (body.text ?? "").trim().slice(0, 1500);
  if (!text) return json({ error: "bad_request", detail: "text is required." }, 400);

  const voice = Deno.env.get("ELEVENLABS_VOICE") ?? "HKFOb9iktHA85uKXydRT";
  const model = Deno.env.get("ELEVENLABS_MODEL") ?? "eleven_turbo_v2_5";

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "xi-api-key": apiKey },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: { stability: 0.45, similarity_boost: 0.8 },
      }),
    },
  );
  if (!res.ok) {
    const detail = await res.text();
    return json({ error: "elevenlabs", status: res.status, detail: detail.slice(0, 400) }, 502);
  }

  return new Response(res.body, {
    headers: { ...CORS, "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
  });
});
