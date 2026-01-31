/* index.js - ULTIMATE DISCORD SELFBOT MANAGER (ERROR HANDLED & OPTIMIZED) */

const { Client, WebhookClient, Options } = require('discord.js-selfbot-v13');
const { joinVoiceChannel } = require('@discordjs/voice');
const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

// ==========================================
// ⚙️ DATA MANAGEMENT & CONFIGURATION
// ==========================================
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const SYSTEM_FILE = path.join(__dirname, 'system.json'); 
const AFK_LOGS_FILE = path.join(__dirname, 'afk-logs.json');
const MESSAGE_LOGS_FILE = path.join(__dirname, 'message-logs.json'); 
const IMAGE_URLS_FILE = path.join(__dirname, 'image-urls.json');
const IMAGES_DIR = path.join(__dirname, 'rpc_images');

if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR);

let accountsData = [];
let systemConfig = { webhookUrl: '' }; 
let activeSessions = new Map();
let afkLogs = [];
let messageLogs = {}; 
let savedImageUrls = [];

function loadData() {
    const loadJSON = (file, defaultVal) => {
        if (fs.existsSync(file)) {
            try { return JSON.parse(fs.readFileSync(file, 'utf8')); } 
            catch (e) { console.error(`[System] Lỗi đọc file ${file}:`, e.message); return defaultVal; }
        }
        return defaultVal;
    };

    accountsData = loadJSON(ACCOUNTS_FILE, []);
    systemConfig = loadJSON(SYSTEM_FILE, { webhookUrl: '' });
    savedImageUrls = loadJSON(IMAGE_URLS_FILE, []);
    
    const afkData = loadJSON(AFK_LOGS_FILE, []);
    afkLogs = (Array.isArray(afkData) && afkData.length > 0 && !afkData[0].time) ? [] : afkData;
    messageLogs = loadJSON(MESSAGE_LOGS_FILE, {});
}

function saveData() { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accountsData, null, 2)); }
function saveSystemConfig() { fs.writeFileSync(SYSTEM_FILE, JSON.stringify(systemConfig, null, 2)); }
function saveAfkLogs() { fs.writeFileSync(AFK_LOGS_FILE, JSON.stringify(afkLogs, null, 2)); }
function saveMessageLogs() { fs.writeFileSync(MESSAGE_LOGS_FILE, JSON.stringify(messageLogs, null, 2)); }
function saveImageUrls() { fs.writeFileSync(IMAGE_URLS_FILE, JSON.stringify(savedImageUrls, null, 2)); }

loadData();

function sanitizeUrl(url) {
    if (!url || typeof url !== 'string') return null;
    let cleanUrl = url.trim();
    if (!cleanUrl.startsWith('http')) cleanUrl = 'https://' + cleanUrl;
    try { new URL(cleanUrl); return cleanUrl; } catch (e) { return null; }
}

async function sendWebhook(title, description, color = 15548997, fields = []) {
    if (!systemConfig.webhookUrl) return;
    try {
        const webhook = new WebhookClient({ url: systemConfig.webhookUrl });
        const embed = { 
            title, description, color, fields, 
            footer: { text: `System Time: ${new Date().toLocaleString('vi-VN')}` } 
        };
        await webhook.send({ embeds: [embed] });
    } catch (e) { console.error("[System] Lỗi Webhook:", e.message); }
}

process.on('unhandledRejection', (reason, p) => { console.log(' [Anti-Crash] :: Async Error'); });
process.on('uncaughtException', (err, origin) => { console.log(' [Anti-Crash] :: System Error'); });

// ==========================================
// 🤖 BOT SESSION CLASS
// ==========================================
class BotSession {
    constructor(config) {
        this.id = config.id;
        this.config = config;
        this.client = null;
        this.voiceConnection = null;
        this.autoChatTimer = null;
        this.rpcTimer = null;
        this.voiceJoinedAt = null;
        this.isRunning = false;
        this.statusMessage = "Stopped";
    }

    async start() {
        if (this.client) await this.stop();
        if (!this.config.token) { this.statusMessage = "Thiếu Token"; return; }

        this.client = new Client({ 
            checkUpdate: false,
            patchVoice: true, 
            makeCache: Options.cacheWithLimits({
                MessageManager: 0, 
                PresenceManager: 0, 
                GuildMemberManager: 0, 
                UserManager: 0, 
                ThreadMemberManager: 0, 
                ReactionManager: 0, 
                GuildScheduledEventManager: 0,
                StageInstanceManager: 0,
                VoiceStateManager: 0,
                ApplicationCommandManager: 0,
                GuildManager: Infinity,
                ChannelManager: Infinity,
            }),
            sweepers: {
                ...Options.defaultSweeperSettings,
                messages: { interval: 300, lifetime: 60 },
            },
        });

        this.client.on('ready', async () => {
            this.isRunning = true;
            this.statusMessage = `Online: ${this.client.user.tag}`;
            console.log(`[${this.config.name}] ✅ Online: ${this.client.user.tag}`);
            
            this.updateRPC();
            setTimeout(() => this.connectVoice(), 2000); 
            this.startAutoChat();
        });

        this.client.on('voiceStateUpdate', async (o, n) => {
            if (!this.client.user || o.member?.id !== this.client.user.id) return;
            if (!n.channelId && this.config.voiceEnabled) {
                this.voiceJoinedAt = null;
                setTimeout(() => this.connectVoice(), 5000);
            }
        });

        this.client.on('messageCreate', async (message) => { 
            this.handleAFK(message); 
            this.handleMessageLog(message);
        });

        try { await this.client.login(this.config.token); } 
        catch (error) {
            console.error(`[${this.config.name}] Login Error: ${error.message}`);
            this.statusMessage = "Lỗi Login: " + error.message;
            this.isRunning = false;
        }
    }

    async stop() {
        if (this.autoChatTimer) { clearInterval(this.autoChatTimer); this.autoChatTimer = null; }
        if (this.rpcTimer) { clearInterval(this.rpcTimer); this.rpcTimer = null; }
        if (this.voiceConnection) { try{this.voiceConnection.destroy()}catch(e){}; this.voiceConnection = null; }
        
        if (this.client) { try { this.client.destroy(); } catch(e){}; this.client = null; }
        
        this.isRunning = false;
        this.voiceJoinedAt = null;
        this.statusMessage = "Stopped";
    }

    async connectVoice() {
        if (!this.config.voiceEnabled || !this.config.voiceGuildId || !this.config.voiceChannelId) {
            if (this.voiceConnection) { try{this.voiceConnection.destroy()}catch(e){}; this.voiceConnection = null; }
            this.voiceJoinedAt = null;
            return;
        }
        try {
            const guild = await this.client.guilds.fetch(this.config.voiceGuildId).catch(() => null);
            const channel = guild?.channels.cache.get(this.config.voiceChannelId);
            if (!guild || !channel) return;

            this.voiceConnection = joinVoiceChannel({
                channelId: channel.id, 
                guildId: guild.id, 
                adapterCreator: guild.voiceAdapterCreator,
                selfDeaf: false, 
                selfMute: true, 
                selfVideo: this.config.voiceVideo,
                group: this.client.user.id
            });
            
            this.voiceJoinedAt = Date.now();
            
            if (this.config.voiceVideo) {
                setTimeout(() => {
                    if(guild.shard) guild.shard.send({ op: 4, d: { guild_id: guild.id, channel_id: channel.id, self_mute: true, self_deaf: false, self_video: true } });
                }, 2000);
            }
        } catch (e) { console.error(`[${this.config.name}] Voice Error: ${e.message}`); }
    }

    updateRPC() {
        if (!this.client || !this.client.user) return;
        if (this.rpcTimer) clearInterval(this.rpcTimer);

        const c = this.config;
        if (!c.enabled) {
            this.client.user.setPresence({ activities: [], status: 'online' });
            return;
        }

        const setActivity = (detailsOverride, stateOverride) => {
            const status = c.status || 'online';
            let streamUrl = 'https://www.twitch.tv/discord';
            const btn1Url = sanitizeUrl(c.button1URL);
            
            if (c.type === 'STREAMING' && btn1Url && (btn1Url.includes('twitch.tv') || btn1Url.includes('youtube.com'))) {
                streamUrl = btn1Url;
            }

            const activity = {
                name: c.name, type: c.type, 
                details: detailsOverride || c.details, 
                state: stateOverride || c.state,
                timestamps: c.startTimestamp ? { start: Date.now() } : undefined,
                url: c.type === 'STREAMING' ? streamUrl : undefined, 
                application_id: c.applicationId || undefined, 
                assets: {}, buttons: []
            };

            if (c.applicationId) {
                if (c.largeImage) activity.assets.large_image = c.largeImage;
                if (c.smallImage) activity.assets.small_image = c.smallImage;
            } else {
                const lImg = sanitizeUrl(c.largeImage);
                const sImg = sanitizeUrl(c.smallImage);
                if (lImg) activity.assets.large_image = lImg;
                if (sImg) activity.assets.small_image = sImg;
            }

            if (c.largeImage && c.largeText) activity.assets.large_text = c.largeText;
            if (c.smallImage && c.smallText) activity.assets.small_text = c.smallText;
            if (Object.keys(activity.assets).length === 0) delete activity.assets;
            
            const url1 = sanitizeUrl(c.button1URL);
            const url2 = sanitizeUrl(c.button2URL);
            if (c.button1Label && url1) activity.buttons.push({ label: c.button1Label, url: url1 });
            if (c.button2Label && url2) activity.buttons.push({ label: c.button2Label, url: url2 });
            if (activity.buttons.length === 0) delete activity.buttons;

            this.client.user.setPresence({ activities: [activity], status: status });
        };

        if (c.details && c.details.includes('|')) {
            const frames = c.details.split('|').map(s => s.trim());
            let index = 0;
            setActivity(frames[0], c.state);
            this.rpcTimer = setInterval(() => {
                index = (index + 1) % frames.length;
                setActivity(frames[index], c.state);
            }, 5000); 
        } else {
            setActivity(c.details, c.state);
        }
    }

    startAutoChat() {
        if (this.autoChatTimer) clearInterval(this.autoChatTimer);
        if (!this.config.autoChatEnabled || !this.config.autoChatChannelId) return;
        
        this.autoChatTimer = setInterval(async () => {
            if (!this.client || !this.client.user) return;
            try {
                const channel = await this.client.channels.fetch(this.config.autoChatChannelId).catch(() => null);
                if (!channel) return;
                const lines = (this.config.autoChatContent || '').split('\n').filter(l => l.trim() !== '');
                if (lines.length > 0) await channel.send(lines[Math.floor(Math.random() * lines.length)]);
            } catch (e) {}
        }, Math.max(2000, (this.config.autoChatInterval || 5) * 1000));
    }

    handleMessageLog(message) {
        const conf = this.config;
        if (!conf.logEnabled) return;
        
        const targetGuilds = (conf.logGuilds || '').split(',').map(s => s.trim()).filter(s => s);
        const targetChannels = (conf.logChannels || '').split(',').map(s => s.trim()).filter(s => s);

        const isTargetGuild = message.guild && targetGuilds.includes(message.guild.id);
        const isTargetChannel = targetChannels.includes(message.channel.id);

        if (isTargetGuild || isTargetChannel) {
            if (!messageLogs[this.id]) messageLogs[this.id] = [];
            
            const logItem = {
                id: message.id,
                time: new Date().toLocaleString('vi-VN'),
                author: message.author.tag,
                authorAvatar: message.author.displayAvatarURL(),
                content: message.content || '[File/Sticker/Embed]',
                location: message.guild ? `${message.guild.name} (#${message.channel.name})` : 'DM',
                attachments: message.attachments.map(a => a.url)
            };

            messageLogs[this.id].unshift(logItem);
            if (messageLogs[this.id].length > 50) messageLogs[this.id].pop();
            
            saveMessageLogs();
        }
    }

    async handleAFK(message) {
        if (message.author.id === this.client.user.id || message.mentions.everyone) return;

        if (message.mentions.has(this.client.user.id)) {
            const logEntry = { id: Date.now(), time: new Date().toLocaleString('vi-VN'), user: message.author.tag, server: message.guild ? message.guild.name : 'DM', content: message.content, botName: this.client.user.tag };
            afkLogs.unshift(logEntry);
            if (afkLogs.length > 100) afkLogs.pop();
            saveAfkLogs();

            sendWebhook(
                `🔔 Bạn bị tag bởi ${message.author.tag}`, 
                message.content, 
                16776960, 
                [{ name: 'Nơi gửi', value: message.guild ? `${message.guild.name} (#${message.channel.name})` : 'DM' }]
            );

            if (this.config.afkEnabled) {
                setTimeout(async () => {
                    try {
                        if (message.guild && !message.channel.permissionsFor(this.client.user).has("SEND_MESSAGES")) return;
                        await message.channel.send(`${message.author} ${this.config.afkMessage}`);
                    } catch (e) {}
                }, 2000);
            }
        }
    }

    async updateConfig(newConfig) {
        const oldToken = this.config.token;
        const oldVoice = { ...this.config };
        this.config = { ...this.config, ...newConfig };

        if (newConfig.token && newConfig.token !== oldToken) { await this.start(); } 
        else if (this.isRunning) {
            if (this.config.voiceEnabled !== oldVoice.voiceEnabled || this.config.voiceChannelId !== oldVoice.voiceChannelId || this.config.voiceVideo !== oldVoice.voiceVideo) { await this.connectVoice(); }
            this.updateRPC();
            this.startAutoChat();
        }
    }
}

// ==========================================
// 🌐 WEB SERVER & API ENDPOINTS
// ==========================================
function initBots() {
    activeSessions.forEach((session, id) => { if (!accountsData.find(a => a.id === id)) { session.stop(); activeSessions.delete(id); } });
    accountsData.forEach(acc => {
        let session = activeSessions.get(acc.id);
        if (!session) { session = new BotSession(acc); activeSessions.set(acc.id, session); if (acc.token) session.start(); } 
        else { session.config = acc; }
    });
}
initBots();

const app = express();
const SECRET_KEY = 'multi-bot-secret-key';
const WEB_USER = process.env.AUTH_USERNAME || 'admin';
const WEB_PASS = process.env.AUTH_PASSWORD || '123456';
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));
app.use('/images', express.static(IMAGES_DIR));

function checkAuth(req, res, next) { if (req.cookies.auth === SECRET_KEY) return next(); res.status(401).json({ error: 'Unauthorized' }); }

// AUTH
app.post('/api/login', (req, res) => {
    if (req.body.username === WEB_USER && req.body.password === WEB_PASS) { res.cookie('auth', SECRET_KEY, { httpOnly: true, maxAge: 2592000000 }); return res.json({ success: true }); }
    res.status(401).json({ error: 'Sai mật khẩu' });
});
app.post('/api/logout', (req, res) => { res.clearCookie('auth'); res.json({ success: true }); });

// ACCOUNTS
app.get('/api/accounts', checkAuth, (req, res) => {
    res.json(accountsData.map(a => {
        const s = activeSessions.get(a.id);
        return { 
            id: a.id, name: a.name || 'Bot', 
            isRunning: s ? s.isRunning : false, 
            statusMessage: s ? s.statusMessage : 'No Session', 
            avatar: s && s.client?.user ? s.client.user.displayAvatarURL() : null 
        };
    }));
});

app.post('/api/accounts/create', checkAuth, (req, res) => {
    const newId = crypto.randomUUID();
    accountsData.push({ 
        id: newId, token: '', name: 'New Bot', status: 'online', 
        deviceType: 'desktop', enabled: false, type: 'PLAYING', 
        voiceEnabled: false, afkEnabled: false, afkMessage: 'AFK...',
        logEnabled: false, logGuilds: '', logChannels: '' 
    });
    saveData(); initBots(); res.json({ success: true, id: newId });
});

app.delete('/api/accounts/:id', checkAuth, (req, res) => {
    const s = activeSessions.get(req.params.id); if (s) s.stop(); activeSessions.delete(req.params.id);
    accountsData = accountsData.filter(a => a.id !== req.params.id); saveData(); 
    if (messageLogs[req.params.id]) delete messageLogs[req.params.id]; saveMessageLogs();
    res.json({ success: true });
});

app.get('/api/accounts/:id', checkAuth, (req, res) => {
    const s = activeSessions.get(req.params.id); if (!s) return res.status(404).json({ error: "Bot not found" });
    res.json({ ...s.config, isRunning: s.isRunning, voiceJoinedAt: s.voiceJoinedAt });
});

app.post('/api/accounts/:id/config', checkAuth, async (req, res) => {
    const s = activeSessions.get(req.params.id); if (!s) return res.status(404).json({ error: "Bot not found" });
    await s.updateConfig(req.body);
    const idx = accountsData.findIndex(a => a.id === req.params.id); if (idx !== -1) { accountsData[idx] = s.config; saveData(); }
    res.json({ success: true });
});

app.post('/api/accounts/:id/power', checkAuth, async (req, res) => {
    const s = activeSessions.get(req.params.id); if (!s) return res.status(404).json({ error: "Bot not found" });
    if (req.body.action === 'start') {
        if(req.body.tempConfig) { await s.updateConfig(req.body.tempConfig); const idx = accountsData.findIndex(a => a.id === req.params.id); if (idx !== -1) { accountsData[idx] = s.config; saveData(); } }
        if(!s.config.token) return res.json({ success: false, isRunning: false, message: "Thiếu Token" });
        await s.start();
    } else await s.stop();
    res.json({ success: true, isRunning: s.isRunning, message: s.statusMessage });
});

// PURGE
app.post('/api/accounts/:id/purge', checkAuth, async (req, res) => {
    const s = activeSessions.get(req.params.id);
    if (!s || !s.client) return res.status(404).json({ error: "Bot chưa chạy" });
    const { channelId, amount } = req.body;
    if (!channelId) return res.status(400).json({ error: "Thiếu Channel ID" });

    try {
        const channel = await s.client.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isText()) return res.status(400).json({ error: "Kênh không hợp lệ" });

        const messages = await channel.messages.fetch({ limit: 100 });
        const myMessages = messages.filter(m => m.author.id === s.client.user.id);
        
        let deleted = 0;
        const limit = amount || 10;
        for (const [id, msg] of myMessages) {
            if (deleted >= limit) break;
            try { await msg.delete(); deleted++; await new Promise(r => setTimeout(r, 1200)); } catch (e) {}
        }
        res.json({ success: true, deleted });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// FETCH HISTORY (FIXED 403/404)
app.post('/api/history/:id', checkAuth, async (req, res) => {
    const s = activeSessions.get(req.params.id);
    if (!s || !s.client) return res.status(404).json({ error: "Bot chưa chạy" });

    const { channelId } = req.body;
    if (!channelId) return res.status(400).json({ error: "Thiếu Channel ID" });

    try {
        console.log(`[History] Đang tải tin nhắn từ kênh: ${channelId}...`);

        const channel = await s.client.channels.fetch(channelId).catch(err => {
            console.error(`[History] Lỗi fetch channel: ${err.message}`);
            // Ném lỗi ra để catch xử lý
            throw err;
        });

        if (!channel || !channel.isText()) {
            return res.status(400).json({ error: "Kênh không hợp lệ (Không phải text channel hoặc Bot không thấy kênh này)." });
        }

        const messages = await channel.messages.fetch({ limit: 50 });
        
        const history = messages.map(m => {
            const authorName = m.author ? m.author.tag : "Unknown";
            const authorAvatar = m.author ? m.author.displayAvatarURL() : "https://cdn.discordapp.com/embed/avatars/0.png";
            
            return {
                id: m.id,
                time: new Date(m.createdTimestamp).toLocaleString('vi-VN'),
                author: authorName,
                authorAvatar: authorAvatar,
                content: m.content || '[File/Sticker/Embed]',
                location: `${m.guild ? m.guild.name : 'DM'} (#${m.channel ? m.channel.name : 'Unknown'})`,
                attachments: m.attachments ? m.attachments.map(a => a.url) : []
            };
        });

        res.json({ success: true, data: history });

    } catch (e) {
        console.error("[History Error]", e);
        
        let userMsg = "Lỗi không xác định";
        if (e.httpStatus === 403) userMsg = "⛔ Bot không có quyền xem kênh này (hoặc không ở trong server).";
        else if (e.httpStatus === 404) userMsg = "❌ ID Kênh không tồn tại.";
        else userMsg = e.message || "Lỗi kết nối Discord.";

        res.status(500).json({ error: userMsg });
    }
});

// LOGS & IMAGES
app.get('/api/system', checkAuth, (req, res) => res.json(systemConfig));
app.post('/api/system', checkAuth, (req, res) => { systemConfig = { ...systemConfig, ...req.body }; saveSystemConfig(); if(req.body.test) sendWebhook("Test System", "Webhook hoạt động tốt!"); res.json({ success: true }); });

app.get('/api/afklogs', checkAuth, (req, res) => res.json(afkLogs));
app.delete('/api/afklogs', checkAuth, (req, res) => { afkLogs = []; saveAfkLogs(); res.json({ success: true }); });

app.get('/api/logs/:id', checkAuth, (req, res) => { res.json(messageLogs[req.params.id] || []); });
app.delete('/api/logs/:id', checkAuth, (req, res) => { messageLogs[req.params.id] = []; saveMessageLogs(); res.json({ success: true }); });

app.get('/api/images', checkAuth, (req, res) => { try { res.json({ local: fs.readdirSync(IMAGES_DIR).filter(f => /\.(jpg|png|gif)$/i.test(f)), savedUrls: savedImageUrls }); } catch(e){ res.json({local:[], savedUrls:[]}); } });
app.post('/api/images/url', checkAuth, (req, res) => { if(req.body.url && !savedImageUrls.includes(req.body.url)) { savedImageUrls.push(req.body.url); saveImageUrls(); } res.json({ success: true }); });
app.delete('/api/images/url', checkAuth, (req, res) => { savedImageUrls = savedImageUrls.filter(u => u !== req.body.url); saveImageUrls(); res.json({ success: true }); });

app.listen(PORT, () => { console.log(`🌐 Multi-Bot Manager running on port ${PORT} | RAM Optimized`); });
