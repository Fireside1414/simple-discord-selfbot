/* index.js - V9 FINAL (Image URL Manager Added) */

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
let autoChatTimer = null;
let voiceJoinedAt = null;

const PORT = process.env.PORT || 3000;
const SECRET_KEY = 'rpc-secret-super-secure-key-2024'; 

const CONFIG_FILE = path.join(__dirname, 'rpc-config.json');
const AFK_LOGS_FILE = path.join(__dirname, 'afk-logs.json');
const IMAGE_URLS_FILE = path.join(__dirname, 'image-urls.json'); // File lưu link ảnh
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
    autoChatEnabled: false, autoChatChannelId: '', autoChatInterval: 5, autoChatContent: 'Alo\n123\ntest'
};

let afkLogs = [];
let savedImageUrls = []; // Danh sách link ảnh đã lưu

// --- LOAD DATA ---
if (fs.existsSync(CONFIG_FILE)) { try { currentConfig = { ...currentConfig, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch (e) {} }
if (fs.existsSync(AFK_LOGS_FILE)) { try { afkLogs = JSON.parse(fs.readFileSync(AFK_LOGS_FILE, 'utf8')); } catch (e) {} }
if (fs.existsSync(IMAGE_URLS_FILE)) { try { savedImageUrls = JSON.parse(fs.readFileSync(IMAGE_URLS_FILE, 'utf8')); } catch (e) {} }

function saveConfig() { fs.writeFileSync(CONFIG_FILE, JSON.stringify(currentConfig, null, 2)); }
function saveAfkLogs() { fs.writeFileSync(AFK_LOGS_FILE, JSON.stringify(afkLogs, null, 2)); }
function saveImageUrls() { fs.writeFileSync(IMAGE_URLS_FILE, JSON.stringify(savedImageUrls, null, 2)); }

// ==========================================
// 🤖 BOT LOGIC
// ==========================================

async function startBot() {
    const tokenToUse = currentConfig.token || process.env.DISCORD_TOKEN;
    if (!tokenToUse) return console.log("⚠️ CHƯA CÓ TOKEN!");

    if (client) { try { client.destroy(); } catch(e) {} client = null; }
    if (autoChatTimer) { clearInterval(autoChatTimer); autoChatTimer = null; }
    voiceJoinedAt = null;

    client = new Client({ checkUpdate: false });

    client.on('ready', async () => {
        console.log(`✅ Login: ${client.user.tag} (${currentConfig.deviceType})`);
        if(client.user) client.user.setPresence({ status: currentConfig.status });
        updateRPC();
        connectVoice();
        startAutoChat();
    });

    client.on('voiceStateUpdate', async (o, n) => {
        if (!client.user || o.member.id !== client.user.id) return;
        if (!n.channelId && currentConfig.voiceEnabled) {
            voiceJoinedAt = null;
            console.log('⚠️ Mất kết nối Voice, thử lại sau 5s...');
            setTimeout(connectVoice, 5000);
        }
    });

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
                } catch (err) {}
            }, 1000);
        }
    });

    try { await client.login(tokenToUse); } catch (e) { console.error("❌ Login Error:", e.message); }
}

async function stopBot() {
    if (autoChatTimer) { clearInterval(autoChatTimer); autoChatTimer = null; }
    voiceJoinedAt = null;
    if (client) { client.destroy(); client = null; }
}

function startAutoChat() {
    if (autoChatTimer) clearInterval(autoChatTimer);
    if (!client || !currentConfig.autoChatEnabled || !currentConfig.autoChatChannelId) return;
    autoChatTimer = setInterval(async () => {
        if (!client || !client.user) return;
        try {
            const channel = client.channels.cache.get(currentConfig.autoChatChannelId);
            if (!channel) return;
            const lines = currentConfig.autoChatContent.split('\n').filter(line => line.trim() !== '');
            if (lines.length === 0) return;
            await channel.send(lines[Math.floor(Math.random() * lines.length)]);
        } catch (err) {}
    }, Math.max(2000, currentConfig.autoChatInterval * 1000));
}

async function connectVoice() {
    if (!currentConfig.voiceEnabled || !currentConfig.voiceGuildId || !currentConfig.voiceChannelId) {
        if (voiceConnection) { try{voiceConnection.destroy()}catch(e){}; voiceConnection = null; }
        voiceJoinedAt = null;
        return;
    }
    try {
        const guild = client.guilds.cache.get(currentConfig.voiceGuildId);
        const channel = guild?.channels.cache.get(currentConfig.voiceChannelId);
        if (!guild || !channel) return;
        
        voiceConnection = joinVoiceChannel({ channelId: channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: true, selfVideo: currentConfig.voiceVideo });
        voiceJoinedAt = Date.now(); 
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
        res.cookie('auth', SECRET_KEY, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 });
        return res.json({ success: true });
    }
    res.status(401).json({ error: 'Sai mật khẩu' });
});

app.post('/api/logout', (req, res) => { res.clearCookie('auth'); res.json({ success: true }); });

app.get('/api/config', checkAuth, (req, res) => {
    const statusData = { ...currentConfig, isRunning: !!client, voiceJoinedAt };
    res.json(statusData);
});

app.post('/api/power', checkAuth, async (req, res) => {
    const { action } = req.body;
    if (action === 'stop') { await stopBot(); res.json({ success: true, message: "Đã tắt Bot." }); }
    else { await startBot(); res.json({ success: true, message: "Đã bật Bot." }); }
});

app.post('/api/config', checkAuth, async (req, res) => {
    const oldToken = currentConfig.token;
    const oldVoice = { ...currentConfig };
    currentConfig = { ...currentConfig, ...req.body };
    saveConfig();

    if (client) {
        if (req.body.token && req.body.token !== oldToken) await startBot();
        else {
            if (currentConfig.voiceEnabled !== oldVoice.voiceEnabled || currentConfig.voiceChannelId !== oldVoice.voiceChannelId || currentConfig.voiceVideo !== oldVoice.voiceVideo) await connectVoice();
            updateRPC();
            startAutoChat();
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

// --- API QUẢN LÝ ẢNH (MỚI) ---

// Lấy danh sách ảnh Local + Online URLs
app.get('/api/images', checkAuth, (req, res) => {
    // Đọc ảnh local
    let localImages = [];
    try {
        localImages = fs.readdirSync(IMAGES_DIR).filter(f => /\.(jpg|png|gif)$/i.test(f));
    } catch(e) {}

    res.json({
        local: localImages,
        savedUrls: savedImageUrls
    });
});

// Thêm URL mới
app.post('/api/images/url', checkAuth, (req, res) => {
    const { url } = req.body;
    if (!url || !url.startsWith('http')) return res.status(400).json({ error: "Link không hợp lệ" });
    
    if (!savedImageUrls.includes(url)) {
        savedImageUrls.push(url);
        saveImageUrls();
    }
    res.json({ success: true, savedUrls: savedImageUrls });
});

// Xóa URL
app.delete('/api/images/url', checkAuth, (req, res) => {
    const { url } = req.body;
    savedImageUrls = savedImageUrls.filter(u => u !== url);
    saveImageUrls();
    res.json({ success: true, savedUrls: savedImageUrls });
});

app.listen(PORT, () => { console.log(`🌐 Web UI: http://localhost:${PORT}`); startBot(); });
