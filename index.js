/* index.js - V18 FINAL (Fix Multi-Account Voice Join) */

const { Client, WebhookClient } = require('discord.js-selfbot-v13');
const { joinVoiceChannel } = require('@discordjs/voice');
const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

// ==========================================
// ⚙️ DATA MANAGEMENT
// ==========================================
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const SYSTEM_FILE = path.join(__dirname, 'system.json'); 
const AFK_LOGS_FILE = path.join(__dirname, 'afk-logs.json');
const IMAGE_URLS_FILE = path.join(__dirname, 'image-urls.json');
const IMAGES_DIR = path.join(__dirname, 'rpc_images');

if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR);

let accountsData = [];
let systemConfig = { webhookUrl: '' }; 
let activeSessions = new Map();
let afkLogs = [];
let savedImageUrls = [];

function loadData() {
    if (fs.existsSync(ACCOUNTS_FILE)) { try { accountsData = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch (e) {} }
    if (fs.existsSync(SYSTEM_FILE)) { try { systemConfig = JSON.parse(fs.readFileSync(SYSTEM_FILE, 'utf8')); } catch (e) {} }
    if (fs.existsSync(IMAGE_URLS_FILE)) { try { savedImageUrls = JSON.parse(fs.readFileSync(IMAGE_URLS_FILE, 'utf8')); } catch (e) {} }
    if (fs.existsSync(AFK_LOGS_FILE)) { 
        try { 
            const data = JSON.parse(fs.readFileSync(AFK_LOGS_FILE, 'utf8'));
            if (Array.isArray(data) && data.length > 0 && !data[0].time) afkLogs = []; 
            else afkLogs = data;
        } catch (e) { afkLogs = []; } 
    }
}
function saveData() { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accountsData, null, 2)); }
function saveSystemConfig() { fs.writeFileSync(SYSTEM_FILE, JSON.stringify(systemConfig, null, 2)); }
function saveAfkLogs() { fs.writeFileSync(AFK_LOGS_FILE, JSON.stringify(afkLogs, null, 2)); }
function saveImageUrls() { fs.writeFileSync(IMAGE_URLS_FILE, JSON.stringify(savedImageUrls, null, 2)); }

loadData();

function sanitizeUrl(url) {
    if (!url || typeof url !== 'string') return null;
    let cleanUrl = url.trim();
    if (!cleanUrl.startsWith('http')) cleanUrl = 'https://' + cleanUrl;
    try { new URL(cleanUrl); return cleanUrl; } catch (e) { return null; }
}

async function sendErrorWebhook(title, errorDetail, botName = 'System') {
    if (!systemConfig.webhookUrl) return;
    try {
        const webhook = new WebhookClient({ url: systemConfig.webhookUrl });
        const embed = {
            title: `🚨 ${title}`, color: 15548997, 
            fields: [
                { name: '🤖 Bot', value: botName, inline: true },
                { name: '❌ Lỗi', value: `\`\`\`js\n${errorDetail.toString().substring(0, 1000)}\n\`\`\`` }
            ]
        };
        await webhook.send({ embeds: [embed] });
    } catch (e) { console.error("Lỗi Webhook:", e.message); }
}

process.on('unhandledRejection', (reason, p) => { console.log(' [Anti-Crash] :: Async Error'); });
process.on('uncaughtException', (err, origin) => { console.log(' [Anti-Crash] :: System Error'); });

// ==========================================
// 🤖 BOT SESSION
// ==========================================
class BotSession {
    constructor(config) {
        this.id = config.id;
        this.config = config;
        this.client = null;
        this.voiceConnection = null;
        this.autoChatTimer = null;
        this.voiceJoinedAt = null;
        this.isRunning = false;
        this.statusMessage = "Stopped";
    }

    async start() {
        if (this.client) await this.stop();
        if (!this.config.token) { this.statusMessage = "Thiếu Token"; return; }

        this.client = new Client({ checkUpdate: false });

        this.client.on('ready', async () => {
            this.isRunning = true;
            this.statusMessage = `Online: ${this.client.user.tag}`;
            console.log(`[${this.config.name}] ✅ Online: ${this.client.user.tag}`);
            
            this.updateRPC();
            // Delay nhẹ để tránh rate limit khi nhiều bot cùng vào voice
            setTimeout(() => this.connectVoice(), 1000); 
            this.startAutoChat();
        });

        this.client.on('voiceStateUpdate', async (o, n) => {
            if (!this.client.user || o.member.id !== this.client.user.id) return;
            if (!n.channelId && this.config.voiceEnabled) {
                this.voiceJoinedAt = null;
                setTimeout(() => this.connectVoice(), 5000);
            }
        });

        this.client.on('messageCreate', async (message) => { this.handleAFK(message); });

        try { await this.client.login(this.config.token); } 
        catch (error) {
            console.error(`[${this.config.name}] Login Error: ${error.message}`);
            this.statusMessage = "Lỗi Login: " + error.message;
            this.isRunning = false;
        }
    }

    async stop() {
        if (this.autoChatTimer) { clearInterval(this.autoChatTimer); this.autoChatTimer = null; }
        if (this.voiceConnection) { try{this.voiceConnection.destroy()}catch(e){}; this.voiceConnection = null; }
        if (this.client) { try{this.client.destroy()}catch(e){}; this.client = null; }
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
            const guild = this.client.guilds.cache.get(this.config.voiceGuildId);
            const channel = guild?.channels.cache.get(this.config.voiceChannelId);
            if (!guild || !channel) return;

            // 🔥 FIX: Thêm tham số GROUP để tách riêng kết nối cho từng bot
            this.voiceConnection = joinVoiceChannel({
                channelId: channel.id, 
                guildId: guild.id, 
                adapterCreator: guild.voiceAdapterCreator,
                selfDeaf: false, 
                selfMute: true, 
                selfVideo: this.config.voiceVideo,
                group: this.client.user.id // <--- QUAN TRỌNG NHẤT: Định danh riêng cho mỗi bot
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
        const c = this.config;
        const status = c.status || 'online';
        
        const presenceUpdate = {
            activities: [], status: status, afk: false,
            client_status: {
                desktop: c.deviceType === 'desktop' ? status : undefined,
                mobile: c.deviceType === 'mobile' ? status : undefined,
                web: c.deviceType === 'web' ? status : undefined,
            }
        };

        if (c.enabled && c.name) {
            let streamUrl = 'https://www.twitch.tv/discord';
            const btn1Url = sanitizeUrl(c.button1URL);
            if (c.type === 'STREAMING' && btn1Url && (btn1Url.includes('twitch.tv') || btn1Url.includes('youtube.com'))) {
                streamUrl = btn1Url;
            }

            const activity = {
                name: c.name, type: c.type, details: c.details || undefined, state: c.state || undefined,
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

            presenceUpdate.activities.push(activity);
        }
        if (presenceUpdate.activities.length === 0) presenceUpdate.activities = null;
        try { this.client.user.setPresence(presenceUpdate); } catch(e) { console.error(`[${c.name}] RPC Error: ${e.message}`); }
    }

    startAutoChat() {
        if (this.autoChatTimer) clearInterval(this.autoChatTimer);
        if (!this.config.autoChatEnabled || !this.config.autoChatChannelId) return;
        this.autoChatTimer = setInterval(async () => {
            if (!this.client || !this.client.user) return;
            try {
                const channel = this.client.channels.cache.get(this.config.autoChatChannelId);
                if (!channel) return;
                const lines = (this.config.autoChatContent || '').split('\n').filter(l => l.trim() !== '');
                if (lines.length > 0) await channel.send(lines[Math.floor(Math.random() * lines.length)]);
            } catch (e) {}
        }, Math.max(2000, (this.config.autoChatInterval || 5) * 1000));
    }

    handleAFK(message) {
        if (!this.config.afkEnabled || message.author.id === this.client.user.id || message.mentions.everyone) return;
        if (message.mentions.has(this.client.user.id)) {
            const logEntry = { id: Date.now(), time: new Date().toLocaleString('vi-VN'), user: message.author.tag, server: message.guild ? message.guild.name : 'DM', content: message.content, botName: this.client.user.tag };
            afkLogs.unshift(logEntry);
            if (afkLogs.length > 100) afkLogs.pop();
            saveAfkLogs();
            setTimeout(async () => {
                try {
                    if (message.guild && !message.channel.permissionsFor(this.client.user).has("SEND_MESSAGES")) return;
                    await message.channel.send(`${message.author} ${this.config.afkMessage}`);
                } catch (e) {}
            }, 1000);
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

// 🌐 SERVER SETUP
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

app.post('/api/login', (req, res) => {
    if (req.body.username === WEB_USER && req.body.password === WEB_PASS) { res.cookie('auth', SECRET_KEY, { httpOnly: true, maxAge: 2592000000 }); return res.json({ success: true }); }
    res.status(401).json({ error: 'Sai mật khẩu' });
});
app.post('/api/logout', (req, res) => { res.clearCookie('auth'); res.json({ success: true }); });

app.get('/api/accounts', checkAuth, (req, res) => {
    res.json(accountsData.map(a => {
        const s = activeSessions.get(a.id);
        return { id: a.id, name: a.name || 'Bot', isRunning: s ? s.isRunning : false, statusMessage: s ? s.statusMessage : 'No Session', avatar: s && s.client?.user ? s.client.user.displayAvatarURL() : null };
    }));
});
app.post('/api/accounts/create', checkAuth, (req, res) => {
    const newId = crypto.randomUUID();
    accountsData.push({ id: newId, token: '', name: 'New Bot', status: 'online', deviceType: 'desktop', enabled: false, type: 'PLAYING', voiceEnabled: false, afkEnabled: false, afkMessage: 'AFK...' });
    saveData(); initBots(); res.json({ success: true, id: newId });
});
app.delete('/api/accounts/:id', checkAuth, (req, res) => {
    const s = activeSessions.get(req.params.id); if (s) s.stop(); activeSessions.delete(req.params.id);
    accountsData = accountsData.filter(a => a.id !== req.params.id); saveData(); res.json({ success: true });
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

app.get('/api/system', checkAuth, (req, res) => res.json(systemConfig));
app.post('/api/system', checkAuth, (req, res) => { systemConfig = { ...systemConfig, ...req.body }; saveSystemConfig(); if(req.body.test) sendErrorWebhook("Test", "OK", "Admin"); res.json({ success: true }); });
app.get('/api/afklogs', checkAuth, (req, res) => res.json(afkLogs));
app.delete('/api/afklogs', checkAuth, (req, res) => { afkLogs = []; saveAfkLogs(); res.json({ success: true }); });
app.get('/api/images', checkAuth, (req, res) => { try { res.json({ local: fs.readdirSync(IMAGES_DIR).filter(f => /\.(jpg|png|gif)$/i.test(f)), savedUrls: savedImageUrls }); } catch(e){ res.json({local:[], savedUrls:[]}); } });
app.post('/api/images/url', checkAuth, (req, res) => { if(req.body.url && !savedImageUrls.includes(req.body.url)) { savedImageUrls.push(req.body.url); saveImageUrls(); } res.json({ success: true }); });
app.delete('/api/images/url', checkAuth, (req, res) => { savedImageUrls = savedImageUrls.filter(u => u !== req.body.url); saveImageUrls(); res.json({ success: true }); });

app.listen(PORT, () => { console.log(`🌐 Multi-Bot Manager running on port ${PORT}`); });
