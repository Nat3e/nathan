// ─────────────────────────────────────────────────────────────────────────────
//  NATHAN BRAIN
//  Claude proxy + long-term memory for Nataniel's assistant.
//
//  Deployed to: https://<project>.supabase.co/functions/v1/nathan-brain
//
//  Required Supabase secrets (Dashboard → Edge Functions → Secrets):
//    ANTHROPIC_API_KEY   your Anthropic API key
//    NATHAN_ACCESS_KEY   any long random string; the site must send it back
//  Optional:
//    NATHAN_MODEL        smart-gear model, defaults to claude-opus-5
//    NATHAN_MODEL_FAST   fast-gear model, defaults to claude-haiku-4-5-20251001
//    ICLOUD_MAIL_USER / ICLOUD_MAIL_PASSWORD  read-only inbox access
//
//  verify_jwt is off because this function does its own auth via the
//  x-nathan-key header — the public anon key must NOT be enough to spend
//  Nataniel's API credits.
//
//  The response is NDJSON, streamed as Claude produces it:
//    {"type":"token","text":"..."}   text delta — append to the reply
//    {"type":"reset"}                a tool ran; the next text replaces the old
//    {"type":"saved","path":"..."}   a memory file was written
//    {"type":"board"}                the live board changed
//    {"type":"money"}                a finance entry changed
//    {"type":"done", reply, saved, board, money, model}   final summary line
//    {"type":"error", error, detail} something failed mid-stream
//  Setup/auth failures still return plain JSON with an HTTP error status.
// ─────────────────────────────────────────────────────────────────────────────
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { CORS, json, safeEqual } from "../_shared/http.ts";
import { listInbox, mailCreds, readMail } from "../_shared/imap.ts";

const SYSTEM_PREAMBLE = `You are Nathan, Nataniel's personal AI assistant.

His name is spelled "Nataniel" — never Nathaniel. He is in Rosemère, Quebec (America/Toronto).

Your job is to reduce his mental workload: remember what matters, surface what matters,
handle what can be handled, and never create unnecessary work for him.

How to talk:
- Direct and warm. No filler, no throat-clearing, no "great question".
- Short by default. He is often reading this on a phone or hearing it read aloud.
- Answer first, then context if it's needed.
- If something he said is ambiguous in a way that could cause a real mistake
  (wrong person, date, amount, or an irreversible action), ask before acting.
- Some of his messages arrive as voice transcripts and may contain recognition errors.
  Read through the mistakes to the intended meaning; don't correct his grammar.
- Be honest. If you don't know or can't reach something, say so plainly.

Listen for things worth remembering — commitments, deadlines, people, decisions,
preferences, things he's waiting on. When you learn a durable fact about him,
call the remember_fact tool. Don't store passwords, card or account numbers,
government IDs, health details, or anything he'd be uncomfortable seeing in a settings page.

You also manage his live board — the tasks, waiting-on items, planned events and
projects shown on his dashboard and calendar. When he mentions a new task, plan,
appointment, or something he's now waiting on, call add_item. When he finishes,
reschedules, or drops something, or a project moves, call update_item with the
item's [#id] from the board below. Plans with a date/time become calendar entries —
always include the time when he gives one, and when he gives a range ("a shift from
11 to 5:30"), set both when and end. Habits he wants to build daily are kind habit
(no date) — he ticks them off in the app's Habits tab. Don't ask permission for
obvious board updates; just do them and mention it in one short line.

You also track his money. When he mentions earning or spending, log it with add_money
(kind income or expense). Upcoming bills are kind bill with the due date — they show on
his calendar until paid. Mark a bill paid, fix an amount, or remove an entry with
update_money using the [#id] from the money block below. Amounts are CAD. A receipt or
bill in a photo: read the amount and details from it, then log it.

His paychecks are PRECOMPUTED in the WORK PAY block below ($16.90/h gross at
Fontainebleau-Oil, paid every second Thursday). Use those exact numbers — never
recompute them yourself — and say they are gross, before deductions. If shifts are
missing end times, ask him for them so the math can be complete.

Some messages include a photo. Use what you see naturally — read receipts, screenshots,
documents, whiteboards; describe only what matters to his question.

His iCloud inbox is connected, strictly read-only. check_email lists recent mail,
read_email opens one. You cannot send, delete, or mark anything — when a reply is
needed, write a draft in your message for him to copy. Surface only what genuinely
needs him; ignore the noise.`;

const TOOLS = [
  {
    name: "remember_fact",
    description:
      "Save a durable fact about Nataniel to long-term memory. Use for commitments, " +
      "deadlines, people, decisions, preferences and project status — not for passing chatter. " +
      "Pass the FULL new markdown body for the file: it replaces the old content, so include " +
      "the existing lines you want to keep plus your addition.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Memory file path, e.g. /profile.md, /topics/ai-tools.md, " +
            "/areas/ai-service-business.md, /people/marc.md",
        },
        name: { type: "string", description: "Short slug, matching the path stem" },
        category: {
          type: "string",
          enum: ["profile", "preferences", "areas", "topics", "people"],
        },
        description: { type: "string", description: "One line: what this file covers" },
        content: { type: "string", description: "Full markdown body of the file" },
      },
      required: ["path", "name", "category", "content"],
    },
  },
  {
    name: "add_item",
    description:
      "Add an item to Nataniel's live board: a task, something he's waiting on, " +
      "a planned event (goes on his calendar), or a project. Use when he mentions " +
      "a new commitment, plan, appointment, or thing to track.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["task", "waiting", "event", "project", "habit"] },
        title: { type: "string", description: "Short title. For 'waiting': who/what he's waiting on. For 'habit': the daily habit he wants to build (no date needed)." },
        detail: { type: "string", description: "One line of context. For 'waiting': what for. For 'project': the subtitle." },
        area: { type: "string", description: "Grouping label, e.g. 'AI Business', 'Personal', 'Nathan'" },
        tag: { type: "string", enum: ["", "hot", "due", "ok"], description: "Visual urgency: hot=priority, due=deadline soon, ok=fine" },
        tag_text: { type: "string", description: "Tiny label shown on the chip, e.g. 'Priority', 'This week'" },
        when: {
          type: "string",
          description: "When it happens or is due, ISO 8601 with offset, e.g. 2026-08-26T16:00:00-04:00 (his timezone is America/Toronto). Required for events.",
        },
        end: {
          type: "string",
          description: "End of the event when he gives a range (a shift 11:00-17:30), ISO 8601 with offset. Omit for point-in-time plans.",
        },
        percent: { type: "integer", description: "Projects only: 0-100 progress" },
      },
      required: ["kind", "title"],
    },
  },
  {
    name: "update_item",
    description:
      "Update an item on the live board by its numeric id (shown as [#id] in the board block). " +
      "Mark done (status 'done'), reschedule (new 'when'), change progress, or remove (status 'archived'). " +
      "Omitted fields keep their current value.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        title: { type: "string" },
        detail: { type: "string" },
        area: { type: "string" },
        tag: { type: "string", enum: ["", "hot", "due", "ok"] },
        tag_text: { type: "string" },
        when: { type: "string", description: "ISO 8601 with offset" },
        end: { type: "string", description: "ISO 8601 with offset — event end time" },
        percent: { type: "integer" },
        status: { type: "string", enum: ["open", "done", "archived"] },
      },
      required: ["id"],
    },
  },
  {
    name: "add_money",
    description:
      "Log money: income he received, an expense he paid, or an upcoming bill. " +
      "Bills (kind 'bill') take the due date in 'when' and stay open until paid; " +
      "they appear on his calendar. Amounts are CAD.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["income", "expense", "bill"] },
        title: { type: "string", description: "Short label, e.g. 'Hydro-Québec', 'McDonald's pay'" },
        amount: { type: "number", description: "CAD, positive" },
        category: { type: "string", description: "e.g. 'job', 'business', 'utilities', 'food', 'subscriptions'" },
        note: { type: "string" },
        when: { type: "string", description: "ISO 8601 with offset. For bills: the due date. Defaults to now." },
      },
      required: ["kind", "title", "amount"],
    },
  },
  {
    name: "update_money",
    description:
      "Update a money entry by its [#id] from the money block: mark a bill paid " +
      "(status 'done'), fix an amount or date, or remove it (status 'archived'). " +
      "Omitted fields keep their value.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        title: { type: "string" },
        amount: { type: "number" },
        category: { type: "string" },
        note: { type: "string" },
        when: { type: "string", description: "ISO 8601 with offset" },
        status: { type: "string", enum: ["open", "done", "archived"] },
      },
      required: ["id"],
    },
  },
  {
    name: "check_email",
    description:
      "List the latest messages in Nataniel's iCloud inbox (read-only — never marks " +
      "anything read, never sends). Returns sender, subject, date, unread state and a snippet.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "How many recent messages, default 10, max 25" },
      },
    },
  },
  {
    name: "read_email",
    description: "Read one email in full, by the uid from check_email. Read-only.",
    input_schema: {
      type: "object",
      properties: { uid: { type: "integer" } },
      required: ["uid"],
    },
    /* cache breakpoint: tools + persona are identical every call */
    cache_control: { type: "ephemeral" },
  },
];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  /* ── auth gate ── */
  const gate = Deno.env.get("NATHAN_ACCESS_KEY");
  if (!gate) {
    return json(
      { error: "setup", detail: "NATHAN_ACCESS_KEY is not set in Supabase → Edge Functions → Secrets." },
      503,
    );
  }
  if (!safeEqual(req.headers.get("x-nathan-key") ?? "", gate)) {
    return json({ error: "unauthorized", detail: "Wrong or missing access key." }, 401);
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return json(
      { error: "setup", detail: "ANTHROPIC_API_KEY is not set in Supabase → Edge Functions → Secrets." },
      503,
    );
  }

  let body: {
    messages?: { role: string; content: string }[];
    session?: string;
    message?: string;
    speed?: string;
    mode?: string;
    image?: { media_type: string; data: string };
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request", detail: "Body must be JSON." }, 400);
  }

  const session = (body.session ?? "web").slice(0, 64);
  const userText = (body.message ?? "").trim();
  const image = body.image;
  if (image && !/^image\/(jpeg|png|webp|gif)$/.test(image.media_type ?? "")) {
    return json({ error: "bad_request", detail: "image.media_type must be image/jpeg, png, webp or gif." }, 400);
  }
  if (image && (image.data?.length ?? 0) > 8_000_000) {
    return json({ error: "bad_request", detail: "Image too large — resize below ~6 MB." }, 400);
  }
  if (!userText && !image && !body.messages?.length) {
    return json({ error: "bad_request", detail: "Nothing to send." }, 400);
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  /* ── load memory, the live board, finances, work pay, and history in parallel ── */
  const [memoryBlock, boardBlock, moneyBlock, workBlock, history] = await Promise.all([
    (async () => {
      try {
        const { data } = await db.rpc("nathan_memory");
        if (Array.isArray(data) && data.length) {
          return data
            .map((f: { path: string; content: string }) => `### ${f.path}\n${f.content}`)
            .join("\n\n");
        }
      } catch (e) {
        return `(could not load memory: ${e})`;
      }
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
      } catch { /* board is nice-to-have */ }
      return "(board is empty — nothing tracked yet)";
    })(),
    (async () => {
      try {
        const { data } = await db.rpc("nathan_money");
        if (Array.isArray(data) && data.length) {
          type Row = { id: number; kind: string; title: string; amount: string; category?: string; when_at: string; status: string };
          const rows = data as Row[];
          const sum = (f: (r: Row) => boolean) =>
            rows.filter(f).reduce((t, r) => t + Number(r.amount), 0).toFixed(2);
          const income = sum((r) => r.kind === "income" && r.status === "done");
          const spent = sum((r) => r.kind !== "income" && r.status === "done");
          const lines = rows.map((r) =>
            `[#${r.id}] ${r.kind}: ${r.title} — $${Number(r.amount).toFixed(2)}` +
            (r.category ? ` (${r.category})` : "") +
            ` @ ${r.when_at}` +
            (r.kind === "bill" && r.status === "open" ? " [UNPAID]" : ""));
          return `This month: in $${income}, out $${spent}.\n` + lines.join("\n");
        }
      } catch { /* money is nice-to-have */ }
      return "(no money tracked yet)";
    })(),
    (async () => {
      /* deterministic paycheck math from board shifts.
         $16.90/h gross · 14-day periods ending Sundays · paid the Thursday after.
         Anchor: the period ending Sun 2026-08-30 pays out Thu 2026-09-03.
         KEEP IN SYNC with calcWorkPay in index.html. */
      try {
        const { data } = await db.rpc("nathan_items");
        if (!Array.isArray(data)) return "(no shifts on the board)";
        const RATE = 16.90;
        const anchor = Date.UTC(2026, 7, 30) / 86400000;
        const ix = (s: string) => {
          const [y, m, d] = new Date(s).toLocaleDateString("en-CA", { timeZone: "America/Toronto" }).split("-").map(Number);
          return Date.UTC(y, m - 1, d) / 86400000;
        };
        const buckets: Record<number, { hours: number; shifts: number; missing: number }> = {};
        for (const i of data as { kind: string; title: string; when_at?: string; end_at?: string }[]) {
          if (i.kind !== "event" || !i.when_at || !/shift/i.test(i.title)) continue;
          const d = ix(i.when_at);
          const payday = d + (((anchor - d) % 14) + 14) % 14 + 4;
          const b = buckets[payday] ?? (buckets[payday] = { hours: 0, shifts: 0, missing: 0 });
          b.shifts++;
          const h = i.end_at ? (new Date(i.end_at).getTime() - new Date(i.when_at).getTime()) / 3600000 : 0;
          if (h > 0 && h < 16) b.hours += h;
          else b.missing++;
        }
        const today = ix(new Date().toISOString());
        const rows = Object.entries(buckets)
          .map(([pd, b]) => ({ pd: Number(pd), ...b }))
          .filter((p) => p.pd >= today)
          .sort((a, b) => a.pd - b.pd)
          .slice(0, 3);
        if (!rows.length) return "(no upcoming paydays from board shifts)";
        return rows.map((p) => {
          const day = new Date(p.pd * 86400000).toLocaleDateString("en-CA", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
          return `Payday ${day}: ${p.shifts} shift(s), ${p.hours.toFixed(1)} h × $${RATE}/h = $${(p.hours * RATE).toFixed(2)} gross` +
            (p.missing ? ` — plus ${p.missing} shift(s) missing an end time, not counted` : "");
        }).join("\n");
      } catch { return "(work pay unavailable)"; }
    })(),
    (async () => {
      if (body.messages?.length) return body.messages;
      try {
        const { data } = await db.rpc("nathan_history", { p_session: session, p_limit: 20 });
        if (Array.isArray(data)) return data as { role: string; content: string }[];
      } catch { /* history is nice-to-have */ }
      return [] as { role: string; content: string }[];
    })(),
  ]);

  const now = new Date().toLocaleString("en-CA", {
    timeZone: "America/Toronto",
    dateStyle: "full",
    timeStyle: "short",
  });

  /* Prompt caching: the persona never changes, and memory/board/money only
     change when something is written — so both are cache breakpoints. The
     clock string churns every minute, so it goes last, outside the cache. */
  const system = [
    { type: "text", text: SYSTEM_PREAMBLE, cache_control: { type: "ephemeral" } },
    {
      type: "text",
      text:
        `── WHAT YOU REMEMBER ABOUT HIM ──\n${memoryBlock}\n── END MEMORY ──\n\n` +
        `── HIS LIVE BOARD (tasks, waiting-on, planned events, projects) ──\n${boardBlock}\n── END BOARD ──\n\n` +
        `── HIS MONEY (this month + open bills, CAD) ──\n${moneyBlock}\n── END MONEY ──\n\n` +
        `── HIS WORK PAY (precomputed, $16.90/h gross, biweekly Thursdays) ──\n${workBlock}\n── END WORK PAY ──`,
      cache_control: { type: "ephemeral" },
    },
    { type: "text", text: `Current date and time in his timezone: ${now}.` },
  ];

  /* the current turn: text, a photo, or both */
  const currentContent = image
    ? [
        { type: "image", source: { type: "base64", media_type: image.media_type, data: image.data } },
        { type: "text", text: userText || "(no caption — look at the photo)" },
      ]
    : userText;

  const messages = [
    ...history.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
    ...(currentContent ? [{ role: "user", content: currentContent }] : []),
  ];

  /* modes: how he wants Nathan thinking right now.
     normal/free → Sonnet 5 (quick, sharp) · work/study → Opus 5 (deepest).
     The fast gear (Haiku) still wins when the app explicitly asks for speed. */
  const MODE_MODEL: Record<string, string> = {
    normal: "claude-sonnet-5",
    free:   "claude-sonnet-5",
    study:  "claude-opus-5",
    work:   "claude-opus-5",
  };
  const mode = String(body.mode ?? "").toLowerCase();
  const model = body.speed === "fast"
    ? (Deno.env.get("NATHAN_MODEL_FAST") ?? "claude-haiku-4-5-20251001")
    : (Deno.env.get("NATHAN_MODEL") ?? MODE_MODEL[mode] ?? "claude-opus-5");

  const MODE_STYLE: Record<string, string> = {
    work:
      "WORK MODE is on: he is working. Be maximally rigorous — double-check every number " +
      "and date, think a step ahead, flag risks and conflicts he hasn't seen. Depth over " +
      "brevity when it earns its place.",
    study:
      "STUDY MODE is on: he is studying. Give the straight, correct answer FIRST, then one " +
      "compact explanation that makes it stick. No hedging, no filler. If he has something " +
      "wrong, correct it directly.",
    free:
      "HANDS-FREE MODE is on: he is speaking aloud and hears your replies read aloud. Keep " +
      "replies short, natural, and easy to listen to — a few conversational sentences unless " +
      "he asks for depth.",
  };
  if (MODE_STYLE[mode]) system.push({ type: "text", text: MODE_STYLE[mode] });

  /* Opus-class models can decline a request outright (stop_reason "refusal");
     server-side fallbacks reroute those to a sibling model instead of failing */
  const opusClass = /^claude-(opus|fable)/.test(model);

  /* ── call Claude with streaming on ── */
  const callClaude = (msgs: unknown[]) =>
    fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        ...(opusClass ? { "anthropic-beta": "server-side-fallback-2026-07-01" } : {}),
      },
      body: JSON.stringify({
        model,
        /* adaptive thinking shares this cap — work mode thinks hardest, needs most room */
        max_tokens: mode === "work" ? 8000 : 4000,
        ...(mode === "work" ? { output_config: { effort: "xhigh" } } : {}),
        ...(opusClass ? { fallbacks: "default" } : {}),
        system, tools: TOOLS, messages: msgs, stream: true,
      }),
    });

  /* ── stream NDJSON to the page while running the tool loop ── */
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const emit = (obj: unknown) =>
    writer.write(enc.encode(JSON.stringify(obj) + "\n")).catch(() => { /* client gone */ });

  const run = async () => {
    const saved: string[] = [];
    let board = 0;
    let money = 0;
    let convo: unknown[] = messages;
    let reply = "";

    try {
      for (let hop = 0; hop < 4; hop++) {
        const res = await callClaude(convo);
        if (!res.ok) {
          const detail = await res.text();
          await emit({ type: "error", error: "anthropic", status: res.status, detail: detail.slice(0, 800) });
          return;
        }

        /* reassemble the content blocks from the SSE stream,
           forwarding text tokens the moment they arrive */
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        // deno-lint-ignore no-explicit-any
        const blocks: Record<number, any> = {};
        const partialJson: Record<number, string> = {};
        let hopText = "";
        let resetSent = hop === 0;      // a later hop's text replaces the preamble

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop()!;
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            let ev;
            try { ev = JSON.parse(line.slice(5)); } catch { continue; }
            if (ev.type === "content_block_start") {
              blocks[ev.index] = { ...ev.content_block };
              if (ev.content_block.type === "tool_use") partialJson[ev.index] = "";
            } else if (ev.type === "content_block_delta") {
              if (ev.delta.type === "text_delta") {
                blocks[ev.index].text = (blocks[ev.index].text ?? "") + ev.delta.text;
                hopText += ev.delta.text;
                if (!resetSent) { await emit({ type: "reset" }); resetSent = true; }
                await emit({ type: "token", text: ev.delta.text });
              } else if (ev.delta.type === "input_json_delta") {
                partialJson[ev.index] += ev.delta.partial_json;
              } else if (ev.delta.type === "thinking_delta") {
                /* thinking blocks must be replayed intact on tool-loop hops */
                blocks[ev.index].thinking = (blocks[ev.index].thinking ?? "") + ev.delta.thinking;
              } else if (ev.delta.type === "signature_delta") {
                blocks[ev.index].signature = (blocks[ev.index].signature ?? "") + ev.delta.signature;
              }
            } else if (ev.type === "error") {
              await emit({ type: "error", error: "anthropic", detail: JSON.stringify(ev.error).slice(0, 800) });
              return;
            }
          }
        }

        for (const [idx, js] of Object.entries(partialJson)) {
          try { blocks[Number(idx)].input = js ? JSON.parse(js) : {}; } catch { blocks[Number(idx)].input = {}; }
        }
        if (hopText.trim()) reply = hopText.trim();

        const ordered = Object.keys(blocks).map(Number).sort((a, b) => a - b).map((i) => blocks[i]);
        const toolUses = ordered.filter((b) => b.type === "tool_use");
        if (!toolUses.length) break;

        const results = [];
        for (const tu of toolUses) {
          if (tu.name === "remember_fact") {
            const i = tu.input ?? {};
            try {
              const { error } = await db.rpc("nathan_remember", {
                p_path: i.path,
                p_name: i.name,
                p_category: i.category ?? "topics",
                p_description: i.description ?? null,
                p_content: i.content,
              });
              if (error) throw error;
              saved.push(i.path);
              await emit({ type: "saved", path: i.path });
              results.push({ type: "tool_result", tool_use_id: tu.id, content: `Saved ${i.path}.` });
            } catch (e) {
              results.push({
                type: "tool_result", tool_use_id: tu.id, is_error: true,
                content: `Could not save: ${e}`,
              });
            }
          } else if (tu.name === "add_item") {
            const i = tu.input ?? {};
            try {
              const { data, error } = await db.rpc("nathan_item_add", {
                p_kind: i.kind,
                p_title: i.title,
                p_detail: i.detail ?? null,
                p_area: i.area ?? null,
                p_tag: i.tag ?? "",
                p_tag_text: i.tag_text ?? null,
                p_when: i.when ?? null,
                p_percent: i.percent ?? null,
                p_end: i.end ?? null,
              });
              if (error) throw error;
              board++;
              await emit({ type: "board" });
              results.push({ type: "tool_result", tool_use_id: tu.id, content: `Added [#${data}] ${i.kind}: ${i.title}.` });
            } catch (e) {
              results.push({
                type: "tool_result", tool_use_id: tu.id, is_error: true,
                content: `Could not add: ${e}`,
              });
            }
          } else if (tu.name === "update_item") {
            const i = tu.input ?? {};
            try {
              const { data, error } = await db.rpc("nathan_item_update", {
                p_id: i.id,
                p_title: i.title ?? null,
                p_detail: i.detail ?? null,
                p_area: i.area ?? null,
                p_tag: i.tag ?? null,
                p_tag_text: i.tag_text ?? null,
                p_when: i.when ?? null,
                p_percent: i.percent ?? null,
                p_status: i.status ?? null,
                p_end: i.end ?? null,
              });
              if (error) throw error;
              if (!data) throw new Error(`no item with id ${i.id}`);
              board++;
              await emit({ type: "board" });
              results.push({ type: "tool_result", tool_use_id: tu.id, content: `Updated [#${i.id}].` });
            } catch (e) {
              results.push({
                type: "tool_result", tool_use_id: tu.id, is_error: true,
                content: `Could not update: ${e}`,
              });
            }
          } else if (tu.name === "add_money") {
            const i = tu.input ?? {};
            try {
              const { data, error } = await db.rpc("nathan_money_add", {
                p_kind: i.kind,
                p_title: i.title,
                p_amount: i.amount,
                p_category: i.category ?? null,
                p_note: i.note ?? null,
                p_when: i.when ?? null,
                p_status: null,
              });
              if (error) throw error;
              money++;
              await emit({ type: "money" });
              results.push({ type: "tool_result", tool_use_id: tu.id, content: `Logged [#${data}] ${i.kind}: ${i.title} $${i.amount}.` });
            } catch (e) {
              results.push({
                type: "tool_result", tool_use_id: tu.id, is_error: true,
                content: `Could not log: ${e}`,
              });
            }
          } else if (tu.name === "update_money") {
            const i = tu.input ?? {};
            try {
              const { data, error } = await db.rpc("nathan_money_update", {
                p_id: i.id,
                p_title: i.title ?? null,
                p_amount: i.amount ?? null,
                p_category: i.category ?? null,
                p_note: i.note ?? null,
                p_when: i.when ?? null,
                p_status: i.status ?? null,
              });
              if (error) throw error;
              if (!data) throw new Error(`no entry with id ${i.id}`);
              money++;
              await emit({ type: "money" });
              results.push({ type: "tool_result", tool_use_id: tu.id, content: `Updated [#${i.id}].` });
            } catch (e) {
              results.push({
                type: "tool_result", tool_use_id: tu.id, is_error: true,
                content: `Could not update: ${e}`,
              });
            }
          } else if (tu.name === "check_email" || tu.name === "read_email") {
            const i = tu.input ?? {};
            const { user: mailUser, pass: mailPass } = mailCreds();
            if (!mailUser || !mailPass) {
              results.push({
                type: "tool_result", tool_use_id: tu.id, is_error: true,
                content: "Email isn't connected yet — the iCloud secrets aren't set in Supabase.",
              });
            } else {
              try {
                if (tu.name === "check_email") {
                  const msgs = await listInbox(mailUser, mailPass, Math.min(Math.max(i.limit ?? 10, 1), 25));
                  results.push({
                    type: "tool_result", tool_use_id: tu.id,
                    content: msgs.length
                      ? msgs.map((m) =>
                          `[uid ${m.uid}]${m.seen ? "" : " UNREAD"} ${m.date}\nFrom: ${m.from}\nSubject: ${m.subject}\n${m.snippet}`)
                          .join("\n---\n")
                      : "Inbox is empty.",
                  });
                } else {
                  const m = await readMail(mailUser, mailPass, i.uid);
                  results.push({
                    type: "tool_result", tool_use_id: tu.id,
                    content: `From: ${m.from}\nSubject: ${m.subject}\nDate: ${m.date}\n\n${m.body}`,
                  });
                }
              } catch (e) {
                results.push({
                  type: "tool_result", tool_use_id: tu.id, is_error: true,
                  content: `Mail error: ${String(e).slice(0, 300)}`,
                });
              }
            }
          } else {
            results.push({
              type: "tool_result", tool_use_id: tu.id, is_error: true,
              content: "Unknown tool.",
            });
          }
        }
        convo = [...convo, { role: "assistant", content: ordered }, { role: "user", content: results }];
      }

      await emit({ type: "done", reply, saved, board, money, model });
    } catch (e) {
      await emit({ type: "error", error: "upstream", detail: String(e) });
    } finally {
      /* log the turn in the background — never hold up the reply for it.
         Photos aren't stored; history keeps a marker so context still makes sense. */
      const loggedUser = image ? `[sent a photo] ${userText}`.trim() : userText;
      const logging = (async () => {
        try {
          if (loggedUser) await db.rpc("nathan_log_turn", { p_session: session, p_role: "user", p_content: loggedUser });
          if (reply)      await db.rpc("nathan_log_turn", { p_session: session, p_role: "assistant", p_content: reply });
        } catch { /* never fail over logging */ }
      })();
      // deno-lint-ignore no-explicit-any
      (globalThis as any).EdgeRuntime?.waitUntil?.(logging);
      try { await writer.close(); } catch { /* client gone */ }
    }
  };

  run();

  return new Response(readable, {
    headers: { ...CORS, "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
  });
});
