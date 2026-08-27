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
//  POST { action: "contacts", query? }   → { contacts: [{name, phones, emails, birthday?, org?}], total }
//    His iCloud contacts, read-only via CardDAV — the same app-specific
//    password that unlocks mail unlocks these. Nothing is ever written.
//  POST { action: "calendar_add", event:{title,start,end?,notes?} } → { ok, calendar, uid }
//    CREATE-ONLY write to his real iCloud calendar — existing events can
//    never be modified or deleted through this path (see _shared/caldav.ts).
//  POST { action: "bank_sync" }          → { ok, scanned, fresh, logged, balance? }
//    Scans recent mail for bank alert emails (EN/FR, any Canadian bank),
//    extracts transactions with Haiku, logs them to the money tracker
//    (deduplicated by mail UID), and remembers the latest balance in the
//    memory file /finances/bank.md. Run hourly by the nathan-bank-sync cron.
// ─────────────────────────────────────────────────────────────────────────────
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { CORS, json, safeEqual } from "../_shared/http.ts";
import { listInbox, mailCreds, probeImap, readMail } from "../_shared/imap.ts";
import { findContacts, listContacts } from "../_shared/carddav.ts";
import { addCalendarEvent } from "../_shared/caldav.ts";

/* does this email smell like a bank alert? sender or subject, English or French */
const BANK_FROM = /(desjardins|rbc|royalbank|banquenationale|bnc\b|nbc\b|scotiabank|scotia|bmo|\btd\b|tdcanadatrust|cibc|tangerine|interac|wealthsimple|koho|neo-?financial|eqbank|laurentienne|laurentian)/i;
const BANK_SUBJ = /(alert|transaction|deposit|withdraw|balance|payment|purchase|transfer|e-?transfer|debit|credit|virement|retrait|d[ée]p[ôo]t|solde|op[ée]ration|paiement|achat|re[çc]u|sent you|vous a envoy[ée])/i;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const gate = Deno.env.get("NATHAN_ACCESS_KEY");
  if (!gate) return json({ error: "setup", detail: "NATHAN_ACCESS_KEY is not set." }, 503);
  if (!safeEqual(req.headers.get("x-nathan-key") ?? "", gate)) {
    return json({ error: "unauthorized", detail: "Wrong or missing access key." }, 401);
  }

  let body: {
    action?: string; limit?: number; uid?: number; query?: string;
    event?: { title?: string; start?: string; end?: string; notes?: string };
  };
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
      case "calendar_add": {
        /* create-only write to his REAL iCloud calendar (see _shared/caldav.ts):
           existing events can never be modified or deleted through this path */
        const ev = body.event;
        if (!ev?.title || !ev?.start) {
          return json({ error: "bad_request", detail: "event.title and event.start are required." }, 400);
        }
        const placed = await addCalendarEvent(user, pass, {
          title: ev.title, start: ev.start, end: ev.end, notes: ev.notes,
        });
        return json({ ok: true, ...placed });
      }

      case "contacts": {
        const all = await listContacts(user, pass);
        const hits = body.query ? findContacts(all, body.query) : all;
        return json({
          contacts: hits.slice(0, Math.min(Math.max(body.limit ?? 50, 1), 200)),
          total: hits.length,
        });
      }

      case "bank_sync": {
        const db = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        );
        const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
        if (!apiKey) return json({ error: "setup", detail: "ANTHROPIC_API_KEY is not set." }, 503);

        /* 1. recent mail → the ones that look like bank alerts */
        const msgs = await listInbox(user, pass, 25);
        const cands = msgs.filter((m) => BANK_FROM.test(m.from) || BANK_SUBJ.test(m.subject));
        if (!cands.length) return json({ ok: true, scanned: 0, fresh: 0, logged: 0 });

        /* 2. skip everything already processed (dedup by mail UID) */
        const { data: unseen, error: seenErr } = await db.rpc("nathan_bank_unseen", {
          p_uids: cands.map((m) => m.uid),
        });
        if (seenErr) return json({ error: "db", detail: String(seenErr) }, 500);
        const freshUids = new Set((unseen ?? []) as number[]);
        const fresh = cands.filter((m) => freshUids.has(m.uid)).slice(0, 8);
        if (!fresh.length) return json({ ok: true, scanned: cands.length, fresh: 0, logged: 0 });

        /* 3. read the fresh ones in full and have Haiku pull out the numbers */
        const bodies: string[] = [];
        for (const m of fresh) {
          try {
            const full = await readMail(user, pass, m.uid);
            bodies.push(`[uid ${m.uid}] ${m.date}\nFrom: ${m.from}\nSubject: ${m.subject}\n${full.body.slice(0, 1500)}`);
          } catch {
            bodies.push(`[uid ${m.uid}] ${m.date}\nFrom: ${m.from}\nSubject: ${m.subject}\n${m.snippet}`);
          }
        }
        const extractRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: Deno.env.get("NATHAN_MODEL_FAST") ?? "claude-haiku-4-5-20251001",
            max_tokens: 1500,
            system:
              "You extract banking data from alert emails (English or French). " +
              "Return ONLY a JSON array, no prose. One object per email: " +
              '{"uid": <number from [uid N]>, "kind": "income"|"expense"|null, ' +
              '"title": short label like "Interac from Marc" or "Tim Hortons", ' +
              '"amount": number in CAD or null, "when": ISO 8601 date from the email, ' +
              '"balance": account balance in CAD if the email states one, else null}. ' +
              "kind is income for money received/deposited, expense for money spent/withdrawn, " +
              "null if the email is not an actual transaction (promo, statement notice, login alert).",
            messages: [{ role: "user", content: bodies.join("\n\n=====\n\n") }],
          }),
        });
        if (!extractRes.ok) {
          const detail = await extractRes.text();
          return json({ error: "anthropic", detail: detail.slice(0, 400) }, 502);
        }
        const extractData = await extractRes.json();
        const rawText = (extractData.content ?? [])
          .filter((b: { type: string }) => b.type === "text")
          .map((b: { text: string }) => b.text).join("");
        let entries: { uid?: number; kind?: string | null; title?: string; amount?: number | null; when?: string; balance?: number | null }[] = [];
        try {
          const m = rawText.match(/\[[\s\S]*\]/);
          entries = m ? JSON.parse(m[0]) : [];
        } catch { entries = []; }

        /* 4. log real transactions; remember the newest stated balance */
        let logged = 0;
        let balance: number | null = null;
        let balanceWhen = "";
        for (const e of entries) {
          if ((e.kind === "income" || e.kind === "expense") && Number(e.amount) > 0) {
            try {
              const { error } = await db.rpc("nathan_money_add", {
                p_kind: e.kind,
                p_title: (e.title || "Bank transaction").slice(0, 80),
                p_amount: Number(e.amount),
                p_category: "bank",
                p_note: "auto from bank alert email",
                p_when: e.when ?? null,
                p_status: null,
              });
              if (!error) logged++;
            } catch { /* skip a bad row, keep the rest */ }
          }
          if (e.balance != null && Number(e.balance) >= 0) { balance = Number(e.balance); balanceWhen = e.when ?? ""; }
        }
        if (balance != null) {
          try {
            await db.rpc("nathan_remember", {
              p_path: "/finances/bank.md",
              p_name: "bank-balance",
              p_category: "preferences",
              p_description: "Latest bank balance, from bank alert emails (auto-updated)",
              p_content: `# Bank\nBalance: $${balance.toFixed(2)} CAD` +
                (balanceWhen ? ` as of ${balanceWhen}` : "") +
                `\n(from bank alert emails — updated automatically by the hourly sync)`,
            });
          } catch { /* balance memory is nice-to-have */ }
        }

        /* 5. mark every fresh candidate processed, transaction or not */
        await db.rpc("nathan_bank_mark", { p_uids: fresh.map((m) => m.uid) });

        return json({ ok: true, scanned: cands.length, fresh: fresh.length, logged, ...(balance != null ? { balance } : {}) });
      }

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
