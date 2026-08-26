# Nathan — setup

> **Nathan runs on Claude** with two gears, picked in the gear icon:
> **⚡ Fast** (Haiku — near-instant, ~¼ cent a message) and **🧠 Smart**
> (Sonnet — deeper thinking, ~1c a message). Memory, board and finances
> are shared either way.

Three things stand between you and a working assistant. Do them in order; each takes a couple of minutes.

---

## 1. Give the brain its keys

The backend is already deployed. It just needs two secrets.

Open this page (it's your project's secrets page, direct link):

<https://supabase.com/dashboard/project/pgsbqcpmnjhfhonswtin/functions/secrets>

Add each of these as a Key / Value pair and press Save:

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Create it at <https://platform.claude.com/settings/keys> → **Create Key**. Copy it immediately, it's shown once. Add credits first at <https://platform.claude.com/settings/billing> — API usage is billed separately from a Claude subscription. |
| `NATHAN_ACCESS_KEY` | Any long random string — this is your own password for the endpoint. Not an Anthropic thing; you invent it. |
| `ELEVENLABS_API_KEY` *(optional)* | Gives Nathan his real voice (works on phones). Create it at elevenlabs.io → profile icon → API Keys. Without it the app falls back to the browser's built-in voice. |
| `NATHAN_MODEL` | *(optional)* `claude-sonnet-5` is the default. `claude-opus-5` is smarter and pricier. `claude-haiku-4-5-20251001` is much faster and cheaper — a good daily driver; switch back when you want deep thinking. |

**Never put these in the HTML file or paste them into a chat.** The Edge Function reads them
from Supabase's environment; nothing else can see them.

Secrets take effect immediately — no redeploy needed.

---

## 2. Unlock with your code — that's the whole setup

Open the app and type your 4-digit lock code. The server checks it, hands the browser
its access key, and the badge goes from *Demo mode* to *Online*. A brand-new phone
needs nothing else — no pasted keys, no links.

Wrong guesses are rate-limited **server-side**: every 3rd miss locks tries for
5 → 15 → 30 → 60 minutes. Changing the code in Settings changes it for every device.
(The gear icon still accepts a manually pasted `NATHAN_ACCESS_KEY` as a fallback.)

The key is kept in your browser's local storage only. It is sent as a header to your own
Supabase function and nowhere else.

At this point **chat works** — even opening the file straight from your hard drive.

---

## 3. Put it on a real address (this is what unlocks voice)

Chrome refuses microphone access to pages opened as `file:///...`. The voice button
will only work once the page is served over **https://** or **http://localhost**.

**Easiest option — no install, ~30 seconds:**

1. Go to <https://app.netlify.com/drop>
2. Drag the `nathan-assistant` folder onto the page
3. You get an https link immediately

That link works from your phone too, which is the point — Nathan in your pocket.

**If you'd rather keep it local** and you have Node installed:

```
cd "C:\Users\nataj\OneDrive\A I\Project NATHAN\nathan-assistant"
npx --yes serve -l 3000
```

Then open <http://localhost:3000>.

---

## What you get

- **Voice in** — click the mic (or press `Space`), talk, and it transcribes live under the orb.
  With *"Send as soon as I stop talking"* on, it sends itself.
- **Voice out** — Nathan reads his replies aloud. Pick the voice, speed and pitch in
  settings (with a *Listen* preview) — Nathan auto-picks the most natural voice your
  browser has. **Tip:** open the page in Microsoft Edge for its free "Natural" voices,
  which sound close to a real person. Toggle speech off in settings if you'd rather read.
- **Memory** — the brain loads everything in your Supabase `memory.files` before every reply,
  and can write new facts back. When it saves something you'll see a green
  *"remembered"* chip under the message.
- **Conversation history** — the last 20 turns are kept in `memory.conversations`, so it
  doesn't forget mid-conversation.
- **A live board** — the Briefing, Waiting On, Coming Up and Projects panels are real.
  Tell Nathan "add calling Marc to my list" or "I'm seeing the dentist Thursday at 2"
  and the panels update (green *"board updated"* chip). Ticking a task saves it too.
- **A calendar** — the calendar icon in the header (or *Calendar* next to Coming Up)
  opens a month view of every plan with a date. It refreshes every time Nathan
  learns a new one, and you can quick-add plans right on a day.
- **Finances** — tell Nathan what you earned, spent, or owe ("hydro bill, $84, due
  Friday") and it lands in the Finances panel; *Open* shows the month's ledger with
  In/Out/Net, and unpaid bills sit on your calendar until you mark them paid.
  Amounts are CAD.
- **Photos in chat** — the image button in the composer (or just paste a screenshot)
  sends a photo with your message. Nathan reads receipts, screenshots and documents —
  snap a bill and say "log this". Photos are sent to the brain but never stored.
- **Habits** — the Habits tab (header nav, or the phone tab bar) tracks daily
  habits with a 7-day trail and streaks. Add them there or tell Nathan.
- **Email** — Nathan can read your iCloud inbox, strictly read-only (he can never
  send, delete, or mark anything as read). Ask "check my email" or "anything
  important in my inbox?", and the Night Shift flags overnight mail in the morning
  briefing with draft replies you can copy. To connect: create an **app-specific
  password** at <https://account.apple.com> → Sign-In & Security → App-Specific
  Passwords (never your real password, revocable there any time), then add two
  secrets in Supabase → Edge Functions → Secrets: `ICLOUD_MAIL_USER` (your full
  address) and `ICLOUD_MAIL_PASSWORD` (the app-specific password). To disconnect:
  delete the secrets, revoke the password at Apple.
- **The Night Shift** — every night around 5:30 AM, Nathan wakes up on his own:
  reviews your calendar for the day, flags unpaid bills and stale items, researches
  your projects' space with live web search, and writes a morning briefing. Tap the
  *☀️ Morning briefing* chip (or just ask) and it's already there. Costs roughly
  5–10¢ a night in API usage. Turn it off any time in the Supabase SQL editor:
  `select cron.unschedule('nathan-nightshift');`

---

## Files

```
nathan-assistant/
  index.html                              the whole front end
  SETUP.md                                this file
  start.bat                               serves the page on localhost
  supabase/
    config.toml                           function config (verify_jwt stays off)
    migrations/                           the database: tables, RPCs, permissions
    functions/nathan-brain/index.ts       the brain (deployed)
    functions/nathan-memory/index.ts      the data plane: board, money, habits
    functions/nathan-nightshift/index.ts  the overnight briefing writer
    functions/_shared/http.ts             CORS + auth helpers shared by all
```

The whole backend is reproducible from this folder: `supabase db push` recreates the
database, `supabase functions deploy` redeploys the functions (config.toml keeps
`verify_jwt` off — they do their own auth). Only the secrets from step 1 live
outside the repo, on purpose.

The Briefing and Projects panels are live: they render the `memory.items` table via the
`nathan-memory` function, and both brains manage it with the `add_item` / `update_item`
tools. The `TASKS`/`WAITING`/`UPCOMING`/`PROJECTS` constants in `index.html` are only
the demo preview shown before an access key is set.

---

## Troubleshooting

| What you see | What it means |
|---|---|
| *"NATHAN_ACCESS_KEY is not set"* | Step 1 isn't done — check the spelling of the secret name |
| *"Wrong or missing access key"* | The key in settings doesn't match the Supabase secret |
| `invalid x-api-key` | The `ANTHROPIC_API_KEY` secret is wrong — recopy it, watch for stray spaces |
| A `404 model not found` error | Set `NATHAN_MODEL` to a model your account can use |
| `credit_balance_too_low` | Add credits at <https://platform.claude.com/settings/billing> |
| Mic does nothing | You're on `file:///` — do step 3 |
| Chat works, voice doesn't | Same thing — step 3 |
