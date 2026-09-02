# Changelog

The version shown in Settings comes from `src/brand.js`, and `package.json` carries the same number.
A test checks the two agree, because a version that is wrong in one of them is worse than having none:
it is what people paste when asking for help, and it decides which set of bugs you are looking at.

Anything marked **fixed** was a real fault someone could hit, and each one has a test named after it so
it cannot come back quietly.

## 2.27.0

Thinking controls and more natural roleplay.

**Added: model thinking can be inspected without leaking into the roleplay.** Providers that return
reasoning now keep it beside the reply as separate data. Each reply has a compact, accessible
**Model thinking** disclosure that can be opened and closed, and Generation Settings can choose
whether those disclosures start open. Reasoning is plain text, never executable markup, and is not
sent back as dialogue on later turns.

**Improved: roleplay guidance protects the reader's agency and continuity.** Characters are now told
not to invent the reader's dialogue, actions, feelings, or consent; to answer the latest turn before
moving the scene; to avoid repetitive gestures and phrasing; and to preserve established scene and
relationship facts. Replies are also directed to leave room for the reader rather than resolving an
entire scene at once.

**Fixed: a recovered streaming reply could still be followed by an outage notice.** A successful
emergency retry now ends the request as a success.

## 2.26.0

Provider compatibility and failure handling.

**Fixed: OpenAI-compatible providers were all sent a provider-specific option.** The shared request
body included `reasoning_effort` for every service. That field is not part of the common chat
completions format, and compatible services may reject fields they do not understand. The common
request now contains only portable fields; an adapter can still opt in when its provider explicitly
supports reasoning effort.

**Fixed: a failed reply could be reported in whichever chat was open later.** Successful replies
already remembered their originating conversation, but the final failure handler read the currently
open chat and character. The request now captures its destination, and one durable failure reply is
written there without duplicate fallback apologies. A successful emergency retry is also treated as
success instead of being followed by an outage message.

## 2.25.0

Requests that never come back.

**Fixed: nothing ever gave up.** There was no time limit at any point in the chain: not in the app, not
in the development server, not in the Netlify function. A provider that accepted the connection and then
said nothing left the request open for as long as the browser was willing to hold it. **Check the
connection** showed "Connecting to NVIDIA NIM." and went on showing it. Rebuilding a character profile
did the same. No error, no timeout, nothing to click, and no way to tell a slow model from a dead one.

Every request now has a limit, in all three places. When it runs out you are told which provider went
quiet, that it was given up on rather than that something is broken, and what to try: a smaller model,
or a longer wait.

**Added: "Give up after", in Generation Settings.** 150 seconds by default, which is long enough for a
very large model to start and short enough that nobody concludes the app has stopped working. A 500
billion parameter model on a free tier really can take minutes, so it is adjustable, and a nonsense
value falls back rather than meaning no limit.

**Added: CAST_PROXY_EXTRA_HOSTS and CAST_PROXY_TIMEOUT_MS.** Hosts you add yourself may be plain http,
which is what you want for a model running on your own machine or network. The built in provider list
stays https only, and adding one host does not open the proxy to anything else.

**Fixed: the test that claimed to go from browser to proxy to provider and back did not do that.** The
stand in provider was on plain http, which the rules refuse, so the test fell back to checking the
planning and then called the stand in directly, skipping the proxy. The forwarding, which is the part
that matters, was never tested at all. It is now, end to end through a real server on a real port,
along with a provider that goes quiet and a provider that refuses the connection.

## 2.24.0

Doing something else while a reply is still arriving.

**Fixed: a typing indicator could be left in a chat forever.** When a reply failed, the failure was
reported and the function returned normally rather than throwing, so the tidying up in the outer catch
never ran and the indicator stayed. If you had moved to another character in the meantime you would not
see it happen, and going back to that conversation showed it still apparently writing, with nothing
short of a reload to clear it. The indicator is now taken away on every path out of a reply, not only
the ones that succeed.

**Added: a sweep for indicators nothing is working on.** The backstop for the paths nobody has found.
A reload in the middle of a reply, or a tab a phone suspended and woke later, leaves a message in
stored data marked as writing with no request behind it. That is now cleared when a chat is opened and
once at start up. A chat with a reply genuinely on its way is left alone.

**Checked: a reply cannot land in the wrong conversation.** Ask a question, switch to another
character while it is still coming, and the reply goes to the conversation it was asked for. Same for
your own message, and for the line a character says when they could not answer. Nine tests hold a
reply open, do something else, and then let it go, which is the only way to test a race deliberately
rather than wait for one.

**Checked: changing provider mid-reply.** Going to Settings and picking another provider while a reply
is arriving no longer risks losing it. A request that was already made is still delivered, since it was
a real answer, and the app is left able to send the next message.

**Written down: only one reply is in flight at a time.** This is a lock across the whole app, and it is
what stops two conversations writing over each other. It also means you cannot talk to a second
character while the first is still answering. That is a limitation rather than a bug, and there is now a
test for it so that changing it is a decision rather than an accident.

Also in this release: a test of the above passed while checking nothing, because the second message it
tried to send was refused by that lock and so there was never anything to leak. It has been replaced
with one that checks the refusal, and the real fault it was meant to find was then located separately.

## 2.23.0

The interface, and being able to test providers without deploying.

**Fixed: the header covered the top of the modals.** Both the edit panel and the chat history panel
were marked `z-50` in the markup, while the header was 51 on a narrow screen and 100 on a wide one, and
the message box on a phone was also 100. The heading of the panel and the button that closes it were
behind the header, so you could open a panel and not close it. There is now one stacking ladder in
`style.css` with every floating layer named, and nothing sets its own number next to the element.

**Fixed: selecting text closed the panel.** A click handler on the dark area outside also fires when a
drag that started inside the panel ends outside it, so selecting the text of a description and letting
go threw away the edit. Both the press and the release now have to be on the dark area. The same fault,
and the same fix, in the dialog that asks before anything is deleted.

**Fixed: dark mode on tinted panels.** An audit of every colour class used anywhere in the app found 26
of 35 with no dark rule at all, including the tinted result panels in Settings, which were pastel with
dark text on a dark page. Dark mode is now driven by tokens rather than a rule per panel, and a test
fails if a colour is used without one, or if a raw colour value creeps back into the rules.

**Fixed: the close button on the chat history panel.** It was hand rolled rather than using
`modal-close-btn`, so every dark mode rule written for that class missed it and it was invisible on a
dark background. Both panels now use the same control, checked by a test.

**Added: the development server is also the proxy.** `npm start` now serves `/api/proxy`, which the app
finds on its own. NVIDIA NIM, Groq, Cerebras, Mistral and GitHub Models work on your own machine, so
testing a provider no longer means deploying the site first. The rules about what may be forwarded
where moved to `proxy-rules.js`, shared with the Netlify function, since two copies of a host list is
how you get a provider that works locally and not once deployed.

**Added: a clear message when the app is opened from a file.** A `file://` page has no server behind it
to be the proxy, so a provider that refuses browser requests cannot work and never will. Every attempt
came back as "Failed to fetch" with no status, which reads like the app is broken. It now says what is
wrong and to run `npm start`.

**Fixed: `corsPolicy` given a provider id returned the wrong answer.** It only accepted a provider
object, and handed a string it found no `cors` field and returned `try-direct`, the least cautious of
the three answers. Every caller happened to pass an object so nothing was broken, but a helper whose
wrong answer is the unsafe one should not depend on which shape it was given.

## 2.22.0

The one file became fifty.

`script.js` was 8,301 lines. It is now 35 files under `src/app/`, grouped by what part of the app you
are working on, with a median of 158 lines and a header on each one saying what it is for. No code was
retyped: every declaration was moved as the exact bytes it already was, and the result was checked
declaration by declaration against the original.

**Added: the app can be started outside a browser.** There was no way to run any of it under Node
before, so a change could only be checked by opening the page and clicking. `tools/loadapp.js` loads
every file the page loads, in the same order, into a stand in for a browser and starts the app. It is
not a browser and says nothing about how things look, but it proves every file parses, that they work
together, and that starting up runs to the end.

**Fixed: keys were written into every backup.** With "include key in backups" turned off,
`buildExport` correctly left out the top level `apiKeys` and then copied the whole settings object into
the file, and settings is where the keys are kept. Anyone who sent a backup to someone else, or put one
in a bug report, sent their key with it. The switch now covers every field a key has ever lived in.

**Fixed: creating a character reported success and failure at once.** `createNewCharacter` was wired to
the button in two places, so one click ran it twice: the first call made the character and cleared the
form, and the second found an empty form and complained. You got "Character created successfully" and
"Please provide a name for your character" together, which reads like the save failed when it had
worked.

**Fixed: a function that could never have run.** `callGeminiAPI` was declared twice. The second
declaration silently replaced the first, so the version using `conversationTokens` had never run at
all. A test now fails if any two files declare the same name, which is the fault that hid it.

**Added: tests about the shape of the project.** Every script the page loads exists, every file on disk
is loaded by the page, no two files declare the same name, only `boot.js` runs anything at load time,
and nothing has grown past 800 lines.

## Before 2.22.0

Not recorded here. `README.md` has a section on what was fixed coming from Gemini Character Roleplay,
which covers the faults this project started by dealing with.
