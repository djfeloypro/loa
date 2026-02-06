
let weeklyProgramsData = {};
// Estado do Usuário
let userToken = localStorage.getItem('userToken');
let userPhone = localStorage.getItem('userPhone');
let userAvatar = localStorage.getItem('userAvatar');
// Identificador Único do Visitante (para contagem precisa de online)
let visitorId = localStorage.getItem('visitorId');
if (!visitorId) {
    visitorId = 'u-' + Date.now() + '-' + Math.floor(Math.random() * 1e9);
    localStorage.setItem('visitorId', visitorId);
}
let notificationSoundEnabled = localStorage.getItem('notificationSoundEnabled') !== 'false'; // Padrão: Ligado

let subscribedPrograms = [];
let fallbackImageUrl = null;
let isPlaying = false;
let streamUrl = '';
let userNotifications = [];
let isHD = true;
let cropper = null;
const FIXED_STREAM_URL = "https://vdo.ninja/?view=g5Se4bN";
let viewRegistered = false;
let lastNotificationId = Date.now(); // Ignora notificações antigas ao carregar
let iti = null; // Instância do validador de telefone

document.addEventListener('DOMContentLoaded', () => {
    initApp();
    if (userToken) {
        loadUserFavorites();
    }
    // updateViewCount(); // Removido: Agora só conta ao clicar no Play
    
    // Atualiza visualizações a cada 10 segundos
    setInterval(getViewCount, 10000);

    // Envia sinal de vida (Heartbeat) a cada 30 segundos
    setInterval(sendHeartbeat, 30000);
    sendHeartbeat(); // Envia o primeiro imediatamente
    
    // Verifica mensagens a cada 60 segundos
    setInterval(checkUserMessages, 60000);

    // Inicializa navegação por controle remoto (Smart TV)
    initSpatialNavigation();
    setupEPGSearch();
    addClickEffects();

    // Inicializa o Input de Telefone com Validação Internacional
    const phoneInput = document.querySelector("#userPhoneInput");
    if (phoneInput) {
        iti = window.intlTelInput(phoneInput, {
            utilsScript: "https://cdn.jsdelivr.net/npm/intl-tel-input@18.2.1/build/js/utils.js",
            initialCountry: "auto",
            geoIpLookup: callback => {
                fetch("https://ipapi.co/json")
                    .then(res => res.json())
                    .then(data => callback(data.country_code))
                    .catch(() => callback("br"));
            },
            preferredCountries: ['br', 'pt', 'ao', 'mz', 'cv', 'us'],
            separateDialCode: true
        });
    }
});

// --- Lógica do Backend (Visualizações) ---
const API_URL = '/api';

async function updateViewCount() {
    if (viewRegistered) return;
    try {
        viewRegistered = true;
        await fetch(`${API_URL}/view`, { method: 'POST' });
    } catch (error) {
        console.error("Erro ao conectar com backend:", error);
        viewRegistered = false;
    }
}

async function getViewCount() {
    try {
        // Apenas lê o valor atual
        const response = await fetch(`${API_URL}/views`);
        const data = await response.json();
        
        // Atualiza Ticker em tempo real
        const tickerWrap = document.getElementById('tickerWrap');
        const tickerContent = document.getElementById('tickerContent');
        if (data.ticker && data.ticker.trim() !== "") {
            tickerWrap.style.display = 'block';
            tickerContent.innerText = data.ticker;
        } else {
            tickerWrap.style.display = 'none';
        }

        // Atualiza Enquete em tempo real
        if (data.poll) {
            handlePoll(data.poll);
        }

        // Verifica Notificações Globais
        if (data.lastNotification && data.lastNotification.id > lastNotificationId) {
            lastNotificationId = data.lastNotification.id;
            showToast(data.lastNotification.message, data.lastNotification.type);
            playNotificationSound();
            checkUserMessages(); // Atualiza a caixa de entrada também
        }
    } catch (error) {
        console.log("Tentando reconectar...");
    }
}

async function sendHeartbeat() {
    try {
        const headers = {
            'x-visitor-id': visitorId // Envia o ID único para o servidor
        };
        if (userToken) headers['x-user-token'] = userToken;
        
        await fetch(`${API_URL}/heartbeat`, { 
            method: 'POST',
            headers: headers
        });
    } catch (e) {
        // Falha silenciosa
    } 
}

// --- Lógica de Usuário ---
function openUserLogin() {
    document.getElementById('userLoginModal').style.display = 'flex';
}

function closeUserLogin() {
    document.getElementById('userLoginModal').style.display = 'none';
}

async function submitUserLogin() {
    // Validação rigorosa do número
    if (!iti) return;
    
    if (!iti.isValidNumber()) {
        alert("Número inválido. Por favor, verifique o código do país e o número digitado.");
        return;
    }

    // Obtém o número completo formatado (ex: +5511999999999)
    const fullPhone = iti.getNumber();

    try {
        const res = await fetch(`${API_URL}/user/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: fullPhone })
        });
        const data = await res.json();
        
        if (data.success) {
            userToken = data.token;
            userPhone = fullPhone;
            subscribedPrograms = data.favorites;
            userAvatar = data.avatarUrl || '';
            
            localStorage.setItem('userToken', userToken);
            localStorage.setItem('userPhone', userPhone);
            localStorage.setItem('userAvatar', userAvatar);
            
            updateUserUI();
            closeUserLogin();
            initEPG(); // Atualiza ícones
        }
    } catch (e) {
        alert("Erro ao fazer login.");
    }
}

function updateUserUI() {
    if (userToken) {
        document.getElementById('userLoginBtn').style.display = 'none';
        document.getElementById('userProfileArea').style.display = 'flex';
        // Telefone oculto na navbar, visível apenas no modal
        
        const avatarUrl = userAvatar || 'https://via.placeholder.com/32?text=U';
        document.getElementById('navUserAvatar').src = avatarUrl;
        document.getElementById('profileAvatarLarge').src = avatarUrl;
        
        // Adiciona container para o badge se não existir
        const avatarImg = document.getElementById('navUserAvatar');
        if (avatarImg && !avatarImg.parentElement.classList.contains('avatar-wrapper')) {
            const wrapper = document.createElement('div');
            wrapper.className = 'avatar-wrapper';
            wrapper.style.position = 'relative';
            wrapper.style.display = 'inline-block';
            avatarImg.parentNode.insertBefore(wrapper, avatarImg);
            wrapper.appendChild(avatarImg);
            
            const badge = document.createElement('div');
            badge.className = 'notification-badge';
            badge.id = 'navNotificationBadge';
            wrapper.appendChild(badge);
        }
        
        checkUserMessages();
    } else {
        document.getElementById('userLoginBtn').style.display = 'block';
        document.getElementById('userProfileArea').style.display = 'none';
    }
}

async function checkUserMessages() {
    if (!userToken) return;
    try {
        const res = await fetch(`${API_URL}/user/notifications`, { headers: { 'x-user-token': userToken } });
        const data = await res.json();
        if (data.notifications) {
            userNotifications = data.notifications;
            const unreadCount = userNotifications.filter(n => !n.read).length;
            const badge = document.getElementById('navNotificationBadge');
            if (badge) {
                badge.style.display = unreadCount > 0 ? 'flex' : 'none';
                badge.innerText = unreadCount > 99 ? '99+' : unreadCount;
                if (unreadCount > 0) badge.classList.add('blink');
                else badge.classList.remove('blink');
            }
        }
    } catch (e) {}
}

async function openUserProfile() {
    document.getElementById('profilePhoneDisplay').innerText = userPhone;
    document.getElementById('userProfileModal').style.display = 'flex';

    // Atualiza mensagens ao abrir
    await checkUserMessages();
    
    // Injeta estrutura de abas se não existir
    const modalContent = document.querySelector('#userProfileModal > div'); // Pega o card interno
    if (modalContent && !document.getElementById('profileTabsNav')) {
        // Salva o conteúdo original (Perfil)
        const originalContent = Array.from(modalContent.children).filter(el => el.tagName !== 'H2' && !el.classList.contains('close-btn')); // Assume H2 como título se houver
        
        // Cria container de abas
        const tabsNav = document.createElement('div');
        tabsNav.id = 'profileTabsNav';
        tabsNav.className = 'profile-nav';
        tabsNav.innerHTML = `
            <button class="profile-tab-btn active" onclick="switchProfileTab('profile')">Meu Perfil</button>
            <button class="profile-tab-btn" onclick="switchProfileTab('messages')">Mensagens <span id="msgTabCount"></span></button>
        `;
        
        // Insere abas antes do conteúdo
        const firstContent = originalContent[0];
        if (firstContent) modalContent.insertBefore(tabsNav, firstContent);
        else modalContent.appendChild(tabsNav);

        // Envolve conteúdo original na aba Perfil
        const profileTab = document.createElement('div');
        profileTab.id = 'tab-profile';
        profileTab.className = 'profile-tab-content active';
        originalContent.forEach(el => profileTab.appendChild(el));
        modalContent.appendChild(profileTab);

        // Cria aba Mensagens
        const messagesTab = document.createElement('div');
        messagesTab.id = 'tab-messages';
        messagesTab.className = 'profile-tab-content';
        messagesTab.innerHTML = `
            <div style="text-align: right; margin-bottom: 5px;">
                <button onclick="clearAllUserMessages()" style="background: none; border: none; color: #aaa; cursor: pointer; font-size: 12px; text-decoration: underline; padding: 5px;">Limpar Tudo</button>
            </div>
            <div id="messagesList" class="message-list">
                <div id="adminTypingIndicator" class="typing-indicator">
                    <div style="font-size: 11px; color: #e50914; font-weight: bold; margin-bottom: 4px;">Admin digitando...</div>
                    <div class="typing-dots"><span></span><span></span><span></span></div>
                </div>
                <div id="messagesContent"><p style="color:#aaa; text-align:center;">Nenhuma mensagem.</p></div>
            </div>
        `;
        modalContent.appendChild(messagesTab);
        
        // Injeta a opção de som na aba de perfil (se ainda não estiver lá)
        injectSoundToggle(profileTab);
    } else {
        // Se já existe, apenas atualiza a lista
        renderMessagesList();
    }
}

function injectSoundToggle(container) {
    if (!document.getElementById('soundToggleContainer')) {
        const toggleDiv = document.createElement('div');
        toggleDiv.id = 'soundToggleContainer';
        toggleDiv.style.marginTop = '15px';
        toggleDiv.style.paddingTop = '15px';
        toggleDiv.style.borderTop = '1px solid #333';
        toggleDiv.innerHTML = `
            <label style="display: flex; align-items: center; gap: 10px; cursor: pointer; color: #ddd; font-size: 14px;">
                <input type="checkbox" id="userSoundToggle" ${notificationSoundEnabled ? 'checked' : ''}>
                Receber alerta sonoro de mensagens
            </label>
        `;
        
        // Insere antes do botão de sair (assumindo que é o último ou penúltimo)
        container.appendChild(toggleDiv);

        document.getElementById('userSoundToggle').addEventListener('change', (e) => {
            notificationSoundEnabled = e.target.checked;
            localStorage.setItem('notificationSoundEnabled', notificationSoundEnabled);
        });
    }
}

window.switchProfileTab = async function(tabName) {
    document.querySelectorAll('.profile-tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.profile-tab-btn').forEach(el => el.classList.remove('active'));
    
    document.getElementById(`tab-${tabName}`).classList.add('active');
    const btnIndex = tabName === 'profile' ? 0 : 1;
    document.querySelectorAll('.profile-tab-btn')[btnIndex].classList.add('active');

    if (tabName === 'messages') {
        renderMessagesList();
        // Marca como lidas no servidor
        const unread = userNotifications.some(n => !n.read);
        if (unread) {
            await fetch(`${API_URL}/user/notifications/read`, { method: 'POST', headers: { 'x-user-token': userToken } });
            // Atualiza localmente
            userNotifications.forEach(n => n.read = true);
            const badge = document.getElementById('navNotificationBadge');
            if (badge) {
                badge.style.display = 'none';
                badge.classList.remove('blink');
            }
        }
    }
};

function renderMessagesList() {
    const content = document.getElementById('messagesContent');
    if (!content) return;

    if (!userNotifications || userNotifications.length === 0) {
        content.innerHTML = '<p style="color:#aaa; text-align:center; padding: 20px;">Nenhuma mensagem recebida.</p>';
        return;
    }

    content.innerHTML = userNotifications.map(msg => {
        const date = new Date(msg.date).toLocaleString('pt-BR');
        const sender = msg.isDirect ? 'Admin (Privado)' : 'Admin (Global)';
        const senderColor = msg.isDirect ? '#ffce56' : '#e50914';
        return `
            <div class="message-item ${msg.read ? '' : 'unread'}">
                <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                    <div style="font-size: 11px; color: ${senderColor}; font-weight: bold; margin-bottom: 4px;">${sender}</div>
                    <div style="display: flex; gap: 10px;">
                        <button onclick="replyToMessage(${msg.id})" style="background: none; border: none; color: #00a8ff; cursor: pointer; padding: 0; font-size: 12px; text-decoration: underline;">Responder</button>
                        <button onclick="deleteUserMessage(${msg.id})" style="background: none; border: none; color: #aaa; cursor: pointer; padding: 0;" title="Excluir">
                            <i class="material-icons" style="font-size: 16px;">close</i>
                        </button>
                    </div>
                </div>
                <p style="font-size: 14px; color: #fff; margin-right: 15px;">${msg.message}</p>
                <span class="message-date">${date}</span>
            </div>
        `;
    }).join('');
    
    // Atualiza contador na aba
    const unreadCount = userNotifications.filter(n => !n.read).length;
    const countSpan = document.getElementById('msgTabCount');
    if (countSpan) countSpan.innerText = unreadCount > 0 ? `(${unreadCount})` : '';
}

window.deleteUserMessage = async function(id) {
    if (!confirm("Excluir esta mensagem?")) return;
    
    try {
        const res = await fetch(`${API_URL}/user/notifications/${id}`, {
            method: 'DELETE',
            headers: { 'x-user-token': userToken }
        });
        const data = await res.json();
        
        if (data.success) {
            // Remove localmente e atualiza UI
            userNotifications = userNotifications.filter(n => n.id !== id);
            renderMessagesList();
            
            // Atualiza badge se necessário
            const unreadCount = userNotifications.filter(n => !n.read).length;
            const badge = document.getElementById('navNotificationBadge');
            if (badge) {
                badge.style.display = unreadCount > 0 ? 'flex' : 'none';
                badge.innerText = unreadCount > 99 ? '99+' : unreadCount;
                if (unreadCount > 0) badge.classList.add('blink');
                else badge.classList.remove('blink');
            }
        } else {
            alert("Erro ao excluir mensagem.");
        }
    } catch (e) {
        alert("Erro de conexão.");
    }
};

window.clearAllUserMessages = async function() {
    if (!userNotifications || userNotifications.length === 0) {
        return alert("Sua caixa de entrada já está vazia.");
    }
    
    if (!confirm("Tem certeza que deseja apagar TODAS as mensagens?")) return;

    try {
        const res = await fetch(`${API_URL}/user/notifications`, {
            method: 'DELETE',
            headers: { 'x-user-token': userToken }
        });
        const data = await res.json();

        if (data.success) {
            userNotifications = [];
            renderMessagesList();
            
            const badge = document.getElementById('navNotificationBadge');
            if (badge) {
                badge.style.display = 'none';
                badge.classList.remove('blink');
            }
        } else {
            alert("Erro ao limpar mensagens.");
        }
    } catch (e) {
        alert("Erro de conexão.");
    }
};

function updateTypingStatus(isTyping) {
    const indicator = document.getElementById('adminTypingIndicator');
    if (indicator) {
        indicator.style.display = isTyping ? 'block' : 'none';
        // Se estiver digitando, rola para o topo da lista para garantir visibilidade
        if (isTyping) document.getElementById('messagesList').scrollTop = 0;
    }
}

function closeUserProfile() {
    document.getElementById('userProfileModal').style.display = 'none';
}

function logoutUser() {
    if (!confirm("Tem certeza que deseja sair da sua conta?")) return;

    userToken = null;
    userPhone = null;
    userAvatar = null;
    localStorage.removeItem('userToken');
    localStorage.removeItem('userPhone');
    localStorage.removeItem('userAvatar');
    
    updateUserUI();
    closeUserProfile();
    window.location.reload();
}

async function deleteUserAccount() {
    if (!confirm("Tem certeza que deseja excluir sua conta? Todos os favoritos serão perdidos.")) return;

    try {
        const res = await fetch(`${API_URL}/user/me`, {
            method: 'DELETE',
            headers: { 'x-user-token': userToken }
        });
        const data = await res.json();
        if (data.success) {
            alert("Conta excluída com sucesso.");
            logoutUser();
        } else {
            alert("Erro ao excluir conta.");
        }
    } catch (e) {
        alert("Erro de conexão.");
    }
}

function openImageCropper(event) {
    const fileInput = event.target;
    const file = fileInput.files[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
        alert("A imagem é muito grande. O tamanho máximo permitido é 5MB.");
        fileInput.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        const image = document.getElementById('imageToCrop');
        image.src = e.target.result;

        const modal = document.getElementById('imageCropModal');
        modal.style.display = 'flex';

        if (cropper) {
            cropper.destroy();
        }

        cropper = new Cropper(image, {
            aspectRatio: 1,
            viewMode: 1,
            background: false,
            autoCropArea: 0.8,
        });
    };
    reader.readAsDataURL(file);
}

function rotateImage(degree) {
    if (cropper) {
        cropper.rotate(degree);
    }
}

function zoomImage(ratio) {
    if (cropper) {
        cropper.zoom(ratio);
    }
}

function resetCrop() {
    if (cropper) {
        cropper.reset();
    }
}

function cancelCrop() {
    const modal = document.getElementById('imageCropModal');
    modal.style.display = 'none';
    if (cropper) {
        cropper.destroy();
        cropper = null;
    }
    document.getElementById('avatarInput').value = ''; // Reset file input
}

function confirmCropAndUpload() {
    if (!cropper) return;

    const canvas = cropper.getCroppedCanvas({
        width: 512,
        height: 512,
    });

    canvas.toBlob((blob) => {
        const formData = new FormData();
        formData.append('avatarFile', blob, 'avatar.png');

        const progressContainer = document.getElementById('uploadProgressContainer');
        const progressBar = document.getElementById('uploadProgressBar');
        
        cancelCrop();
        
        if (progressContainer) {
            progressContainer.style.display = 'block';
            progressBar.style.width = '0%';
        }

        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API_URL}/user/upload-avatar`, true);
        xhr.setRequestHeader('x-user-token', userToken);

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && progressBar) {
                const percent = (e.loaded / e.total) * 100;
                progressBar.style.width = `${percent}%`;
            }
        };

        xhr.onload = () => {
            if (progressContainer) progressContainer.style.display = 'none';

            if (xhr.status === 200) {
                try {
                    const data = JSON.parse(xhr.responseText);
                    if (data.success) {
                        userAvatar = data.avatarUrl;
                        localStorage.setItem('userAvatar', userAvatar);
                        updateUserUI();
                        alert("Foto de perfil atualizada com sucesso!");
                    } else {
                        alert("Erro: " + (data.message || "Não foi possível salvar a imagem."));
                    }
                } catch (e) {
                    console.error(e);
                    alert("Erro ao processar resposta.");
                }
            } else {
                alert("Falha no envio da imagem.");
            }
        };

        xhr.onerror = () => {
            if (progressContainer) progressContainer.style.display = 'none';
            alert("Erro de conexão.");
        };

        xhr.send(formData);

    }, 'image/png');
}

async function removeUserAvatar() {
    if (!userAvatar) return; // Já está sem foto
    if (!confirm("Deseja remover sua foto de perfil e voltar ao padrão?")) return;

    try {
        const res = await fetch(`${API_URL}/user/avatar`, {
            method: 'DELETE',
            headers: { 'x-user-token': userToken }
        });
        const data = await res.json();
        if (data.success) {
            userAvatar = null;
            localStorage.removeItem('userAvatar');
            updateUserUI();
            alert("Foto removida com sucesso.");
        } else {
            alert("Erro ao remover foto.");
        }
    } catch (e) {
        alert("Erro de conexão.");
    }
}

async function loadUserFavorites() {
    try {
        const res = await fetch(`${API_URL}/user/favorites`, {
            headers: { 'x-user-token': userToken }
        });
        const data = await res.json();
        if (data.favorites) {
            subscribedPrograms = data.favorites;
            // Se a API retornasse avatar aqui também seria bom, mas já pegamos no login
            updateUserUI();
            initEPG();
        }
    } catch (e) {
        console.error("Erro ao carregar favoritos");
    }
}

// --- Inicialização do App (Config + EPG) ---
async function initApp() {
    try {
        // Carrega a preferência de qualidade do usuário
        const savedQualityIsHD = localStorage.getItem('playerQualityIsHD');
        if (savedQualityIsHD === 'false') {
            isHD = false;
        }
        updateQualityIcon(); // Atualiza o ícone com a preferência carregada

        const response = await fetch(`${API_URL}/config`);
        const data = await response.json();
        
        fallbackImageUrl = data.fallbackImageUrl;
        
        // Configuração do Player
        const config = data.streamConfig || { type: 'embed', url: '', defaultQuality: 'auto' };
        
        // Define o link solicitado e garante tipo embed
        config.url = isHD ? FIXED_STREAM_URL : FIXED_STREAM_URL + '&quality=3';
        config.type = "embed";
        streamUrl = config.url;

        const iframe = document.getElementById('streamFrame');
        const video = document.getElementById('streamVideo');

        if (config.type === 'embed') {
            video.style.display = 'none';
            video.pause();
            iframe.style.display = 'block';
            
            // Garante que inicia vazio (sem autoplay)
            iframe.src = "";
            updatePlayState(false);
        } else if (config.type === 'hls') {
            iframe.style.display = 'none';
            iframe.src = '';
            video.style.display = 'block';
            
            if (Hls.isSupported()) {
                const hls = new Hls();
                hls.loadSource(config.url);
                hls.attachMedia(video);
                hls.on(Hls.Events.MANIFEST_PARSED, function(event, data) {
                    // Aplica qualidade padrão se configurada
                    const quality = config.defaultQuality || 'auto';
                    if (quality !== 'auto') {
                        const targetHeight = parseInt(quality);
                        // Encontra o nível que corresponde à altura desejada
                        const levelIndex = data.levels.findIndex(l => l.height === targetHeight);
                        if (levelIndex !== -1) {
                            hls.currentLevel = levelIndex;
                        }
                    }
                    // Tenta autoplay, mas atualiza UI se falhar
                    updatePlayState(false); // Garante que o estado inicial é 'pausado'
                });
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = config.url;
                video.addEventListener('loadedmetadata', function() {
                    updatePlayState(false); // Garante que o estado inicial é 'pausado'
                });
            }
        } else if (config.type === 'flv') {
            iframe.style.display = 'none';
            iframe.src = '';
            video.style.display = 'block';
            
            if (typeof flvjs !== 'undefined' && flvjs.isSupported()) {
                const flvPlayer = flvjs.createPlayer({ type: 'flv', url: config.url });
                flvPlayer.attachMediaElement(video);
                flvPlayer.load();
            }
            else {
                alert("Seu navegador não suporta reprodução FLV (ex: iOS).");
            }
            updatePlayState(false);
        }


        // Atualiza o Logo
        const logoEl = document.getElementById('channelLogo');
        if (data.logoUrl) {
            logoEl.src = data.logoUrl;
        } else {
            logoEl.style.display = 'none'; // Esconde se não houver logo
        }

        // Inicia o EPG com os dados recebidos
        weeklyProgramsData = data.programs;
        initEPG();
        
        // Inicia atualização da barra de progresso
        setInterval(updateProgressBar, 60000); // A cada minuto
        updateProgressBar(); // Chamada inicial
        checkNotifications(); // Verifica notificações imediatamente
    } catch (error) {
        console.error("Erro ao carregar configurações:", error);
    }
}

// --- Controle do Player (Play/Pause) ---
function togglePlay() {
    const iframe = document.getElementById('streamFrame');
    const video = document.getElementById('streamVideo');
    const isEmbed = iframe.style.display !== 'none';
    
    if (isEmbed) {
        // Controle via SRC para carregar/descarregar o vídeo
        if (isPlaying) {
            iframe.src = ""; // Remove o vídeo para parar
            updatePlayState(false);
        } else {
            iframe.src = streamUrl; // Carrega o link para tocar
            updatePlayState(true);
            updateViewCount();
        }
    } else {
        // Controle HTML5 Nativo (HLS)
        if (video.paused) {
            video.play();
            updatePlayState(true);
            updateViewCount();
        } else {
            video.pause();
            updatePlayState(false);
        }
    }
}

function updatePlayState(playing) {
    isPlaying = playing;
    const centerBtn = document.getElementById('centerPlayBtn');
    const controlIcon = document.getElementById('controlPlayIcon');
    const centerIcon = centerBtn.querySelector('i');

    if (playing) {
        centerBtn.classList.add('hidden');
        controlIcon.innerText = 'pause';
        centerIcon.innerText = 'pause'; // Prepara para pause
    } else {
        centerBtn.classList.remove('hidden');
        controlIcon.innerText = 'play_arrow';
        centerIcon.innerText = 'play_arrow';
    }
}

function reloadPlayer() {
    const iframe = document.getElementById('streamFrame');
    const video = document.getElementById('streamVideo');
    const isEmbed = iframe.style.display !== 'none';

    if (isEmbed) {
        iframe.src = "";
        setTimeout(() => {
            iframe.src = streamUrl;
            updatePlayState(true);
        }, 500);
    } else {
        video.load();
        video.play().then(() => updatePlayState(true)).catch(() => updatePlayState(false));
    }
}

function toggleQuality() {
    isHD = !isHD;
    const iframe = document.getElementById('streamFrame');
    const isEmbed = iframe.style.display !== 'none';

    // Salva a preferência no localStorage
    localStorage.setItem('playerQualityIsHD', isHD);

    if (isHD) {
        streamUrl = FIXED_STREAM_URL; // HD (Original)
    } else {
        streamUrl = FIXED_STREAM_URL + '&quality=3'; // SD (Baixa qualidade)
    }

    updateQualityIcon();

    if (isEmbed && isPlaying) {
        iframe.src = streamUrl;
    }
}

function updateQualityIcon() {
    const icon = document.getElementById('qualityIcon');
    if (!icon) return;

    if (isHD) {
        icon.style.color = '#fff';
        icon.parentElement.title = "Qualidade: HD";
    } else {
        icon.style.color = '#666'; // Indica modo econômico/SD
        icon.parentElement.title = "Qualidade: SD";
    }
}

function setupEPGSearch() {
    const searchInput = document.getElementById('epgSearch');
    searchInput.addEventListener('input', (e) => {
        const term = e.target.value.toLowerCase();
        const currentPrograms = getCurrentDayPrograms();
        const filtered = currentPrograms.filter(p => 
            p.title.toLowerCase().includes(term) || 
            p.category.toLowerCase().includes(term)
        );
        initEPG(filtered);
    });
}

function getCurrentDayPrograms() {
    const day = new Date().getDay(); // 0 (Dom) - 6 (Sab)
    if (Array.isArray(weeklyProgramsData)) return weeklyProgramsData;
    return weeklyProgramsData[day] || [];
}

// --- Lógica do EPG Automático ---
function initEPG(programsDB) {
    // Se não passar lista (chamada inicial ou atualização), pega do dia atual
    if (!programsDB) {
        programsDB = getCurrentDayPrograms();
    }

    const epgList = document.getElementById('epgList');
    const currentDateEl = document.getElementById('currentDate');
    const currentProgramTitle = document.getElementById('currentProgramTitle');
    
    // Limpa a lista atual
    epgList.innerHTML = '';

    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    
    // Formata data: "Segunda-feira, 03 de Fevereiro"
    const options = { weekday: 'long', day: 'numeric', month: 'long' };
    currentDateEl.innerText = now.toLocaleDateString('pt-BR', options);

    // Ordena a lista de exibição
    programsDB.sort((a, b) => {
        const t1 = a.time || "00:00";
        const t2 = b.time || "00:00";
        return t1.localeCompare(t2);
    });

    // Identifica o programa ativo REAL usando a lista completa (global)
    const activeProgram = getActiveProgram(getCurrentDayPrograms()); // Agora a função existe

    // Renderiza a lista
    programsDB.forEach((program, index) => {
        // Verifica se este programa é o ativo comparando título e horário
        const isCurrent = activeProgram && (program.title === activeProgram.title && program.time === activeProgram.time);
        
        // Verifica se o usuário ativou notificação para este programa
        const isSubscribed = subscribedPrograms.includes(program.title);

        if (isCurrent) {
            currentProgramTitle.innerText = `No Ar: ${program.title}`;
            document.title = `▶ ${program.title} - StreamHD`;
        }
        
        const item = document.createElement('div');
        item.className = `epg-item ${isCurrent ? 'active' : ''}`;
        item.setAttribute('data-title', program.title); // Identificador para updateProgressBar
        item.setAttribute('data-time', program.time);
        item.style.cursor = 'pointer'; // Indica que é clicável
        item.innerHTML = `
            <div class="epg-time">${program.time || '00:00'}</div>
            <div class="epg-details">
                <h3>${program.title}</h3>
                <p>${program.category} ${isCurrent ? '• <span style="color:#e50914">AO VIVO</span>' : ''}</p>
                <div class="epg-description">
                    ${program.description || 'Sem informações adicionais.'}
                </div>
            </div>
            ${!isCurrent ? `
            <button class="notify-btn ${isSubscribed ? 'active' : ''}" onclick="toggleNotification('${program.title}')" title="${isSubscribed ? 'Remover aviso' : 'Avise-me quando começar'}">
                <i class="material-icons">${isSubscribed ? 'notifications_active' : 'notifications_none'}</i>
            </button>
            ` : ''}
        `;
        
        // Evento de clique para expandir/recolher descrição
        item.addEventListener('click', (e) => {
            if (e.target.closest('.notify-btn')) return; // Ignora clique no sino
            const desc = item.querySelector('.epg-description');
            desc.classList.toggle('expanded');
        });

        epgList.appendChild(item);
    });
}

// Função auxiliar para encontrar o programa ativo na lista completa
function getActiveProgram(allPrograms) {
    if (!allPrograms || allPrograms.length === 0) return null;
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    
    let activeIndex = -1;
    for (let i = 0; i < allPrograms.length; i++) {
        const [h, m] = (allPrograms[i].time || "00:00").split(':').map(Number);
        const progMinutes = h * 60 + m;
        if (currentMinutes >= progMinutes) {
            activeIndex = i;
        }
    }
    if (activeIndex === -1 && allPrograms.length > 0) activeIndex = allPrograms.length - 1;
    return allPrograms[activeIndex];
}

async function toggleNotification(programTitle) {
    if (!userToken) {
        openUserLogin();
        return;
    }

    if (Notification.permission !== 'granted') {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;
    }

    try {
        const res = await fetch(`${API_URL}/user/toggle-favorite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-user-token': userToken },
            body: JSON.stringify({ programTitle })
        });
        const data = await res.json();
        if (data.success) {
            subscribedPrograms = data.favorites;
            initEPG();
        }
    } catch (e) {
        alert("Erro ao salvar favorito.");
    }
}

function checkNotifications() {
    const currentPrograms = getCurrentDayPrograms();
    if (!currentPrograms || Notification.permission !== 'granted') return;

    const now = new Date();
    // Formata hora atual para HH:MM
    const currentTimeString = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');

    currentPrograms.forEach(prog => {
        // Se o horário bater e o usuário estiver inscrito
        if (prog.time === currentTimeString && subscribedPrograms.includes(prog.title)) {
            // Dispara notificação do sistema
            new Notification(`Começou: ${prog.title}`, {
                body: `O programa ${prog.title} está começando agora no StreamHD!`,
                icon: '/uploads/logo.png' // Tenta usar o logo se existir
            });

            // Remove da lista de inscritos para não notificar novamente amanhã (opcional)
            // toggleNotification(prog.title); 
        }
    });
}

function updateProgressBar() {
    const currentPrograms = getCurrentDayPrograms();
    if (!currentPrograms || currentPrograms.length === 0) return;

    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    
    // Encontra o programa atual (mesma lógica do initEPG)
    let activeIndex = -1; 
    for (let i = 0; i < currentPrograms.length; i++) {
        const [h, m] = (currentPrograms[i].time || "00:00").split(':').map(Number);
        const progMinutes = h * 60 + m;
        if (currentMinutes >= progMinutes) {
            activeIndex = i;
        }
    }
    if (activeIndex === -1 && currentPrograms.length > 0) activeIndex = currentPrograms.length - 1;

    // Atualiza Título e Classe Active na lista (para manter sincronizado)
    const currentProg = currentPrograms[activeIndex];
    document.getElementById('currentProgramTitle').innerText = `No Ar: ${currentProg.title}`;
    document.title = `▶ ${currentProg.title} - StreamHD`;

    // Atualiza classes na lista DOM (busca por atributo data-title em vez de índice)
    const epgItems = document.querySelectorAll('.epg-item');
    epgItems.forEach((item) => {
        if (item.getAttribute('data-title') === currentProg.title && item.getAttribute('data-time') === currentProg.time) {
            item.classList.add('active');
        }
        else item.classList.remove('active');
    });

    // Cálculos da Barra de Progresso
    const nextIndex = (activeIndex + 1) % currentPrograms.length;
    const nextProg = currentPrograms[nextIndex];

    const [h1, m1] = (currentProg.time || "00:00").split(':').map(Number);
    const startMinutes = h1 * 60 + m1;
    
    const [h2, m2] = (nextProg.time || "00:00").split(':').map(Number);
    let endMinutes = h2 * 60 + m2;

    let nowMinutesAdjusted = currentMinutes;

    // Ajuste para virada do dia (meia-noite)
    if (endMinutes < startMinutes) endMinutes += 1440;
    if (activeIndex === currentPrograms.length - 1 && currentMinutes < startMinutes) nowMinutesAdjusted += 1440;

    const totalDuration = endMinutes - startMinutes;
    const elapsed = nowMinutesAdjusted - startMinutes;
    const remaining = totalDuration - elapsed;

    const percentage = Math.min(100, Math.max(0, (elapsed / totalDuration) * 100));
    
    document.getElementById('progressContainer').style.display = 'flex';
    document.getElementById('progressBar').style.width = `${percentage}%`;
    
    const remH = Math.floor(remaining / 60);
    const remM = remaining % 60;
    document.getElementById('timeRemaining').innerText = remH > 0 ? `Faltam ${remH}h ${remM}min` : `Faltam ${remM}min`;
    
    // Verifica notificações a cada minuto junto com a barra de progresso
    checkNotifications();
}

// --- Lógica da Enquete ---

function handlePoll(poll) {
    const overlay = document.getElementById('pollOverlay');
    const questionEl = document.getElementById('pollQuestion');
    const optionsEl = document.getElementById('pollOptions');

    if (!poll.visible || !poll.question) {
        overlay.style.display = 'none';
        return;
    }

    overlay.style.display = 'block';
    questionEl.innerText = poll.question;

    const hasVoted = localStorage.getItem('votedPoll') === poll.question;

    if (hasVoted) {
        renderPollResults(poll);
    } else {
        renderPollOptions(poll);
    }
}

function renderPollOptions(poll) {
    const optionsEl = document.getElementById('pollOptions');
    optionsEl.innerHTML = '';
    poll.options.forEach((option, index) => {
        const button = document.createElement('button');
        button.className = 'poll-option';
        button.innerText = option.text;
        button.onclick = () => vote(index, poll.question);
        optionsEl.appendChild(button);
    });
}

function renderPollResults(poll) {
    const optionsEl = document.getElementById('pollOptions');
    optionsEl.innerHTML = '';
    const totalVotes = poll.options.reduce((sum, opt) => sum + opt.votes, 0);

    poll.options.forEach(option => {
        const percentage = totalVotes > 0 ? ((option.votes / totalVotes) * 100).toFixed(1) : 0;
        const resultDiv = document.createElement('div');
        resultDiv.className = 'poll-result';
        resultDiv.innerHTML = `
            <div class="poll-result-bar" style="width: ${percentage}%;"></div>
            <span style="position: relative; z-index: 1;">${option.text} - ${percentage}% (${option.votes} votos)</span>
        `;
        optionsEl.appendChild(resultDiv);
    });
}

async function vote(optionIndex, question) {
    try {
        const res = await fetch(`${API_URL}/poll/vote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ optionIndex })
        });
        const data = await res.json();
        if (data.success) {
            localStorage.setItem('votedPoll', question); // Marca que votou nesta enquete
            renderPollResults(data.poll);
        } else {
            alert(data.message); // Ex: "Voto já registrado."
        }
    } catch (e) {
        alert("Erro ao registrar voto.");
    }
}

function toggleCinemaMode() {
    const wrapper = document.querySelector('.video-wrapper');
    wrapper.classList.toggle('cinema-mode');
    
    const btnIcon = document.querySelector('#controlCinemaIcon');
    if (wrapper.classList.contains('cinema-mode')) {
        btnIcon.innerText = 'close_fullscreen';
    } else {
        btnIcon.innerText = 'open_in_full';
    }
}

function shareOnWhatsApp() {
    const programTitleElement = document.getElementById('currentProgramTitle');
    let programTitle = "a programação ao vivo"; // Texto padrão

    if (programTitleElement && programTitleElement.innerText.includes('No Ar: ')) {
        programTitle = programTitleElement.innerText.replace('No Ar: ', '').trim();
    }

    const message = `Estou assistindo: *${programTitle}* no StreamHD! 📺\n\nAssista também: ${window.location.href}`;
    const whatsappUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(message)}`;

    window.open(whatsappUrl, '_blank');
}

function showToast(message, type = 'info') {
    const toast = document.getElementById('toastNotification');
    if (!toast) return;
    toast.innerText = message;
    
    // Reseta classes e adiciona a nova cor
    toast.className = 'toast-notification';
    toast.classList.add(type);
    
    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
    }, 5000);
}

function playNotificationSound() {
    if (notificationSoundEnabled) {
        // Som de notificação suave
        const audio = new Audio('https://actions.google.com/sounds/v1/alarms/beep_short.ogg');
        audio.volume = 0.5;
        audio.play().catch(() => {}); // Ignora erro se o navegador bloquear autoplay
    }
}

function addClickEffects() {
    const buttons = document.querySelectorAll('.interactive-btn');
    buttons.forEach(btn => {
        btn.addEventListener('click', function() {
            this.classList.remove('clicked');
            void this.offsetWidth; // Trigger reflow
            this.classList.add('clicked');
        });
    });
}

// --- Navegação Smart TV / Teclado ---
function initSpatialNavigation() {
    // Elementos que podem receber foco
    const focusableSelector = 'button, a, input, [tabindex]:not([tabindex="-1"])';
    
    document.addEventListener('keydown', (e) => {
        const focusable = Array.from(document.querySelectorAll(focusableSelector))
            .filter(el => el.offsetParent !== null); // Apenas visíveis
        
        const index = focusable.indexOf(document.activeElement);
        let nextIndex = 0;

        // Mapeamento de teclas
        switch(e.key) {
            case 'ArrowDown':
            case 'ArrowRight':
                e.preventDefault();
                nextIndex = index + 1;
                if (nextIndex >= focusable.length) nextIndex = 0;
                focusable[nextIndex].focus();
                break;
            case 'ArrowUp':
            case 'ArrowLeft':
                e.preventDefault();
                nextIndex = index - 1;
                if (nextIndex < 0) nextIndex = focusable.length - 1;
                focusable[nextIndex].focus();
                break;
            case 'Back':
            case 'Escape':
                // Fecha modais se abertos
                if (document.getElementById('userLoginModal').style.display === 'flex') {
                    closeUserLogin();
                }
                // Sai do Modo Cinema
                if (document.querySelector('.video-wrapper').classList.contains('cinema-mode')) {
                    toggleCinemaMode();
                }
                break;
            case 'Enter':
            case ' ': // Espaço
                if (document.activeElement === document.body) {
                    e.preventDefault();
                    togglePlay();
                }
                break;
            case 'q': // Alternar Qualidade
            case 'Q':
                if (document.activeElement === document.body) {
                    e.preventDefault();
                    toggleQuality();
                }
                break;

        }
    });
}