// ─────────────────────────────────────────────────────────────────────────────
//  NATHAN GARDENER
//  Once a day (09:10 UTC, cron nathan-gardener) Nathan re-reads yesterday's
//  conversations and quietly files the durable facts into long-term memory —
//  no "remember this" needed. Conservative by design:
//    · only facts Nataniel himself stated, durable beyond a week
//    · merged into existing files (full new body), never bolted on as noise
//    · skip entirely when unsure — an empty run is a good run
//    · never secrets, card numbers, IDs, or health details
//  Same auth as everything else: x-nathan-key from Vault via pg_cron.
// ─────────────────────────────────────────────────────────────────────────────
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { CORS, json, safeEqual } from "../_shared/http.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const gate = Deno.env.get("NATHAN_ACCESS_KEY");
  if (!gate) return json({ error: "setup", detail: "NATHAN_ACCESS_KEY is not set." }, 503);
  if (!safeEqual(req.headers.get("x-nathan-key") ?? "", gate)) {
    return json({ error: "unauthorized" }, 401);
  }
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "setup", detail: "ANTHROPIC_API_KEY is not set." }, 503);

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: turns } = await db.rpc("nathan_recent_turns", { p_hours: 26 });
  if (!Array.isArray(turns) || turns.length < 4) {
    return json({ ok: true, skipped: "quiet day", turns: turns?.length ?? 0 });
  }

  const { data: files } = await db.rpc("nathan_memory");
  const memoryBlock = Array.isArray(files) && files.length
    ? files.map((f: { path: string; content: string }) => `### ${f.path}\n${f.content}`).join("\n\n")
    : "(memory store is empty)";
  const convoBlock = turns
    .map((t: { role: string; content: string }) => (t.role === "assistant" ? "NATHAN: " : "NATANIEL: ") + t.content.slice(0, 600))
    .join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 4000,
      system:
        "You are the memory gardener for Nataniel's assistant. Read yesterday's conversation " +
        "and decide which DURABLE facts belong in long-term memory. Rules, strictly:\n" +
        "1. Only facts NATANIEL himself stated (his lines), still relevant in a month: " +
        "people and relationships, school/work facts, decisions, preferences, goals, recurring plans.\n" +
        "2. Never facts that only Nathan said, nothing from web pages, nothing speculative, " +
        "no one-off logistics (single events, single expenses — other systems track those).\n" +
        "3. Never passwords, codes, card/account numbers, government IDs, or health details.\n" +
        "4. MERGE: when updating an existing file, output its COMPLETE new markdown body — " +
        "keep everything still true, fold the new facts in cleanly, drop only what he explicitly " +
        "contradicted. Keep files short and scannable.\n" +
        "5. When nothing qualifies, output []. An empty run is a good run.\n" +
        "Output ONLY a JSON array, max 4 objects: " +
        '[{"path":"/people/x.md","name":"x","category":"profile|preferences|areas|topics|people",' +
        '"description":"one line","content":"full markdown body"}]',
      messages: [{
        role: "user",
        content:
          `── CURRENT MEMORY FILES ──\n${memoryBlock}\n── END MEMORY ──\n\n` +
          `── YESTERDAY'S CONVERSATION ──\n${convoBlock}\n── END CONVERSATION ──`,
      }],
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    return json({ error: "anthropic", status: res.status, detail: detail.slice(0, 400) }, 502);
  }
  const data = await res.json();
  const raw = (data.content ?? [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text).join("");
  let updates: { path?: string; name?: string; category?: string; description?: string; content?: string }[] = [];
  try {
    const m = raw.match(/\[[\s\S]*\]/);
    updates = m ? JSON.parse(m[0]) : [];
  } catch { updates = []; }

  const applied: string[] = [];
  for (const u of updates.slice(0, 4)) {
    if (!u.path || !u.content || !/^\/[\w\-/]+\.md$/.test(u.path)) continue;
    const { error } = await db.rpc("nathan_remember", {
      p_path: u.path,
      p_name: u.name ?? u.path.split("/").pop()?.replace(/\.md$/, "") ?? "note",
      p_category: u.category ?? "topics",
      p_description: u.description ?? null,
      p_content: u.content,
    });
    if (!error) applied.push(u.path);
  }
  return json({ ok: true, turns: turns.length, proposed: updates.length, applied });
});
