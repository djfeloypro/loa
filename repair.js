const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'db.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const BACKUPS_DIR = path.join(__dirname, 'backups');

// Dados padrão para recriação
const defaultData = {
    views: 0,
    streamConfig: {
        type: 'embed',
        url: "https://www.youtube.com/embed/j285sZAL6I8?si=E4mpAxlMCqNEAGbU&autoplay=1&enablejsapi=1",
        defaultQuality: 'auto'
    },
    users: {},
    logoUrl: null,
    fallbackImageUrl: null,
    tickerMessage: "",
    weeklyStats: {},
    programs: {},
    poll: {
        visible: false,
        question: '',
        options: [],
        votedIPs: {}
    },
    tickerHistory: [],
    activityLogs: []
};

// Inicializa estatísticas semanais vazias
for (let i = 0; i < 7; i++) {
    defaultData.weeklyStats[i] = new Array(24).fill(0);
}

async function repair() {
    console.log("🛠️  Iniciando Reparo do Sistema...");
    let fixedCount = 0;

    // 1. Verificar Diretórios Obrigatórios
    if (!fs.existsSync(UPLOADS_DIR)) {
        fs.mkdirSync(UPLOADS_DIR, { recursive: true });
        console.log("✅ Diretório 'uploads' criado.");
        fixedCount++;
    }
    if (!fs.existsSync(BACKUPS_DIR)) {
        fs.mkdirSync(BACKUPS_DIR, { recursive: true });
        console.log("✅ Diretório 'backups' criado.");
        fixedCount++;
    }

    // 2. Verificar Integridade do Banco de Dados (db.json)
    let appData = null;
    let dbExists = fs.existsSync(DB_FILE);

    if (dbExists) {
        try {
            const data = fs.readFileSync(DB_FILE, 'utf-8');
            appData = JSON.parse(data);
            console.log("✅ db.json lido com sucesso.");
        } catch (error) {
            console.error("❌ Erro ao ler db.json (Arquivo corrompido).");
            
            // Tentar Restaurar do Backup mais recente
            const backups = fs.readdirSync(BACKUPS_DIR)
                .filter(f => f.endsWith('.json'))
                .sort()
                .reverse(); // Ordena para pegar o mais recente primeiro

            if (backups.length > 0) {
                console.log(`🔄 Tentando restaurar do backup: ${backups[0]}`);
                try {
                    const backupData = fs.readFileSync(path.join(BACKUPS_DIR, backups[0]), 'utf-8');
                    appData = JSON.parse(backupData);
                    
                    // Renomeia o arquivo corrompido para análise posterior
                    const corruptedName = `${DB_FILE}.corrupted-${Date.now()}`;
                    fs.renameSync(DB_FILE, corruptedName);
                    console.log(`⚠️  Arquivo corrompido salvo como: ${path.basename(corruptedName)}`);
                    
                    // Salva o backup como o novo db.json
                    fs.writeFileSync(DB_FILE, JSON.stringify(appData, null, 2));
                    console.log("✅ Restaurado com sucesso do backup.");
                    fixedCount++;
                } catch (e) {
                    console.error("❌ Falha ao restaurar backup.", e);
                }
            }
        }
    }

    // Se não conseguiu ler nem restaurar, cria um novo
    if (!appData) {
        console.log("⚠️  Criando novo db.json com dados padrão.");
        appData = JSON.parse(JSON.stringify(defaultData));
        fs.writeFileSync(DB_FILE, JSON.stringify(appData, null, 2));
        fixedCount++;
    }

    // 3. Verificar Campos Internos (Estrutura de Dados)
    let dataModified = false;

    if (!appData.users) { appData.users = {}; dataModified = true; }
    if (!appData.streamConfig) { appData.streamConfig = defaultData.streamConfig; dataModified = true; }
    if (!appData.poll) { appData.poll = defaultData.poll; dataModified = true; }
    if (!appData.programs) { appData.programs = {}; dataModified = true; }
    
    if (dataModified) {
        fs.writeFileSync(DB_FILE, JSON.stringify(appData, null, 2));
        console.log("✅ Estrutura interna de dados corrigida.");
        fixedCount++;
    }

    console.log(`\n🏁 Reparo concluído. ${fixedCount} correções aplicadas.`);
    console.log("🚀 Agora você pode tentar iniciar o servidor: node server.js");
}

repair();