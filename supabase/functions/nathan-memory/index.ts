// ─────────────────────────────────────────────────────────────────────────────
//  NATHAN MEMORY
//  The app's data door: memory files, the board, money, habits — and the
//  lock-code unlock that hands the browser its access key.
//
//  Needs only NATHAN_ACCESS_KEY — no Anthropic key, no cost.
//
//  POST { action: "list" }                    → { files: [{path, description, content}] }
//  POST { action: "save", file: {...} }       → { ok: true, path }
//  POST { action: "log", role, content }      → { ok: true }
//  POST { action: "history", limit }          → { turns: [{role, content}] }
//  POST { action: "items" }                   → { items: [{id, kind, title, ...}] }
//  POST { action: "item_add", item: {...} }   → { ok: true, id }
//  POST { action: "item_update", item: {...} }→ { ok: true }
//  POST { action: "money", from?, to? }       → { entries: [{id, kind, amount, ...}] }
//  POST { action: "money_add", entry: {...} } → { ok: true, id }
//  POST { action: "money_update", entry:{...}}→ { ok: true }
//  POST { action: "habit_toggle", item:{id}, day? } → { ok: true, done }
//  POST { action: "habit_marks", from, to }   → { marks: [{item_id, day}] }
//
//  Ungated (no x-nathan-key — this IS how the app gets the key):
//  POST { action: "unlock", pin }             → { ok: true, key } | { error, until?, left? }
//    The 4-digit lock code is checked server-side (salted hash, never stored
//    plain) and swapped for the access key, so a new phone needs only the
//    code. Wrong guesses cool down 5 → 15 → 30 → 60 min after every 3rd miss,
//    enforced in the database where a browser can't clear it.
//  POST { action: "set_pin", pin }            → { ok: true }   (gated — changes the code everywhere)
// ─────────────────────────────────────────────────────────────────────────────
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { CORS, json, safeEqual } from "../_shared/http.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const gate = Deno.env.get("NATHAN_ACCESS_KEY");
  if (!gate) {
    return json(
      { error: "setup", detail: "NATHAN_ACCESS_KEY is not set in Supabase → Edge Functions → Secrets." },
      503,
    );
  }

  let body: {
    action?: string;
    pin?: string;
    file?: { path: string; name: string; category?: string; description?: string; content: string };
    item?: {
      id?: number; kind?: string; title?: string; detail?: string; area?: string;
      tag?: string; tag_text?: string; when?: string; end?: string; percent?: number; status?: string;
    };
    entry?: {
      id?: number; kind?: string; title?: string; amount?: number;
      category?: string; note?: string; when?: string; status?: string;
    };
    from?: string;
    to?: string;
    day?: string;
    role?: string;
    content?: string;
    session?: string;
    limit?: number;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request", detail: "Body must be JSON." }, 400);
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  /* the one ungated action: swap the lock code for the access key.
     Rate limiting lives in the nathan_unlock RPC itself, so hammering
     this endpoint can't brute-force the code. */
  if (body.action === "unlock") {
    const pin = String(body.pin ?? "");
    if (!/^\d{4}$/.test(pin)) return json({ ok: false, error: "wrong" }, 401);
    const { data, error } = await db.rpc("nathan_unlock", { p_pin: pin });
    if (error) return json({ error: "db", detail: String(error) }, 500);
    const out = data as { ok?: boolean; error?: string };
    if (out?.ok) return json({ ok: true, key: gate });
    return json(out, out?.error === "locked" ? 423 : 401);
  }

  if (!safeEqual(req.headers.get("x-nathan-key") ?? "", gate)) {
    return json({ error: "unauthorized", detail: "Wrong or missing access key." }, 401);
  }

  const session = (body.session ?? "local").slice(0, 64);

  try {
    switch (body.action) {
      case "list": {
        const { data, error } = await db.rpc("nathan_memory");
        if (error) throw error;
        return json({ files: data ?? [] });
      }

      case "save": {
        const f = body.file;
        if (!f?.path || !f?.content) {
          return json({ error: "bad_request", detail: "file.path and file.content are required." }, 400);
        }
        const { error } = await db.rpc("nathan_remember", {
          p_path: f.path,
          p_name: f.name ?? f.path.split("/").pop()?.replace(/\.md$/, "") ?? "note",
          p_category: f.category ?? "topics",
          p_description: f.description ?? null,
          p_content: f.content,
        });
        if (error) throw error;
        return json({ ok: true, path: f.path });
      }

      case "log": {
        if (!body.role || !body.content) return json({ ok: false });
        const { error } = await db.rpc("nathan_log_turn", {
          p_session: session,
          p_role: body.role === "assistant" ? "assistant" : "user",
          p_content: body.content,
        });
        if (error) throw error;
        return json({ ok: true });
      }

      case "history": {
        const { data, error } = await db.rpc("nathan_history", {
          p_session: session,
          p_limit: Math.min(Math.max(body.limit ?? 20, 1), 100),
        });
        if (error) throw error;
        return json({ turns: data ?? [] });
      }

      /* ── the live board behind the dashboard panels + calendar ── */

      case "items": {
        const { data, error } = await db.rpc("nathan_items");
        if (error) throw error;
        return json({ items: data ?? [] });
      }

      case "item_add": {
        const it = body.item;
        if (!it?.kind || !it?.title) {
          return json({ error: "bad_request", detail: "item.kind and item.title are required." }, 400);
        }
        const { data, error } = await db.rpc("nathan_item_add", {
          p_kind: it.kind,
          p_title: it.title,
          p_detail: it.detail ?? null,
          p_area: it.area ?? null,
          p_tag: it.tag ?? "",
          p_tag_text: it.tag_text ?? null,
          p_when: it.when ?? null,
          p_percent: it.percent ?? null,
          p_end: it.end ?? null,
        });
        if (error) throw error;
        return json({ ok: true, id: data });
      }

      case "item_update": {
        const it = body.item;
        if (!it?.id) return json({ error: "bad_request", detail: "item.id is required." }, 400);
        const { error } = await db.rpc("nathan_item_update", {
          p_id: it.id,
          p_title: it.title ?? null,
          p_detail: it.detail ?? null,
          p_area: it.area ?? null,
          p_tag: it.tag ?? null,
          p_tag_text: it.tag_text ?? null,
          p_when: it.when ?? null,
          p_percent: it.percent ?? null,
          p_status: it.status ?? null,
          p_end: it.end ?? null,
        });
        if (error) throw error;
        return json({ ok: true });
      }

      /* ── finances ── */

      case "money": {
        const args: Record<string, string> = {};
        if (body.from) args.p_from = body.from;
        if (body.to) args.p_to = body.to;
        const { data, error } = await db.rpc("nathan_money", args);
        if (error) throw error;
        return json({ entries: data ?? [] });
      }

      case "money_add": {
        const e = body.entry;
        if (!e?.kind || !e?.title || !(Number(e.amount) >= 0)) {
          return json({ error: "bad_request", detail: "entry.kind, entry.title and entry.amount are required." }, 400);
        }
        const { data, error } = await db.rpc("nathan_money_add", {
          p_kind: e.kind,
          p_title: e.title,
          p_amount: e.amount,
          p_category: e.category ?? null,
          p_note: e.note ?? null,
          p_when: e.when ?? null,
          p_status: e.status ?? null,
        });
        if (error) throw error;
        return json({ ok: true, id: data });
      }

      case "money_update": {
        const e = body.entry;
        if (!e?.id) return json({ error: "bad_request", detail: "entry.id is required." }, 400);
        const { error } = await db.rpc("nathan_money_update", {
          p_id: e.id,
          p_title: e.title ?? null,
          p_amount: e.amount ?? null,
          p_category: e.category ?? null,
          p_note: e.note ?? null,
          p_when: e.when ?? null,
          p_status: e.status ?? null,
        });
        if (error) throw error;
        return json({ ok: true });
      }

      /* ── habits ── */

      case "habit_toggle": {
        if (!body.item?.id) return json({ error: "bad_request", detail: "item.id is required." }, 400);
        const args: Record<string, unknown> = { p_id: body.item.id };
        if (body.day) args.p_day = body.day;
        const { data, error } = await db.rpc("nathan_habit_toggle", args);
        if (error) throw error;
        return json({ ok: true, done: data });
      }

      case "set_pin": {
        const pin = String(body.pin ?? "");
        if (!/^\d{4}$/.test(pin)) {
          return json({ error: "bad_request", detail: "The code must be exactly 4 digits." }, 400);
        }
        const { data, error } = await db.rpc("nathan_set_pin", { p_pin: pin });
        if (error) throw error;
        return json(data);
      }

      case "habit_marks": {
        if (!body.from || !body.to) return json({ error: "bad_request", detail: "from and to are required." }, 400);
        const { data, error } = await db.rpc("nathan_habit_marks", { p_from: body.from, p_to: body.to });
        if (error) throw error;
        return json({ marks: data ?? [] });
      }

      default:
        return json({ error: "bad_request", detail: "Unknown action." }, 400);
    }
  } catch (e) {
    return json({ error: "db", detail: String(e) }, 500);
  }
});
