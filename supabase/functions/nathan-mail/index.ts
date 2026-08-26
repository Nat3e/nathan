// ─────────────────────────────────────────────────────────────────────────────
//  NATHAN MAIL
//  Read-only window into Nataniel's iCloud inbox.
//
//  Required Supabase secrets:
//    ICLOUD_MAIL_USER      the full address, e.g. name@icloud.com
//    ICLOUD_MAIL_PASSWORD  an app-specific password from account.apple.com
//                          (Sign-In & Security → App-Specific Passwords) —
//                          revocable there at any time, never the real password
//
//  Strictly read-only: EXAMINE + BODY.PEEK. Nothing is ever sent, deleted,
//  moved, or marked as read.
//
//  POST { action: "probe" }              → { ok, greeting }   (no mail secrets needed)
//  POST { action: "inbox", limit? }      → { messages: [{uid, seen, from, subject, date, snippet}] }
//  POST { action: "read", uid }          → { message: {..., body} }
// ─────────────────────────────────────────────────────────────────────────────
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { CORS, json, safeEqual } from "../_shared/http.ts";
import { listInbox, mailCreds, probeImap, readMail } from "../_shared/imap.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const gate = Deno.env.get("NATHAN_ACCESS_KEY");
  if (!gate) return json({ error: "setup", detail: "NATHAN_ACCESS_KEY is not set." }, 503);
  if (!safeEqual(req.headers.get("x-nathan-key") ?? "", gate)) {
    return json({ error: "unauthorized", detail: "Wrong or missing access key." }, 401);
  }

  let body: { action?: string; limit?: number; uid?: number };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request", detail: "Body must be JSON." }, 400);
  }

  try {
    if (body.action === "probe") {
      const greeting = await probeImap();
      return json({ ok: true, greeting });
    }

    const { user, pass } = mailCreds();
    if (!user || !pass) {
      return json({
        error: "setup",
        detail: "Email isn't connected — set ICLOUD_MAIL_USER and ICLOUD_MAIL_PASSWORD in Supabase secrets.",
      }, 503);
    }

    switch (body.action) {
      case "inbox": {
        const messages = await listInbox(user, pass, Math.min(Math.max(body.limit ?? 10, 1), 25));
        return json({ messages });
      }
      case "read": {
        if (!body.uid) return json({ error: "bad_request", detail: "uid is required." }, 400);
        const message = await readMail(user, pass, body.uid);
        return json({ message });
      }
      default:
        return json({ error: "bad_request", detail: "Unknown action." }, 400);
    }
  } catch (e) {
    return json({ error: "imap", detail: String(e).slice(0, 400) }, 502);
  }
});
