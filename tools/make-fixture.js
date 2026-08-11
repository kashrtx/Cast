// Makes the test fixture: a set of characters and chats at roughly the scale of real use.
//
// It is generated rather than copied from anyone's actual data, because a fixture taken from a real
// export would put someone's conversations in a public repository. It is checked in so the tests do
// not depend on this running, and this is kept so it can be changed and regenerated.
//
// Everything is derived from a fixed seed, so running it twice gives the same file and a diff shows
// only what was actually changed.

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'tests', 'fixture-app-data.json');

const NAMES = [
    'Ada Vance', 'Bram Holloway', 'Cleo Marsh', 'Dorian Vale', 'Esme Quill',
    'Felix Rook', 'Greta Sonne', 'Hugo Latimer', 'Iris Fenn', 'Jonah Kress',
];

// A small predictable generator, so the fixture is the same every time.
let seed = 12345;
function next() {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
}

const characters = NAMES.map((name, i) => ({
    id: `char${String(i).padStart(8, '0')}`,
    name,
    userContext: `${name} is a character used for testing. They speak plainly.`,
    enhancedContext: `## ${name}\n\n**Core essence:** a settled, dry sort, written so that a long `
        + `profile is present to check it survives a round trip and reaches the model whole.\n\n`
        + `**Speech:** short sentences. Says "right then" before starting something.\n\n`
        + `**Background:** invented for a fixture, and content with that.`,
    createdAt: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(),
    hasPicture: i % 4 === 0,
}));

// One entry in a character's history: a summary of a chat, naming the chat rather than holding it.
function historyEntry(chatId, members, messages) {
    const last = messages[messages.length - 1];
    return {
        id: chatId,
        timestamp: Date.parse(last.timestamp),
        characterIds: members.map((c) => c.id),
        characterNames: members.map((c) => c.name).join(', '),
        messageCount: messages.length,
        lastMessage: String(last.content).slice(0, 50),
        date: last.timestamp,
    };
}

const chats = {};
const chatMembers = {};
const chatHistory = {};
const lastActiveChats = {};
let chatCount = 0;

const CHATS_PER_CHARACTER = 3;

characters.forEach((character) => {
    for (let k = 0; k < CHATS_PER_CHARACTER; k += 1) {
        const chatId = `chat_${String(chatCount).padStart(12, '0')}`;
        chatCount += 1;

        const turns = 8 + Math.floor(next() * 5);
        const messages = [];
        for (let t = 0; t < turns; t += 1) {
            const isUser = t % 2 === 0;
            const message = {
                id: `msg${chatCount}_${String(t).padStart(4, '0')}`,
                content: isUser
                    ? 'What do you make of that, then?'
                    : `*${character.name.split(' ')[0]} considers it.*\n\nRight then. Here is what I `
                      + 'think, with **emphasis** and a line of *action*, so the markdown path is used.',
                isUser,
                timestamp: new Date(Date.UTC(2025, 5, 1 + k, 9, t)).toISOString(),
                // One deleted message per character, since a deleted message is kept and hidden
                // rather than removed, and that has to survive loading.
                isDeleted: t === 5 && k === 1,
            };
            if (!isUser) message.characterId = character.id;
            messages.push(message);
        }

        chats[chatId] = messages;
        chatMembers[chatId] = [character.id];

        if (k === CHATS_PER_CHARACTER - 1) {
            lastActiveChats[character.id] = chatId;
        } else {
            // History is a list of summaries per character, each naming the chat it describes. The
            // messages themselves stay in chats, which is why a summary can outlive its body.
            if (!chatHistory[character.id]) chatHistory[character.id] = [];
            chatHistory[character.id].push(historyEntry(chatId, [character], messages));
        }
    }
});

// A group chat, because who speaks next is a separate path from a one to one chat.
const groupId = `chat_${String(chatCount).padStart(12, '0')}`;
chats[groupId] = [
    { id: 'gmsg0001', content: 'Both of you, at once.', isUser: true, timestamp: '2025-06-10T10:00:00.000Z', isDeleted: false },
    { id: 'gmsg0002', content: 'Right then.', isUser: false, characterId: characters[0].id, timestamp: '2025-06-10T10:00:05.000Z', isDeleted: false },
    { id: 'gmsg0003', content: 'Agreed.', isUser: false, characterId: characters[1].id, timestamp: '2025-06-10T10:00:09.000Z', isDeleted: false },
];
chatMembers[groupId] = [characters[0].id, characters[1].id];

// A chat whose character is gone. Loading has to keep this rather than delete it, which is the rule
// that stops a bad load taking real conversations with it.
chats.chat_orphaned000 = [
    { id: 'omsg0001', content: 'Anyone there?', isUser: true, timestamp: '2025-06-11T10:00:00.000Z', isDeleted: false },
];
chatMembers.chat_orphaned000 = ['charDELETED00'];

// A history entry pointing at a chat whose body is not there. This is what the loader calls an
// orphan, and it has to be hidden rather than deleted: the body may come back from a backup, and
// deleting the entry would make that unrecoverable. An earlier version dropped these, which is how
// a single unreadable value used to destroy a whole history.
chatHistory[characters[0].id] = chatHistory[characters[0].id] || [];
chatHistory[characters[0].id].push(historyEntry('chat_bodyless001', [characters[0]], [
    { id: 'bmsg0001', content: 'This one lost its body.', isUser: true, timestamp: '2025-06-12T10:00:00.000Z', isDeleted: false },
]));

const messageCount = Object.values(chats).reduce((total, list) => total + list.length, 0);

const fixture = {
    app: 'Cast',
    backupFormat: 2,
    appVersion: '2.21.1',
    exportDate: '2026-01-01T00:00:00.000Z',
    contents: {
        characters: characters.length,
        chats: Object.keys(chats).length,
        messages: messageCount,
    },
    characters,
    chats,
    chatHistory,
    chatMembers,
    lastActiveChats,
    settings: {
        provider: 'gemini',
        apiKeys: {},
        models: { gemini: 'gemini-2.0-flash' },
        baseUrls: {},
        includeKeyInBackups: false,
        proxyUrl: '',
        memoryCompaction: false,
        memory: {},
        temperature: 1,
        enhancedContextTokens: 4096,
        conversationTokens: 4096,
        maxTokens: 4096,
    },
    personalContext: {
        name: 'Sam',
        personality: 'Curious, a bit blunt.',
        context: 'Testing the app.',
    },
};

fs.writeFileSync(OUT, `${JSON.stringify(fixture)}\n`);
console.log(
    `wrote ${path.relative(process.cwd(), OUT)}: ${characters.length} characters, `
    + `${Object.keys(chats).length} chats, ${messageCount} messages, `
    + `${Math.round(fs.statSync(OUT).size / 1024)} kB`
);
