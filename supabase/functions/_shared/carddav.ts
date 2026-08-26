// ─────────────────────────────────────────────────────────────────────────────
//  Minimal read-only CardDAV client — enough to read iCloud Contacts.
//
//  Uses the SAME iCloud app-specific password as the mail reader (an
//  app-specific password unlocks IMAP and CardDAV alike), so contacts work
//  the moment mail does. Read-only by construction: only PROPFIND, REPORT
//  and GET are ever issued — nothing can be created, changed, or deleted.
// ─────────────────────────────────────────────────────────────────────────────

export type Contact = {
  name: string;
  phones: string[];
  emails: string[];
  birthday?: string;
  org?: string;
};

const CARDDAV_ROOT = "https://contacts.icloud.com";

async function dav(method: string, url: string, user: string, pass: string, depth: string, body: string): Promise<string> {
  const res = await fetch(url, {
    method,
    headers: {
      "Authorization": "Basic " + btoa(user + ":" + pass),
      "Depth": depth,
      "Content-Type": "application/xml; charset=utf-8",
    },
    body,
  });
  if (res.status !== 207 && !res.ok) {
    throw new Error(`carddav ${method} ${new URL(url).pathname} → ${res.status}`);
  }
  return await res.text();
}

const xmlUnescape = (s: string) =>
  s.replace(/&#13;/g, "\r").replace(/&#10;/g, "\n").replace(/&lt;/g, "<")
   .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function firstHref(xml: string, insideTag: string): string | undefined {
  const scope = xml.match(new RegExp(`<[^>]*${insideTag}[^>]*>([\\s\\S]*?)</[^>]*${insideTag}[^>]*>`, "i"));
  const m = (scope ? scope[1] : "").match(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href[^>]*>/i);
  return m ? xmlUnescape(m[1].trim()) : undefined;
}

/* unfold vCard line continuations, then pull the fields that matter */
function parseVcards(text: string): Contact[] {
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const out: Contact[] = [];
  for (const block of unfolded.split(/BEGIN:VCARD/i).slice(1)) {
    const card = block.split(/END:VCARD/i)[0];
    const get = (prop: string) => {
      const re = new RegExp(`^${prop}(?:;[^:\\r\\n]*)?:(.+)$`, "gim");
      const vals: string[] = [];
      let m;
      while ((m = re.exec(card))) vals.push(m[1].trim());
      return vals;
    };
    const fn = get("FN")[0] ?? get("N")[0]?.split(";").filter(Boolean).reverse().join(" ");
    if (!fn) continue;
    const clean = (s: string) => s.replace(/\\([,;])/g, "$1").trim();
    out.push({
      name: clean(fn),
      phones: [...new Set(get("TEL").map((t) => t.replace(/[^\d+#*ext.,]/gi, "").trim()).filter(Boolean))],
      emails: [...new Set(get("EMAIL").map(clean).filter(Boolean))],
      birthday: get("BDAY")[0]?.trim() || undefined,
      org: get("ORG")[0] ? clean(get("ORG")[0].replace(/;+$/, "")) : undefined,
    });
  }
  return out;
}

/* everything in his address book, via discovery → collection listing → cards */
export async function listContacts(user: string, pass: string): Promise<Contact[]> {
  const rootXml = await dav("PROPFIND", CARDDAV_ROOT + "/", user, pass, "0",
    `<propfind xmlns="DAV:"><prop><current-user-principal/></prop></propfind>`);
  const principal = firstHref(rootXml, "current-user-principal");
  if (!principal) throw new Error("carddav: no principal");

  const homeXml = await dav("PROPFIND", new URL(principal, CARDDAV_ROOT).href, user, pass, "0",
    `<propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><prop><C:addressbook-home-set/></prop></propfind>`);
  const home = firstHref(homeXml, "addressbook-home-set");
  if (!home) throw new Error("carddav: no addressbook home");
  const homeUrl = new URL(home, CARDDAV_ROOT).href.replace(/\/?$/, "/");
  const collection = homeUrl + "card/";

  /* try one-shot query first; some servers want multiget instead */
  try {
    const xml = await dav("REPORT", collection, user, pass, "1",
      `<C:addressbook-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">` +
      `<D:prop><C:address-data/></D:prop></C:addressbook-query>`);
    const cards = parseVcards(xmlUnescape(xml));
    if (cards.length) return cards;
  } catch { /* fall through to multiget */ }

  const listXml = await dav("PROPFIND", collection, user, pass, "1",
    `<propfind xmlns="DAV:"><prop><getetag/></prop></propfind>`);
  const hrefs = [...listXml.matchAll(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href[^>]*>/gi)]
    .map((m) => xmlUnescape(m[1].trim()))
    .filter((h) => /\.vcf$/i.test(h))
    .slice(0, 500);
  const cards: Contact[] = [];
  for (let i = 0; i < hrefs.length; i += 50) {
    const batch = hrefs.slice(i, i + 50);
    const xml = await dav("REPORT", collection, user, pass, "1",
      `<C:addressbook-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">` +
      `<D:prop><C:address-data/></D:prop>` +
      batch.map((h) => `<D:href>${h.replace(/&/g, "&amp;")}</D:href>`).join("") +
      `</C:addressbook-multiget>`);
    cards.push(...parseVcards(xmlUnescape(xml)));
  }
  return cards;
}

/* accent-and-case-insensitive search across name, org, email */
export function findContacts(all: Contact[], query: string): Contact[] {
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const q = norm(query.trim());
  if (!q) return all;
  return all.filter((c) =>
    norm(c.name).includes(q) ||
    (c.org && norm(c.org).includes(q)) ||
    c.emails.some((e) => norm(e).includes(q)));
}
