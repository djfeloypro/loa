const API_URL = '/api';
let weeklyPrograms = {}; // Armazena a grade completa
let currentDay = 1; // Default: Segunda (1)
let sortable = null;
let statsChart = null;
let weeklyChart = null;
let peakChart = null;
let dailyPeakChart = null;
let deviceChart = null;
let statsInterval = null;
let lastTotalViews = null;
let isSoundEnabled = true;
let currentWeeklyStats = null;
let currentScheduledNotifications = [];
let activeChatPhone = null; // Telefone do usuário selecionado no suporte
let lastSupportUnreadCount = null; // Controle para notificação sonora de suporte

// Verifica se já tem senha salva na sessão
document.addEventListener('DOMContentLoaded', async () => {
    const token = sessionStorage.getItem('authToken');
    if (token) {
        document.getElementById('loginSection').style.display = 'none';
        document.getElementById('dashboardSection').style.display = 'block';
        document.getElementById('logoutBtn').style.display = 'inline-block';
        await loadData();
        startStatsMonitoring();
    }

    // Evento de Digitação (Throttle para evitar muitas requisições)
    document.getElementById('globalMessageInput').addEventListener('input', throttle(notifyTyping, 2000));
    
    // Enter para enviar resposta no suporte
    document.getElementById('supportReplyInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendSupportReply();
    });
});

async function login() {
    const password = document.getElementById('adminPassword').value;
    
    try {
        const res = await fetch(`${API_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        
        const data = await res.json();
        
        if (data.success) {
            sessionStorage.setItem('authToken', data.token);
            document.getElementById('loginSection').style.display = 'none';
            document.getElementById('dashboardSection').style.display = 'block';
            document.getElementById('logoutBtn').style.display = 'inline-block';
            await loadData();
            startStatsMonitoring();
        } else {
            document.getElementById('loginError').style.display = 'block';
        }
    } catch (e) {
        alert("Erro ao conectar com servidor");
    }
}

function logout() {
    sessionStorage.removeItem('authToken');
    document.getElementById('loginSection').style.display = 'block';
    document.getElementById('dashboardSection').style.display = 'none';
    document.getElementById('logoutBtn').style.display = 'none';
    document.getElementById('adminPassword').value = '';
    if (statsInterval) clearInterval(statsInterval);
    if (statsChart) statsChart.destroy();
    if (weeklyChart) weeklyChart.destroy();
    if (peakChart) peakChart.destroy();
    if (dailyPeakChart) dailyPeakChart.destroy();
    if (deviceChart) deviceChart.destroy();
}

async function loadData() {
    const res = await fetch(`${API_URL}/config`);
    const data = await res.json();
    
    // Preenche Stream Config
    if (data.streamConfig) {
        document.getElementById('streamTypeSelect').value = data.streamConfig.type;
        document.getElementById('streamUrlInput').value = data.streamConfig.url;
        document.getElementById('streamQualitySelect').value = data.streamConfig.defaultQuality || 'auto';
    }

    // Preenche a pré-visualização do Logo
    const logoPreview = document.getElementById('logoPreview');
    if (data.logoUrl) {
        logoPreview.src = data.logoUrl + '?' + new Date().getTime(); // Cache bust
    } else {
        logoPreview.src = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="; // Imagem transparente
    }
    
    // Preenche Ticker
    document.getElementById('tickerInput').value = data.tickerMessage || "";
    renderTickerHistory(data.tickerHistory);

    // Preenche Preview Fallback
    const fallbackPreview = document.getElementById('fallbackPreview');
    if (data.fallbackImageUrl) {
        fallbackPreview.src = data.fallbackImageUrl + '?' + new Date().getTime();
    } else {
        fallbackPreview.style.display = 'none';
    }

    // Preenche Enquete
    if (data.poll) {
        document.getElementById('pollQuestionInput').value = data.poll.question;
        const optionInputs = document.querySelectorAll('.poll-option-input');
        optionInputs.forEach((input, index) => {
            input.value = data.poll.options[index] ? data.poll.options[index].text : '';
        });
        updatePollVisibilityButton(data.poll.visible);
        renderPollResultsAdmin(data.poll);
    }
    loadNotificationHistory(); // Carrega histórico de mensagens
    loadScheduledNotifications(); // Carrega agendamentos
    loadSupportSummary(); // Carrega lista de tickets

    // Preenche EPG
    weeklyPrograms = data.programs || {};
    // Se vier vazio ou formato antigo, inicializa
    if (Array.isArray(weeklyPrograms)) {
        // Já tratado no backend, mas por segurança
    }
    
    // Seleciona automaticamente o dia da semana atual
    const today = new Date().getDay();
    document.getElementById('epgDaySelect').value = today;
    changeEPGDay(); // Renderiza o dia selecionado
}

function renderTickerHistory(history) {
    const select = document.getElementById('tickerHistorySelect');
    if (!history || history.length === 0) {
        select.style.display = 'none';
        return;
    }
    
    select.style.display = 'block';
    select.innerHTML = '<option value="">Histórico de Mensagens...</option>';
    
    history.forEach(msg => {
        const option = document.createElement('option');
        option.value = msg;
        option.textContent = msg.length > 60 ? msg.substring(0, 60) + '...' : msg;
        select.appendChild(option);
    });
}

function selectTickerHistory() {
    const select = document.getElementById('tickerHistorySelect');
    if (select.value) {
        document.getElementById('tickerInput').value = select.value;
    }
}

function startStatsMonitoring() {
    updateStats(); // Primeira chamada
    statsInterval = setInterval(updateStats, 5000); // Atualiza a cada 5 segundos
}

async function updateStats() {
    const token = sessionStorage.getItem('authToken');
    try {
        const res = await fetch(`${API_URL}/stats`, {
            headers: { 'x-auth-token': token }
        });
        if (res.ok) {
            const data = await res.json();
            
            // Notificação Sonora de Novo Usuário
            if (lastTotalViews !== null && data.totalViews > lastTotalViews) {
                playNotificationSound();
            }
            lastTotalViews = data.totalViews;

            document.getElementById('statActiveUsers').innerText = data.activeUsers;
            document.getElementById('statTotalViews').innerText = data.totalViews;
            document.getElementById('statLoggedUsers').innerText = data.loggedUsers;
            currentWeeklyStats = data.weeklyStats; // Salva para exportação
            renderChart(data.history);
            renderWeeklyChart(data.weeklyStats);
            renderPeakChart(data.peakStats);
            renderDailyPeakChart(data.peakStats);
            renderDeviceChart(data.deviceStats);
            loadSupportSummary(); // Atualiza tickets em tempo real
            if (activeChatPhone) renderChatWindow(activeChatPhone, true); // Atualiza chat ativo sem loading
            // A API de stats não retorna a enquete, então não precisa atualizar aqui
        }
    } catch (e) {
        console.error("Erro ao atualizar estatísticas", e);
    }
}

function renderChart(history) {
    const ctx = document.getElementById('usersChart').getContext('2d');
    const labels = history.map(h => h.time);
    const dataPoints = history.map(h => h.count);

    if (statsChart) {
        statsChart.data.labels = labels;
        statsChart.data.datasets[0].data = dataPoints;
        statsChart.update();
    } else {
        statsChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Usuários Online',
                    data: dataPoints,
                    borderColor: '#28a745',
                    backgroundColor: 'rgba(40, 167, 69, 0.2)',
                    borderWidth: 2,
                    tension: 0.4,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                scales: {
                    y: { beginAtZero: true, ticks: { color: '#aaa' }, grid: { color: '#333' } },
                    x: { ticks: { color: '#aaa' }, grid: { color: '#333' } }
                },
                plugins: { legend: { labels: { color: 'white' } } }
            }
        });
    }
}

function renderWeeklyChart(weeklyStats) {
    const ctx = document.getElementById('weeklyChart').getContext('2d');
    const days = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
    const hours = Array.from({length: 24}, (_, i) => i.toString().padStart(2, '0') + 'h');
    
    // Prepara datasets (um para cada dia)
    const datasets = days.map((day, index) => {
        const colors = ['#ff6384', '#36a2eb', '#ffce56', '#4bc0c0', '#9966ff', '#ff9f40', '#e50914'];
        return {
            label: day,
            data: weeklyStats[index],
            borderColor: colors[index],
            backgroundColor: 'transparent',
            borderWidth: 2,
            tension: 0.3,
            pointRadius: 1
        };
    });

    if (weeklyChart) {
        weeklyChart.data.datasets = datasets;
        weeklyChart.update();
    } else {
        weeklyChart = new Chart(ctx, {
            type: 'line',
            data: { labels: hours, datasets: datasets },
            options: {
                responsive: true,
                scales: {
                    y: { beginAtZero: true, grid: { color: '#333' }, ticks: { color: '#aaa' } },
                    x: { grid: { color: '#333' }, ticks: { color: '#aaa' } }
                },
                plugins: { legend: { labels: { color: 'white' } } }
            }
        });
    }
}

function renderPeakChart(peakStats) {
    if (!peakStats) return;
    const ctx = document.getElementById('peakChart').getContext('2d');
    const days = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
    const hours = Array.from({length: 24}, (_, i) => i.toString().padStart(2, '0') + 'h');
    
    // Prepara datasets (um para cada dia)
    const datasets = days.map((day, index) => {
        const colors = ['#ff6384', '#36a2eb', '#ffce56', '#4bc0c0', '#9966ff', '#ff9f40', '#e50914'];
        return {
            label: day,
            data: peakStats[index],
            borderColor: colors[index],
            backgroundColor: 'transparent',
            borderWidth: 2,
            borderDash: [5, 5], // Linha tracejada para diferenciar
            tension: 0.3,
            pointRadius: 1
        };
    });

    if (peakChart) {
        peakChart.data.datasets = datasets;
        peakChart.update();
    } else {
        peakChart = new Chart(ctx, {
            type: 'line',
            data: { labels: hours, datasets: datasets },
            options: {
                responsive: true,
                scales: {
                    y: { beginAtZero: true, grid: { color: '#333' }, ticks: { color: '#aaa' } },
                    x: { grid: { color: '#333' }, ticks: { color: '#aaa' } }
                },
                plugins: { legend: { labels: { color: 'white' } } }
            }
        });
    }
}

function renderDailyPeakChart(peakStats) {
    if (!peakStats) return;
    const ctx = document.getElementById('dailyPeakChart').getContext('2d');
    const days = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
    
    // Extrai o valor máximo de cada dia (o maior valor entre as 24 horas)
    const dataPoints = days.map((_, index) => {
        const dayHours = peakStats[index] || [];
        // Encontra o maior número de usuários registrado naquele dia
        return Math.max(...dayHours, 0);
    });

    if (dailyPeakChart) {
        dailyPeakChart.data.datasets[0].data = dataPoints;
        dailyPeakChart.update();
    } else {
        dailyPeakChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: days,
                datasets: [{
                    label: 'Recorde de Usuários',
                    data: dataPoints,
                    backgroundColor: '#ffce56',
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                scales: {
                    y: { beginAtZero: true, grid: { color: '#333' }, ticks: { color: '#aaa' } },
                    x: { grid: { color: '#333' }, ticks: { color: '#aaa' } }
                },
                plugins: { legend: { labels: { color: 'white' } } }
            }
        });
    }
}

function renderDeviceChart(deviceStats) {
    if (!deviceStats) return;
    const ctx = document.getElementById('deviceChart').getContext('2d');
    
    const data = [deviceStats.mobile, deviceStats.desktop];
    
    if (deviceChart) {
        deviceChart.data.datasets[0].data = data;
        deviceChart.update();
    } else {
        deviceChart = new Chart(ctx, {
            type: 'pie',
            data: {
                labels: ['Mobile', 'Desktop'],
                datasets: [{
                    data: data,
                    backgroundColor: ['#e50914', '#00a8ff'],
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                plugins: { 
                    legend: { labels: { color: 'white' } } 
                }
            }
        });
    }
}

function changeEPGDay() {
    const select = document.getElementById('epgDaySelect');
    currentDay = parseInt(select.value);
    renderEPGEditor();
}

function renderEPGEditor() {
    const list = document.getElementById('epgEditorList');
    list.innerHTML = '';
    const currentPrograms = weeklyPrograms[currentDay] || [];
    
    currentPrograms.forEach((prog, index) => {
        const item = document.createElement('div');
        item.className = 'epg-edit-item';
        item.innerHTML = `
            <i class="material-icons drag-handle">drag_indicator</i>
            <span class="index-badge">#${index + 1}</span>
            <input type="time" value="${prog.time || '00:00'}" onchange="updateProgram(${index}, 'time', this.value)" style="padding: 10px; border-radius: 4px; border: 1px solid #333; background: rgba(0,0,0,0.3); color: white;">
            <input type="text" placeholder="Título do Programa" value="${prog.title}" onchange="updateProgram(${index}, 'title', this.value)">
            <input type="text" placeholder="Descrição" value="${prog.description || ''}" onchange="updateProgram(${index}, 'description', this.value)">
            <input type="text" placeholder="Categoria" value="${prog.category}" onchange="updateProgram(${index}, 'category', this.value)">
            <button onclick="removeProgram(${index})" style="background: #e50914; color: white; border: none; padding: 8px; cursor: pointer; border-radius: 4px; margin-left: 5px; display: flex; align-items: center;" title="Remover">
                <i class="material-icons" style="font-size: 18px;">delete</i>
            </button>
        `;
        list.appendChild(item);
    });

    // Inicializa o SortableJS
    if (sortable) {
        sortable.destroy();
    }

    sortable = new Sortable(list, {
        animation: 150,
        handle: '.drag-handle',
        onEnd: (evt) => {
            const currentPrograms = weeklyPrograms[currentDay];
            const [movedItem] = currentPrograms.splice(evt.oldIndex, 1);
            currentPrograms.splice(evt.newIndex, 0, movedItem);
            renderEPGEditor(); // Re-render para atualizar os índices nos handlers
        }
    });
}

function updateProgram(index, field, value) {
    weeklyPrograms[currentDay][index][field] = value;
}

function addProgram() {
    if (!weeklyPrograms[currentDay]) weeklyPrograms[currentDay] = [];
    weeklyPrograms[currentDay].push({ time: "12:00", title: "Novo Programa", description: "", category: "Geral" });
    renderEPGEditor();
}

function removeProgram(index) {
    if (confirm("Deseja remover este programa?")) {
        weeklyPrograms[currentDay].splice(index, 1);
        renderEPGEditor();
    }
}

function cloneSchedule() {
    const days = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
    const targetInput = prompt(`Copiar a programação de ${days[currentDay]} para qual dia?\n\n0 = Domingo\n1 = Segunda\n2 = Terça\n3 = Quarta\n4 = Quinta\n5 = Sexta\n6 = Sábado`);
    
    if (targetInput === null) return;
    const targetDay = parseInt(targetInput);

    if (isNaN(targetDay) || targetDay < 0 || targetDay > 6) {
        alert("Dia inválido.");
        return;
    }

    if (targetDay === currentDay) return alert("Origem e destino são iguais.");

    if (confirm(`Isso substituirá toda a programação de ${days[targetDay]}. Continuar?`)) {
        weeklyPrograms[targetDay] = JSON.parse(JSON.stringify(weeklyPrograms[currentDay] || []));
        alert(`Copiado para ${days[targetDay]}. Clique em "Salvar Grade Completa" para confirmar.`);
    }
}

function clearSchedule() {
    const days = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
    if (confirm(`Tem certeza que deseja limpar toda a programação de ${days[currentDay]}?`)) {
        weeklyPrograms[currentDay] = [];
        renderEPGEditor();
    }
}

function importEPG() {
    document.getElementById('epgImportInput').click();
}

function handleEPGImport(input) {
    const file = input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const importedData = JSON.parse(e.target.result);
            
            if (confirm("Isso substituirá toda a grade de programação atual pela do arquivo. Continuar?")) {
                if (Array.isArray(importedData)) {
                    // Suporte a formato antigo (array único) - Replica para todos os dias
                    const newStructure = {};
                    for (let i = 0; i < 7; i++) {
                        newStructure[i] = JSON.parse(JSON.stringify(importedData));
                    }
                    weeklyPrograms = newStructure;
                } else if (typeof importedData === 'object') {
                    weeklyPrograms = importedData;
                } else {
                    throw new Error("Formato inválido");
                }
                
                renderEPGEditor();
                alert("EPG Importado com sucesso! Verifique os dados e clique em 'Salvar Grade Completa' para persistir.");
            }
        } catch (err) {
            alert("Erro ao processar arquivo: " + err.message);
        }
        input.value = ''; // Reset do input
    };
    reader.readAsText(file);
}

async function saveConfig() {
    const token = sessionStorage.getItem('authToken');
    
    const body = {
        programs: weeklyPrograms
    };

    try {
        const res = await fetch(`${API_URL}/update-config`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'x-auth-token': token
            },
            body: JSON.stringify(body)
        });

        if (res.status === 401) {
            alert("Sessão expirada. Faça login novamente.");
            logout();
            return;
        }
        
        if (res.ok) alert("Configurações salvas com sucesso!");
        else alert("Erro ao salvar.");
    } catch (e) {
        alert("Erro de conexão.");
    }
}

// --- Utilitários ---
function throttle(func, limit) {
    let inThrottle;
    return function() {
        const args = arguments;
        const context = this;
        if (!inThrottle) {
            func.apply(context, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    }
}

async function notifyTyping() {
    const token = sessionStorage.getItem('authToken');
    try {
        await fetch(`${API_URL}/admin/typing`, { method: 'POST', headers: { 'x-auth-token': token } });
    } catch (e) {}
}

async function scheduleGlobalNotification() {
    const token = sessionStorage.getItem('authToken');
    const message = document.getElementById('globalMessageInput').value;
    const type = document.getElementById('globalMessageType').value;
    const scheduledAt = document.getElementById('scheduleTimeInput').value;

    if (!message.trim()) return alert("Digite uma mensagem.");
    if (!scheduledAt) return alert("Por favor, selecione uma data e hora para o agendamento.");

    if (new Date(scheduledAt).getTime() <= Date.now()) {
        return alert("A data de agendamento deve ser no futuro.");
    }

    try {
        const res = await fetch(`${API_URL}/admin/notifications/schedule`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'x-auth-token': token 
            },
            body: JSON.stringify({ message, type, scheduledAt })
        });

        const data = await res.json();
        if (data.success) {
            alert("Mensagem agendada com sucesso!");
            document.getElementById('globalMessageInput').value = '';
            document.getElementById('scheduleTimeInput').value = '';
            loadScheduledNotifications();
        } else {
            alert("Erro ao agendar: " + (data.message || 'Erro desconhecido.'));
        }
    } catch (e) {
        alert("Erro de conexão.");
    }
}

async function loadSupportSummary() {
    const token = sessionStorage.getItem('authToken');
    const list = document.getElementById('supportUserList');
    if (!list) return;

    try {
        const res = await fetch(`${API_URL}/admin/support/summary`, { headers: { 'x-auth-token': token } });
        const data = await res.json();
        
        // Verifica se há novas mensagens para tocar som
        const currentTotalUnread = (data.summary || []).reduce((acc, u) => acc + u.unreadCount, 0);
        
        if (lastSupportUnreadCount !== null && currentTotalUnread > lastSupportUnreadCount) {
            playNotificationSound();
        }
        lastSupportUnreadCount = currentTotalUnread;
        
        if (!data.summary || data.summary.length === 0) {
            list.innerHTML = '<p style="padding:15px; color:#666; font-size:13px;">Nenhum ticket aberto.</p>';
            return;
        }

        // Mantém a seleção ativa se houver
        const currentActive = activeChatPhone;

        list.innerHTML = data.summary.map(user => {
            const date = new Date(user.date).toLocaleTimeString('pt-BR', {hour: '2-digit', minute:'2-digit'});
            const activeClass = user.phone === currentActive ? 'active' : '';
            const unreadBadge = user.unreadCount > 0 ? `<span style="background:#e50914; color:white; padding:2px 6px; border-radius:10px; font-size:10px; margin-left:5px;">${user.unreadCount}</span>` : '';
            
            return `
                <div class="support-user-item ${activeClass}" onclick="openSupportChat('${user.phone}')">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <strong style="color:white; font-size:14px;">${user.phone}</strong>
                        <span style="color:#aaa; font-size:11px;">${date}</span>
                    </div>
                    <div style="display:flex; justify-content:space-between; margin-top:5px;">
                        <span style="color:#aaa; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:150px;">${user.lastMessage}</span>
                        ${unreadBadge}
                    </div>
                </div>
            `;
        }).join('');
    } catch (e) { console.error(e); }
}

async function openSupportChat(phone) {
    activeChatPhone = phone;
    loadSupportSummary(); // Atualiza UI para marcar ativo
    
    const token = sessionStorage.getItem('authToken');
    const chatWindow = document.getElementById('supportChatWindow');
    const inputArea = document.getElementById('supportInputArea');
    
    chatWindow.innerHTML = '<p style="text-align:center; color:#aaa; padding:20px;">Carregando conversa...</p>';
    inputArea.style.display = 'flex';

    try {
        const res = await fetch(`${API_URL}/admin/support/conversation/${phone}`, { headers: { 'x-auth-token': token } });
        const data = await res.json();
        
        chatWindow.innerHTML = '';
        data.conversation.forEach(msg => {
            const date = new Date(msg.date).toLocaleString('pt-BR');
            const typeClass = msg.sender === 'admin' ? 'admin' : 'user';
            
            chatWindow.innerHTML += `
                <div class="chat-bubble ${typeClass}">
                    ${msg.message}
                    <div style="font-size:10px; opacity:0.6; margin-top:5px; text-align:right;">${date}</div>
                </div>
            `;
        });
        
        // Rola para o final
        chatWindow.scrollTop = chatWindow.scrollHeight;
    } catch (e) {
        chatWindow.innerHTML = '<p style="color:red; text-align:center;">Erro ao carregar conversa.</p>';
    }
}

async function sendSupportReply() {
    if (!activeChatPhone) return;
    const input = document.getElementById('supportReplyInput');
    const message = input.value;
    if (!message.trim()) return;

    const token = sessionStorage.getItem('authToken');
    try {
        const res = await fetch(`${API_URL}/admin/user/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
            body: JSON.stringify({ phone: activeChatPhone, message, type: 'info' })
        });
        
        if (res.ok) {
            input.value = '';
            renderChatWindow(activeChatPhone, true); // Recarrega chat sem loading
        }
    } catch (e) { alert("Erro ao enviar."); }
}

async function loadScheduledNotifications() {
    const token = sessionStorage.getItem('authToken');
    const list = document.getElementById('scheduledNotificationsList');
    if (!list) return;

    try {
        const res = await fetch(`${API_URL}/admin/notifications/scheduled`, { headers: { 'x-auth-token': token } });
        const data = await res.json();
        currentScheduledNotifications = data.scheduled || [];
        
        if (!data.scheduled || data.scheduled.length === 0) {
            list.innerHTML = '<p style="color: #666; font-size: 13px;">Nenhuma mensagem agendada.</p>';
            return;
        }

        list.innerHTML = data.scheduled.map(item => {
            const date = new Date(item.scheduledAt).toLocaleString('pt-BR');
            return `
                <div style="background: rgba(255,255,255,0.05); padding: 10px; margin-bottom: 8px; border-radius: 4px; border-left: 3px solid #ff9800;">
                    <div style="display:flex; justify-content:space-between; margin-bottom:5px;">
                        <span style="font-size: 11px; color: #aaa;"><b>Agendado para:</b> ${date}</span>
                        <div>
                            <button onclick="openEditScheduleModal(${item.id})" style="background:none; border:none; color:#ffce56; cursor:pointer; font-size:11px; text-decoration:underline; margin-right: 10px;">Editar</button>
                            <button onclick="cancelScheduledNotification(${item.id})" style="background:none; border:none; color:#e50914; cursor:pointer; font-size:11px; text-decoration:underline;">Cancelar</button>
                        </div>
                    </div>
                    <p style="font-size: 13px; color: #ddd; margin: 0;">${item.message}</p>
                </div>
            `;
        }).join('');
    } catch (e) { console.error(e); }
}

async function cancelScheduledNotification(id) {
    if (!confirm("Tem certeza que deseja cancelar o agendamento desta mensagem?")) return;
    
    const token = sessionStorage.getItem('authToken');
    try {
        const res = await fetch(`${API_URL}/admin/notifications/scheduled/${id}`, {
            method: 'DELETE',
            headers: { 'x-auth-token': token }
        });
        const data = await res.json();
        if (data.success) {
            alert(`Agendamento cancelado com sucesso.`);
            loadScheduledNotifications();
        } else {
            alert("Erro ao cancelar agendamento.");
        }
    } catch (e) {
        alert("Erro de conexão.");
    }
}

function openEditScheduleModal(id) {
    const item = currentScheduledNotifications.find(n => n.id === id);
    if (!item) return;

    document.getElementById('editScheduleId').value = item.id;
    document.getElementById('editScheduleMessage').value = item.message;
    document.getElementById('editScheduleType').value = item.type || 'info';
    document.getElementById('editScheduleTime').value = item.scheduledAt;

    document.getElementById('editScheduleModal').style.display = 'flex';
}

function closeEditScheduleModal() {
    document.getElementById('editScheduleModal').style.display = 'none';
}

async function saveScheduledNotification() {
    const token = sessionStorage.getItem('authToken');
    const id = document.getElementById('editScheduleId').value;
    const message = document.getElementById('editScheduleMessage').value;
    const type = document.getElementById('editScheduleType').value;
    const scheduledAt = document.getElementById('editScheduleTime').value;

    if (!message.trim()) return alert("A mensagem não pode estar vazia.");

    try {
        const res = await fetch(`${API_URL}/admin/notifications/scheduled/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
            body: JSON.stringify({ message, type, scheduledAt })
        });
        const data = await res.json();
        if (data.success) {
            alert("Agendamento atualizado!");
            closeEditScheduleModal();
            loadScheduledNotifications();
        } else alert("Erro: " + (data.message || "Falha ao atualizar."));
    } catch (e) {
        alert("Erro de conexão.");
    }
}

async function saveStreamConfig() {
    const token = sessionStorage.getItem('authToken');
    const type = document.getElementById('streamTypeSelect').value;
    const url = document.getElementById('streamUrlInput').value;
    const defaultQuality = document.getElementById('streamQualitySelect').value;

    try {
        const res = await fetch(`${API_URL}/update-config`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'x-auth-token': token
            },
            body: JSON.stringify({ streamConfig: { type, url, defaultQuality } })
        });

        if (res.status === 401) {
            alert("Sessão expirada. Faça login novamente.");
            logout();
            return;
        }
        
        if (res.ok) alert("Configuração de transmissão salva!");
        else alert("Erro ao salvar.");
    } catch (e) {
        alert("Erro de conexão.");
    }
}

async function resetViews() {
    if(!confirm("Tem certeza que deseja zerar o contador?")) return;
    
    const token = sessionStorage.getItem('authToken');
    const res = await fetch(`${API_URL}/reset-views`, {
        method: 'POST',
        headers: { 'x-auth-token': token }
    });

    if (res.status === 401) {
        alert("Sessão expirada. Faça login novamente.");
        logout();
        return;
    }
    alert("Visualizações zeradas.");
}

async function uploadLogo() {
    const token = sessionStorage.getItem('authToken');
    const logoInput = document.getElementById('logoInput');
    const file = logoInput.files[0];

    if (!file) {
        alert("Por favor, selecione um arquivo de imagem.");
        return;
    }

    if (file.size > 5 * 1024 * 1024) {
        alert("A imagem é muito grande. O tamanho máximo permitido é 5MB.");
        return;
    }

    const formData = new FormData();
    formData.append('logoFile', file); // 'logoFile' deve ser o mesmo nome usado no server.js

    try {
        const res = await fetch(`${API_URL}/upload-logo`, {
            method: 'POST',
            headers: { 'x-auth-token': token },
            body: formData // O browser define o Content-Type automaticamente
        });

        if (res.status === 401) {
            alert("Sessão expirada. Faça login novamente.");
            logout();
            return;
        }

        const data = await res.json();
        if (data.success) {
            alert("Logo salvo com sucesso!");
            document.getElementById('logoPreview').src = data.filePath + '?' + new Date().getTime(); // Atualiza preview com cache bust
        } else {
            alert("Erro ao salvar o logo: " + (data.message || 'Verifique o console do servidor.'));
        }
    } catch (e) {
        alert("Erro de conexão ao enviar o logo.");
    }
}

async function deleteLogo() {
    if (!confirm("Tem certeza que deseja eliminar o logo?")) return;
    const token = sessionStorage.getItem('authToken');
    try {
        const res = await fetch(`${API_URL}/upload-logo`, {
            method: 'DELETE',
            headers: { 'x-auth-token': token }
        });
        if (res.ok) {
            alert("Logo eliminado.");
            document.getElementById('logoPreview').src = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
        }
    } catch (e) { alert("Erro ao eliminar."); }
}

async function saveTicker() {
    const token = sessionStorage.getItem('authToken');
    const message = document.getElementById('tickerInput').value;

    try {
        const res = await fetch(`${API_URL}/update-ticker`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'x-auth-token': token 
            },
            body: JSON.stringify({ message })
        });
        
        const data = await res.json();
        if (data.success) {
            alert("Mensagem atualizada!");
            if (data.history) renderTickerHistory(data.history);
        } else alert("Erro ao atualizar mensagem.");
    } catch (e) {
        alert("Erro de conexão.");
    }
}

async function uploadFallback() {
    const token = sessionStorage.getItem('authToken');
    const fileInput = document.getElementById('fallbackInput');
    const file = fileInput.files[0];

    if (!file) {
        alert("Selecione uma imagem.");
        return;
    }

    if (file.size > 5 * 1024 * 1024) {
        alert("A imagem é muito grande. O tamanho máximo permitido é 5MB.");
        return;
    }

    const formData = new FormData();
    formData.append('fallbackFile', file);

    try {
        const res = await fetch(`${API_URL}/upload-fallback`, {
            method: 'POST',
            headers: { 'x-auth-token': token },
            body: formData
        });
        
        const data = await res.json();
        if (data.success) {
            alert("Imagem offline salva!");
            document.getElementById('fallbackPreview').src = data.filePath + '?' + new Date().getTime();
            document.getElementById('fallbackPreview').style.display = 'block';
        }
    } catch (e) {
        alert("Erro ao enviar imagem.");
    }
}

async function deleteFallback() {
    if (!confirm("Tem certeza que deseja eliminar a imagem de falha?")) return;
    const token = sessionStorage.getItem('authToken');
    try {
        const res = await fetch(`${API_URL}/upload-fallback`, {
            method: 'DELETE',
            headers: { 'x-auth-token': token }
        });
        if (res.ok) {
            alert("Imagem eliminada.");
            document.getElementById('fallbackPreview').style.display = 'none';
        }
    } catch (e) { alert("Erro ao eliminar."); }
}

function openTab(tabName) {
    // Esconde todas as abas
    const contents = document.querySelectorAll('.tab-content');
    contents.forEach(content => {
        content.style.display = 'none';
        content.classList.remove('active');
    });

    // Remove classe active dos botões
    const buttons = document.querySelectorAll('.tab-btn');
    buttons.forEach(btn => btn.classList.remove('active'));

    // Mostra a aba selecionada
    document.getElementById('tab-' + tabName).style.display = 'block';
    document.getElementById('tab-' + tabName).classList.add('active');
    
    // Ativa o botão correspondente
    const activeBtn = document.querySelector(`button[onclick="openTab('${tabName}')"]`);
    if (activeBtn) activeBtn.classList.add('active');

    // Se for a aba de logs, carrega os dados
    if (tabName === 'logs') {
        loadLogs();
    }
    // Se for a aba de backups, carrega os dados
    if (tabName === 'backups') {
        loadBackups();
    }
    // Se for a aba de usuários
    if (tabName === 'users') {
        loadUsers();
    }
    // Atualiza link do EPG
    if (tabName === 'epg') {
        document.getElementById('epgPublicLink').innerText = `${window.location.protocol}//${window.location.hostname}:${window.location.port || '3000'}/api/epg`;
    }
}

async function updatePoll() {
    const token = sessionStorage.getItem('authToken');
    const question = document.getElementById('pollQuestionInput').value;
    const optionInputs = document.querySelectorAll('.poll-option-input');
    const options = Array.from(optionInputs).map(input => input.value).filter(val => val.trim() !== '');

    if (!question || options.length < 2) {
        alert("A enquete precisa de uma pergunta e pelo menos 2 opções.");
        return;
    }

    try {
        const res = await fetch(`${API_URL}/admin/poll/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
            body: JSON.stringify({ question, options })
        });
        const data = await res.json();
        if (data.success) {
            alert("Enquete atualizada!");
            renderPollResultsAdmin(data.poll);
        }
    } catch (e) {
        alert("Erro ao atualizar enquete.");
    }
}

async function togglePollVisibility() {
    const token = sessionStorage.getItem('authToken');
    const btn = document.getElementById('pollVisibilityBtn');
    const isVisible = btn.innerText.includes('Mostrar');

    try {
        const res = await fetch(`${API_URL}/admin/poll/toggle`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
            body: JSON.stringify({ visible: isVisible })
        });
        const data = await res.json();
        if (data.success) {
            updatePollVisibilityButton(data.poll.visible);
        }
    } catch (e) {
        alert("Erro ao alterar visibilidade.");
    }
}

function updatePollVisibilityButton(isVisible) {
    const btn = document.getElementById('pollVisibilityBtn');
    if (isVisible) {
        btn.innerText = 'Ocultar Enquete';
        btn.style.backgroundColor = '#f44336';
    } else {
        btn.innerText = 'Mostrar Enquete';
        btn.style.backgroundColor = '#4CAF50';
    }
}

function renderPollResultsAdmin(poll) {
    const container = document.getElementById('pollResultsAdmin');
    if (!poll || !poll.question) {
        container.innerHTML = '';
        return;
    }

    const totalVotes = poll.options.reduce((sum, opt) => sum + opt.votes, 0);
    
    let html = `<h4 style="margin-bottom: 10px;">Resultados: ${poll.question}</h4>`;
    poll.options.forEach(option => {
        const percentage = totalVotes > 0 ? ((option.votes / totalVotes) * 100).toFixed(1) : 0;
        html += `
            <div style="margin-bottom: 8px;">
                <div style="display: flex; justify-content: space-between; font-size: 14px; margin-bottom: 4px;">
                    <span>${option.text}</span>
                    <span style="color: #aaa;">${option.votes} votos (${percentage}%)</span>
                </div>
                <div style="background: #333; border-radius: 4px; overflow: hidden;">
                    <div style="width: ${percentage}%; background: var(--primary-color); height: 8px; border-radius: 4px;"></div>
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}

async function loadUsers() {
    const token = sessionStorage.getItem('authToken');
    try {
        const res = await fetch(`${API_URL}/admin/users`, { headers: { 'x-auth-token': token } });
        const data = await res.json();
        const tbody = document.getElementById('usersTableBody');
        tbody.innerHTML = '';
        data.users.forEach(u => {
            const row = document.createElement('tr');
            row.style.borderBottom = '1px solid #333';
            row.innerHTML = `
                <td style="padding: 10px;">${u.phone}</td>
                <td style="padding: 10px;">${u.favorites.length}</td>
                <td style="padding: 10px; text-align: right;">
                    <button onclick="sendMessageToUser('${u.phone}')" class="btn-info" style="padding: 5px 10px; font-size: 12px; margin-right: 5px;">Enviar Mensagem</button>
                    <button onclick="deleteUser('${u.phone}')" class="btn-danger" style="padding: 5px 10px; font-size: 12px;">Excluir</button>
                </td>
            `;
            tbody.appendChild(row);
        });
    } catch (e) { console.error(e); }
}

async function deleteUser(phone) {
    if(!confirm(`Excluir usuário ${phone}?`)) return;
    const token = sessionStorage.getItem('authToken');
    await fetch(`${API_URL}/admin/users/${phone}`, { method: 'DELETE', headers: { 'x-auth-token': token } });
    await loadUsers();
}

async function sendMessageToUser(phone) {
    const message = prompt(`Digite a mensagem para o usuário ${phone}:`);
    if (!message || !message.trim()) return;

    const token = sessionStorage.getItem('authToken');
    try {
        const res = await fetch(`${API_URL}/admin/user/message`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'x-auth-token': token 
            },
            body: JSON.stringify({ phone, message, type: 'info' })
        });
        const data = await res.json();
        if (data.success) alert("Mensagem enviada com sucesso!");
        else alert("Erro ao enviar.");
    } catch (e) {
        alert("Erro de conexão.");
    }
}

async function copyEPGLink() {
    const url = document.getElementById('epgPublicLink').innerText;
    try {
        await navigator.clipboard.writeText(url);
        alert("Link copiado!");
    } catch (e) {
        console.error("Erro ao copiar link", e);
    }
}

// --- Funcionalidades Adicionais (Som, CSV, Teste) ---

function toggleSound() {
    isSoundEnabled = !isSoundEnabled;
    const btn = document.getElementById('soundToggleBtn');
    if (isSoundEnabled) {
        btn.innerHTML = '<i class="material-icons" style="vertical-align: middle;">volume_up</i> Som: ON';
        btn.className = 'btn-info';
        btn.style.backgroundColor = '#17a2b8';
    } else {
        btn.innerHTML = '<i class="material-icons" style="vertical-align: middle;">volume_off</i> Som: OFF';
        btn.className = 'btn-danger';
        btn.style.backgroundColor = '#6c757d';
    }
}

function playNotificationSound() {
    if (isSoundEnabled) {
        const audio = new Audio('https://actions.google.com/sounds/v1/alarms/beep_short.ogg');
        audio.volume = 0.5;
        audio.play().catch(() => {});
    }
}

function exportStatsCSV() {
    if (!currentWeeklyStats) {
        alert("Aguarde o carregamento das estatísticas...");
        return;
    }

    let csvContent = "data:text/csv;charset=utf-8,";
    csvContent += "Dia da Semana,Hora,Visualizacoes\n";

    const days = ['Domingo', 'Segunda', 'Terca', 'Quarta', 'Quinta', 'Sexta', 'Sabado'];

    days.forEach((dayName, dayIndex) => {
        const dayData = currentWeeklyStats[dayIndex] || [];
        dayData.forEach((views, hour) => {
            csvContent += `${dayName},${hour}:00,${views}\n`;
        });
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "estatisticas_streamhd.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function testStreamLink() {
    const url = document.getElementById('streamUrlInput').value;
    if (url && url.trim() !== "") {
        window.open(url, '_blank');
    } else {
        alert("Por favor, insira uma URL válida para testar.");
    }
}

// --- Comunicação Global e Histórico ---

async function sendGlobalNotification() {
    const token = sessionStorage.getItem('authToken');
    const input = document.getElementById('globalMessageInput');
    const message = input.value;
    const type = document.getElementById('globalMessageType').value;

    if (!message.trim()) return alert("Digite uma mensagem.");

    try {
        const res = await fetch(`${API_URL}/admin/notification`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'x-auth-token': token 
            },
            body: JSON.stringify({ message, type })
        });

        const data = await res.json();
        if (data.success) {
            alert("Mensagem enviada para todos os usuários!");
            input.value = '';
            loadNotificationHistory(); // Atualiza a lista
        } else {
            alert("Erro ao enviar.");
        }
    } catch (e) {
        alert("Erro de conexão.");
    }
}

async function loadNotificationHistory() {
    const token = sessionStorage.getItem('authToken');
    const list = document.getElementById('notificationHistoryList');
    if (!list) return;

    try {
        const res = await fetch(`${API_URL}/admin/notifications/history`, { headers: { 'x-auth-token': token } });
        const data = await res.json();
        
        if (!data.history || data.history.length === 0) {
            list.innerHTML = '<p style="color: #666; font-size: 13px;">Nenhuma mensagem enviada ainda.</p>';
            return;
        }

        list.innerHTML = data.history.map(item => {
            const date = new Date(item.date).toLocaleString('pt-BR');
            return `
                <div style="background: rgba(255,255,255,0.05); padding: 10px; margin-bottom: 8px; border-radius: 4px; border-left: 3px solid #00a8ff;">
                    <div style="display:flex; justify-content:space-between; margin-bottom:5px;">
                        <span style="font-size: 11px; color: #aaa;">${date}</span>
                        <div>
                            <button onclick="viewReaders(${item.id})" style="background:none; border:none; color:#00a8ff; cursor:pointer; font-size:11px; text-decoration:underline; margin-right: 10px;">Ver quem leu</button>
                            <button onclick="deleteNotification(${item.id})" style="background:none; border:none; color:#e50914; cursor:pointer; font-size:11px; text-decoration:underline;">Excluir</button>
                        </div>
                    </div>
                    <p style="font-size: 13px; color: #ddd; margin: 0;">${item.message}</p>
                    <div id="readers-${item.id}" style="display:none; margin-top:10px; padding-top:10px; border-top:1px solid rgba(255,255,255,0.1); font-size:12px;"></div>
                </div>
            `;
        }).join('');
    } catch (e) { console.error(e); }
}

async function viewReaders(id) {
    const token = sessionStorage.getItem('authToken');
    const container = document.getElementById(`readers-${id}`);
    
    try {
        container.innerHTML = 'Carregando...';
        container.style.display = 'block';
        
        const res = await fetch(`${API_URL}/admin/notifications/${id}/readers`, { headers: { 'x-auth-token': token } });
        const data = await res.json();
        
        if (data.success) {
            const readCount = data.readers.length;
            const totalCount = data.total;
            const percentage = totalCount > 0 ? Math.round((readCount / totalCount) * 100) : 0;
            
            let html = `<p style="color: #aaa; margin-bottom: 5px;"><strong>Progresso:</strong> ${readCount} de ${totalCount} usuários leram (${percentage}%)</p>`;
            
            if (readCount > 0) {
                html += `<div style="max-height: 100px; overflow-y: auto; background: rgba(0,0,0,0.2); padding: 5px; border-radius: 4px;">`;
                html += data.readers.map(phone => `<span style="display:inline-block; background:#28a745; color:white; padding:2px 6px; border-radius:10px; font-size:10px; margin:2px;">${phone}</span>`).join('');
                html += `</div>`;
            } else {
                html += `<p style="color: #777; font-style: italic;">Ninguém leu ainda.</p>`;
            }
            
            container.innerHTML = html;
        }
    } catch (e) {
        container.innerHTML = '<span style="color:red">Erro ao carregar.</span>';
    }
}

async function deleteNotification(id) {
    if (!confirm("Tem certeza que deseja apagar esta mensagem? Ela sumirá da caixa de entrada de todos os usuários.")) return;
    
    const token = sessionStorage.getItem('authToken');
    try {
        const res = await fetch(`${API_URL}/admin/notification/${id}`, {
            method: 'DELETE',
            headers: { 'x-auth-token': token }
        });
        const data = await res.json();
        
        if (data.success) {
            alert(`Mensagem apagada! Removida de ${data.deletedCount} usuários.`);
            loadNotificationHistory();
        } else {
            alert("Erro ao apagar.");
        }
    } catch (e) {
        alert("Erro de conexão.");
    }
}

async function runDebug(command) {
    const token = sessionStorage.getItem('authToken');
    try {
        const res = await fetch(`${API_URL}/admin/debug`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'x-auth-token': token 
            },
            body: JSON.stringify({ command })
        });
        const data = await res.json();
        if (data.success) {
            alert(data.message);
            if (command.includes('node')) {
                // Se for comando de reinício, recarrega a página após alguns segundos
                setTimeout(() => window.location.reload(), 3000);
            }
        } else {
            alert("Erro ao executar comando.");
        }
    } catch (e) {
        alert("Erro de conexão.");
    }
}

async function fixSystemErrors() {
    const btn = document.querySelector('button[onclick="fixSystemErrors()"]');
    const resultDiv = document.getElementById('fixReportResult');
    
    // Efeito visual de carregamento
    const originalText = btn.innerHTML;
    btn.innerHTML = '🔍 Verificando e Corrigindo...';
    btn.disabled = true;
    resultDiv.style.display = 'none';

    try {
        const token = sessionStorage.getItem('authToken');

        const response = await fetch(`${API_URL}/admin/fix-errors`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-auth-token': token
            }
        });

        const data = await response.json();
        resultDiv.style.display = 'block';

        if (data.success) {
            const status = data.fixed ? '<span style="color: #4CAF50; font-weight: bold;">Sim, corrigido!</span>' : '<span style="color: #2196F3; font-weight: bold;">Sistema Saudável (Nenhum erro encontrado)</span>';
            const details = data.report.length > 0 ? `<ul style="margin-top:5px; padding-left: 20px;">${data.report.map(r => `<li>${r}</li>`).join('')}</ul>` : '';
            resultDiv.innerHTML = `${status}<br>${details}`;
        } else {
            resultDiv.innerHTML = '<span style="color: #f44336;">Erro ao tentar corrigir. Verifique o console.</span>';
        }
    } catch (error) {
        console.error(error);
        resultDiv.style.display = 'block';
        resultDiv.innerHTML = '<span style="color: #f44336;">Falha na comunicação com o servidor.</span>';
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

async function loadLogs() {
    const token = sessionStorage.getItem('authToken');
    try {
        const res = await fetch(`${API_URL}/admin/logs`, { headers: { 'x-auth-token': token } });
        const data = await res.json();
        const tbody = document.getElementById('logsTableBody');
        if (tbody) {
            tbody.innerHTML = '';
            data.logs.forEach((log, index) => {
                const date = new Date(log.timestamp).toLocaleString('pt-BR');
                const row = document.createElement('tr');
                row.style.borderBottom = '1px solid #333';
                row.innerHTML = `
                    <td style="padding: 10px;">${date}</td>
                    <td style="padding: 10px;">${log.action}</td>
                    <td style="padding: 10px;">${log.ip}</td>
                    <td style="padding: 10px;">${log.details}</td>
                    <td style="padding: 10px; text-align: right;">
                        <button onclick="deleteLog(${index})" style="background: none; border: none; color: #e50914; cursor: pointer;"><i class="material-icons">delete</i></button>
                    </td>
                `;
                tbody.appendChild(row);
            });
        }
    } catch (e) { console.error(e); }
}

async function clearLogs() {
    if (!confirm("Tem certeza que deseja limpar todos os logs?")) return;
    const token = sessionStorage.getItem('authToken');
    await fetch(`${API_URL}/admin/logs`, { method: 'DELETE', headers: { 'x-auth-token': token } });
    loadLogs();
}

async function deleteLog(index) {
    const token = sessionStorage.getItem('authToken');
    await fetch(`${API_URL}/admin/logs/${index}`, { method: 'DELETE', headers: { 'x-auth-token': token } });
    loadLogs();
}

async function loadBackups() {
    const token = sessionStorage.getItem('authToken');
    try {
        const res = await fetch(`${API_URL}/admin/backups`, { headers: { 'x-auth-token': token } });
        const data = await res.json();
        const tbody = document.getElementById('backupsTableBody');
        if (tbody) {
            tbody.innerHTML = '';
            data.backups.forEach(backup => {
                const date = new Date(backup.date).toLocaleString('pt-BR');
                const size = (backup.size / 1024).toFixed(2) + ' KB';
                const row = document.createElement('tr');
                row.style.borderBottom = '1px solid #333';
                row.innerHTML = `
                    <td style="padding: 10px;">${backup.filename}</td>
                    <td style="padding: 10px;">${date}</td>
                    <td style="padding: 10px;">${size}</td>
                    <td style="padding: 10px; text-align: right;">
                        <button onclick="restoreBackup('${backup.filename}')" class="btn-info" style="padding: 5px 10px; font-size: 12px;">Restaurar</button>
                    </td>
                `;
                tbody.appendChild(row);
            });
        }
    } catch (e) { console.error(e); }
}

async function clearBackups() {
    if (!confirm("Tem certeza que deseja excluir todo o histórico de backups?")) return;
    const token = sessionStorage.getItem('authToken');
    await fetch(`${API_URL}/admin/backups`, { method: 'DELETE', headers: { 'x-auth-token': token } });
    loadBackups();
}

async function restoreBackup(filename) {
    if (!confirm(`Deseja restaurar o backup ${filename}? Isso substituirá os dados atuais.`)) return;
    const token = sessionStorage.getItem('authToken');
    try {
        const res = await fetch(`${API_URL}/admin/backups/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
            body: JSON.stringify({ filename })
        });
        if (res.ok) {
            alert("Backup restaurado com sucesso! A página será recarregada.");
            window.location.reload();
        } else {
            alert("Erro ao restaurar backup.");
        }
    } catch (e) { alert("Erro de conexão."); }
}