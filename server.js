const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs'); // Importa versão síncrona para inicialização
const multer = require('multer');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
const port = process.env.PORT || 3000;

// Senha de Administrador
const ADMIN_PASSWORD = '##0910Fula';
const DB_FILE = path.join(__dirname, 'db.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const BACKUPS_DIR = path.join(__dirname, 'backups');

// Armazenamento de sessões ativas (em memória)
const sessions = new Set();
// Armazenamento de usuários online (VisitorID -> {lastSeen, device})
const activeUsers = new Map();
// Armazenamento de sessões de usuários (Token -> Phone)
const userSessions = new Map();
// Usuários logados online (Phone -> Timestamp)
const loggedUsers = new Map();
// Histórico para o gráfico (últimos 20 pontos)
let statsHistory = [];
// Armazenamento da enquete atual
let currentPoll = {
    visible: false,
    question: '',
    options: [], // { text: 'Option 1', votes: 0 }
    votedIPs: {}
};
// Estado de digitação do admin (ephemeral - não salvo em disco)
let adminTypingUntil = 0;

// --- Configuração do Multer para Upload de Logo ---
fsSync.mkdirSync(UPLOADS_DIR, { recursive: true });
fsSync.mkdirSync(BACKUPS_DIR, { recursive: true });

// Storage engine for the main logo
const logoStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const extension = path.extname(file.originalname);
        cb(null, 'logo' + extension); // Always overwrites 'logo.ext'
    }
});
const logoUpload = multer({ storage: logoStorage });

// Storage engine for the fallback image
const fallbackStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const extension = path.extname(file.originalname);
        cb(null, 'fallback' + extension); // Always overwrites 'fallback.ext'
    }
});
const fallbackUpload = multer({ storage: fallbackStorage });

// Storage engine for User Avatars
const avatarStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const extension = path.extname(file.originalname);
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'avatar-' + uniqueSuffix + extension);
    }
});
const avatarUpload = multer({ 
    storage: avatarStorage,
    limits: { fileSize: 10 * 1024 * 1024 }, // Aumentado para 10MB para suportar alta resolução
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Apenas arquivos de imagem (JPG, PNG) são permitidos.'));
        }
    }
});

// Middleware
app.use(cors()); // Enable CORS for all routes
app.use(express.json()); // Parse JSON request bodies
app.set('trust proxy', true); // Confia no IP real se estiver atrás de um proxy (ex: Nginx, Heroku)

// Middleware de Segurança - Bloqueia acesso a arquivos sensíveis
app.use((req, res, next) => {
    const forbidden = ['/server.js', '/db.json', '/package.json', '/package-lock.json'];
    const p = req.path.toLowerCase();
    if (forbidden.includes(p) || p.startsWith('/backups') || p.startsWith('/node_modules')) {
        return res.status(403).send('Acesso Negado');
    }
    next();
});

app.use(express.static(__dirname)); // Serve arquivos estáticos (HTML, CSS, JS)
app.use('/uploads', express.static(UPLOADS_DIR)); // Serve a pasta de uploads

// --- Dados da Aplicação ---
let appData = {};

// --- Funções de Persistência ---
const saveData = async () => {
    try {
        await fs.writeFile(DB_FILE, JSON.stringify(appData, null, 2));
    } catch (error) {
        console.error('Erro ao salvar os dados no arquivo db.json:', error);
    }
};

const loadData = async () => {
    try {
        const data = await fs.readFile(DB_FILE, 'utf-8');
        appData = JSON.parse(data);
        console.log('Dados carregados de db.json.');
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('Erro ao ler db.json (possível corrupção):', error);
            try {
                const backupName = `${DB_FILE}.corrupted-${Date.now()}`;
                await fs.rename(DB_FILE, backupName);
                console.log(`Arquivo corrompido renomeado para: ${backupName}`);
            } catch (e) {
                console.error('Falha ao renomear arquivo corrompido:', e);
            }
        }
        console.log('Arquivo db.json não encontrado ou recriado. Criando com dados padrão.');
        appData = {
            views: 0,
            streamConfig: {
                type: 'embed', // embed, hls
                url: "https://www.youtube.com/embed/j285sZAL6I8?si=E4mpAxlMCqNEAGbU&autoplay=1&enablejsapi=1",
                defaultQuality: 'auto'
            },
            users: {}, // Armazena dados dos usuários (phone -> { favorites: [] })
            logoUrl: null, // Inicia sem logo
            fallbackImageUrl: null, // Imagem de offline/erro
            tickerMessage: "", // Mensagem de rodapé
            weeklyStats: {}, // Será preenchido abaixo
            programs: {}, // Será preenchido abaixo (0-6)
            poll: currentPoll, // Adiciona a enquete ao db
            tickerHistory: [],
            activityLogs: []
        };
        // Inicializa estatísticas semanais (0=Dom, 6=Sab)
        for (let i = 0; i < 7; i++) {
            appData.weeklyStats[i] = new Array(24).fill(0);
        }
        await saveData();
    }

    currentPoll = appData.poll || currentPoll; // Carrega a enquete do arquivo
    
    // Migração/Garantia de campos para versões antigas do db.json
    if (Array.isArray(appData.programs)) {
        // Migra array antigo para estrutura semanal (copia para todos os dias ou apenas padrão)
        const oldPrograms = appData.programs;
        appData.programs = {};
        for (let i = 0; i < 7; i++) {
            appData.programs[i] = JSON.parse(JSON.stringify(oldPrograms));
        }
    }
    if (!appData.programs) {
        appData.programs = {};
    }
    if (!appData.streamConfig) {
        appData.streamConfig = { type: 'embed', url: "https://www.youtube.com/embed/j285sZAL6I8?si=E4mpAxlMCqNEAGbU&autoplay=1&enablejsapi=1", defaultQuality: 'auto' };
    }
    if (!appData.weeklyStats || Object.keys(appData.weeklyStats).length === 0) {
        appData.weeklyStats = {};
        for (let i = 0; i < 7; i++) appData.weeklyStats[i] = new Array(24).fill(0);
    }
    if (!appData.peakStats || Object.keys(appData.peakStats).length === 0) {
        appData.peakStats = {};
        for (let i = 0; i < 7; i++) appData.peakStats[i] = new Array(24).fill(0);
    }
    if (!appData.users) {
        appData.users = {};
    }
    if (appData.tickerMessage === undefined) {
        appData.tickerMessage = "";
    }
    if (appData.fallbackImageUrl === undefined) {
        appData.fallbackImageUrl = null;
    }
    if (!appData.tickerHistory) {
        appData.tickerHistory = [];
    }
    if (!appData.activityLogs) {
        appData.activityLogs = [];
    }
    if (!appData.poll) {
        appData.poll = currentPoll;
    }
    if (!appData.lastNotification) {
        appData.lastNotification = { id: 0, message: "" };
    }
    if (!appData.sentNotifications) {
        appData.sentNotifications = [];
    }
    if (!appData.scheduledNotifications) {
        appData.scheduledNotifications = [];
    }
    if (!appData.adminInbox) {
        appData.adminInbox = [];
    }
};

// Middleware de Autenticação
const checkAuth = (req, res, next) => {
    const token = req.headers['x-auth-token'];
    if (token && sessions.has(token)) {
        next();
    } else {
        res.status(401).json({ success: false, message: 'Não autorizado' });
    }
};

// Middleware de Autenticação de Usuário
const checkUserAuth = (req, res, next) => {
    const token = req.headers['x-user-token'];
    if (token && userSessions.has(token)) {
        const phone = userSessions.get(token);
        if (appData.users && appData.users[phone]) {
            req.userPhone = phone;
            next();
        } else {
            userSessions.delete(token); // Remove sessão inválida
            res.status(401).json({ success: false, message: 'Usuário não encontrado' });
        }
    } else {
        res.status(401).json({ success: false, message: 'Não autorizado' });
    }
};

// --- Função de Log de Atividade ---
const logActivity = async (req, action, details = '') => {
    const ip = req.ip || req.socket.remoteAddress;
    const log = {
        timestamp: new Date().toISOString(),
        ip: ip,
        action: action,
        details: details
    };

    if (!appData.activityLogs) appData.activityLogs = [];
    appData.activityLogs.unshift(log);
    // Mantém apenas os últimos 50 registros
    if (appData.activityLogs.length > 50) appData.activityLogs.pop();
    await saveData();
};

// --- Monitoramento de Usuários Ativos ---
// Limpa usuários inativos e atualiza histórico a cada 10 segundos
setInterval(() => {
    const now = Date.now();
    // Remove usuários que não deram sinal de vida há mais de 60 segundos
    for (const [ip, data] of activeUsers.entries()) {
        const lastSeen = data.lastSeen || data; // Compatibilidade com formato antigo/novo
        if (now - lastSeen > 60000) activeUsers.delete(ip);
    }
    
    // Limpa usuários logados inativos
    for (const [phone, lastSeen] of loggedUsers.entries()) {
        if (now - lastSeen > 60000) loggedUsers.delete(phone);
    }
    
    // Adiciona ao histórico do gráfico
    const timeLabel = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    statsHistory.push({ time: timeLabel, count: activeUsers.size });
    if (statsHistory.length > 20) statsHistory.shift(); // Mantém apenas os últimos 20 registros

    // Atualiza Pico de Audiência (Máximo de usuários simultâneos na hora atual)
    const dateObj = new Date();
    const day = dateObj.getDay();
    const hour = dateObj.getHours();
    
    if (appData.peakStats && appData.peakStats[day]) {
        if (activeUsers.size > appData.peakStats[day][hour]) {
            appData.peakStats[day][hour] = activeUsers.size;
            saveData();
        }
    }
}, 10000);

// --- Rotas da API ---

// Obter número de visualizações
app.get('/api/views', (req, res) => {
    res.json({ 
        views: appData.views,
        ticker: appData.tickerMessage,
        poll: currentPoll,
        lastNotification: appData.lastNotification,
        adminTyping: Date.now() < adminTypingUntil // Retorna true se o admin digitou nos últimos 5s
    });
});

// Registrar nova visualização (chamado ao entrar no site)
app.post('/api/view', async (req, res) => {
    appData.views++;
    
    // Registra estatística por dia e hora
    const now = new Date();
    const day = now.getDay(); // 0-6
    const hour = now.getHours(); // 0-23
    if (appData.weeklyStats[day]) {
        appData.weeklyStats[day][hour]++;
    }

    await saveData();
    res.json({ views: appData.views });
});

// Heartbeat (Sinal de vida do usuário)
app.post('/api/heartbeat', (req, res) => {
    // Usa o ID único do visitante (gerado no front) ou cai para o IP se não existir
    const visitorId = req.headers['x-visitor-id'] || req.ip || req.socket.remoteAddress;
    const ua = req.headers['user-agent'] || '';
    const isMobile = /mobile|android|iphone|ipad|phone/i.test(ua);
    const device = isMobile ? 'Mobile' : 'Desktop';
    activeUsers.set(visitorId, { lastSeen: Date.now(), device });

    const userToken = req.headers['x-user-token'];
    if (userToken && userSessions.has(userToken)) {
        const phone = userSessions.get(userToken);
        loggedUsers.set(phone, Date.now());
    }
    res.json({ success: true });
});

// Rota de Login
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        const token = crypto.randomBytes(32).toString('hex');
        sessions.add(token);
        logActivity(req, 'Login', 'Admin logado com sucesso');
        res.json({ success: true, token });
    } else {
        res.json({ success: false });
    }
});

// Rota de Login de Usuário (WhatsApp)
app.post('/api/user/login', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false });

    // Cria usuário se não existir
    if (!appData.users[phone]) {
        appData.users[phone] = { favorites: [] };
        await saveData();
    }

    const token = crypto.randomBytes(32).toString('hex');
    userSessions.set(token, phone);
    res.json({ success: true, token, favorites: appData.users[phone].favorites, avatarUrl: appData.users[phone].avatarUrl });
});

// Obter Favoritos do Usuário
app.get('/api/user/favorites', checkUserAuth, (req, res) => {
    const user = appData.users[req.userPhone];
    res.json({ favorites: user ? user.favorites : [] });
});

// Alternar Favorito (Adicionar/Remover)
app.post('/api/user/toggle-favorite', checkUserAuth, async (req, res) => {
    const { programTitle } = req.body;
    if (!programTitle) return res.status(400).json({ success: false, message: 'Título inválido' });

    const user = appData.users[req.userPhone];
    if (!user.favorites) user.favorites = []; // Garante que o array existe
    
    const index = user.favorites.indexOf(programTitle);
    if (index === -1) {
        user.favorites.push(programTitle);
    } else {
        user.favorites.splice(index, 1);
    }
    
    await saveData();
    res.json({ success: true, favorites: user.favorites });
});

// Upload de Avatar do Usuário
app.post('/api/user/upload-avatar', checkUserAuth, avatarUpload.single('avatarFile'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'Nenhum arquivo.' });
    
    const user = appData.users[req.userPhone];
    if (user) {
        if (user.avatarUrl) {
            try {
                const oldFilename = path.basename(user.avatarUrl);
                await fs.unlink(path.join(UPLOADS_DIR, oldFilename));
            } catch (e) {}
        }
        user.avatarUrl = `/uploads/${req.file.filename}`;
        await saveData();
        res.json({ success: true, avatarUrl: user.avatarUrl });
    } else {
        try {
            await fs.unlink(path.join(UPLOADS_DIR, req.file.filename));
        } catch (e) {}
        res.status(404).json({ success: false });
    }
});

// Remover Avatar do Usuário
app.delete('/api/user/avatar', checkUserAuth, async (req, res) => {
    const user = appData.users[req.userPhone];
    if (user) {
        if (user.avatarUrl) {
            try {
                const filename = path.basename(user.avatarUrl);
                await fs.unlink(path.join(UPLOADS_DIR, filename));
            } catch (e) {
                console.error("Erro ao deletar arquivo de avatar:", e);
            }
        }
        user.avatarUrl = null;
        await saveData();
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false });
    }
});

// Excluir Conta do Usuário (Self)
app.delete('/api/user/me', checkUserAuth, async (req, res) => {
    const phone = req.userPhone;
    if (appData.users[phone]) {
        delete appData.users[phone];
        
        // Remove sessão ativa
        const token = req.headers['x-user-token'];
        userSessions.delete(token);
        loggedUsers.delete(phone);
        
        await saveData();
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false });
    }
});

// Obter configurações (URL da Stream e EPG)
app.get('/api/config', (req, res) => {
    res.json({ 
        streamConfig: appData.streamConfig,
        programs: appData.programs,
        logoUrl: appData.logoUrl,
        fallbackImageUrl: appData.fallbackImageUrl,
        tickerMessage: appData.tickerMessage,
        tickerHistory: appData.tickerHistory,
        poll: currentPoll
    });
});

// Obter Estatísticas (Painel Admin)
app.get('/api/stats', checkAuth, (req, res) => {
    let mobile = 0;
    let desktop = 0;
    for (const user of activeUsers.values()) {
        if (user.device === 'Mobile') mobile++;
        else desktop++;
    }

    res.json({
        activeUsers: activeUsers.size,
        loggedUsers: loggedUsers.size,
        totalViews: appData.views,
        history: statsHistory,
        weeklyStats: appData.weeklyStats,
        peakStats: appData.peakStats,
        deviceStats: { mobile, desktop }
    });
});

// Obter Logs de Atividade
app.get('/api/admin/logs', checkAuth, (req, res) => {
    res.json({ logs: appData.activityLogs || [] });
});

// Limpar Logs
app.delete('/api/admin/logs', checkAuth, async (req, res) => {
    appData.activityLogs = [];
    await saveData();
    res.json({ success: true });
});

// Deletar Log Específico
app.delete('/api/admin/logs/:index', checkAuth, async (req, res) => {
    const idx = parseInt(req.params.index);
    if (appData.activityLogs && appData.activityLogs[idx]) {
        appData.activityLogs.splice(idx, 1);
        await saveData();
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false });
    }
});

// Editar Log Específico
app.put('/api/admin/logs/:index', checkAuth, async (req, res) => {
    const idx = parseInt(req.params.index);
    const { details } = req.body;
    if (appData.activityLogs && appData.activityLogs[idx]) {
        appData.activityLogs[idx].details = details;
        await saveData();
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false });
    }
});

// Debug / Restart
app.post('/api/admin/debug', checkAuth, async (req, res) => {
    const { command } = req.body;
    
    if (command === 'node server.js' || command === 'nodemon server.js') {
        await logActivity(req, 'System Restart', `Comando: ${command}`);
        res.json({ success: true, message: 'Reiniciando servidor...' });
        
        // Aguarda resposta ser enviada antes de reiniciar
        setTimeout(() => {
            const args = command.split(' ');
            const cmd = args[0]; // 'node' ou 'nodemon'
            const script = args.slice(1);
            
            spawn(cmd, script, {
                cwd: process.cwd(),
                detached: true,
                stdio: "inherit"
            }).unref();
            process.exit();
        }, 1000);
        return;
    }

    await logActivity(req, 'Debug Command', `Comando acionado: ${command}`);
    res.json({ success: true, message: `Comando ${command} registrado.` });
});

// --- Rota de Correção Automática de Erros (Integridade) ---
app.post('/api/admin/fix-errors', checkAuth, async (req, res) => {
    const report = [];
    let fixedCount = 0;

    // 1. Verificar Diretórios
    try {
        await fs.access(UPLOADS_DIR);
    } catch {
        await fs.mkdir(UPLOADS_DIR, { recursive: true });
        report.push("Diretório 'uploads' estava faltando e foi recriado.");
        fixedCount++;
    }
    try {
        await fs.access(BACKUPS_DIR);
    } catch {
        await fs.mkdir(BACKUPS_DIR, { recursive: true });
        report.push("Diretório 'backups' estava faltando e foi recriado.");
        fixedCount++;
    }

    // 2. Verificar Integridade de Usuários e Sessões
    if (!appData.users) {
        appData.users = {};
        report.push("Estrutura de usuários recriada.");
        fixedCount++;
    }

    for (const [token, phone] of userSessions.entries()) {
        if (!appData.users[phone]) {
            userSessions.delete(token);
            report.push(`Sessão órfã removida para o telefone: ${phone}`);
            fixedCount++;
        }
    }

    // 3. Verificar Enquete
    if (!currentPoll.options) {
        currentPoll.options = [];
        report.push("Estrutura de opções da enquete corrigida.");
        fixedCount++;
    }

    if (fixedCount > 0) await saveData();
    
    await logActivity(req, 'System Fix', `Correção executada. ${fixedCount} problemas resolvidos.`);
    res.json({ success: true, fixed: fixedCount > 0, report: report });
});

// --- Rotas Públicas ---
app.get('/api/epg', (req, res) => {
    res.json(appData.programs);
});

// --- Rotas de Gerenciamento de Usuários (Admin) ---
app.get('/api/admin/users', checkAuth, (req, res) => {
    const usersList = Object.keys(appData.users).map(phone => ({
        phone: phone,
        favorites: appData.users[phone].favorites
    }));
    res.json({ users: usersList });
});

app.delete('/api/admin/users/:phone', checkAuth, async (req, res) => {
    const { phone } = req.params;
    if (appData.users[phone]) {
        delete appData.users[phone];
        await saveData();
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false, message: 'Usuário não encontrado' });
    }
});

// --- Rotas de Backup ---
app.get('/api/admin/backups', checkAuth, async (req, res) => {
    try {
        const files = await fs.readdir(BACKUPS_DIR);
        const backups = [];
        for (const file of files) {
            if (file.endsWith('.json')) {
                const filePath = path.join(BACKUPS_DIR, file);
                const stats = await fs.stat(filePath);
                backups.push({
                    filename: file,
                    date: stats.mtime,
                    size: stats.size
                });
            }
        }
        // Ordena do mais recente para o mais antigo
        backups.sort((a, b) => new Date(b.date) - new Date(a.date));
        res.json({ backups });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao listar backups' });
    }
});

// Rota para excluir todos os backups (Limpar Histórico)
app.delete('/api/admin/backups', checkAuth, async (req, res) => {
    try {
        const files = await fs.readdir(BACKUPS_DIR);
        for (const file of files) {
            if (file.endsWith('.json')) {
                await fs.unlink(path.join(BACKUPS_DIR, file));
            }
        }
        await logActivity(req, 'Clear Backups', 'Histórico de backups excluído');
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Erro ao excluir backups' });
    }
});

app.post('/api/admin/backups/restore', checkAuth, async (req, res) => {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ success: false, message: 'Nome do arquivo inválido' });

    const backupPath = path.join(BACKUPS_DIR, filename);
    
    // Segurança básica de path traversal
    if (path.dirname(backupPath) !== BACKUPS_DIR) {
         return res.status(403).json({ success: false, message: 'Acesso negado' });
    }

    try {
        await fs.copyFile(backupPath, DB_FILE);
        await loadData(); // Recarrega os dados na memória
        await logActivity(req, 'Restore Backup', `Restaurado: ${filename}`);
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Erro ao restaurar backup' });
    }
});

// Rota de Upload de Logo
app.post('/api/upload-logo', checkAuth, logoUpload.single('logoFile'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'Nenhum arquivo enviado.' });
    }
    
    // O caminho do arquivo para ser usado no frontend
    const logoUrl = `/uploads/${req.file.filename}`;
    appData.logoUrl = logoUrl;
    await logActivity(req, 'Upload Logo', `Novo logo: ${req.file.filename}`);
    await saveData();
    res.json({ success: true, filePath: logoUrl });
});

// Rota para Deletar Logo
app.delete('/api/upload-logo', checkAuth, async (req, res) => {
    if (appData.logoUrl) {
        try {
            const filename = path.basename(appData.logoUrl);
            await fs.unlink(path.join(UPLOADS_DIR, filename));
        } catch (e) {}
        appData.logoUrl = null;
        await logActivity(req, 'Delete Logo', 'Logo removido');
        await saveData();
    }
    res.json({ success: true });
});

// Rota de Upload de Imagem de Falha (Fallback)
app.post('/api/upload-fallback', checkAuth, fallbackUpload.single('fallbackFile'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'Nenhum arquivo enviado.' });
    }
    
    const url = `/uploads/${req.file.filename}`;
    appData.fallbackImageUrl = url;
    await logActivity(req, 'Upload Fallback', `Nova imagem offline: ${req.file.filename}`);
    await saveData();
    res.json({ success: true, filePath: url });
});

// Rota para Deletar Fallback
app.delete('/api/upload-fallback', checkAuth, async (req, res) => {
    if (appData.fallbackImageUrl) {
        try {
            const filename = path.basename(appData.fallbackImageUrl);
            await fs.unlink(path.join(UPLOADS_DIR, filename));
        } catch (e) {}
        appData.fallbackImageUrl = null;
        await logActivity(req, 'Delete Fallback', 'Imagem offline removida');
        await saveData();
    }
    res.json({ success: true });
});

// Atualizar Ticker (Mensagem de Rodapé)
app.post('/api/update-ticker', checkAuth, async (req, res) => {
    const { message } = req.body;
    appData.tickerMessage = message;

    // Adiciona ao histórico se não for vazio
    if (message && String(message).trim().length > 0) {
        if (!appData.tickerHistory) appData.tickerHistory = [];
        
        // Remove se já existir para mover para o topo
        const idx = appData.tickerHistory.indexOf(message);
        if (idx !== -1) appData.tickerHistory.splice(idx, 1);
        
        appData.tickerHistory.unshift(message);
        // Limita a 10 itens
        if (appData.tickerHistory.length > 10) appData.tickerHistory.pop();
    }

    await logActivity(req, 'Update Ticker', `Mensagem: ${message}`);
    await saveData();
    res.json({ success: true, history: appData.tickerHistory });
});

// --- Rotas da Enquete ---

// Admin: Atualiza ou cria uma enquete
app.post('/api/admin/poll/update', checkAuth, async (req, res) => {
    const { question, options } = req.body;
    
    if (!Array.isArray(options)) {
        return res.status(400).json({ success: false, message: 'Opções inválidas' });
    }

    // Se a pergunta for nova, reseta tudo
    if (currentPoll.question !== question) {
        currentPoll.votedIPs = {};
    }

    currentPoll.question = question;
    currentPoll.options = options.map(optText => {
        // Tenta manter os votos se a opção já existia
        const existingOption = (currentPoll.options || []).find(o => o.text === optText);
        return { text: optText, votes: existingOption ? existingOption.votes : 0 };
    });

    appData.poll = currentPoll;
    await logActivity(req, 'Update Poll', `Enquete atualizada: "${question}"`);
    await saveData();
    res.json({ success: true, poll: currentPoll });
});

// Admin: Altera visibilidade da enquete
app.post('/api/admin/poll/toggle', checkAuth, async (req, res) => {
    currentPoll.visible = req.body.visible;
    appData.poll = currentPoll;
    await logActivity(req, 'Toggle Poll', `Visibilidade: ${currentPoll.visible}`);
    await saveData();
    res.json({ success: true, poll: currentPoll });
});

// Admin: Notificar que está digitando
app.post('/api/admin/typing', checkAuth, (req, res) => {
    adminTypingUntil = Date.now() + 5000; // Status válido por 5 segundos
    res.json({ success: true });
});

// Admin: Enviar Notificação Global
app.post('/api/admin/notification', checkAuth, async (req, res) => {
    const { message, type } = req.body;
    if (!message) return res.status(400).json({ success: false });
    
    const notificationId = Date.now();
    const notificationType = type || 'info';
    
    // 1. Atualiza notificação global (Toast para quem está online agora - Anônimos e Logados)
    appData.lastNotification = {
        id: notificationId,
        message: message,
        type: notificationType
    };

    // 2. Salva na caixa de entrada de todos os usuários cadastrados (Persistência)
    const notificationObj = {
        id: notificationId,
        message: message,
        type: notificationType,
        date: new Date().toISOString(),
        read: false
    };

    if (appData.users) {
        for (const phone in appData.users) {
            if (!appData.users[phone].notifications) {
                appData.users[phone].notifications = [];
            }
            appData.users[phone].notifications.unshift(notificationObj);
            // Limita a 20 mensagens para não crescer infinitamente
            if (appData.users[phone].notifications.length > 20) {
                appData.users[phone].notifications.pop();
            }
        }
    }

    // 3. Salva no histórico do admin
    if (!appData.sentNotifications) appData.sentNotifications = [];
    appData.sentNotifications.unshift({
        id: notificationId,
        message: message,
        type: notificationType,
        date: new Date().toISOString()
    });
    if (appData.sentNotifications.length > 50) appData.sentNotifications.pop();

    await logActivity(req, 'Global Notification', `Mensagem: ${message}`);
    await saveData();
    res.json({ success: true });
});

// Admin: Enviar Mensagem Direta para Usuário Específico
app.post('/api/admin/user/message', checkAuth, async (req, res) => {
    const { phone, message, type } = req.body;
    if (!phone || !message) return res.status(400).json({ success: false });

    const user = appData.users[phone];
    if (user) {
        const notificationId = Date.now();
        const notificationType = type || 'info';
        
        const notificationObj = {
            id: notificationId,
            message: message,
            type: notificationType,
            date: new Date().toISOString(),
            read: false,
            isDirect: true // Marca como mensagem direta
        };

        if (!user.notifications) user.notifications = [];
        user.notifications.unshift(notificationObj);
        if (user.notifications.length > 50) user.notifications.pop();

        await logActivity(req, 'Direct Message', `Para ${phone}: ${message}`);
        await saveData();
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false, message: 'Usuário não encontrado' });
    }
});

// Admin: Excluir notificação enviada (Undo)
app.delete('/api/admin/notification/:id', checkAuth, async (req, res) => {
    const notifId = parseInt(req.params.id);
    let deletedCount = 0;

    // 1. Remove da caixa de entrada dos usuários
    if (appData.users) {
        for (const phone in appData.users) {
            const user = appData.users[phone];
            if (user.notifications) {
                const initialLength = user.notifications.length;
                user.notifications = user.notifications.filter(n => n.id !== notifId);
                if (user.notifications.length < initialLength) {
                    deletedCount++;
                }
            }
        }
    }

    // 2. Remove do histórico de enviados
    if (appData.sentNotifications) {
        appData.sentNotifications = appData.sentNotifications.filter(n => n.id !== notifId);
    }

    await logActivity(req, 'Delete Notification', `Notificação ${notifId} removida de ${deletedCount} usuários.`);
    await saveData();
    res.json({ success: true, deletedCount });
});

// Admin: Agendar uma notificação
app.post('/api/admin/notifications/schedule', checkAuth, async (req, res) => {
    const { message, type, scheduledAt } = req.body;

    if (!message || !scheduledAt) {
        return res.status(400).json({ success: false, message: 'Mensagem e data de agendamento são obrigatórias.' });
    }

    if (new Date(scheduledAt).getTime() <= Date.now()) {
        return res.status(400).json({ success: false, message: 'A data de agendamento deve ser no futuro.' });
    }

    const newScheduledNotification = {
        id: Date.now(),
        message,
        type: type || 'info',
        scheduledAt
    };

    if (!appData.scheduledNotifications) appData.scheduledNotifications = [];
    appData.scheduledNotifications.push(newScheduledNotification);
    appData.scheduledNotifications.sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt)); // Keep it sorted

    await logActivity(req, 'Schedule Notification', `Agendado para ${new Date(scheduledAt).toLocaleString('pt-BR')}: ${message}`);
    await saveData();

    res.json({ success: true, scheduled: appData.scheduledNotifications });
});

// Admin: Cancelar uma notificação agendada
app.delete('/api/admin/notifications/scheduled/:id', checkAuth, async (req, res) => {
    const notifId = parseInt(req.params.id);
    if (!appData.scheduledNotifications) appData.scheduledNotifications = [];
    const initialLength = appData.scheduledNotifications.length;
    appData.scheduledNotifications = appData.scheduledNotifications.filter(n => n.id !== notifId);
    if (appData.scheduledNotifications.length < initialLength) {
        await logActivity(req, 'Cancel Scheduled Notification', `Agendamento ${notifId} cancelado.`);
        await saveData();
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false, message: 'Agendamento não encontrado.' });
    }
});

// Admin: Editar uma notificação agendada
app.put('/api/admin/notifications/scheduled/:id', checkAuth, async (req, res) => {
    const notifId = parseInt(req.params.id);
    const { message, type, scheduledAt } = req.body;

    if (!appData.scheduledNotifications) return res.status(404).json({ success: false });

    const index = appData.scheduledNotifications.findIndex(n => n.id === notifId);
    if (index !== -1) {
        if (message) appData.scheduledNotifications[index].message = message;
        if (type) appData.scheduledNotifications[index].type = type;
        if (scheduledAt) {
             if (new Date(scheduledAt).getTime() <= Date.now()) {
                return res.status(400).json({ success: false, message: 'A data de agendamento deve ser no futuro.' });
            }
            appData.scheduledNotifications[index].scheduledAt = scheduledAt;
        }

        // Reordena por data
        appData.scheduledNotifications.sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));

        await logActivity(req, 'Edit Scheduled Notification', `Agendamento ${notifId} atualizado.`);
        await saveData();
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false, message: 'Agendamento não encontrado.' });
    }
});

// Usuário: Obter Notificações (Caixa de Entrada)
app.get('/api/user/notifications', checkUserAuth, (req, res) => {
    const user = appData.users[req.userPhone];
    // Retorna array vazio se não tiver notificações
    res.json({ notifications: user ? (user.notifications || []) : [] });
});

// Usuário: Marcar notificações como lidas
app.post('/api/user/notifications/read', checkUserAuth, async (req, res) => {
    const user = appData.users[req.userPhone];
    if (user && user.notifications) {
        user.notifications.forEach(n => n.read = true);
        await saveData();
    }
    res.json({ success: true });
});

// Usuário: Responder a mensagem (Enviar para Admin)
app.post('/api/user/reply', checkUserAuth, async (req, res) => {
    const { message, originalMessageId } = req.body;
    if (!message) return res.status(400).json({ success: false });

    const reply = {
        id: Date.now(),
        from: req.userPhone,
        message: message,
        originalMessageId: originalMessageId || null,
        date: new Date().toISOString(),
        read: false
    };

    if (!appData.adminInbox) appData.adminInbox = [];
    appData.adminInbox.unshift(reply);
    // Limita a 100 mensagens na caixa de entrada do admin
    if (appData.adminInbox.length > 100) appData.adminInbox.pop();

    await logActivity(req, 'User Reply', `De ${req.userPhone}: ${message}`);
    await saveData();
    res.json({ success: true });
});

// Usuário: Excluir notificação individual
app.delete('/api/user/notifications/:id', checkUserAuth, async (req, res) => {
    const user = appData.users[req.userPhone];
    const notifId = parseInt(req.params.id);
    
    if (user && user.notifications) {
        const initialLength = user.notifications.length;
        user.notifications = user.notifications.filter(n => n.id !== notifId);
        
        if (user.notifications.length < initialLength) {
            await saveData();
            return res.json({ success: true });
        }
    }
    res.status(404).json({ success: false, message: 'Mensagem não encontrada.' });
});

// Usuário: Excluir TODAS as notificações (Limpar Tudo)
app.delete('/api/user/notifications', checkUserAuth, async (req, res) => {
    const user = appData.users[req.userPhone];
    if (user) {
        user.notifications = [];
        await saveData();
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false });
    }
});

// Admin: Obter histórico de notificações enviadas
app.get('/api/admin/notifications/history', checkAuth, (req, res) => {
    res.json({ history: appData.sentNotifications || [] });
});

// Admin: Obter notificações agendadas
app.get('/api/admin/notifications/scheduled', checkAuth, (req, res) => {
    res.json({ scheduled: appData.scheduledNotifications || [] });
});

// Admin: Ver quem leu uma notificação específica
app.get('/api/admin/notifications/:id/readers', checkAuth, (req, res) => {
    const notifId = parseInt(req.params.id);
    const readers = [];
    const unread = [];
    const totalSentTo = [];

    if (appData.users) {
        for (const [phone, user] of Object.entries(appData.users)) {
            const notif = user.notifications ? user.notifications.find(n => n.id === notifId) : null;
            if (notif) {
                totalSentTo.push(phone);
                if (notif.read) {
                    readers.push(phone);
                } else {
                    unread.push(phone);
                }
            }
        }
    }
    res.json({ 
        success: true, 
        readers, 
        unread,
        total: totalSentTo.length 
    });
});

// Admin: Obter Caixa de Entrada (Respostas dos Usuários)
app.get('/api/admin/inbox', checkAuth, (req, res) => {
    res.json({ inbox: appData.adminInbox || [] });
});

// Admin: Apagar mensagem da Caixa de Entrada
app.delete('/api/admin/inbox/:id', checkAuth, async (req, res) => {
    const id = parseInt(req.params.id);
    if (appData.adminInbox) {
        appData.adminInbox = appData.adminInbox.filter(m => m.id !== id);
        await saveData();
    }
    res.json({ success: true });
});

// --- Sistema de Suporte (Tickets) ---

// Admin: Resumo de Tickets (Usuários com mensagens)
app.get('/api/admin/support/summary', checkAuth, (req, res) => {
    if (!appData.adminInbox) appData.adminInbox = [];
    
    const userSummary = {};
    
    // Agrupa mensagens por telefone
    appData.adminInbox.forEach(msg => {
        if (!userSummary[msg.from]) {
            userSummary[msg.from] = {
                phone: msg.from,
                lastMessage: msg.message,
                date: msg.date,
                unreadCount: 0
            };
        }
        // Atualiza para a mensagem mais recente
        if (new Date(msg.date) > new Date(userSummary[msg.from].date)) {
            userSummary[msg.from].lastMessage = msg.message;
            userSummary[msg.from].date = msg.date;
        }
        if (!msg.read) userSummary[msg.from].unreadCount++;
    });

    // Converte para array e ordena por data (mais recente primeiro)
    const summaryList = Object.values(userSummary).sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ summary: summaryList });
});

// Admin: Obter Conversa Completa com Usuário
app.get('/api/admin/support/conversation/:phone', checkAuth, (req, res) => {
    const { phone } = req.params;
    
    // 1. Mensagens do Usuário (Inbox)
    const userMessages = (appData.adminInbox || []).filter(m => m.from === phone).map(m => ({ ...m, sender: 'user' }));
    
    // 2. Respostas do Admin (Notifications Direct)
    const user = appData.users[phone];
    const adminMessages = (user && user.notifications ? user.notifications.filter(n => n.isDirect) : []).map(m => ({ ...m, sender: 'admin', date: m.date }));

    // 3. Mescla e Ordena
    const conversation = [...userMessages, ...adminMessages].sort((a, b) => new Date(a.date) - new Date(b.date));
    res.json({ conversation });
});

// Usuário: Vota em uma opção
app.post('/api/poll/vote', (req, res) => {
    const { optionIndex } = req.body;
    const ip = req.ip || req.socket.remoteAddress;

    // Previne múltiplos votos (simplificado por IP)
    if (currentPoll.votedIPs[ip]) {
        return res.status(403).json({ success: false, message: 'Voto já registrado.' });
    }
    if (currentPoll.options && currentPoll.options[optionIndex]) {
        currentPoll.options[optionIndex].votes++;
        currentPoll.votedIPs[ip] = true;
        appData.poll = currentPoll;
        // Não precisa salvar a cada voto para não sobrecarregar o disco,
        // mas vamos salvar para persistir os votos.
        saveData();
        res.json({ success: true, poll: currentPoll });
    } else {
        res.status(400).json({ success: false, message: 'Opção inválida.' });
    }
});

// Atualizar configurações (Painel Admin)
app.post('/api/update-config', checkAuth, async (req, res) => {
    const { programs, streamConfig } = req.body;
    if (streamConfig) appData.streamConfig = streamConfig;
    if (programs) appData.programs = programs;
    await logActivity(req, 'Update Config', 'Configurações atualizadas');
    await saveData();
    res.json({ success: true });
});

// Zerar visualizações (Painel Admin)
app.post('/api/reset-views', checkAuth, async (req, res) => {
    appData.views = 0;
    await logActivity(req, 'Reset Views', 'Contador de visualizações zerado');
    await saveData();
    res.json({ success: true, views: 0 });
});

// Tratamento de erros básico
app.use(async (err, req, res, next) => {
  console.error(err.stack);
  try {
      await logActivity(req, 'SERVER ERROR', err.message || 'Erro interno desconhecido');
  } catch (e) {
      console.error("Falha ao registrar log de erro:", e);
  }
  res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
});

// --- Sistema de Agendamento de Notificações ---
const checkScheduledNotifications = async () => {
    const now = Date.now();
    const toSend = [];

    if (!appData.scheduledNotifications) appData.scheduledNotifications = [];

    // Find messages that are due
    appData.scheduledNotifications = appData.scheduledNotifications.filter(notif => {
        if (new Date(notif.scheduledAt).getTime() <= now) {
            toSend.push(notif);
            return false; // Remove from scheduled list
        }
        return true; // Keep in scheduled list
    });

    if (toSend.length > 0) {
        console.log(`Enviando ${toSend.length} notificações agendadas...`);
        for (const notif of toSend) {
            const notificationId = notif.id;
            const notificationType = notif.type || 'info';

            // 1. Toast para usuários online
            appData.lastNotification = {
                id: notificationId,
                message: notif.message,
                type: notificationType
            };

            // 2. Caixa de entrada de usuários cadastrados
            const notificationObj = {
                id: notificationId,
                message: notif.message,
                type: notificationType,
                date: new Date().toISOString(),
                read: false
            };

            if (appData.users) {
                for (const phone in appData.users) {
                    if (!appData.users[phone].notifications) appData.users[phone].notifications = [];
                    appData.users[phone].notifications.unshift(notificationObj);
                    if (appData.users[phone].notifications.length > 20) appData.users[phone].notifications.pop();
                }
            }

            // 3. Histórico do admin
            if (!appData.sentNotifications) appData.sentNotifications = [];
            appData.sentNotifications.unshift({ id: notificationId, message: notif.message, type: notificationType, date: new Date().toISOString() });
            if (appData.sentNotifications.length > 50) appData.sentNotifications.pop();

            // Log
            const log = { timestamp: new Date().toISOString(), ip: 'SYSTEM', action: 'Scheduled Notification Sent', details: `Mensagem: ${notif.message}` };
            if (!appData.activityLogs) appData.activityLogs = [];
            appData.activityLogs.unshift(log);
            if (appData.activityLogs.length > 50) appData.activityLogs.pop();
        }
        await saveData();
    }
};

// --- Sistema de Backup Automático ---
const performBackup = async () => {
    try {
        // Verifica se o arquivo db.json existe
        try {
            await fs.access(DB_FILE);
        } catch {
            return; 
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFile = path.join(BACKUPS_DIR, `db-${timestamp}.json`);
        await fs.copyFile(DB_FILE, backupFile);
        console.log(`Backup automático realizado: ${backupFile}`);

        // Mantém apenas os últimos 50 backups para economizar espaço
        const files = await fs.readdir(BACKUPS_DIR);
        const backups = files.filter(f => f.startsWith('db-') && f.endsWith('.json')).sort();
        
        if (backups.length > 50) {
            const toDelete = backups.slice(0, backups.length - 50);
            for (const file of toDelete) {
                await fs.unlink(path.join(BACKUPS_DIR, file));
            }
        }
    } catch (error) {
        console.error('Erro no backup automático:', error);
    }
};

// Realiza backup a cada 1 hora (3600000 ms)
setInterval(performBackup, 3600000);

// Verifica agendamentos a cada 1 minuto
setInterval(checkScheduledNotifications, 60000);

// Start the server
const startServer = async () => {
    await loadData();
    app.listen(port, () => {
      console.log(`Server is running on port ${port}`);
    });
};

startServer();