# Contributing

This is a roleplay app for people who want to write their own characters, and it is meant to be easy
to help with. There is no build step, no packages to install, and no framework to learn. If you can
write plain JavaScript you can change anything here.

## Getting set up

```
git clone <your fork>
cd Cast
npm test
```

That is the whole setup. There is nothing to install: the tests use Node's own test runner and the app
uses no packages at all.

To use the app, open `index.html` in a browser. Straight from disk is fine. If you would rather serve
it:

```
npm start
```

You need Node 18 or newer, and an API key from whichever provider you want to use. Everything the app
stores stays in your browser.

## Before you send a change

```
npm test
python3 verify-html.py index.html
```

Both should pass. The second one only matters if you touched `index.html`.

If a test fails and you think the test is wrong rather than your change, say so in the pull request
and explain why. Several tests exist to replay faults that happened once already, and those are worth
arguing about rather than deleting.

## Where things live

`src/` holds the pieces that stand on their own, each tested directly. `src/app/` is the app itself,
grouped by what part of it you are working on. The README has a table of every file and what it
handles; that is the fastest way to find where something happens.

If you are not sure where a change belongs, search for a string you can see in the app. The file that
produces it is almost always the file you want.

## Some common changes

**Adding a provider.** `src/providers.js`, and usually nothing else. Anything that speaks the OpenAI
chat format shares one code path, so a new one is a row in the registry rather than new code. The
settings screen works out which fields to show from what you put there.

**Changing how characters behave.** `src/app/ai/context.js`. This is where the profile, what the app
was told about you, and the guidance on staying in character are assembled into what gets sent. It is
the most useful file to read if you want better replies, and the easiest place to make them worse. The
long text in it is a prompt, not code, so treat an edit to it as something everyone using the app will
notice.

**Changing how a message looks.** `src/app/chat/messages.js` builds the markup for one message.
`src/markdown.js` turns the reply text into formatting. `style.css` is plain CSS with Tailwind classes
in the markup.

**Adding a control to the page.** Put it in `index.html`, then connect it in `src/app/events.js`.
Nearly every listener in the app is attached from that one file in a single pass at start up, which is
what stops the same button being wired twice. A message being sent two at a time is what that looks
like when it goes wrong.

**Adding a setting.** Give it a default in `src/app/state.js` with a comment saying what it is for. If
it replaces an older field, move the old value across in `migrateSettingsShape` in
`src/app/data/load.js` rather than resetting it, so nobody loses what they had chosen.

**Adding a file.** Add it to `index.html` as well. The build reads its list of scripts from there, so
there is no second list to keep in step, and a test will tell you if you forget.

## Two rules that are easy to break

**Every file shares one scope.** These are ordinary scripts, not modules. If two files declare the
same name, the second quietly replaces the first and the first becomes code that looks live and never
runs. That has already happened once. There is a test for it, so you will find out, but it is worth
knowing why the test exists.

**Only `src/app/boot.js` runs anything at load time.** Every other file just declares functions. That
is what makes the load order safe to change and start up easy to follow. If you need something to
happen at start up, add a step to `boot.js` rather than running it where it is defined. There is a test
for this one too.

## Nothing is deleted without asking

This matters more here than in most apps, because everything lives in one browser and there is no
server holding a copy. Two habits follow from it:

- Anything destructive goes through `src/confirm.js` first.
- Data that looks wrong is kept, not deleted. A chat whose character is gone, a history entry whose
  messages are missing, a settings field in an unexpected shape: all of these are set aside rather
  than dropped, because the missing half may come back from a backup and a delete cannot be undone.

If your change deletes or overwrites anything, record it in the activity log
(`src/app/activity.js`). That log is what people paste when they ask for help, and a change that left
no trace is the hardest kind to work out afterwards.

## Writing tests

Most things can be tested without a browser. There are two ways in:

For a piece in `src/`, require it and call it. Those files have no idea there is a page, which is the
point of them.

For anything in `src/app/`, start the whole app and call its functions:

```js
const { bootApp } = require('../tools/loadapp');
const vm = require('node:vm');

const app = await bootApp({ storage: { /* what is already saved */ } });
const run = (expression) => vm.runInContext(`(${expression})`, app.context);

assert.strictEqual(run('filterCharacters(state.characters, "Ada").length'), 1);
```

`tests/app-behaviour.test.js` has plenty of examples. Two things to watch:

- Some functions build a DOM element and return it rather than returning a string. An element turns
  into `[object Object]`, so a test that compares one without serialising it compares fifteen
  identical characters and passes on nothing. Use `serialize` from `tools/loadapp.js`.
- Bring values across as JSON: `JSON.parse(run('JSON.stringify(...)'))`. An array made inside the app
  is not the same kind of array as one made in your test, so comparing them directly fails even when
  the contents match.
- Asking for an element the page does not have gives `null`. If you mistype an id, the test fails
  rather than quietly measuring nothing. Check the id is really in `index.html`.
- The harness does not sanitise. `DOMPurify` is stood in for and records its calls instead, so a test
  can check that a reply was routed through it, but not that sanitising works. Whether DOMPurify does
  its job is tested by DOMPurify.
- Start up catches each step, so a broken one throws nothing. Check `app.stepFailures`, not just
  `app.failures`.

Every one of those points is there because a test of mine passed while checking nothing, and it took
a bug report from a real machine to notice.

If you change the set of functions the app defines, run `node tools/record-globals.js` and read the
diff before committing it. That file is how a function that quietly disappeared gets noticed.

## Writing comments

The comments here explain why, not what. A comment saying a loop iterates over characters is worth
nothing; a comment saying a character is looked up again rather than reused so that an edit applies to
the next message is worth a lot. If a piece of code looks odd, the reason it is odd is the thing to
write down, and quite a lot of this project is odd because of a real fault that happened once.

Plain English, and no need to be formal about it.

## Versions and the changelog

Bump the version in `src/brand.js` and `package.json` together, and add an entry at the top of
`CHANGELOG.md`. Tests check all three agree, so a pull request that forgets one will say so.

Write the entry as what a person would notice, not as what you changed in the code. "The header covered
the top of the edit panel" is useful; "adjusted z-index values" is not. If it was a real fault, say so
and say what it looked like, because that is what someone searching the changelog is searching for.

## What to work on

Anything in the app that annoyed you is a good place to start; the annoying parts are the ones nobody
has looked at. Known gaps are listed at the end of the README.

Small pull requests are easier to read and get merged faster than large ones. If you are planning
something big, open an issue first so nobody duplicates it.
