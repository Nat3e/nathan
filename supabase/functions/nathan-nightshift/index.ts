// ─────────────────────────────────────────────────────────────────────────────
//  NATHAN NIGHT SHIFT
//  Runs while Nataniel sleeps (pg_cron → this function, ~05:30 his time).
//
//  It reads his memory, board, and finances, researches the day ahead with
//  Claude's web search (market/trends/competitor context for his projects),
//  and writes a morning briefing to the memory file /briefings/latest.md —
//  which every Nathan conversation automatically loads. Ask "morning briefing"
//  and it's there, already thought through.
//
//  Cost: one Claude call with up to 4 web searches ≈ $0.05–0.10 per night.
//  Turn it off any time:  select cron.unschedule('nathan-nightshift');
//
//  Same auth as the rest: x-nathan-key must match NATHAN_ACCESS_KEY.
//  The cron job reads that key from Supabase Vault (name: nathan_access_key).
// ─────────────────────────────────────────────────────────────────────────────
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { CORS, json, safeEqual } from "../_shared/http.ts";
import { listInbox, mailCreds } from "../_shared/imap.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const gate = Deno.env.get("NATHAN_ACCESS_KEY");
  if (!gate) return json({ error: "setup", detail: "NATHAN_ACCESS_KEY is not set." }, 503);
  if (!safeEqual(req.headers.get("x-nathan-key") ?? "", gate)) {
    return json({ error: "unauthorized", detail: "Wrong or missing access key." }, 401);
  }
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "setup", detail: "ANTHROPIC_API_KEY is not set." }, 503);

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  /* ── everything Nathan knows, loaded in parallel ── */
  const [memoryBlock, boardBlock, moneyBlock, inboxBlock] = await Promise.all([
    (async () => {
      try {
        const { data } = await db.rpc("nathan_memory");
        if (Array.isArray(data) && data.length) {
          return data
            .filter((f: { path: string }) => f.path !== "/briefings/latest.md")
            .map((f: { path: string; content: string }) => `### ${f.path}\n${f.content}`)
            .join("\n\n");
        }
      } catch { /* fine */ }
      return "(memory store is empty)";
    })(),
    (async () => {
      try {
        const { data } = await db.rpc("nathan_items");
        if (Array.isArray(data) && data.length) {
          return data
            .map((i: { id: number; kind: string; title: string; detail?: string; when_at?: string; end_at?: string; percent?: number; status: string }) =>
              `[#${i.id}] ${i.kind}: ${i.title}` +
              (i.detail ? ` — ${i.detail}` : "") +
              (i.when_at ? ` @ ${i.when_at}` + (i.end_at ? ` → ${i.end_at}` : "") : "") +
              (i.percent != null ? ` (${i.percent}%)` : "") +
              (i.status !== "open" ? ` [${i.status}]` : ""))
            .join("\n");
        }
      } catch { /* fine */ }
      return "(board is empty)";
    })(),
    (async () => {
      try {
        const { data } = await db.rpc("nathan_money");
        if (Array.isArray(data) && data.length) {
          return data
            .map((r: { id: number; kind: string; title: string; amount: string; when_at: string; status: string }) =>
              `${r.kind}: ${r.title} — $${Number(r.amount).toFixed(2)} @ ${r.when_at}` +
              (r.kind === "bill" && r.status === "open" ? " [UNPAID]" : ""))
            .join("\n");
        }
      } catch { /* fine */ }
      return "(no money tracked)";
    })(),
    (async () => {
      const { user: u, pass: p } = mailCreds();
      if (!u || !p) return "(email not connected)";
      try {
        const msgs = await listInbox(u, p, 15);
        if (!msgs.length) return "(inbox is empty)";
        return msgs.map((m) =>
          `${m.seen ? "read" : "UNREAD"} · ${m.date} · ${m.from}\n  ${m.subject}\n  ${m.snippet.slice(0, 140)}`)
          .join("\n");
      } catch (e) { return `(could not read inbox: ${String(e).slice(0, 120)})`; }
    })(),
  ]);

  const now = new Date().toLocaleString("en-CA", {
    timeZone: "America/Toronto", dateStyle: "full", timeStyle: "short",
  });
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });

  const system =
    `You are Nathan, Nataniel's personal AI assistant, working the night shift while he sleeps.
He is in Rosemère, Quebec. It is currently ${now}. He will read your briefing on his phone
over breakfast — make every line earn its place.

Compose his MORNING BRIEFING in markdown with exactly these sections (skip a section
entirely if there is truly nothing for it):

**☀️ Today** — his calendar for today from the board: what's on, when, back-to-back
conflicts or tight gaps, and one practical suggestion if the day's shape has a problem.

**⚑ Flags** — what genuinely needs attention: unpaid bills due within 5 days, tasks
tagged hot/due, things he's been waiting on for a while, streaks about to break.

**📈 Worth knowing** — use web search (up to 4 searches) for things that matter to his
actual projects and interests from memory (AI services for small businesses, Shopify /
WISMO order-status space, Claude/AI tooling news). 2-4 tight bullets, each with the
source name. Skip generic news; only what he'd act on or find genuinely interesting.

**📬 Inbox** — from the inbox below (read-only): flag only the messages that genuinely
need him, one line each. If one clearly needs an answer, include a short draft reply
he can copy. Skip newsletters, receipts and noise entirely. Omit the section if the
inbox is not connected or nothing matters.

**✍️ Ready to send** — only if an open task involves reaching out to someone: one short
draft he could copy. Otherwise omit this section.

Keep the whole briefing under 350 words. Plain, warm, zero filler. Don't invent facts
about his life — only what the context below says.

── WHAT YOU REMEMBER ──\n${memoryBlock}\n── END ──
── HIS BOARD ──\n${boardBlock}\n── END ──
── HIS MONEY ──\n${moneyBlock}\n── END ──
── HIS INBOX (latest 15, read-only) ──\n${inboxBlock}\n── END ──`;

  const model = Deno.env.get("NATHAN_MODEL") ?? "claude-sonnet-5";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 3000,
      system,
      messages: [{ role: "user", content: "Compose this morning's briefing for Nataniel." }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }],
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    return json({ error: "anthropic", status: res.status, detail: detail.slice(0, 800) }, 502);
  }
  const data = await res.json();
  const blocks = data.content ?? [];
  const text = blocks
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("\n")
    .trim();
  const searches = blocks.filter((b: { type: string }) => b.type === "server_tool_use").length;
  if (!text) return json({ error: "empty", detail: "No briefing text produced." }, 502);

  const { error } = await db.rpc("nathan_remember", {
    p_path: "/briefings/latest.md",
    p_name: "latest-briefing",
    p_category: "topics",
    p_description: "Overnight briefing for " + today + " — refreshed nightly by the Night Shift",
    p_content: "# Morning briefing — " + today + "\n\n" + text,
  });
  if (error) return json({ error: "db", detail: String(error) }, 500);

  return json({ ok: true, date: today, chars: text.length, searches, model });
});
