// ─────────────────────────────────────────────────────────────────────────────
//  Minimal read-only IMAP client — enough to list and read iCloud Mail.
//
//  Deliberately read-only: EXAMINE (never SELECT) and BODY.PEEK (never BODY),
//  so nothing is ever marked read, moved, or deleted. There is no send path.
//
//  iCloud: host imap.mail.me.com, port 993, login = full address +
//  app-specific password from account.apple.com.
// ─────────────────────────────────────────────────────────────────────────────

export type MailMeta = {
  uid: number;
  seen: boolean;
  from: string;
  subject: string;
  date: string;
  snippet: string;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`imap timeout: ${what}`)), ms)),
  ]);
}

/* RFC 2047 encoded words in headers: =?utf-8?B?...?= / =?iso-8859-1?Q?...?= */
function decodeWords(s: string): string {
  s = s.replace(/(\?=)\s+(=\?)/g, "$1$2"); // whitespace between adjacent words is ignored
  return s.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, cs, kind, data) => {
    try {
      let bytes: Uint8Array;
      if (/b/i.test(kind)) {
        bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      } else {
        const out: number[] = [];
        for (let i = 0; i < data.length; i++) {
          const c = data[i];
          if (c === "_") out.push(32);
          else if (c === "=" && i + 2 < data.length + 1) { out.push(parseInt(data.slice(i + 1, i + 3), 16)); i += 2; }
          else out.push(c.charCodeAt(0));
        }
        bytes = new Uint8Array(out);
      }
      const charset = cs.toLowerCase().split("*")[0] || "utf-8";
      return new TextDecoder(charset).decode(bytes);
    } catch { return whole; }
  });
}

/* best-effort body → plain text: undo base64 / quoted-printable, strip HTML */
function cleanBody(raw: string): string {
  let s = raw.trim();
  const compact = s.replace(/\s+/g, "");
  if (compact.length > 40 && /^[A-Za-z0-9+/=]+$/.test(compact)) {
    try { s = dec.decode(Uint8Array.from(atob(compact), (c) => c.charCodeAt(0))); } catch { /* not base64 */ }
  }
  if (/=[0-9A-F]{2}/.test(s) || /=\r?\n/.test(s)) {
    s = s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => {
      try { return String.fromCharCode(parseInt(h, 16)); } catch { return _; }
    });
  }
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ")
       .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
       .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  return s.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

type Segment = { text?: string; literal?: string };

class Imap {
  private conn!: Deno.TlsConn;
  private buf = new Uint8Array(0);
  private tagN = 0;

  async connect(host: string, port = 993): Promise<string> {
    this.conn = await deadline(Deno.connectTls({ hostname: host, port }), 15000, "connect");
    return await this.readLine(); // server greeting
  }

  closeRaw(): void {
    try { this.conn.close(); } catch { /* fine */ }
  }

  private async fill(): Promise<void> {
    const chunk = new Uint8Array(16384);
    const n = await deadline(this.conn.read(chunk), 20000, "read");
    if (n === null) throw new Error("imap: connection closed");
    const merged = new Uint8Array(this.buf.length + n);
    merged.set(this.buf); merged.set(chunk.subarray(0, n), this.buf.length);
    this.buf = merged;
  }

  private async readLine(): Promise<string> {
    while (true) {
      for (let i = 0; i + 1 < this.buf.length; i++) {
        if (this.buf[i] === 13 && this.buf[i + 1] === 10) {
          const line = dec.decode(this.buf.subarray(0, i));
          this.buf = this.buf.subarray(i + 2);
          return line;
        }
      }
      await this.fill();
    }
  }

  private async readBytes(n: number): Promise<string> {
    while (this.buf.length < n) await this.fill();
    const out = dec.decode(this.buf.subarray(0, n));
    this.buf = this.buf.subarray(n);
    return out;
  }

  /* send a command; return every untagged segment (lines + literals in order) */
  async cmd(command: string): Promise<Segment[]> {
    const tag = "A" + (++this.tagN);
    await deadline(writeAll(this.conn, enc.encode(tag + " " + command + "\r\n")), 15000, "write");
    const segs: Segment[] = [];
    while (true) {
      let line = await this.readLine();
      if (line.startsWith(tag + " ")) {
        if (!/^A\d+ OK/i.test(line)) throw new Error("imap: " + line.slice(tag.length + 1, tag.length + 200));
        return segs;
      }
      /* a line may end in {n} announcing a literal, possibly repeatedly */
      while (true) {
        const m = line.match(/\{(\d+)\}$/);
        segs.push({ text: line });
        if (!m) break;
        segs.push({ literal: await this.readBytes(Number(m[1])) });
        line = await this.readLine(); // continuation of the same response
      }
    }
  }

  async login(user: string, pass: string): Promise<void> {
    const q = (s: string) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    await this.cmd(`LOGIN ${q(user)} ${q(pass)}`);
  }

  /* read-only mailbox open; returns message count */
  async examine(box = "INBOX"): Promise<number> {
    const segs = await this.cmd(`EXAMINE ${box}`);
    for (const s of segs) {
      const m = s.text?.match(/^\* (\d+) EXISTS/);
      if (m) return Number(m[1]);
    }
    return 0;
  }

  async close(): Promise<void> {
    try { await this.cmd("LOGOUT"); } catch { /* fine */ }
    this.closeRaw();
  }
}

async function writeAll(conn: Deno.TlsConn, data: Uint8Array): Promise<void> {
  let off = 0;
  while (off < data.length) off += await conn.write(data.subarray(off));
}

/* group FETCH segments into one bundle per message (paren balance over text parts) */
function fetchBundles(segs: Segment[]): Segment[][] {
  const bundles: Segment[][] = [];
  let cur: Segment[] | null = null;
  let depth = 0;
  for (const s of segs) {
    if (!cur && s.text && /^\* \d+ FETCH/i.test(s.text)) { cur = []; depth = 0; }
    if (!cur) continue;
    cur.push(s);
    if (s.text) {
      for (const ch of s.text) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
      }
      if (depth <= 0 && cur.length > 0) { bundles.push(cur); cur = null; }
    }
  }
  return bundles;
}

function headerValue(headers: string, name: string): string {
  const unfolded = headers.replace(/\r?\n[ \t]+/g, " ");
  const m = unfolded.match(new RegExp("^" + name + ":\\s*(.*)$", "im"));
  return m ? decodeWords(m[1].trim()) : "";
}

function bundleParse(b: Segment[]): MailMeta {
  const text = b.map((s) => s.text ?? "").join(" ");
  const uid = Number((text.match(/UID (\d+)/) || [])[1] || 0);
  const seen = /FLAGS \([^)]*\\Seen/i.test(text);
  let headers = "", body = "";
  for (let i = 0; i < b.length; i++) {
    const t = b[i].text ?? "";
    const lit = b[i + 1]?.literal;
    if (lit == null) continue;
    if (/HEADER\.FIELDS/i.test(t)) headers = lit;
    else if (/BODY\[1\]/i.test(t)) body = lit;
  }
  return {
    uid,
    seen,
    from: headerValue(headers, "From"),
    subject: headerValue(headers, "Subject") || "(no subject)",
    date: headerValue(headers, "Date"),
    snippet: cleanBody(body).slice(0, 260),
  };
}

/* ── public API ── */

/* secret names are case-sensitive and phones love to autocapitalize —
   accept the common spellings so a hand-typed secret still connects */
export function mailCreds(): { user?: string; pass?: string } {
  const pick = (...names: string[]) => {
    for (const n of names) {
      const v = Deno.env.get(n);
      if (v) return v.trim();
    }
    return undefined;
  };
  return {
    user: pick("ICLOUD_MAIL_USER", "Icloud_mail_user", "icloud_mail_user", "iCloud_mail_user"),
    pass: pick("ICLOUD_MAIL_PASSWORD", "Icloud_mail_password", "icloud_mail_password", "iCloud_mail_password"),
  };
}

export async function probeImap(host = "imap.mail.me.com"): Promise<string> {
  const im = new Imap();
  const greeting = await im.connect(host);
  im.closeRaw();
  return greeting.slice(0, 200);
}

export async function listInbox(user: string, pass: string, limit = 10): Promise<MailMeta[]> {
  const im = new Imap();
  await im.connect("imap.mail.me.com");
  try {
    await im.login(user, pass);
    const exists = await im.examine("INBOX");
    if (!exists) return [];
    const lo = Math.max(1, exists - Math.min(limit, 25) + 1);
    const segs = await im.cmd(
      `FETCH ${lo}:${exists} (UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] BODY.PEEK[1]<0.500>)`,
    );
    return fetchBundles(segs).map(bundleParse).sort((a, b) => b.uid - a.uid);
  } finally {
    await im.close();
  }
}

export async function readMail(user: string, pass: string, uid: number): Promise<MailMeta & { body: string }> {
  const im = new Imap();
  await im.connect("imap.mail.me.com");
  try {
    await im.login(user, pass);
    await im.examine("INBOX");
    const segs = await im.cmd(
      `UID FETCH ${uid} (UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)] BODY.PEEK[1]<0.20000>)`,
    );
    const bundles = fetchBundles(segs);
    if (!bundles.length) throw new Error("no message with uid " + uid);
    const meta = bundleParse(bundles[0]);
    let body = "";
    for (let i = 0; i < bundles[0].length; i++) {
      const t = bundles[0][i].text ?? "";
      const lit = bundles[0][i + 1]?.literal;
      if (lit != null && /BODY\[1\]/i.test(t)) body = lit;
    }
    return { ...meta, body: cleanBody(body).slice(0, 8000) };
  } finally {
    await im.close();
  }
}
