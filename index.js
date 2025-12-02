/* index.js - V6 FINAL (Auto Chat + Power Control) */

const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel } = require('@discordjs/voice');
const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ==========================================
// 🛡️ ANTI-CRASH
// ==========================================
process.on('unhandledRejection', (reason, p) => { console.log(' [Anti-Crash] :: Lỗi Async:', reason); });
process.on('uncaughtException', (err, origin) => { console.log(' [Anti-Crash] :: Lỗi Hệ thống:', err); });
process.on('uncaughtExceptionMonitor', (err, origin) => { console.log(' [Anti-Crash] :: Monitor:', err); });

// ==========================================
// ⚙️ SERVER SETUP
// ==========================================
const app = express();
let client = null;
let voiceConnection = null;
let autoChatTimer = null; // Timer cho Auto Chat

const PORT = process.env.PORT || 3000;
const SECRET_KEY = 'rpc-secret-' + Date.now();
const CONFIG_FILE = path.join(__dirname, 'rpc-config.json');
const AFK_LOGS_FILE = path.join(__dirname, 'afk-logs.json');
const IMAGES_DIR = path.join(__dirname, 'rpc_images');

const WEB_USER = process.env.AUTH_USERNAME || 'admin';
const WEB_PASS = process.env.AUTH_PASSWORD || '123456';

if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR);

let currentConfig = {
    token: '',
    enabled: false, type: 'PLAYING', name: 'SelfBot', details: '', state: '',
    largeImage: '', largeText: '', smallImage: '', smallText: '',
    startTimestamp: false, button1Label: '', button1URL: '', button2Label: '', button2URL: '',
    status: 'online', deviceType: 'desktop',
    voiceEnabled: false, voiceGuildId: '', voiceChannelId: '', voiceVideo: false,
    afkEnabled: false, afkMessage: 'Hiện tại tôi đang treo máy.',
    
    // AUTO CHAT CONFIG
    autoChatEnabled: false,
    autoChatChannelId: '',
    autoChatInterval: 5, // giây
    autoChatContent: 'Alo\n123\ntest\nspam nè\nchat linh tinh\nvớ vẩn' // Nội dung mặc định
};

let afkLogs = [];

if (fs.existsSync(CONFIG_FILE)) { try { currentConfig = { ...currentConfig, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch (e) {} }
if (fs.existsSync(AFK_LOGS_FILE)) { try { afkLogs = JSON.parse(fs.readFileSync(AFK_LOGS_FILE, 'utf8')); } catch (e) {} }

function saveConfig() { fs.writeFileSync(CONFIG_FILE, JSON.stringify(currentConfig, null, 2)); }
function saveAfkLogs() { fs.writeFileSync(AFK_LOGS_FILE, JSON.stringify(afkLogs, null, 2)); }

// ==========================================
// 🤖 BOT LOGIC
// ==========================================

async function startBot() {
    const tokenToUse = currentConfig.token || process.env.DISCORD_TOKEN;
    if (!tokenToUse) return console.log("⚠️ CHƯA CÓ TOKEN!");

    if (client) { try { client.destroy(); } catch(e) {} client = null; }
    if (autoChatTimer) { clearInterval(autoChatTimer); autoChatTimer = null; }

    client = new Client({ checkUpdate: false });

    client.on('ready', async () => {
        console.log(`✅ Login: ${client.user.tag} (${currentConfig.deviceType})`);
        if(client.user) client.user.setPresence({ status: currentConfig.status });
        updateRPC();
        connectVoice();
        startAutoChat(); // Bắt đầu Auto Chat nếu bật
    });

    client.on('voiceStateUpdate', async (o, n) => {
        if (!client.user || o.member.id !== client.user.id) return;
        if (!n.channelId && currentConfig.voiceEnabled) setTimeout(connectVoice, 5000);
    });

    // AFK System
    client.on('messageCreate', async (message) => {
        if (!currentConfig.afkEnabled || message.author.id === client.user.id || message.mentions.everyone) return;
        if (message.mentions.has(client.user.id)) {
            const logEntry = { id: Date.now(), time: new Date().toLocaleString('vi-VN'), user: message.author.tag, server: message.guild ? message.guild.name : 'DM', content: message.content };
            afkLogs.unshift(logEntry);
            if (afkLogs.length > 50) afkLogs.pop();
            saveAfkLogs();

            setTimeout(async () => {
                try {
                    if (message.guild && !message.channel.permissionsFor(client.user).has("SEND_MESSAGES")) return;
                    await message.channel.send(`${message.author} ${currentConfig.afkMessage}`);
                    console.log(`💬 [AFK] Đã trả lời ${message.author.tag}`);
                } catch (err) {}
            }, 1000);
        }
    });

    try { await client.login(tokenToUse); } catch (e) { console.error("❌ Login Error:", e.message); }
}

async function stopBot() {
    if (autoChatTimer) { clearInterval(autoChatTimer); autoChatTimer = null; }
    if (client) {
        console.log("🛑 Đang dừng Bot...");
        client.destroy();
        client = null;
    }
}

// --- AUTO CHAT FUNCTION ---
function startAutoChat() {
    if (autoChatTimer) clearInterval(autoChatTimer);
    if (!client || !currentConfig.autoChatEnabled || !currentConfig.autoChatChannelId) return;

    console.log(`💬 Auto Chat: BẬT (Kênh: ${currentConfig.autoChatChannelId}, ${currentConfig.autoChatInterval}s/msg)`);

    autoChatTimer = setInterval(async () => {
        if (!client || !client.user) return;
        try {
            const channel = client.channels.cache.get(currentConfig.autoChatChannelId);
            if (!channel) return console.log(`⚠️ AutoChat: Không tìm thấy kênh ${currentConfig.autoChatChannelId}`);

            // Lấy nội dung ngẫu nhiên
            const lines = currentConfig.autoChatContent.split('\n').filter(line => line.trim() !== '');
            if (lines.length === 0) return;
            const randomLine = lines[Math.floor(Math.random() * lines.length)];

            await channel.send(randomLine);
            console.log(`📤 AutoChat sent: "${randomLine}"`);

        } catch (err) {
            console.error(`❌ AutoChat Error: ${err.message}`);
        }
    }, Math.max(2000, currentConfig.autoChatInterval * 1000)); // Tối thiểu 2 giây để tránh ban
}

async function connectVoice() {
    if (!currentConfig.voiceEnabled || !currentConfig.voiceGuildId || !currentConfig.voiceChannelId) {
        if (voiceConnection) { try{voiceConnection.destroy()}catch(e){}; voiceConnection = null; }
        return;
    }
    try {
        const guild = client.guilds.cache.get(currentConfig.voiceGuildId);
        const channel = guild?.channels.cache.get(currentConfig.voiceChannelId);
        if (!guild || !channel) return;
        voiceConnection = joinVoiceChannel({ channelId: channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: true, selfVideo: currentConfig.voiceVideo });
        if (currentConfig.voiceVideo) { setTimeout(() => { if(guild.shard) guild.shard.send({ op: 4, d: { guild_id: guild.id, channel_id: channel.id, self_mute: true, self_deaf: false, self_video: true } }); }, 2000); }
        console.log(`🔊 Voice Connected: ${channel.name}`);
    } catch (e) { console.error('Voice Error:', e.message); }
}

function updateRPC() {
    if (!client || !client.user || !currentConfig.enabled) { if(client?.user) client.user.setPresence({ activities: [], status: currentConfig.status }); return; }
    try {
        const activity = {
            name: currentConfig.name, type: currentConfig.type, details: currentConfig.details || undefined, state: currentConfig.state || undefined, assets: {}, timestamps: currentConfig.startTimestamp ? { start: Date.now() } : undefined
        };
        if (currentConfig.type === 'STREAMING') activity.url = 'https://www.twitch.tv/discord';
        if (currentConfig.largeImage) { activity.assets.large_image = currentConfig.largeImage; if(currentConfig.largeText) activity.assets.large_text = currentConfig.largeText; }
        if (currentConfig.smallImage) { activity.assets.small_image = currentConfig.smallImage; if(currentConfig.smallText) activity.assets.small_text = currentConfig.smallText; }
        if (Object.keys(activity.assets).length === 0) delete activity.assets;
        activity.buttons = [];
        if (currentConfig.button1Label && currentConfig.button1URL) activity.buttons.push({ label: currentConfig.button1Label, url: currentConfig.button1URL });
        if (currentConfig.button2Label && currentConfig.button2URL) activity.buttons.push({ label: currentConfig.button2Label, url: currentConfig.button2URL });
        if (activity.buttons.length === 0) delete activity.buttons;
        client.user.setPresence({ activities: [activity], status: currentConfig.status });
    } catch (e) {}
}

// ==========================================
// 🌐 WEB API
// ==========================================
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));
app.use('/images', express.static(IMAGES_DIR));

function checkAuth(req, res, next) {
    if (req.cookies.auth === SECRET_KEY) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

app.post('/api/login', (req, res) => {
    if (req.body.username === WEB_USER && req.body.password === WEB_PASS) {
        res.cookie('auth', SECRET_KEY, { httpOnly: true, maxAge: 86400000 });
        return res.json({ success: true });
    }
    res.status(401).json({ error: 'Sai mật khẩu' });
});
app.post('/api/logout', (req, res) => { res.clearCookie('auth'); res.json({ success: true }); });

app.get('/api/config', checkAuth, (req, res) => {
    // Gửi thêm trạng thái bot đang chạy hay tắt
    const statusData = { ...currentConfig, isRunning: !!client };
    res.json(statusData);
});

// API Bật/Tắt Bot (Nguồn)
app.post('/api/power', checkAuth, async (req, res) => {
    const { action } = req.body; // 'start' hoặc 'stop'
    if (action === 'stop') {
        await stopBot();
        res.json({ success: true, message: "Đã tắt Bot." });
    } else {
        await startBot();
        res.json({ success: true, message: "Đã bật Bot." });
    }
});

app.post('/api/config', checkAuth, async (req, res) => {
    const oldToken = currentConfig.token;
    const oldVoice = { ...currentConfig };
    
    currentConfig = { ...currentConfig, ...req.body };
    saveConfig();

    if (client) { // Chỉ update nếu bot đang chạy
        if (req.body.token && req.body.token !== oldToken) await startBot();
        else {
            if (currentConfig.voiceEnabled !== oldVoice.voiceEnabled || currentConfig.voiceChannelId !== oldVoice.voiceChannelId || currentConfig.voiceVideo !== oldVoice.voiceVideo) await connectVoice();
            updateRPC();
            startAutoChat(); // Update Auto Chat
        }
    }
    res.json({ success: true });
});

app.get('/api/afklogs', checkAuth, (req, res) => res.json(afkLogs));
app.delete('/api/afklogs', checkAuth, (req, res) => { afkLogs = []; saveAfkLogs(); res.json({ success: true }); });

app.post('/api/device', checkAuth, async (req, res) => {
    currentConfig.deviceType = req.body.deviceType;
    saveConfig();
    if(client) await startBot();
    res.json({ success: true });
});

app.get('/api/list-images', checkAuth, (req, res) => {
    fs.readdir(IMAGES_DIR, (err, files) => {
        if (err) return res.json([]);
        res.json(files.filter(f => /\.(jpg|png|gif)$/i.test(f)));
    });
});

app.listen(PORT, () => { console.log(`🌐 Web UI: http://localhost:${PORT}`); startBot(); });
