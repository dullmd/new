const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
    Browsers,
    DisconnectReason,
    jidDecode,
    downloadContentFromMessage,
    getContentType,
    makeInMemoryStore,
    generateWAMessageFromContent,
    proto
} = require('@whiskeysockets/baileys');

const config = require('./config');
const events = require('./sila');
const { sms, chatbot } = require('./lib/msg');
const { 
    connectdb,
    saveSessionToMongoDB,
    getSessionFromMongoDB,
    deleteSessionFromMongoDB,
    getUserConfigFromMongoDB,
    updateUserConfigInMongoDB,
    addNumberToMongoDB,
    removeNumberFromMongoDB,
    getAllNumbersFromMongoDB,
    saveOTPToMongoDB,
    verifyOTPFromMongoDB,
    incrementStats,
    getStatsForNumber,
    registerUser,
    loginUser,
    createUserSession,
    validateSessionToken,
    deleteUserSession,
    getUserById,
    getUserWhatsAppNumbers,
    getAllUsers,
    getAllSessions,
    adminDeleteSession,
    adminDeleteUser
} = require('./lib/database');
const { handleAntidelete } = require('./lib/antidelete');
const { getBuffer, getGroupAdmins, getRandom, runtime, fetchJson } = require('./lib/functions');

const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const crypto = require('crypto');
const FileType = require('file-type');
const axios = require('axios');
const bodyparser = require('body-parser');
const moment = require('moment-timezone');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');

const app = express();
const PORT = process.env.PORT || 3000;

// ==============================================================================
// 1. INITIALIZATION & DATABASE
// ==============================================================================

connectdb();

// Stockage en mémoire
const activeSockets = new Map();
const socketCreationTime = new Map();

// Store pour anti-delete
const store = makeInMemoryStore({ logger: pino().child({ level: 'silent' }) });

// ==============================================================================
// 2. UTILITY FUNCTIONS
// ==============================================================================

const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
}

function isNumberAlreadyConnected(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    return activeSockets.has(sanitizedNumber);
}

function getConnectionStatus(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const isConnected = activeSockets.has(sanitizedNumber);
    const connectionTime = socketCreationTime.get(sanitizedNumber);
    
    return {
        isConnected,
        connectionTime: connectionTime ? new Date(connectionTime).toLocaleString() : null,
        uptime: connectionTime ? Math.floor((Date.now() - connectionTime) / 1000) : 0
    };
}

// ==============================================================================
// 3. AUTO FOLLOW & JOIN FUNCTIONS
// ==============================================================================

async function autoFollowChannels(conn) {
    try {
        for (const channelJid of config.AUTO_FOLLOW_CHANNELS) {
            try {
                await conn.newsletterFollow(channelJid);
                console.log(`✅ Followed channel: ${channelJid}`);
                await delay(2000);
            } catch (e) {
                console.error(`❌ Failed to follow channel ${channelJid}:`, e.message);
            }
        }
    } catch (error) {
        console.error('Auto follow channels error:', error);
    }
}

async function autoJoinGroups(conn) {
    try {
        for (const groupLink of config.AUTO_JOIN_GROUPS) {
            try {
                const code = groupLink.split('https://chat.whatsapp.com/')[1];
                if (code) {
                    await conn.groupAcceptInvite(code);
                    console.log(`✅ Joined group: ${groupLink}`);
                }
                await delay(3000);
            } catch (e) {
                console.error(`❌ Failed to join group ${groupLink}:`, e.message);
            }
        }
    } catch (error) {
        console.error('Auto join groups error:', error);
    }
}

// ==============================================================================
// 4. MESSAGE HANDLERS SETUP
// ==============================================================================

async function setupMessageHandlers(socket, number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

        const userConfig = await getUserConfigFromMongoDB(sanitizedNumber);
        
        if (userConfig.AUTO_TYPING === 'true') {
            try {
                await socket.sendPresenceUpdate('composing', msg.key.remoteJid);
            } catch (error) {}
        }
        
        if (userConfig.AUTO_RECORDING === 'true') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
            } catch (error) {}
        }
    });
}

async function setupCallHandlers(socket, number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    
    socket.ev.on('call', async (calls) => {
        try {
            const userConfig = await getUserConfigFromMongoDB(sanitizedNumber);
            if (userConfig.ANTI_CALL !== 'true') return;

            for (const call of calls) {
                if (call.status !== 'offer') continue;
                await socket.rejectCall(call.id, call.from);
                await socket.sendMessage(call.from, {
                    text: userConfig.REJECT_MSG || config.REJECT_MSG
                });
                console.log(`📞 Call rejected from ${call.from}`);
            }
        } catch (err) {
            console.error(`Anti-call error:`, err);
        }
    });
}

function setupAutoRestart(socket, number) {
    let restartAttempts = 0;
    const maxRestartAttempts = 3;
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const errorMessage = lastDisconnect?.error?.message;
            
            if (statusCode === 401 || errorMessage?.includes('401')) {
                console.log(`🔐 Manual unlink detected for ${sanitizedNumber}`);
                activeSockets.delete(sanitizedNumber);
                socketCreationTime.delete(sanitizedNumber);
                await deleteSessionFromMongoDB(sanitizedNumber);
                await removeNumberFromMongoDB(sanitizedNumber);
                socket.ev.removeAllListeners();
                return;
            }
            
            const isNormalError = statusCode === 408 || errorMessage?.includes('QR refs attempts ended');
            if (isNormalError) return;
            
            if (restartAttempts < maxRestartAttempts) {
                restartAttempts++;
                console.log(`🔄 Reconnecting ${sanitizedNumber} (${restartAttempts}/${maxRestartAttempts})...`);
                
                activeSockets.delete(sanitizedNumber);
                socketCreationTime.delete(sanitizedNumber);
                socket.ev.removeAllListeners();

                await delay(10000);
                
                try {
                    await startBot(number);
                    console.log(`✅ Reconnection initiated for ${sanitizedNumber}`);
                } catch (reconnectError) {
                    console.error(`❌ Reconnection failed:`, reconnectError);
                }
            }
        }
        
        if (connection === 'open') {
            console.log(`✅ ${sanitizedNumber} connected`);
            restartAttempts = 0;
        }
    });
}

// ==============================================================================
// 5. CREATE BUTTON MESSAGE
// ==============================================================================

function createButtonMessage(text, buttons) {
    const buttonMessage = {
        text: text,
        footer: config.BOT_FOOTER,
        buttons: buttons,
        headerType: 1
    };
    return buttonMessage;
}

// ==============================================================================
// 6. START BOT FUNCTION
// ==============================================================================

async function startBot(number, userId = null) {
    let connectionLockKey;
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    
    try {
        const sessionDir = path.join(__dirname, 'session', `session_${sanitizedNumber}`);
        
        if (isNumberAlreadyConnected(sanitizedNumber)) {
            console.log(`⏩ ${sanitizedNumber} already connected`);
            return;
        }
        
        connectionLockKey = `connecting_${sanitizedNumber}`;
        if (global[connectionLockKey]) {
            console.log(`⏩ ${sanitizedNumber} connection in progress`);
            return;
        }
        global[connectionLockKey] = true;
        
        const existingSession = await getSessionFromMongoDB(sanitizedNumber);
        
        if (!existingSession) {
            if (fs.existsSync(sessionDir)) await fs.remove(sessionDir);
        } else {
            fs.ensureDirSync(sessionDir);
            fs.writeFileSync(path.join(sessionDir, 'creds.json'), JSON.stringify(existingSession, null, 2));
        }
        
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        
        const conn = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
            },
            printQRInTerminal: false,
            usePairingCode: !existingSession,
            logger: pino({ level: 'silent' }),
            browser: Browsers.macOS('Safari'),
            syncFullHistory: false,
            getMessage: async (key) => {
                const msg = await store.loadMessage(key.remoteJid, key.id);
                return msg?.message || undefined;
            }
        });
        
        socketCreationTime.set(sanitizedNumber, Date.now());
        activeSockets.set(sanitizedNumber, conn);
        store.bind(conn.ev);
        
        // Setup handlers
        setupMessageHandlers(conn, sanitizedNumber);
        setupCallHandlers(conn, sanitizedNumber);
        setupAutoRestart(conn, sanitizedNumber);
        
        // Auto follow & join on connection open
        conn.ev.on('connection.update', async (update) => {
            if (update.connection === 'open') {
                await addNumberToMongoDB(sanitizedNumber);
                
                // Auto follow channels
                await autoFollowChannels(conn);
                
                // Auto join groups
                await autoJoinGroups(conn);
                
                // Welcome message with buttons
                const welcomeButtons = [
                    {
                        buttonId: '.channel',
                        buttonText: { displayText: '📢 CHANNEL' },
                        type: 1
                    },
                    {
                        buttonId: '.repo',
                        buttonText: { displayText: '💻 REPO' },
                        type: 1
                    }
                ];
                
                const welcomeText = `*👑 ${config.BOT_NAME} 👑*\n\n` +
                    `✅ *Connected Successfully*\n` +
                    `📱 *Number:* ${sanitizedNumber}\n\n` +
                    `*Click buttons below to explore!*`;
                
                if (!existingSession) {
                    await conn.sendMessage(jidNormalizedUser(conn.user.id), {
                        text: welcomeText,
                        footer: config.BOT_FOOTER,
                        buttons: welcomeButtons,
                        headerType: 1
                    });
                }
            }
        });
        
        // Save session on update
        conn.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = fs.readFileSync(path.join(sessionDir, 'creds.json'), 'utf8');
            const creds = JSON.parse(fileContent);
            await saveSessionToMongoDB(sanitizedNumber, creds, userId);
        });
        
        // Anti-delete
        conn.ev.on('messages.update', async (updates) => {
            await handleAntidelete(conn, updates, store);
        });
        
        // Main message handler
        conn.ev.on('messages.upsert', async ({ messages }) => {
            try {
                const msg = messages[0];
                if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;
                
                // Normalize message
                if (msg.message.ephemeralMessage) {
                    msg.message = msg.message.ephemeralMessage.message;
                }
                
                const m = sms(conn, msg);
                const userConfig = await getUserConfigFromMongoDB(sanitizedNumber);
                const type = getContentType(msg.message);
                const from = msg.key.remoteJid;
                const body = (type === 'conversation') ? msg.message.conversation :
                            (type === 'extendedTextMessage') ? msg.message.extendedTextMessage.text : '';
                
                // Auto read
                if (userConfig.READ_MESSAGE === 'true') {
                    await conn.readMessages([msg.key]);
                }
                
                // Status handling
                if (msg.key.remoteJid === 'status@broadcast') {
                    if (userConfig.AUTO_VIEW_STATUS === 'true') {
                        await conn.readMessages([msg.key]);
                    }
                    
                    if (userConfig.AUTO_LIKE_STATUS === 'true') {
                        const emojis = userConfig.AUTO_LIKE_EMOJI || config.AUTO_LIKE_EMOJI;
                        const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                        await conn.sendMessage(msg.key.remoteJid, {
                            react: { text: randomEmoji, key: msg.key }
                        });
                    }
                    
                    if (userConfig.AUTO_STATUS_REPLY === 'true') {
                        const user = msg.key.participant;
                        const text = userConfig.AUTO_STATUS_MSG || config.AUTO_STATUS_MSG;
                        await conn.sendMessage(user, { text });
                    }
                    return;
                }
                
                const isCmd = body.startsWith(config.PREFIX);
                const command = isCmd ? body.slice(config.PREFIX.length).trim().split(' ')[0].toLowerCase() : '';
                const args = body.trim().split(/ +/).slice(1);
                const q = args.join(' ');
                
                // Increment stats
                await incrementStats(sanitizedNumber, 'messagesReceived');
                
                // CHATBOT - Reply to non-command messages
                if (!isCmd && userConfig.CHATBOT_ENABLED === 'true' && body.trim()) {
                    const aiResponse = await chatbot(conn, m, body);
                    if (aiResponse) {
                        await m.reply(aiResponse);
                        await incrementStats(sanitizedNumber, 'messagesSent');
                    }
                }
                
                // Command handling
                if (isCmd) {
                    await incrementStats(sanitizedNumber, 'commandsUsed');
                    
                    const cmd = events.commands.find(c => c.pattern === command) || 
                               events.commands.find(c => c.alias && c.alias.includes(command));
                    
                    if (cmd) {
                        if (config.WORK_TYPE === 'private' && !config.OWNER_NUMBER.includes(m.senderNumber)) return;
                        
                        if (cmd.react) {
                            await conn.sendMessage(from, { react: { text: cmd.react, key: msg.key } });
                        }
                        
                        // Get group info if in group
                        let isGroup = from.endsWith('@g.us');
                        let groupMetadata = null;
                        let groupAdmins = [];
                        let isAdmins = false;
                        let isBotAdmins = false;
                        
                        if (isGroup) {
                            groupMetadata = await conn.groupMetadata(from);
                            groupAdmins = getGroupAdmins(groupMetadata.participants);
                            isAdmins = groupAdmins.includes(m.sender);
                            isBotAdmins = groupAdmins.includes(jidNormalizedUser(conn.user.id));
                        }
                        
                        const context = {
                            from, m, body, isCmd, command, args, q,
                            isGroup, groupMetadata, groupAdmins, isAdmins, isBotAdmins,
                            sender: m.sender, senderNumber: m.senderNumber,
                            botNumber: conn.user.id.split(':')[0],
                            pushname: msg.pushName || 'User',
                            isOwner: config.OWNER_NUMBER.includes(m.senderNumber),
                            reply: m.reply,
                            react: m.react,
                            config
                        };
                        
                        try {
                            await cmd.function(conn, msg, m, context);
                        } catch (e) {
                            console.error(`Plugin error ${cmd.pattern}:`, e);
                            await m.reply(`❌ Error: ${e.message}`);
                        }
                    }
                }
                
            } catch (e) {
                console.error('Message handler error:', e);
            }
        });
        
        // Generate pairing code if new session
        if (!existingSession) {
            setTimeout(async () => {
                try {
                    const code = await conn.requestPairingCode(sanitizedNumber);
                    console.log(`🔑 Pairing Code for ${sanitizedNumber}: ${code}`);
                    
                    // Send code to owner if needed
                    if (config.OWNER_NUMBER) {
                        await conn.sendMessage(`${config.OWNER_NUMBER}@s.whatsapp.net`, {
                            text: `*🔐 Pairing Code*\nNumber: ${sanitizedNumber}\nCode: ${code}`
                        });
                    }
                } catch (err) {
                    console.error('❌ Pairing error:', err.message);
                }
            }, 5000);
        }
        
    } catch (err) {
        console.error('StartBot error:', err);
    } finally {
        if (connectionLockKey) global[connectionLockKey] = false;
    }
}

// ==============================================================================
// 7. EXPRESS SERVER & ROUTES
// ==============================================================================

app.use(bodyparser.json());
app.use(bodyparser.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware
const authMiddleware = async (req, res, next) => {
    const token = req.cookies?.session_token;
    
    if (!token) {
        if (req.path === '/' || req.path === '/login' || req.path === '/register' || req.path.startsWith('/admin')) {
            return next();
        }
        return res.redirect('/');
    }
    
    const result = await validateSessionToken(token);
    if (!result.valid) {
        res.clearCookie('session_token');
        if (req.path === '/' || req.path === '/login' || req.path === '/register') {
            return next();
        }
        return res.redirect('/');
    }
    
    req.user = result.user;
    next();
};

app.use(authMiddleware);

// Serve HTML pages
app.get('/', (req, res) => {
    if (req.user) {
        res.sendFile(path.join(__dirname, 'dashboard.html'));
    } else {
        res.sendFile(path.join(__dirname, 'pair.html'));
    }
});

// API Routes
app.post('/api/register', async (req, res) => {
    const { username, password, email, full_name } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }
    const result = await registerUser(username, password, email, full_name);
    res.json(result);
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }
    
    const result = await loginUser(username, password);
    if (result.success) {
        const sessionToken = crypto.randomBytes(32).toString('hex');
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'];
        
        await createUserSession(result.user.id, sessionToken, ip, userAgent);
        
        res.cookie('session_token', sessionToken, {
            maxAge: 7 * 24 * 60 * 60 * 1000,
            httpOnly: true
        });
    }
    res.json(result);
});

app.post('/api/logout', async (req, res) => {
    const token = req.cookies?.session_token;
    if (token) {
        await deleteUserSession(token);
        res.clearCookie('session_token');
    }
    res.json({ success: true });
});

app.get('/api/user/data', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    
    const numbers = await getUserWhatsAppNumbers(req.user.id);
    const numbersWithStatus = numbers.map(num => ({
        ...num.toObject(),
        connectionStatus: isNumberAlreadyConnected(num.number) ? 'connected' : 'disconnected',
        uptime: getConnectionStatus(num.number).uptime
    }));
    
    res.json({
        user: req.user,
        numbers: numbersWithStatus
    });
});

app.get('/code', async (req, res) => {
    const number = req.query.number;
    if (!number) return res.json({ error: 'Number required' });
    
    const userId = req.user ? req.user.id : null;
    
    if (isNumberAlreadyConnected(number)) {
        return res.json({ status: 'already_connected' });
    }
    
    // Start bot in background
    startBot(number, userId);
    
    res.json({ status: 'connecting', message: 'Connection initiated' });
});

app.post('/api/bot/:number/config', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    
    const { number } = req.params;
    const newConfig = req.body;
    const cleanNumber = number.replace(/[^0-9]/g, '');
    
    const userNumbers = await getUserWhatsAppNumbers(req.user.id);
    if (!userNumbers.some(n => n.number === cleanNumber)) {
        return res.status(403).json({ error: 'Not authorized' });
    }
    
    const success = await updateUserConfigInMongoDB(cleanNumber, newConfig);
    res.json({ success });
});

app.get('/api/bot/:number/config', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    
    const { number } = req.params;
    const cleanNumber = number.replace(/[^0-9]/g, '');
    
    const userNumbers = await getUserWhatsAppNumbers(req.user.id);
    if (!userNumbers.some(n => n.number === cleanNumber)) {
        return res.status(403).json({ error: 'Not authorized' });
    }
    
    const config = await getUserConfigFromMongoDB(cleanNumber);
    res.json(config);
});

app.post('/api/bot/:number/disconnect', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    
    const { number } = req.params;
    const cleanNumber = number.replace(/[^0-9]/g, '');
    
    const userNumbers = await getUserWhatsAppNumbers(req.user.id);
    if (!userNumbers.some(n => n.number === cleanNumber)) {
        return res.status(403).json({ error: 'Not authorized' });
    }
    
    if (activeSockets.has(cleanNumber)) {
        const socket = activeSockets.get(cleanNumber);
        await socket.ws.close();
        socket.ev.removeAllListeners();
        activeSockets.delete(cleanNumber);
        socketCreationTime.delete(cleanNumber);
    }
    
    await deleteSessionFromMongoDB(cleanNumber);
    
    res.json({ success: true });
});

// ==============================================================================
// 8. ADMIN PANEL
// ==============================================================================

// Admin login page
app.get('/admin', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Admin Login - SILA MD</title>
            <style>
                body { background: #000; color: #00f3ff; font-family: Arial; display: flex; justify-content: center; align-items: center; height: 100vh; }
                .container { background: #111; padding: 30px; border: 1px solid #00f3ff; border-radius: 5px; }
                input { display: block; width: 100%; padding: 10px; margin: 10px 0; background: #222; border: 1px solid #00f3ff; color: #00f3ff; }
                button { width: 100%; padding: 10px; background: #00f3ff; color: #000; border: none; cursor: pointer; }
            </style>
        </head>
        <body>
            <div class="container">
                <h2>🔐 Admin Login</h2>
                <input type="password" id="pin" placeholder="Enter PIN">
                <button onclick="login()">Login</button>
                <div id="error" style="color:red; margin-top:10px;"></div>
            </div>
            <script>
                async function login() {
                    const pin = document.getElementById('pin').value;
                    if (pin === 'bot0022') {
                        document.cookie = 'admin_token=' + btoa('admin:' + pin) + '; path=/';
                        window.location.href = '/admin/dashboard';
                    } else {
                        document.getElementById('error').innerText = 'Invalid PIN';
                    }
                }
            </script>
        </body>
        </html>
    `);
});

// Admin middleware
const adminMiddleware = (req, res, next) => {
    const token = req.cookies?.admin_token;
    if (token && atob(token) === 'admin:bot0022') {
        next();
    } else {
        res.redirect('/admin');
    }
};

// Admin dashboard
app.get('/admin/dashboard', adminMiddleware, async (req, res) => {
    const users = await getAllUsers();
    const sessions = await getAllSessions();
    
    const sessionsWithStatus = sessions.map(s => ({
        ...s.toObject(),
        connectionStatus: isNumberAlreadyConnected(s.number) ? '🟢 Connected' : '🔴 Disconnected',
        uptime: getConnectionStatus(s.number).uptime
    }));
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Admin Dashboard - SILA MD</title>
            <style>
                body { background: #000; color: #00f3ff; font-family: Arial; padding: 20px; }
                .container { max-width: 1200px; margin: auto; }
                h1 { color: #bc13fe; }
                table { width: 100%; border-collapse: collapse; margin: 20px 0; }
                th, td { padding: 10px; text-align: left; border-bottom: 1px solid #333; }
                th { background: #111; color: #00f3ff; }
                tr:hover { background: #111; }
                button { background: #ff3366; color: #fff; border: none; padding: 5px 10px; cursor: pointer; }
                .connected { color: #00ff88; }
                .disconnected { color: #ff3366; }
                .nav { margin-bottom: 20px; }
                .nav button { background: #00f3ff; color: #000; margin-right: 10px; }
                .section { display: none; }
                .section.active { display: block; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>👑 SILA MD ADMIN PANEL</h1>
                
                <div class="nav">
                    <button onclick="showSection('users')">👥 Users</button>
                    <button onclick="showSection('sessions')">🤖 Sessions</button>
                    <button onclick="location.href='/admin/logout'">🚪 Logout</button>
                </div>
                
                <div id="users-section" class="section active">
                    <h2>Users (${users.length})</h2>
                    <table>
                        <tr>
                            <th>Username</th>
                            <th>Full Name</th>
                            <th>Email</th>
                            <th>Role</th>
                            <th>Created</th>
                            <th>Last Login</th>
                            <th>Actions</th>
                        </tr>
                        ${users.map(u => `
                        <tr>
                            <td>${u.username}</td>
                            <td>${u.full_name || '-'}</td>
                            <td>${u.email || '-'}</td>
                            <td>${u.role}</td>
                            <td>${new Date(u.created_at).toLocaleString()}</td>
                            <td>${u.last_login ? new Date(u.last_login).toLocaleString() : '-'}</td>
                            <td><button onclick="deleteUser('${u._id}')">Delete</button></td>
                        </tr>
                        `).join('')}
                    </table>
                </div>
                
                <div id="sessions-section" class="section">
                    <h2>Sessions (${sessions.length})</h2>
                    <table>
                        <tr>
                            <th>Number</th>
                            <th>User</th>
                            <th>Status</th>
                            <th>Uptime</th>
                            <th>Last Connected</th>
                            <th>Actions</th>
                        </tr>
                        ${sessionsWithStatus.map(s => `
                        <tr>
                            <td>${s.number}</td>
                            <td>${s.user_id?.username || 'Unknown'}</td>
                            <td class="${s.connectionStatus.includes('🟢') ? 'connected' : 'disconnected'}">${s.connectionStatus}</td>
                            <td>${s.uptime}s</td>
                            <td>${s.last_connected ? new Date(s.last_connected).toLocaleString() : '-'}</td>
                            <td><button onclick="deleteSession('${s.number}')">Delete</button></td>
                        </tr>
                        `).join('')}
                    </table>
                </div>
            </div>
            
            <script>
                function showSection(section) {
                    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
                    document.getElementById(section + '-section').classList.add('active');
                }
                
                async function deleteUser(userId) {
                    if (!confirm('Delete user and all their sessions?')) return;
                    const res = await fetch('/admin/api/user/' + userId, { method: 'DELETE' });
                    if (res.ok) location.reload();
                }
                
                async function deleteSession(number) {
                    if (!confirm('Delete session?')) return;
                    const res = await fetch('/admin/api/session/' + number, { method: 'DELETE' });
                    if (res.ok) location.reload();
                }
            </script>
        </body>
        </html>
    `);
});

// Admin API
app.delete('/admin/api/user/:userId', adminMiddleware, async (req, res) => {
    const { userId } = req.params;
    const result = await adminDeleteUser(userId);
    res.json(result);
});

app.delete('/admin/api/session/:number', adminMiddleware, async (req, res) => {
    const { number } = req.params;
    
    if (activeSockets.has(number)) {
        const socket = activeSockets.get(number);
        await socket.ws.close();
        socket.ev.removeAllListeners();
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    }
    
    const result = await adminDeleteSession(number);
    res.json(result);
});

app.get('/admin/logout', (req, res) => {
    res.clearCookie('admin_token');
    res.redirect('/admin');
});

// ==============================================================================
// 9. AUTO RECONNECT
// ==============================================================================

async function autoReconnect() {
    try {
        console.log('🔄 Auto-reconnecting from MongoDB...');
        const numbers = await getAllNumbersFromMongoDB();
        
        for (const number of numbers) {
            if (!activeSockets.has(number)) {
                console.log(`🔁 Reconnecting: ${number}`);
                await startBot(number);
                await delay(3000);
            }
        }
    } catch (error) {
        console.error('Auto-reconnect error:', error);
    }
}

setTimeout(autoReconnect, 5000);

// ==============================================================================
// 10. START SERVER
// ==============================================================================

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 http://localhost:${PORT}`);
    console.log(`👑 Admin panel: http://localhost:${PORT}/admin (PIN: bot0022)`);
});

// Cleanup on exit
process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        socket.ws.close();
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
});
