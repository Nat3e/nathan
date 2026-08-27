// ─────────────────────────────────────────────────────────────────────────────
//  Minimal CREATE-ONLY CalDAV client — writes events to iCloud Calendar.
//
//  Same iCloud app-specific password as mail and contacts. Deliberately
//  create-only: the ONLY write ever issued is a PUT with "If-None-Match: *",
//  which the server rejects if anything already exists at that address.
//  Modifying or deleting an existing event is impossible by construction.
// ─────────────────────────────────────────────────────────────────────────────

const CALDAV_ROOT = "https://caldav.icloud.com";

async function dav(method: string, url: string, user: string, pass: string, headers: Record<string, string>, body: string): Promise<Response> {
  return await fetch(url, {
    method,
    headers: {
      "Authorization": "Basic " + btoa(user + ":" + pass),
      ...headers,
    },
    body,
  });
}

const xmlUnescape = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
   .replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function firstHref(xml: string, insideTag: string): string | undefined {
  const scope = xml.match(new RegExp(`<[^>]*${insideTag}[^>]*>([\\s\\S]*?)</[^>]*${insideTag}[^>]*>`, "i"));
  const m = (scope ? scope[1] : "").match(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href[^>]*>/i);
  return m ? xmlUnescape(m[1].trim()) : undefined;
}

/* the user's event calendars: href + display name, in server order */
async function listCalendars(user: string, pass: string): Promise<{ href: string; name: string }[]> {
  const rootRes = await dav("PROPFIND", CALDAV_ROOT + "/", user, pass,
    { "Depth": "0", "Content-Type": "application/xml; charset=utf-8" },
    `<propfind xmlns="DAV:"><prop><current-user-principal/></prop></propfind>`);
  const principal = firstHref(await rootRes.text(), "current-user-principal");
  if (!principal) throw new Error("caldav: no principal");

  const homeRes = await dav("PROPFIND", new URL(principal, CALDAV_ROOT).href, user, pass,
    { "Depth": "0", "Content-Type": "application/xml; charset=utf-8" },
    `<propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><prop><C:calendar-home-set/></prop></propfind>`);
  const home = firstHref(await homeRes.text(), "calendar-home-set");
  if (!home) throw new Error("caldav: no calendar home");
  const homeUrl = new URL(home, CALDAV_ROOT).href.replace(/\/?$/, "/");

  const listRes = await dav("PROPFIND", homeUrl, user, pass,
    { "Depth": "1", "Content-Type": "application/xml; charset=utf-8" },
    `<propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">` +
    `<prop><displayname/><resourcetype/><C:supported-calendar-component-set/></prop></propfind>`);
  const xml = await listRes.text();

  const out: { href: string; name: string }[] = [];
  for (const resp of xml.split(/<\/[^>]*?response>/i)) {
    /* a calendar collection: its <resourcetype> holds a calendar element —
       iCloud writes it as <calendar xmlns="urn:ietf:params:xml:ns:caldav"/>,
       other servers as <C:calendar/>, so match both spellings */
    const rt = (resp.match(/<resourcetype[\s\S]*?<\/resourcetype>/i) || [""])[0];
    if (!/[<:]calendar[\s/>]/i.test(rt)) continue;
    const href = (resp.match(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href[^>]*>/i) || [])[1];
    if (!href) continue;
    const name = xmlUnescape((resp.match(/<[^>]*displayname[^>]*>([^<]*)<\/[^>]*displayname[^>]*>/i) || [])[1] || "");
    if (/inbox|outbox|notification|freebusy/i.test(href)) continue;
    /* iCloud quotes comp names with single quotes; accept either */
    if (/comp[^>]+name=['"]VTODO['"]/i.test(resp) && !/comp[^>]+name=['"]VEVENT['"]/i.test(resp)) continue;
    if (/reminder|rappel|t[aâ]che|task|birthday|anniversaire|jours fériés|holiday/i.test(name)) continue;
    out.push({ href: new URL(xmlUnescape(href.trim()), homeUrl).href.replace(/\/?$/, "/"), name });
  }
  if (!out.length) throw new Error("caldav: no event calendars found");
  return out;
}

const icsEscape = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

const utcStamp = (d: Date) =>
  d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

/* create one event in his real iCloud calendar; returns where it landed */
export async function addCalendarEvent(
  user: string,
  pass: string,
  ev: { title: string; start: string; end?: string; notes?: string },
): Promise<{ calendar: string; uid: string }> {
  const start = new Date(ev.start);
  if (isNaN(start.getTime())) throw new Error("bad start date: " + ev.start);
  const end = ev.end ? new Date(ev.end) : new Date(start.getTime() + 3600000);
  if (isNaN(end.getTime()) || end <= start) throw new Error("bad end date");

  const cals = await listCalendars(user, pass);
  /* prefer his main personal calendar by name; otherwise the first one */
  const cal = cals.find((c) => /^(home|domicile|calendar|calendrier|personal|personnel)$/i.test(c.name.trim())) ?? cals[0];

  const uid = crypto.randomUUID() + "@nathan";
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Nathan Assistant//EN",
    "BEGIN:VEVENT",
    "UID:" + uid,
    "DTSTAMP:" + utcStamp(new Date()),
    "DTSTART:" + utcStamp(start),
    "DTEND:" + utcStamp(end),
    "SUMMARY:" + icsEscape(ev.title.slice(0, 200)),
    ...(ev.notes ? ["DESCRIPTION:" + icsEscape(ev.notes.slice(0, 800))] : []),
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");

  const res = await dav("PUT", cal.href + uid + ".ics", user, pass,
    {
      "Content-Type": "text/calendar; charset=utf-8",
      /* the whole safety story: refuse to touch anything that already exists */
      "If-None-Match": "*",
    }, ics);
  if (!res.ok) throw new Error(`caldav PUT → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { calendar: cal.name || "Calendar", uid };
}
