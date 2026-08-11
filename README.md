# Cast

Your cast of characters.

A browser app for roleplay chats with characters you write yourself. It runs entirely in your
browser, keeps everything on your own device, and works with whichever AI provider you feel like
using, including several that cost nothing.

**Try it: [castrp.netlify.app](https://castrp.netlify.app)**

Nothing to install and no account to make. Bring an API key from any of the providers below, or
point it at a model running on your own machine.

This replaces Gemini Character Roleplay. The name changed because Gemini is no longer the only
thing it talks to.

## What it does

- Write your own characters, with a description and a picture
- Chat with them and pick up old conversations whenever you like
- Search by name, by description, or by something one of you actually said
- Works properly on a phone, where the character list becomes a simple app style menu
- Save everything to a single file and load it back later

Your characters, chats and keys live in your browser and nowhere else. There is no account and no
server of ours involved. The only thing that leaves your device is the conversation you send to
whichever provider you picked.

## Getting started

1. Open [castrp.netlify.app](https://castrp.netlify.app), or your own copy
2. Go to Settings and pick a provider
3. Paste your key and type a model name
4. Press **Check the connection**, which tells you plainly if something is wrong
5. Go to Characters, write one, and start talking

## Providers

All of these have a free tier of some kind. Switching between them takes a few seconds, and you can
have several set up at once.

| Provider | What you need | Worth knowing |
| --- | --- | --- |
| Google Gemini | A key from Google AI Studio | The most capable free option, but only 20 requests a day per model |
| OpenRouter | A key from openrouter.ai | Anything ending in `:free` costs nothing |
| NVIDIA NIM | A key starting `nvapi-` | Free credits, no card needed |
| Groq | A key from console.groq.com | Far faster than anything else here |
| Cerebras | A key from cloud.cerebras.ai | Generous daily allowance, also very fast |
| Mistral | A key from console.mistral.ai | Large monthly allowance, but the free tier trains on what you send |
| GitHub Models | A GitHub token with models read access | Wide model choice |
| Ollama | Ollama running on your computer | Free and completely private |
| LM Studio | LM Studio running on your computer | Free and completely private |
| Custom | Any address speaking the OpenAI chat format | For providers that did not exist when this was written |

If you keep hitting limits on Gemini, Groq and Cerebras are the two worth trying next. The Gemini
daily cap is per model, so switching from `gemini-3.6-flash` to `gemini-3.5-flash-lite` also gives
you a fresh allowance straight away.

### Model names are something you type

Every provider on that list changes its catalogue regularly, and free tiers change fastest of all.
Names that worked last month get retired and new ones appear constantly, so a fixed dropdown would
have been out of date within days of writing this.

Three ways to set a model, all of which work:

- Type the name yourself, which always works, including for something released this morning
- Press **Load available models** to ask the provider what it currently has, with a **Free models
  only** tick box for OpenRouter that reads the real prices rather than guessing
- Leave the suggestion that is already there

Retired Gemini names are quietly mapped to their nearest replacement, so an old backup opens on a
model that still exists. A name this app has never heard of is left exactly as you typed it,
because an unfamiliar name is far more likely to be something new than a mistake.

### Providers that will not talk to a web page

A browser refuses a request to another domain unless that API sends back headers saying it is
allowed. Gemini, OpenRouter, Ollama and LM Studio do. NVIDIA NIM and GitHub Models do not, and
NVIDIA has been asked to add it for years without it happening.

When a browser blocks a request it never sends it at all, and reports a plain network failure with
no status code. That looks like the app is broken when in fact nothing left your machine.

The fix is a proxy: a small function running on your own site that makes the request from the server
side, where the restriction does not apply, and hands the answer back. One is included at
`netlify/functions/ai-proxy.mjs`, so deploying to Netlify makes it work with no setup. The address
is worked out from wherever the app is served, and there is a field in Settings if yours lives
somewhere else.

Three things worth knowing about it.

Your key goes from your browser to your own function and on to the provider. It is not stored and
not logged. That is the reason to run your own rather than use a public CORS proxy, which would mean
handing your key to a stranger's server.

It only forwards to a fixed list of provider hosts, so it cannot be found and used to relay traffic
anywhere else. If you add a provider, add its host to `ALLOWED_HOSTS` in that file.

Opening `index.html` from disk cannot work for these providers, because there is no server to run
the function. Gemini, OpenRouter, Ollama and LM Studio are all fine that way.

| Provider | From a web page |
| --- | --- |
| Gemini, OpenRouter | Directly |
| Ollama, LM Studio | Directly, on your own machine |
| NVIDIA NIM, GitHub Models | Through the proxy |
| Groq, Cerebras, Mistral, Custom | Tries directly, falls back to the proxy if blocked |

### Using a model on your own machine

A browser will not let a page on the open internet quietly reach into your own machine. Chrome
calls this Local Network Access, and from version 142 it asks permission the first time a public
site tries to reach localhost or an address on your network. If that prompt is dismissed, the
request simply fails.

What you need depends on where the page is:

| Where the page is | Where the model is | What you need |
| --- | --- | --- |
| Opened from a file, or from localhost | localhost | Nothing. Same place, so no permission is involved |
| The deployed site | localhost on the same computer | Allow the permission prompt when it appears, or use the bridge to skip it |
| A phone on the deployed site | Your computer, by network address | The bridge. This is the case it exists for |

The bridge is `local-ai-bridge.user.js` in this repository. It sends requests aimed at a local
address through Tampermonkey rather than the browser's own fetch, and an extension is not bound by
these rules. Everything else is untouched, so Gemini and OpenRouter still go the normal way.

To set it up:

1. Install Tampermonkey in the browser you open the app in
2. Install `local-ai-bridge.user.js`
3. Keep the phone and the computer on the same wifi
4. Start Ollama or LM Studio with local network access turned on
5. In Settings, use your computer's network address, something like `http://192.168.1.25:11434`,
   rather than `localhost`

If a local model will not connect and both the page and the model are on the same machine, it is
usually the server rather than the browser. Ollama needs `OLLAMA_ORIGINS` set before it will accept
requests from a browser. LM Studio accepts them by default.

## Finding a character

The search boxes look in three places: names, descriptions, and the messages inside your
conversations. A half remembered line is enough to find someone even when you cannot recall which
character said it.

Any filtered list says how many it is hiding and gives you a button to clear it, so a search can
never quietly make it look as though characters have gone missing.

## Appearance

Settings has light, dark, and match my device. Matching the device follows it as it changes,
including at sunset if your system does that. The choice is applied before the page is drawn, so the
light theme never flashes first.

## Chat layout

Settings has a choice between two arrangements.

**Modern** is a board of your characters with search, showing what you last said to each. It is the
way in, so there is no list down the side.

**Classic** is the list down the side, as the app has always looked. On a wide screen it can be
hidden and brought back.

On a phone neither applies. The list is the screen and tapping a name opens the chat, which works
well, so it is left alone.

## Long conversations

There is a setting called **Summarise the older part of long chats**, off by default.

A model has no memory. Every time you press send, the whole conversation goes with it. Early on that
costs nothing worth thinking about. By message two hundred every reply is resending all two hundred,
so the total cost of a chat grows with the square of its length. Measured on a real chat from this
app, 219 messages long, the final turn alone sent about 15,600 tokens and the chat as a whole had
sent roughly 1.7 million.

With the setting on, once a chat passes roughly 16,000 tokens the older messages are replaced, for
sending only, with written notes under fixed headings: where things stand, what has been established
as true, how the two are with each other, what is unresolved, and what recently happened. The most
recent twenty messages are still sent word for word, because the scene right now needs exact
wording.

**It never changes your messages.** Not one is edited, moved or deleted. The notes are kept beside
the chat. Turn the setting off and the next reply sees the whole conversation again. That is the one
promise this feature makes and there are tests specifically for it.

If summarising fails, the chat carries on sending its full history. A summary is also checked before
it is trusted: too short, wrong shape, a refusal, or not actually smaller than what it replaced all
get thrown away. After three failures in a row it stops trying for that chat. Summarising only ever
runs after a reply has arrived, so it can never make a message slower.

The honest tradeoff is that notes are less precise than the real thing. An exact turn of phrase from
early on can be lost. That is why it is off by default. If you want a story word perfect from
beginning to end, leave it off and pay for the tokens.

## Nothing is deleted without asking

Every action that destroys something asks first, and the question says what will actually be lost
rather than just are you sure. Deleting a character tells you how many chats and messages go with
them.

Cancel holds focus when the dialog opens, so a stray tap does the safe thing. Escape cancels, and so
does tapping outside.

## Backups

Press **Save a backup** in Settings. You get one file holding your characters, chats, history and
settings, named so you can tell what is in it without opening it:

```
cast-backup-2026-08-09-1432-09-9-chars-25-chats-745-messages.json
```

That is the date, the time to the second, and the counts. Because the date leads and uses dashes,
sorting a folder of these by name also sorts them by date.

**Your API keys are left out by default.** There is a tick box if you want them included, but it
starts off, because a backup file is the sort of thing people send to each other and a key in one is
a key given away.

Loading a backup tells you what is in the file and what it is about to replace, and asks before
doing anything. Before it writes it takes a copy of what you already have, and if anything goes
wrong partway through it puts that copy back.

The app occasionally reminds you to make one. It stays quiet: never in the first few minutes of a
session, never twice in one session, and dismissing it buys a week of silence.

Backup files from every earlier version still open, including from Gemini Character Roleplay. There
are tests that check this against a real file from 2025.

## How replies are formatted

Write your characters expecting ordinary markdown, because that is what models produce without being
asked.

- `*single asterisks*` for actions, gestures and thoughts, shown in italics
- `**double asterisks**` to stress a word, shown in bold
- `_underscores_` and `__double underscores__` work the same way, since models mix them
- `##` at the start of a line for a heading, and `## wrapped like this ##` for a scene band
- `-` or `1.` for lists, `>` for a quote, `---` for a rule
- Backticks for anything that should appear exactly as written

An italic run of four words or more is treated as a stage direction and shown in a muted grey. A
shorter one is treated as a stressed word and takes the colour of the surrounding speech, so an
action reads as an aside and an emphasised word reads as part of what the character is saying.

An asterisk at the start of a line is an action, not a bullet point. Ordinary markdown would make it
a list, but in a roleplay that is almost never what is meant.

If a marker is never closed it shows as an ordinary character and nothing else is affected. Emphasis
never carries across a blank line.

## When changes take effect

Everything takes effect on your next message. There is nothing to reload.

| Changed | Applies from |
| --- | --- |
| A character's description or enhanced profile | the next message |
| Your name, personality or context | the next message |
| Model, provider or key | the next message |
| Creativity or response limit | the next message |

The instructions sent to the model are rebuilt from scratch for every reply, reading the current
records at that moment rather than anything captured earlier.

Two things deliberately do not change retroactively. Replies already in the chat stay as they were
written, since they are a record of what happened. And if you have long chat summarising switched
on, notes already made are kept, because they describe the conversation rather than the character.

## Running your own copy

Open `index.html` directly and everything works except providers that need the proxy.

For the proxy, and for reaching a model on your own machine, serve it over http:

```
npm start
```

then open `http://127.0.0.1:3000`. The server needs nothing installed.

To deploy your own, point Netlify at the repository. `netlify.toml` does the rest.

There is a build step, but only just. `build.js` copies the app into `public/` and that is what gets
published. It exists because Netlify does not want the functions directory sitting inside the
directory being published, and publishing the repository root would also serve the source as static
files. Nothing is compiled, and opening `index.html` from the repository still works exactly as
before.

If a provider that needs the proxy is not working after deploying, open Settings and press **Test
the proxy**. It asks the proxy directly and tells you whether the function is running, which is
quicker than guessing from a failed chat.

## Tests

```
npm test
```

435 tests, no dependencies to install. They use Node's own test runner.

They cover the parts that can run without a browser: separating reasoning from replies including
streams split character by character, loading with every kind of damaged data, backup round trips
against a real file from 2025, markdown against the exact message that once rendered wrong, the
provider registry and proxy routing, turn taking for group chats, notifications, the sliding
navigation, ID generation, escaping, and picture sizing.

Three of them are about the app as a whole rather than one piece of it, and they are the ones that
catch the most:

- **`tests/app-structure.test.js`** checks the way the code is arranged. Every script the page loads
  exists, every file on disk is loaded by the page, no two files declare the same name, only
  `src/app/boot.js` runs anything at load time, and nothing has grown past 800 lines. Most mistakes
  in a pull request that adds a file are caught here.
- **`tests/app-boot.test.js`** loads every file the page loads, in the same order, into a stand in for
  a browser, and then starts the app. It starts it from nothing, from a realistic amount of data, and
  from six kinds of damaged storage. It also compares every name the app defines against a recorded
  list, so a function cannot quietly go missing.
- **`tests/app-behaviour.test.js`** calls the app's own functions inside a started app and checks what
  comes back: filtering and sorting, what actually gets sent to a model, a deleted message being
  hidden but kept, a message becoming markup, replies going through the sanitiser, sending, and a
  backup that can be read back in.

Several exist specifically to replay old faults, so if one fails again you will know immediately.

The stand in for a browser is in `tools/domstub.js`. It is not a browser and does not try to be:
nothing is laid out or drawn, so it says nothing about how the app looks. What it proves is that
every file parses, that they work together, and that starting up runs to the end.

Two things about it are worth knowing before you write a test against it, because both have already
caused a test to pass while checking nothing:

- **Asking for an element the page does not have gives `null`,** the same as in a browser. It did not
  always: it used to hand back an element for any id asked for, which made every `if (element)` check
  true and sent the app down branches a browser never takes. A test that names an id wrongly now fails
  instead of quietly measuring an element nobody has.
- **Values have to be brought across as JSON.** An array made inside the app is not the same kind of
  array as one made in a test, so comparing the two directly fails even when the contents match. Use
  `JSON.parse(run('JSON.stringify(...)'))`.

Start up runs each step inside its own guard, so one failing does not stop the rest. That means
nothing is thrown and a broken step can look like a clean start. `bootApp` reads the app's own log
afterwards and reports them as `stepFailures`, which the tests check.

Anything involving real network calls, the picture store, or how things look still needs a browser
and a real key to check.

## Running it locally, including the providers that block browsers

```
npm start
```

Then open the address it prints. This is the way to run it while working on it, and not only because
it serves the files.

Some providers will not accept a request that comes straight from a web page. NVIDIA NIM is the well
known one: it sends no CORS headers, so the browser refuses to send the request at all and reports
"Failed to fetch" with no status code. That reads like the app is broken when in fact nothing ever
left your machine.

The development server is also the proxy, at `/api/proxy`, which the app finds on its own with no
setting to change. So NVIDIA NIM, Groq, Cerebras, Mistral, GitHub Models and the rest work on your own
machine, and you no longer have to deploy the site to find out whether a provider works.

Opening `index.html` straight from disk still works for everything else. It cannot work for those
providers, and it never will: a `file://` page has no server behind it to be the proxy, so there is
nowhere for the request to go. The app now says exactly that, and says to run `npm start`, rather than
failing with a network error that looks like a bug.

The rules about what may be forwarded where are in `proxy-rules.js`, shared by the development server
and the Netlify function so the two cannot disagree. It is not an open proxy: it forwards only to the
provider hosts listed in that file. Your key goes from your browser to your own proxy to the provider,
and nowhere else, which is the reason to run your own rather than use a public CORS proxy.

## Versions

The number in Settings comes from `src/brand.js`. `package.json` carries the same one, and a test
checks the two agree. Every release is written up in `CHANGELOG.md`, newest first, and a test fails if
the top entry is not the version the app reports.

What each part of the number means here: the last number is a fix with nothing else changed, the middle
one is anything a person would notice, and the first would be a change that made old data unreadable,
which has not happened and should not.

## The log

Settings has an activity and error log, open by default, newest first. It records what changed and
what failed: characters added, edited and deleted, chats cleared and deleted, messages deleted,
backups saved and loaded, profiles built, conversations summarised, settings changed, and every
failure including a reply that did not arrive, a save that did not fit, the proxy not answering,
data that could not be read, and anything that went wrong unexpectedly.

Failures are marked in red and can be shown on their own with **Failures only**. **Copy** puts the
whole thing on your clipboard along with which version, provider and model you are on, which is the
useful thing to paste when asking anyone for help.

Entries since your last backup are brighter than the rest, so it doubles as a record of what you
would lose.

There is also a structure check for the page itself, which counts tags and watches nesting depth.
Worth running before committing markup changes:

```
python3 verify-html.py index.html
```

## How the code is arranged

It used to be one file of 8,301 lines. It is now about fifty files, none over 700, and each one says
at the top what it is for. Nothing else about how the app works changed when it was split up.

There are two layers. **`src/`** holds the pieces that stand on their own: each knows nothing about
the rest of the app, each is tested directly, and each also loads under Node. **`src/app/`** is the
app itself, grouped by what part of it you are working on.

### The standalone pieces

| File | What it handles |
| --- | --- |
| `src/brand.js` | The app name, in one place, so renaming it is one edit |
| `src/ids.js` | Generating IDs that are unique and a fixed length |
| `src/escape.js` | Making text safe to put into the page |
| `src/markdown.js` | Turning a reply into what you see |
| `src/input.js` | What a keypress in the message box does |
| `src/activitylog.js` | A record of what changed and when |
| `src/toast.js` | Notifications that take themselves away |
| `src/segmentnav.js` | The sliding navigation |
| `src/group.js` | Who speaks next in a group chat |
| `src/confirm.js` | Asking before anything is deleted |
| `src/storage.js` | Loading and saving without ever losing anything |
| `src/images.js` | Shrinking pictures and keeping them out of the way |
| `src/thinking.js` | Telling reasoning apart from the actual reply |
| `src/providers.js` | The list of providers and how to talk to each |
| `src/memory.js` | Summarising long chats without touching them |
| `src/backup.js` | Filenames, reminders, and loading old files |

### The app

| File | What it handles |
| --- | --- |
| `src/app/state.js` | The two objects the whole app works from: your settings, and what is happening now |
| `src/app/storage.js` | Reading and writing storage, and what to do when it will not fit |
| `src/app/format.js` | Dates, sizes, and the debounce the search boxes use |
| `src/app/notices.js` | Putting notifications on the screen |
| `src/app/activity.js` | Writing and showing the log |
| `src/app/ai/settings.js` | Which provider is in use, and what key, model and address it should use |
| `src/app/ai/transport.js` | Getting a request out of the browser, and explaining it when it does not go |
| `src/app/ai/client.js` | Asking a model for a reply |
| `src/app/ai/context.js` | Building what the model actually receives |
| `src/app/data/load.js` | Reading everything back at start up, whatever shape it is in |
| `src/app/data/chats.js` | Which characters a chat belongs to |
| `src/app/data/pictures.js` | Profile pictures, and keeping them out of the text storage |
| `src/app/ui/theme.js` | Light, dark, and how wide the chat runs |
| `src/app/ui/navigation.js` | Moving between the parts of the app |
| `src/app/ui/sidebar.js` | The character list down the side |
| `src/app/ui/home.js` | The first screen |
| `src/app/ui/search.js` | Finding a character, and putting them in an order |
| `src/app/characters/form.js` | Writing a character, and changing one later |
| `src/app/characters/list.js` | Drawing the characters, and choosing who is in a chat |
| `src/app/characters/remove.js` | Deleting a character, and everything that pointed at them |
| `src/app/characters/enhance.js` | Turning a sentence about a character into a profile |
| `src/app/chat/session.js` | Opening a chat, starting a new one, clearing one out |
| `src/app/chat/history.js` | Keeping past conversations, and getting back into one |
| `src/app/chat/messages.js` | Turning messages into what you see |
| `src/app/chat/message-edit.js` | Changing a message after it was sent, and taking one back |
| `src/app/chat/send.js` | Sending, and everything that happens while you wait |
| `src/app/chat/respond.js` | Getting one character's reply, from the request to the words on screen |
| `src/app/chat/compaction.js` | Keeping a long chat inside the token budget |
| `src/app/settings/panel.js` | Settings that are not about a provider |
| `src/app/settings/providers.js` | Choosing a provider and a model |
| `src/app/settings/diagnostics.js` | The two buttons that answer "why is this not working" |
| `src/app/backup/transfer.js` | Taking everything out as a file, and putting it back |
| `src/app/backup/reminder.js` | A quiet nudge to take a backup |
| `src/app/events.js` | Connecting the controls on the page to the code that runs |
| `src/app/boot.js` | Starting the app. The only file that runs anything by itself |

### Why plain scripts

These are ordinary scripts loaded in order rather than ES modules, on purpose. It means opening
`index.html` straight from disk still works, with no build step and nothing to install. Each file
also loads under Node, which is how the tests run.

Because they are plain scripts, every file shares one scope. Two files declaring the same name is
not an error the browser reports: the second quietly replaces the first, and the first becomes code
that looks live and never runs. That happened once, to `callGeminiAPI`, and a test now checks for it.

Order matters in one way only. `src/app/state.js` comes first because everything reads from it, and
`src/app/boot.js` comes last because it is the only file that runs anything at load time. Everything
in between only declares functions, so it can be reordered freely. There is a test for that too.

If you add a file, add it to `index.html`. The build reads its list of scripts from there, so nothing
has to be kept in step by hand.

### The one long function

`getCharacterResponse` in `src/app/chat/respond.js` is about 550 lines and is the longest thing in the
project. It is where the most can go wrong: a reply arrives a piece at a time, the chat can be closed
or switched while it is still coming, the model can stop halfway, and the request can fail after some
of the text is already on screen. Every way out of it, including the failures, has to remove the
typing indicator and clear the pending flag, or the chat is left looking like it is still thinking.

It has not been broken up because its parts share too much state to separate without changing
behaviour, and a change there is felt by everyone using the app. If you take it on, the thing to
check is what happens when a reply is interrupted, not what happens when it works.

## The tools

Small things in `tools/`, none of which the app needs to run:

| File | What it does |
| --- | --- |
| `tools/domstub.js` | A pretend browser, complete enough to load and start the app under Node |
| `tools/loadapp.js` | Loads the app the way the page does, reading the file list out of `index.html` |
| `tools/chunker.js` | Splits a file into its top-level declarations, used by the structure tests |
| `tools/record-globals.js` | Records every name the app defines, for `tests/app-boot.test.js` to compare against |
| `tools/make-fixture.js` | Regenerates the test data in `tests/fixture-app-data.json` |

The test data is generated rather than taken from a real export, because a fixture made from someone's
actual backup would put their conversations in a public repository.

## What was fixed coming from Gemini Character Roleplay

Each of these was a real problem, and each has a test to stop it coming back.

**Reasoning appearing instead of the reply.** Models that think before answering produce two things,
the working out and the reply, and the old version treated both as one blob of text. So the working
out ended up in the chat bubble, and sometimes it was the only thing saved. The old version also
tried to stop this by asking the model in words not to think, which was never going to work, and
that instruction was being glued onto every character's description where it quietly interfered
with their personality. Reasoning is now kept short through the settings that actually control it
and separated from the reply afterwards, including when a tag arrives split across two chunks of a
stream.

**A character answering the instructions instead of you.** Every turn built a line like "Remember
that you are roleplaying as X" and sent that as the message, while what you typed went in only as
history. The model often replied to the reminder. It showed up worst after a short message such as
"ok". The character profile is a system instruction now, and the message sent is what you wrote. The
profile also used to be sent only on the first message of a chat, so it is now sent every turn.

**Everything looking deleted.** The app used to come up blank sometimes, because loading assumed
every stored value was the right type and one wrong value threw partway through with nothing
catching it. The data was always still there. Worse, a tidy up routine deleted history entries whose
chat body it could not find and saved that immediately, so one unreadable value destroyed the lot.
Values are now checked one at a time, a bad one is set aside rather than deleted, and every start up
step runs inside its own guard.

**Running out of room.** Pictures were stored as text alongside everything else, in a space browsers
limit to about five megabytes. On a real backup, four pictures were using three megabytes and the
whole thing was two thirds full with only nine characters. Every message saved rewrote all the
chats, so once the limit was reached those saves failed, nothing checked whether they had worked,
and the newest messages vanished on the next reload. Pictures are now shrunk when you add them and
kept somewhere with far more room, failed saves are reported, and every save is checked by reading
it back.

**Backups quietly missing your pictures.** An early version of Cast moved pictures to their own
store and left the export reading the character records, so a backup claimed to have pictures and
contained none. Fixed, with a test that a backup cannot claim a picture it does not carry.

**Chat history filed under the wrong name.** New chats got an ID like `abc123-1741404473116`, and
elsewhere the app worked out which characters a chat belonged to by splitting that apart. A
timestamp passed the test it used, so the timestamp was treated as a character. In a real backup, 13
of 22 history groups were affected. A chat now records its members as actual data, and old data is
repaired on load without losing anything.

**Editing a character threw away its enhanced profile.** The save routine cleared it on the grounds
that the description had changed, so correcting a typo in a name lost several thousand characters of
work. It is now shown in the edit panel, editable, and saved like any other field.

**Enter did not send a message.** It sent only when there was text in the box and did nothing when
the box was empty, so Enter inserted a newline in that one case, while the placeholder said "Enter
for new line". Enter sends now, Shift with Enter makes a new line, and an empty Enter asks the
character to carry on.

**Italics inverted themselves partway through a reply.** Emphasis was handled by one regular
expression that ran before the markdown parser. It could not see double asterisks, so a single bold
word left a stray marker, and because the expression matched across blank lines that stray paired
with the opening marker of the next action line. It is a proper parser now.

**Deleting a character could delete the wrong chats.** The check was whether the character's ID
appeared inside the chat's ID as plain text, which is not the same question.

**A search in one place hid characters in another.** The chat list search and the characters page
search wrote to the same stored value, so typing in one filtered both, with nothing on screen saying
why. They are separate now, and any filtered list says how many it is hiding.

**Other things.** Character names were not escaped, which mattered because opening someone else's
backup would run whatever they put in a name. IDs could come out very short, about one in five
thousand, with no check for repeats. The markdown library loaded whichever version was newest, so
the app could break overnight with no change on your side. The default response limit was too low
for models that reason, since reasoning and reply share one budget.

## A note on privacy

Your characters, chats and keys live in your browser and nowhere else. There is no account and no
server of ours involved. The only thing leaving your machine is the conversation you send to
whichever provider you picked, and their own terms apply to that. Mistral's free tier in particular
trains on what you send it, which is worth knowing before using it for anything you would rather
keep to yourself.

Clearing your browser data will delete everything, so keep backups.

## Known gaps

**Group chat is not finished.** The logic for deciding who speaks next is written and tested,
including a simulation showing an even spread of turns across four characters, but it is not wired
into the app yet. Nothing calls it, so it cannot affect anything.

**Tailwind loads from a CDN** rather than being built into a stylesheet. It prints a console warning
and is not meant for production use. Fine for a personal tool, worth changing if this grows.

**There is debug logging left in.** Useful while building, noisy in a finished app.
