/**
 * 🎯 最终提示词截留透视器 (ST-Prompt-Interceptor)
 * 核心功能：
 * 1. 截留阻断：一旦开启，酒馆最终消息无法发给 AI，直接被插件掐断截留。
 * 2. 左右分栏：大号字体、独立平滑大滚动条，彻底消除拥挤感。
 * 3. 伪装注入：用户输入任意正文，伪装为当前角色的 AI 最新回复写入酒馆，并广播生命周期事件，激活所有后处理插件（编年史、雷达、TTS、表情等）。
 */

const MODULE_NAME = 'st-prompt-interceptor';

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    blockSend: true,           // 核心开关：一旦开启功能，酒馆最终消息无法发给 AI，直接被插件截住
    logToConsole: true,
    showQuickButton: true,
    historyLimit: 10,
    fontSize: 16,              // 默认大号字体 (16px)
});

let capturedHistory = [];
let currentSnapshot = null;
let currentSearchTerm = '';
let currentFontSize = 16;
let currentSelectedNav = 'all'; // 'all' | '0'..'N' | 'payload'
let bypassNextSend = false;

function getSettings() {
    const context = SillyTavern.getContext();
    if (!context.extensionSettings) {
        context.extensionSettings = {};
    }
    context.extensionSettings[MODULE_NAME] = Object.assign(
        {},
        DEFAULT_SETTINGS,
        context.extensionSettings[MODULE_NAME] || {}
    );
    return context.extensionSettings[MODULE_NAME];
}

function saveSettings() {
    const context = SillyTavern.getContext();
    if (typeof context.saveSettingsDebounced === 'function') {
        context.saveSettingsDebounced();
    }
}

/**
 * 核心功能：将用户输入的正文伪装为 AI 最新回复注入酒馆并广播事件
 */
export async function injectMockAiReply(replyText) {
    if (!replyText || !replyText.trim()) {
        if (typeof toastr !== 'undefined') {
            toastr.warning('请输入要伪装的 AI 回复正文！', '提示词截留器');
        } else {
            alert('请输入要伪装的 AI 回复正文！');
        }
        return false;
    }

    const context = SillyTavern.getContext();
    const cleanText = replyText.trim();

    try {
        let messageId = -1;

        // 优先使用酒馆原生 saveReply：自动负责装配当前角色名、头像、渲染与核心事件
        if (typeof context.saveReply === 'function') {
            await context.saveReply({
                type: 'normal',
                getMessage: cleanText,
                title: '',
                fromStreaming: false,
            });
            messageId = context.chat.length - 1;
        } else {
            // 兜底注入流程
            const character = context.characters?.[context.characterId];
            const charName = context.name2 || character?.name || 'AI';
            const avatar = character?.avatar && typeof context.getThumbnailUrl === 'function'
                ? context.getThumbnailUrl('avatar', character.avatar)
                : '';

            const newMessage = {
                name: charName,
                is_user: false,
                is_system: false,
                send_date: new Date().toLocaleTimeString(),
                mes: cleanText,
                force_avatar: avatar,
                original_avatar: character?.avatar || '',
                extra: {
                    api: 'manual_mock',
                    model: currentSnapshot?.model || 'manual',
                    gen_id: Date.now(),
                },
                swipe_id: 0,
                swipes: [cleanText],
                swipe_info: [{
                    send_date: new Date().toLocaleTimeString(),
                    extra: { api: 'manual_mock', model: currentSnapshot?.model || 'manual' },
                }]
            };

            context.chat.push(newMessage);
            messageId = context.chat.length - 1;

            if (context.eventTypes?.MESSAGE_RECEIVED) {
                await context.eventSource.emit(context.eventTypes.MESSAGE_RECEIVED, messageId, 'normal');
            }
            if (typeof context.addOneMessage === 'function') {
                context.addOneMessage(newMessage);
            }
        }

        // 广播生命周期事件：确保所有第三方插件（编年史、雷达、TTS、表情等）感知到 AI 回复并正常激活运行！
        if (context.eventTypes?.CHARACTER_MESSAGE_RENDERED && messageId >= 0) {
            await context.eventSource.emit(context.eventTypes.CHARACTER_MESSAGE_RENDERED, messageId, 'normal');
        }
        if (context.eventTypes?.GENERATION_ENDED) {
            await context.eventSource.emit(context.eventTypes.GENERATION_ENDED, context.chat.length);
        }
        if (typeof context.saveChat === 'function') {
            await context.saveChat();
        }

        console.log(`[${MODULE_NAME}] ✅ 伪装 AI 回复成功注入到楼层 #${messageId + 1}，已广播 CHARACTER_MESSAGE_RENDERED 与 GENERATION_ENDED`);

        if (typeof toastr !== 'undefined') {
            toastr.success('✅ 已成功伪装并注入 AI 回复！各插件已激活运行。', '提示词截留器', { timeOut: 4000 });
        }
        return true;
    } catch (err) {
        console.error(`[${MODULE_NAME}] 伪装注入 AI 回复失败:`, err);
        if (typeof toastr !== 'undefined') {
            toastr.error(`注入失败: ${err.message}`, '提示词截留器');
        }
        return false;
    }
}

/**
 * 网络层硬拦截守卫 (Fetch Proxy Guard)
 */
function installFetchGuard() {
    if (window.__st_prompt_interceptor_fetch_guarded) return;
    window.__st_prompt_interceptor_fetch_guarded = true;

    const originalFetch = window.fetch;
    window.fetch = async function (resource, config) {
        const url = typeof resource === 'string' ? resource : resource?.url || '';
        const settings = getSettings();

        const isGenerateUrl = typeof url === 'string' && (
            url.includes('/api/backends/chat-completions/generate') ||
            url.includes('/api/backends/text-completions/generate')
        );

        if (isGenerateUrl && settings.enabled && settings.blockSend) {
            if (bypassNextSend) {
                console.log(`[${MODULE_NAME}] 🚀 用户放行：本次发包已放行通过。`);
                bypassNextSend = false;
                return originalFetch.apply(this, arguments);
            }

            console.warn(`[${MODULE_NAME}] 🛑 网络层掐断发往 ${url} 的请求！AI 不会收到任何消息。`);
            throw new DOMException('Request blocked by Prompt Interceptor extension', 'AbortError');
        }

        return originalFetch.apply(this, arguments);
    };
}

/**
 * 核心事件拦截挂载 (兼容现代与传统 SillyTavern 事件总线)
 */
function registerPromptInterceptor() {
    const context = SillyTavern.getContext();
    const eventTypes = context.eventTypes || context.event_types;
    if (!context.eventSource || !eventTypes) {
        console.warn(`[${MODULE_NAME}] 未检测到 eventSource 或 eventTypes，拦截器挂载延后 1 秒重试...`);
        setTimeout(registerPromptInterceptor, 1000);
        return;
    }

    // 1. Chat Completion 提示词装配完成
    const promptReadyType = eventTypes.CHAT_COMPLETION_PROMPT_READY || 'CHAT_COMPLETION_PROMPT_READY';
    context.eventSource.on(promptReadyType, (eventData) => {
        const settings = getSettings();
        if (!settings.enabled) return;

        if (eventData && eventData.dryRun) return;

        if (eventData && Array.isArray(eventData.chat)) {
            const snapshot = {
                id: 'snap_' + Date.now(),
                type: 'Chat Completion',
                timestamp: new Date().toLocaleTimeString(),
                fullTime: new Date().toLocaleString(),
                messages: JSON.parse(JSON.stringify(eventData.chat)),
                model: '待确定',
                fullPayload: null,
                isBlocked: false,
            };
            recordSnapshot(snapshot);
        }
    });

    // 2. Chat Completion 即将发包网络层
    const settingsReadyType = eventTypes.CHAT_COMPLETION_SETTINGS_READY || 'CHAT_COMPLETION_SETTINGS_READY';
    context.eventSource.on(settingsReadyType, async (generateData) => {
        const settings = getSettings();
        if (!settings.enabled || !currentSnapshot) return;

        currentSnapshot.model = generateData?.model || '未知模型';
        currentSnapshot.temperature = generateData?.temperature;
        currentSnapshot.max_tokens = generateData?.max_tokens;
        currentSnapshot.stream = generateData?.stream;
        currentSnapshot.fullPayload = JSON.parse(JSON.stringify(generateData || {}));

        const willBlock = settings.blockSend && !bypassNextSend;
        currentSnapshot.isBlocked = willBlock;

        if (settings.logToConsole) {
            console.groupCollapsed(`[${MODULE_NAME}] 🎯 【${willBlock ? '🛑 已截留阻断' : '发包透视'}】[${currentSnapshot.model}] (${currentSnapshot.messages?.length || 0} 条消息)`);
            console.log('发包时间:', currentSnapshot.fullTime);
            console.log('截留阻断状态:', willBlock ? '已拦截 (未发给 AI)' : '已放行');
            console.log('完整请求 Payload:', currentSnapshot.fullPayload);
            console.groupEnd();
        }

        updateStatusDisplay();

        if (willBlock) {
            if (typeof context.stopGeneration === 'function') {
                context.stopGeneration();
            }

            if (typeof toastr !== 'undefined') {
                toastr.warning('🛑【最终消息已被截留】已掐断发包，AI 无法收到此消息！', '提示词截留器', { timeOut: 5000 });
            }

            openPromptViewerModal();
        }
    });

    // 3. Text Completion 兼容
    const textSettingsType = eventTypes.TEXT_COMPLETION_SETTINGS_READY || 'TEXT_COMPLETION_SETTINGS_READY';
    context.eventSource.on(textSettingsType, async (params) => {
        const settings = getSettings();
        if (!settings.enabled) return;

        const willBlock = settings.blockSend && !bypassNextSend;
        const snapshot = {
            id: 'snap_' + Date.now(),
            type: 'Text Completion',
            timestamp: new Date().toLocaleTimeString(),
            fullTime: new Date().toLocaleString(),
            model: params?.model || 'Text Model',
            rawString: params?.prompt || '',
            fullPayload: JSON.parse(JSON.stringify(params || {})),
            isBlocked: willBlock,
        };

        recordSnapshot(snapshot);
        updateStatusDisplay();

        if (willBlock) {
            if (typeof context.stopGeneration === 'function') {
                context.stopGeneration();
            }

            if (typeof toastr !== 'undefined') {
                toastr.warning('🛑【最终消息已被截留】已掐断发包，AI 无法收到！', '提示词截留器', { timeOut: 5000 });
            }

            openPromptViewerModal();
        }
    });
}

function recordSnapshot(snap) {
    const settings = getSettings();
    currentSnapshot = snap;
    capturedHistory.unshift(snap);
    if (capturedHistory.length > settings.historyLimit) {
        capturedHistory.pop();
    }
}

/**
 * 全平台高兼容剪贴板写入工具 (强力支持移动端 HTTP 局域网访问、非安全上下文、iOS Safari)
 */
export async function copyToClipboard(text) {
    if (typeof text !== 'string') {
        text = String(text || '');
    }

    if (!text) {
        throw new Error('复制内容为空');
    }

    // 1. 优先尝试现代 W3C Clipboard API (仅在 Secure Context 如 HTTPS 或 localhost 下可用)
    if (window.isSecureContext && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (err) {
            console.warn(`[${MODULE_NAME}] navigator.clipboard 写入被拦截，降级到 textarea 选区复制:`, err);
        }
    }

    // 2. 降级方案：创建不可见 textarea + document.execCommand('copy')
    // 兼容所有非 HTTPS 移动端 (如 http://192.168.x.x:8000)、内嵌 Webview 及传统浏览器
    let textarea = null;
    try {
        textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.top = '0';
        textarea.style.left = '-9999px';
        textarea.style.width = '2em';
        textarea.style.height = '2em';
        textarea.style.padding = '0';
        textarea.style.border = 'none';
        textarea.style.outline = 'none';
        textarea.style.boxShadow = 'none';
        textarea.style.background = 'transparent';
        textarea.setAttribute('readonly', '');

        document.body.appendChild(textarea);

        // iOS Safari 选区特殊兼容
        if (/ipad|iphone|ipod/i.test(navigator.userAgent)) {
            const range = document.createRange();
            range.selectNodeContents(textarea);
            const selection = window.getSelection();
            if (selection) {
                selection.removeAllRanges();
                selection.addRange(range);
            }
            textarea.setSelectionRange(0, 999999);
        } else {
            textarea.focus();
            textarea.select();
        }

        const successful = document.execCommand('copy');
        if (!successful) {
            throw new Error('execCommand copy returned false');
        }
        return true;
    } catch (fallbackErr) {
        console.error(`[${MODULE_NAME}] 所有剪贴板复制方案均失败:`, fallbackErr);
        throw fallbackErr;
    } finally {
        if (textarea && textarea.parentNode) {
            document.body.removeChild(textarea);
        }
    }
}

/**
 * 按钮即时高亮成功反馈（在移动端直接反馈，防止提示条被遮挡）
 */
function showButtonSuccess(btn, successText = '已复制!') {
    if (!btn) return;
    const origHtml = btn.innerHTML;
    btn.innerHTML = `<i class="fa-solid fa-check" style="color:#4ade80;"></i> ${successText}`;
    btn.style.filter = 'brightness(1.2)';
    btn.style.borderColor = '#4ade80';
    setTimeout(() => {
        btn.innerHTML = origHtml;
        btn.style.filter = '';
        btn.style.borderColor = '';
    }, 1600);
}

/**
 * 弹出全量透视模态面板
 */
export function openPromptViewerModal(selectedSnapId = null, openWithMockDrawer = false) {
    const settings = getSettings();
    let snap = currentSnapshot;
    if (selectedSnapId) {
        const found = capturedHistory.find(item => item.id === selectedSnapId);
        if (found) snap = found;
    }

    if (!snap) {
        // 如果尚无发包快照，构造友好占位快照，确保在移动端点击悬浮球随时能打开面板
        snap = {
            id: 'snap_empty',
            type: '等待发包',
            timestamp: new Date().toLocaleTimeString(),
            fullTime: new Date().toLocaleString(),
            messages: [],
            model: '尚未发包',
            fullPayload: null,
            isBlocked: settings.blockSend,
            isEmptyPlaceholder: true,
        };
    }

    currentFontSize = settings.fontSize || 16;
    currentSelectedNav = 'all';

    let modal = document.getElementById('st-prompt-interceptor-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'st-prompt-interceptor-modal';
        modal.className = 'pi-modal-overlay';
        document.body.appendChild(modal);
    }

    const isChat = Array.isArray(snap.messages);
    const totalChars = isChat
        ? snap.messages.reduce((sum, cur) => sum + (typeof cur.content === 'string' ? cur.content.length : 0), 0)
        : (snap.rawString?.length || 0);

    const historyOptionsHtml = capturedHistory.length ? capturedHistory.map(item => `
        <option value="${item.id}" ${item.id === snap.id ? 'selected' : ''}>
            ${item.timestamp} - [${item.model || item.type}] ${item.isBlocked ? '🛑' : ''} (${Array.isArray(item.messages) ? item.messages.length + '层' : '文本'})
        </option>
    `).join('') : '<option>暂无快照</option>';

    modal.innerHTML = `
        <div class="pi-modal-dialog">
            <!-- 顶部操作条 -->
            <div class="pi-modal-header">
                <div class="pi-modal-top-bar">
                    <div class="pi-modal-title">
                        <i class="fa-solid fa-satellite-dish"></i> <span>最终提示词截留透视</span>
                        ${snap.isBlocked ? '<span class="pi-badge-blocked">🛑 已截留阻断</span>' : '<span class="pi-badge-passed">已放行</span>'}
                    </div>
                    <button class="pi-close-icon-btn pi-close-btn" title="关闭"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="pi-modal-actions">
                    <div class="pi-history-wrap">
                        <span style="font-size:0.82rem; color:#94a3b8;">快照:</span>
                        <select id="pi-history-selector" class="pi-select">${historyOptionsHtml}</select>
                    </div>

                    <!-- 伪装注入 AI 回复按钮 -->
                    <button class="menu_button pi-btn-action pi-btn-mock" id="pi-toggle-mock-drawer-btn" title="输入外部获取的回复，伪装成 AI 原生回复写入酒馆并触发插件">
                        <i class="fa-solid fa-masks-theater"></i> 伪装注入 AI 回复
                    </button>

                    ${snap.isBlocked && !snap.isEmptyPlaceholder ? `
                        <button class="menu_button pi-btn-action pi-btn-release" id="pi-release-send-btn" title="放行本次截留的消息，让 AI 开始生成">
                            <i class="fa-solid fa-paper-plane"></i> 放行发送
                        </button>
                    ` : ''}
                    <button class="menu_button pi-btn-action" id="pi-copy-all-json" title="复制完整发包 Payload (JSON)"><i class="fa-solid fa-copy"></i> 复制 JSON</button>
                </div>
            </div>

            <!-- 伪装注入 AI 回复抽屉 (默认折叠，点击展开) -->
            <div class="pi-mock-drawer" id="pi-mock-drawer" style="display: ${openWithMockDrawer ? 'flex' : 'none'};">
                <div class="pi-mock-header">
                    <span><i class="fa-solid fa-masks-theater" style="margin-right:6px;"></i> 伪装注入 AI 最新回复 (Mock AI Reply)</span>
                    <button class="pi-icon-btn" id="pi-close-mock-drawer"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <p class="notes" style="font-size:0.83rem; color:#94a3b8; margin:0;">
                    在此粘贴外部模型（Claude、DeepSeek、ChatGPT 网页版或本地大模型）生成的回复文本。点击注入后，插件会将其伪装成当前角色的<strong>最新原生回复</strong>写入酒馆，并自动触发 <code>CHARACTER_MESSAGE_RENDERED</code> 与 <code>GENERATION_ENDED</code> 事件，<strong>所有后处理插件（编年史、世界书雷达、TTS、表情等）都将正常激活运行</strong>！
                </p>
                <textarea id="pi-mock-reply-input" class="pi-mock-textarea" placeholder="在此粘贴外部 AI 的回答文本 (支持包含思考过程或长文本)..."></textarea>
                <div class="pi-mock-footer">
                    <button class="menu_button pi-btn-action" id="pi-paste-clipboard-btn"><i class="fa-solid fa-paste"></i> 从剪贴板粘贴</button>
                    <button class="menu_button pi-btn-action pi-btn-confirm-inject" id="pi-confirm-inject-btn"><i class="fa-solid fa-circle-check"></i> 确认伪装为 AI 回复并注入酒馆</button>
                </div>
            </div>

            <!-- 移动端选项卡切换 (窄屏响应式) -->
            <div class="pi-mobile-tabs" id="pi-mobile-tabs">
                <button class="pi-mobile-tab active" data-tab="content"><i class="fa-solid fa-file-lines"></i> 提示词正文</button>
                <button class="pi-mobile-tab" data-tab="sidebar"><i class="fa-solid fa-list-ol"></i> 消息目录 (${isChat ? snap.messages.length : 1})</button>
            </div>
            
            <!-- 核心主区域：左侧导航 + 右侧大滚动区 -->
            <div class="pi-modal-main">
                <!-- 左侧导航 -->
                <div class="pi-sidebar" id="pi-sidebar">
                    <div class="pi-sidebar-header">
                        <span>消息层级列表 (${isChat ? snap.messages.length : 1})</span>
                        <span style="font-size:0.75rem; color:#64748b;">${totalChars.toLocaleString()} 字</span>
                    </div>
                    <div class="pi-nav-list" id="pi-sidebar-nav">
                        ${renderSidebarNav(snap, isChat)}
                    </div>
                </div>

                <!-- 右侧内容阅读展示区 -->
                <div class="pi-content-pane is-mobile-active" id="pi-content-pane">
                    <div class="pi-content-header">
                        <div class="pi-content-title-box" id="pi-current-title-box">
                            <!-- 动态标题与字数 -->
                        </div>
                        <div class="pi-content-tools">
                            <!-- 搜索框 -->
                            <div class="pi-search-box" style="width:220px;">
                                <i class="fa-solid fa-magnifying-glass"></i>
                                <input type="text" id="pi-search-input" placeholder="按关键字高亮..." value="${escapeHtml(currentSearchTerm)}">
                            </div>

                            <!-- 字号选择器 -->
                            <div class="pi-font-group" title="调整字号">
                                <button class="pi-font-btn ${currentFontSize === 14 ? 'active' : ''}" data-size="14">小</button>
                                <button class="pi-font-btn ${currentFontSize === 16 ? 'active' : ''}" data-size="16">标准 (16px)</button>
                                <button class="pi-font-btn ${currentFontSize === 19 ? 'active' : ''}" data-size="19">大</button>
                            </div>

                            <!-- 复制当前正在阅读的内容 -->
                            <button class="menu_button pi-btn-action" id="pi-copy-current-view-btn" style="background:#2563eb!important; color:#fff!important; border-color:#3b82f6!important;">
                                <i class="fa-solid fa-copy"></i> 复制本页文本
                            </button>
                        </div>
                    </div>

                    <!-- 专属顺畅大滚动阅读区 -->
                    <div class="pi-text-scroll-box" id="pi-main-scroll-box">
                        <div id="pi-reading-content">
                            <!-- 动态注入长文本内容 -->
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    // 绑定弹窗关闭
    modal.querySelector('.pi-close-btn').onclick = () => modal.classList.remove('pi-open');
    modal.onclick = (e) => { if (e.target === modal) modal.classList.remove('pi-open'); };

    // 移动端 Tab 选项卡切换
    modal.querySelectorAll('.pi-mobile-tab').forEach(tabBtn => {
        tabBtn.onclick = () => {
            const tab = tabBtn.getAttribute('data-tab');
            modal.querySelectorAll('.pi-mobile-tab').forEach(b => b.classList.remove('active'));
            tabBtn.classList.add('active');
            const sidebar = modal.querySelector('#pi-sidebar');
            const contentPane = modal.querySelector('#pi-content-pane');
            if (tab === 'sidebar') {
                sidebar?.classList.add('is-mobile-active');
                contentPane?.classList.remove('is-mobile-active');
            } else {
                contentPane?.classList.add('is-mobile-active');
                sidebar?.classList.remove('is-mobile-active');
            }
        };
    });

    // 伪装抽屉展开/折叠
    const mockDrawer = modal.querySelector('#pi-mock-drawer');
    const toggleMockBtn = modal.querySelector('#pi-toggle-mock-drawer-btn');
    const closeMockBtn = modal.querySelector('#pi-close-mock-drawer');
    if (toggleMockBtn && mockDrawer) {
        toggleMockBtn.onclick = () => {
            const isShown = mockDrawer.style.display !== 'none';
            mockDrawer.style.display = isShown ? 'none' : 'flex';
            if (!isShown) {
                modal.querySelector('#pi-mock-reply-input')?.focus();
            }
        };
    }
    if (closeMockBtn && mockDrawer) {
        closeMockBtn.onclick = () => {
            mockDrawer.style.display = 'none';
        };
    }

    // 粘贴剪贴板 (增加 HTTP / 移动端非安全上下文容错与指引)
    const pasteBtn = modal.querySelector('#pi-paste-clipboard-btn');
    const mockInput = modal.querySelector('#pi-mock-reply-input');
    if (pasteBtn && mockInput) {
        pasteBtn.onclick = async () => {
            if (window.isSecureContext && navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
                try {
                    const text = await navigator.clipboard.readText();
                    if (text) {
                        mockInput.value = text;
                        if (typeof toastr !== 'undefined') toastr.success('已从剪贴板粘贴文本！');
                        return;
                    }
                } catch (err) {
                    console.warn(`[${MODULE_NAME}] 读取剪贴板受限:`, err);
                }
            }
            mockInput.focus();
            if (typeof toastr !== 'undefined') {
                toastr.info('浏览器在非 HTTPS/局域网环境下限制自动读取剪贴板，请长按输入框直接选择“粘贴”。');
            }
        };
    }

    // 确认注入伪装 AI 回复
    const confirmInjectBtn = modal.querySelector('#pi-confirm-inject-btn');
    if (confirmInjectBtn && mockInput) {
        confirmInjectBtn.onclick = async () => {
            const textToInject = mockInput.value.trim();
            if (!textToInject) {
                if (typeof toastr !== 'undefined') toastr.warning('请先输入或粘贴 AI 回复正文！');
                return;
            }

            confirmInjectBtn.disabled = true;
            const ok = await injectMockAiReply(textToInject);
            confirmInjectBtn.disabled = false;

            if (ok) {
                modal.classList.remove('pi-open');
            }
        };
    }

    // 放行按钮
    const releaseBtn = modal.querySelector('#pi-release-send-btn');
    if (releaseBtn) {
        releaseBtn.onclick = () => {
            bypassNextSend = true;
            modal.classList.remove('pi-open');
            if (typeof toastr !== 'undefined') {
                toastr.success('🚀 已放行！正在向 AI 发送请求...', '提示词截留器');
            }
            $('#option_regenerate').trigger('click');
        };
    }

    // 快照切换
    const historySelector = modal.querySelector('#pi-history-selector');
    if (historySelector) {
        historySelector.onchange = (e) => {
            openPromptViewerModal(e.target.value);
        };
    }

    // 复制完整 JSON (支持移动端 HTTP / 局域网及按钮即时视觉反馈)
    const copyJsonBtn = modal.querySelector('#pi-copy-all-json');
    if (copyJsonBtn) {
        copyJsonBtn.onclick = async () => {
            if (snap.isEmptyPlaceholder) {
                if (typeof toastr !== 'undefined') {
                    toastr.info('当前尚未发送消息产生提示词，请在聊天输入框发送一条消息后再复制。', '提示词截留器');
                } else {
                    alert('当前尚未发送消息产生提示词，请在聊天输入框发送一条消息后再复制。');
                }
                return;
            }

            const payloadToCopy = snap.fullPayload || snap.messages;
            const jsonStr = JSON.stringify(payloadToCopy, null, 2);
            try {
                await copyToClipboard(jsonStr);
                showButtonSuccess(copyJsonBtn, '已复制 JSON!');
                if (typeof toastr !== 'undefined') {
                    toastr.success('✅ 已成功复制完整 Payload JSON 到剪贴板！', '提示词截留器');
                }
            } catch (err) {
                console.error(`[${MODULE_NAME}] 复制 JSON 失败:`, err);
                if (typeof toastr !== 'undefined') {
                    toastr.warning('复制失败，请尝试在正文区域长按选中文本复制。', '提示词截留器');
                }
            }
        };
    }

    // 搜索高亮
    const searchInput = modal.querySelector('#pi-search-input');
    if (searchInput) {
        searchInput.oninput = (e) => {
            currentSearchTerm = e.target.value.trim();
            updateReadingView(modal, snap, isChat);
        };
    }

    // 字号调节
    modal.querySelectorAll('.pi-font-btn').forEach(btn => {
        btn.onclick = () => {
            currentFontSize = parseInt(btn.getAttribute('data-size'), 10) || 16;
            settings.fontSize = currentFontSize;
            saveSettings();
            modal.querySelectorAll('.pi-font-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            updateReadingView(modal, snap, isChat);
        };
    });

    // 绑定左侧导航点击切换
    bindNavEvents(modal, snap, isChat);

    // 渲染右侧内容
    updateReadingView(modal, snap, isChat);

    modal.classList.add('pi-open');
}

/**
 * 渲染左侧楼层导航列表
 */
function renderSidebarNav(snap, isChat) {
    if (snap.isEmptyPlaceholder) {
        return `
            <div class="pi-nav-item active" data-nav="all">
                <div class="pi-nav-top">
                    <span class="pi-nav-title"><i class="fa-solid fa-clock"></i> 等待发包</span>
                    <span class="pi-nav-badge pi-badge-all">READY</span>
                </div>
                <div class="pi-nav-sub">尚未捕获提示词</div>
            </div>
        `;
    }

    if (!isChat) {
        return `
            <div class="pi-nav-item active" data-nav="all">
                <div class="pi-nav-top">
                    <span class="pi-nav-title"><i class="fa-solid fa-file-lines"></i> 文本补全内容</span>
                    <span class="pi-nav-badge pi-badge-all">RAW</span>
                </div>
                <div class="pi-nav-sub">${(snap.rawString?.length || 0).toLocaleString()} 字符</div>
            </div>
            <div class="pi-nav-item" data-nav="payload">
                <div class="pi-nav-top">
                    <span class="pi-nav-title"><i class="fa-solid fa-code"></i> 请求参数 Payload</span>
                    <span class="pi-nav-badge pi-badge-json">JSON</span>
                </div>
                <div class="pi-nav-sub">网络参数及模型</div>
            </div>
        `;
    }

    const totalChars = snap.messages.reduce((sum, cur) => sum + (typeof cur.content === 'string' ? cur.content.length : 0), 0);

    let html = `
        <div class="pi-nav-item ${currentSelectedNav === 'all' ? 'active' : ''}" data-nav="all">
            <div class="pi-nav-top">
                <span class="pi-nav-title"><i class="fa-solid fa-layer-group"></i> <strong>【完整最终提示词】</strong></span>
                <span class="pi-nav-badge pi-badge-all">合并</span>
            </div>
            <div class="pi-nav-sub">全部 ${snap.messages.length} 层依次呈现 (${totalChars.toLocaleString()} 字)</div>
        </div>
    `;

    snap.messages.forEach((msg, idx) => {
        const role = (msg.role || 'unknown').toLowerCase();
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        const chars = content.length;

        let roleLabel = role.toUpperCase();
        let badgeClass = 'pi-badge-user';
        let desc = '历史记录';

        if (role === 'system') {
            roleLabel = 'SYSTEM';
            badgeClass = 'pi-badge-system';
            desc = '预设 / 世界书 / 设定 / 记忆';
        } else if (role === 'user') {
            badgeClass = 'pi-badge-user';
            desc = idx === snap.messages.length - 1 ? '🔥 最新用户输入' : '历史对话';
        } else if (role === 'assistant') {
            badgeClass = 'pi-badge-assistant';
            desc = 'AI 历史回复';
        }

        const isAct = currentSelectedNav === String(idx) ? 'active' : '';
        html += `
            <div class="pi-nav-item ${isAct}" data-nav="${idx}">
                <div class="pi-nav-top">
                    <span class="pi-nav-title">#${idx + 1} ${roleLabel}</span>
                    <span class="pi-nav-badge ${badgeClass}">${roleLabel}</span>
                </div>
                <div class="pi-nav-sub">${desc} · ${chars.toLocaleString()} 字</div>
            </div>
        `;
    });

    html += `
        <div class="pi-nav-item ${currentSelectedNav === 'payload' ? 'active' : ''}" data-nav="payload">
            <div class="pi-nav-top">
                <span class="pi-nav-title"><i class="fa-solid fa-gear"></i> 网络请求 Payload</span>
                <span class="pi-nav-badge pi-badge-json">JSON</span>
            </div>
            <div class="pi-nav-sub">${snap.model || '未知模型'} 参数结构</div>
        </div>
    `;

    return html;
}

function bindNavEvents(modal, snap, isChat) {
    modal.querySelectorAll('.pi-nav-item').forEach(item => {
        item.onclick = () => {
            currentSelectedNav = item.getAttribute('data-nav');
            modal.querySelectorAll('.pi-nav-item').forEach(el => el.classList.remove('active'));
            item.classList.add('active');
            updateReadingView(modal, snap, isChat);

            const scrollBox = modal.querySelector('#pi-main-scroll-box');
            if (scrollBox) scrollBox.scrollTop = 0;

            // 移动端在目录选择楼层后，自动切换回正文 Tab 供用户直接阅读
            const contentTab = modal.querySelector('.pi-mobile-tab[data-tab="content"]');
            if (contentTab) {
                contentTab.click();
            }
        };
    });
}

/**
 * 刷新右侧大滚动阅读区
 */
function updateReadingView(modal, snap, isChat) {
    const titleBox = modal.querySelector('#pi-current-title-box');
    const contentBox = modal.querySelector('#pi-reading-content');
    const copyBtn = modal.querySelector('#pi-copy-current-view-btn');
    if (!titleBox || !contentBox) return;

    // 尚未发包时的空状态友好指引
    if (snap.isEmptyPlaceholder) {
        titleBox.innerHTML = `<span>⏳ 提示词截留透视器已就绪</span><span class="pi-content-stats">等待发包截留</span>`;
        contentBox.innerHTML = `
            <div style="text-align:center; padding: 42px 16px; color:#94a3b8;">
                <i class="fa-solid fa-satellite-dish" style="font-size:3.2rem; color:#38bdf8; margin-bottom:18px; display:inline-block;"></i>
                <h3 style="color:#f8fafc; font-size:1.15rem; margin-bottom:12px;">尚未捕获到发往 AI 的提示词报文</h3>
                <p style="font-size:0.92rem; line-height:1.75; max-width:540px; margin:0 auto 24px auto; color:#cbd5e1;">
                    截留透视功能工作正常！当前您尚未在酒馆输入框发送消息。<br>
                    当您在聊天输入框点击发送时，若已开启<strong>【发包截留阻断】</strong>，插件将在发包前一瞬间切断网络请求，AI 无法收到任何消息（真·零 Token 消耗），并自动将拼接完整的全量提示词在此呈现。
                </p>
                <div style="display:flex; justify-content:center; gap:12px; flex-wrap:wrap;">
                    <button class="menu_button pi-btn-action pi-btn-mock" id="pi-empty-open-mock-btn" style="padding:10px 18px; font-size:0.92rem;">
                        <i class="fa-solid fa-masks-theater"></i> 打开伪装注入 AI 最新回复
                    </button>
                    <button class="menu_button pi-btn-action" id="pi-empty-close-btn" style="padding:10px 18px; font-size:0.92rem;">
                        <i class="fa-solid fa-arrow-left"></i> 返回对话界面测试发包
                    </button>
                </div>
            </div>
        `;
        const openMockFromEmpty = contentBox.querySelector('#pi-empty-open-mock-btn');
        if (openMockFromEmpty) {
            openMockFromEmpty.onclick = () => {
                const mockDrawer = modal.querySelector('#pi-mock-drawer');
                if (mockDrawer) {
                    mockDrawer.style.display = 'flex';
                    modal.querySelector('#pi-mock-reply-input')?.focus();
                }
            };
        }
        const closeFromEmpty = contentBox.querySelector('#pi-empty-close-btn');
        if (closeFromEmpty) {
            closeFromEmpty.onclick = () => {
                modal.classList.remove('pi-open');
            };
        }

        // 即使未发包，点击复制也给予明确友好提示，绝不静默无反应
        if (copyBtn) {
            copyBtn.onclick = () => {
                if (typeof toastr !== 'undefined') {
                    toastr.info('当前尚未捕获到发往 AI 的提示词，请在聊天框发送一条消息后再复制。', '提示词截留器');
                } else {
                    alert('当前尚未捕获到发往 AI 的提示词，请在聊天框发送一条消息后再复制。');
                }
            };
        }
        return;
    }

    let textToCopy = '';

    if (!isChat) {
        if (currentSelectedNav === 'payload') {
            titleBox.innerHTML = `<span>⚙️ 原始请求 Payload (JSON)</span><span class="pi-content-stats">[${snap.model}]</span>`;
            const jsonText = JSON.stringify(snap.fullPayload || snap, null, 2);
            contentBox.innerHTML = `<pre class="pi-article-text" style="font-size:${currentFontSize}px;">${highlightSearchText(escapeHtml(jsonText), currentSearchTerm)}</pre>`;
            textToCopy = jsonText;
        } else {
            titleBox.innerHTML = `<span>📄 文本补全完整输入内容</span><span class="pi-content-stats">${(snap.rawString?.length || 0).toLocaleString()} 字符 (~${Math.round((snap.rawString?.length || 0) / 3.5)} tokens)</span>`;
            contentBox.innerHTML = `<pre class="pi-article-text" style="font-size:${currentFontSize}px;">${highlightSearchText(escapeHtml(snap.rawString || ''), currentSearchTerm)}</pre>`;
            textToCopy = snap.rawString || '';
        }
    } else {
        if (currentSelectedNav === 'all') {
            const totalChars = snap.messages.reduce((sum, cur) => sum + (typeof cur.content === 'string' ? cur.content.length : 0), 0);
            titleBox.innerHTML = `<span>📄 完整最终提示词 (全部 ${snap.messages.length} 层消息合并)</span><span class="pi-content-stats">共计 ${totalChars.toLocaleString()} 字符 (~${Math.round(totalChars / 3.5)} tokens)</span>`;

            let combinedHtml = '';
            let fullPlainText = '';

            snap.messages.forEach((msg, idx) => {
                const role = (msg.role || 'unknown').toLowerCase();
                const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);
                const roleUpper = role.toUpperCase();

                let roleBannerTitle = `【第 ${idx + 1} 层 · ${roleUpper}】`;
                if (role === 'system') roleBannerTitle += ' · 系统预设 / 世界书 / 设定 / 记忆召回';
                else if (role === 'user') roleBannerTitle += idx === snap.messages.length - 1 ? ' · 🔥 最新用户发送消息' : ' · 用户历史';
                else if (role === 'assistant') roleBannerTitle += ' · AI 历史回复';

                combinedHtml += `
                    <div class="pi-section-banner role-${role}">
                        <span>${roleBannerTitle}</span>
                        <span style="font-size:0.8rem; opacity:0.85;">${content.length.toLocaleString()} 字符</span>
                    </div>
                    <pre class="pi-article-text" style="font-size:${currentFontSize}px;">${highlightSearchText(escapeHtml(content), currentSearchTerm)}</pre>
                `;

                fullPlainText += `================================================================================\n${roleBannerTitle} (${content.length.toLocaleString()} 字符)\n================================================================================\n\n${content}\n\n`;
            });

            contentBox.innerHTML = combinedHtml || '<div class="pi-empty">暂无消息</div>';
            textToCopy = fullPlainText;

        } else if (currentSelectedNav === 'payload') {
            titleBox.innerHTML = `<span>⚙️ 原始请求 Payload (JSON)</span><span class="pi-content-stats">模型: ${snap.model}</span>`;
            const jsonText = JSON.stringify(snap.fullPayload || snap.messages, null, 2);
            contentBox.innerHTML = `<pre class="pi-article-text" style="font-size:${currentFontSize}px;">${highlightSearchText(escapeHtml(jsonText), currentSearchTerm)}</pre>`;
            textToCopy = jsonText;

        } else {
            const idx = parseInt(currentSelectedNav, 10);
            const msg = snap.messages[idx];
            if (!msg) {
                contentBox.innerHTML = '<div class="pi-empty">未找到该消息</div>';
                return;
            }

            const role = (msg.role || 'unknown').toLowerCase();
            const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);

            let roleDesc = role.toUpperCase();
            if (role === 'system') roleDesc += ' (系统预设/世界书/设定)';
            else if (role === 'user') roleDesc += idx === snap.messages.length - 1 ? ' (最新输入)' : ' (历史记录)';

            titleBox.innerHTML = `<span>#${idx + 1} [${roleDesc}]</span><span class="pi-content-stats">${content.length.toLocaleString()} 字符 (~${Math.round(content.length / 3.5)} tokens)</span>`;
            contentBox.innerHTML = `<pre class="pi-article-text" style="font-size:${currentFontSize}px;">${highlightSearchText(escapeHtml(content), currentSearchTerm)}</pre>`;
            textToCopy = content;
        }
    }

    if (copyBtn) {
        copyBtn.onclick = async () => {
            if (!textToCopy || !textToCopy.trim()) {
                if (typeof toastr !== 'undefined') {
                    toastr.warning('当前查看的页面没有可复制的文本内容。', '提示词截留器');
                }
                return;
            }

            try {
                await copyToClipboard(textToCopy);
                showButtonSuccess(copyBtn, '已复制正文!');
                if (typeof toastr !== 'undefined') {
                    toastr.success('✅ 已成功复制当前显示的提示词正文！', '提示词截留器');
                }
            } catch (err) {
                console.error(`[${MODULE_NAME}] 复制当前视图正文失败:`, err);
                if (typeof toastr !== 'undefined') {
                    toastr.warning('写入剪贴板受限，请在正文区域长按选中文本复制。', '提示词截留器');
                }
            }
        };
    }
}

function highlightSearchText(text, term) {
    if (!term || !text) return text;
    const regex = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return text.replace(regex, '<mark class="pi-highlight">$1</mark>');
}

function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function updateStatusDisplay() {
    const indicator = document.getElementById('pi-status-indicator');
    const settings = getSettings();
    const btn = document.getElementById('pi-chat-quick-btn');

    if (btn) {
        if (settings.blockSend) {
            btn.classList.add('is-blocking');
        } else {
            btn.classList.remove('is-blocking');
        }
    }

    if (indicator) {
        if (currentSnapshot) {
            const blockStatus = settings.blockSend 
                ? '<span style="color:#ef4444; font-weight:bold;">[🛑截留阻断生效中]</span>' 
                : '<span style="color:#40c057">[透视放行]</span>';
            indicator.innerHTML = `${blockStatus} 最新: <strong>${currentSnapshot.timestamp}</strong> [${currentSnapshot.model}] (${currentSnapshot.messages?.length || 1} 层)`;
        } else {
            indicator.innerHTML = settings.blockSend
                ? '<span style="color:#ef4444; font-weight:bold;">● 截留阻断已就绪</span> (发一条消息测试拦截)'
                : '<span style="color:#40c057">● 透视放行已就绪</span> (发一条消息测试透视)';
        }
    }
}

let justDragged = false;

/**
 * 悬浮球手势拖拽与位置持久化
 */
function initQuickButtonInteraction(btn) {
    if (!btn) return;

    // 读取并恢复历史保存的坐标
    try {
        const savedPosStr = localStorage.getItem('st_pi_floating_pos');
        if (savedPosStr) {
            const savedPos = JSON.parse(savedPosStr);
            if (typeof savedPos.x === 'number' && typeof savedPos.y === 'number') {
                const maxX = Math.max(10, window.innerWidth - 70);
                const maxY = Math.max(10, window.innerHeight - 70);
                const clampedX = Math.min(Math.max(10, savedPos.x), maxX);
                const clampedY = Math.min(Math.max(10, savedPos.y), maxY);
                btn.style.left = `${clampedX}px`;
                btn.style.top = `${clampedY}px`;
                btn.style.right = 'auto';
                btn.style.bottom = 'auto';
            }
        }
    } catch (e) {
        console.warn(`[${MODULE_NAME}] 读取悬浮球坐标失败:`, e);
    }

    let isPointerDown = false;
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;

    const onPointerDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        isPointerDown = true;
        isDragging = false;
        justDragged = false;
        startX = e.clientX || (e.touches && e.touches[0]?.clientX) || 0;
        startY = e.clientY || (e.touches && e.touches[0]?.clientY) || 0;

        const rect = btn.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;

        if (btn.setPointerCapture && e.pointerId) {
            try { btn.setPointerCapture(e.pointerId); } catch (_) {}
        }
    };

    const onPointerMove = (e) => {
        if (!isPointerDown) return;
        const curX = e.clientX || (e.touches && e.touches[0]?.clientX) || 0;
        const curY = e.clientY || (e.touches && e.touches[0]?.clientY) || 0;
        const dx = curX - startX;
        const dy = curY - startY;

        if (!isDragging && Math.hypot(dx, dy) > 6) {
            isDragging = true;
            justDragged = true;
        }

        if (isDragging) {
            if (e.cancelable) e.preventDefault();
            e.stopPropagation();

            const maxX = Math.max(10, window.innerWidth - btn.offsetWidth - 10);
            const maxY = Math.max(10, window.innerHeight - btn.offsetHeight - 10);
            const newX = Math.min(Math.max(10, initialLeft + dx), maxX);
            const newY = Math.min(Math.max(10, initialTop + dy), maxY);

            btn.style.left = `${newX}px`;
            btn.style.top = `${newY}px`;
            btn.style.right = 'auto';
            btn.style.bottom = 'auto';
        }
    };

    const onPointerUp = (e) => {
        if (!isPointerDown) return;
        isPointerDown = false;

        if (isDragging) {
            justDragged = true;
            setTimeout(() => { justDragged = false; }, 250);

            try {
                localStorage.setItem('st_pi_floating_pos', JSON.stringify({
                    x: btn.offsetLeft,
                    y: btn.offsetTop,
                }));
            } catch (_) {}
        }
    };

    btn.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp, { passive: true });
    window.addEventListener('pointercancel', onPointerUp, { passive: true });

    // 移动端 Touch 事件增强兼容
    btn.addEventListener('touchstart', onPointerDown, { passive: true });
    window.addEventListener('touchmove', onPointerMove, { passive: false });
    window.addEventListener('touchend', onPointerUp, { passive: true });
}

export function resetQuickButtonPosition() {
    try {
        localStorage.removeItem('st_pi_floating_pos');
    } catch (_) {}

    const btn = document.getElementById('pi-chat-quick-btn');
    if (btn) {
        btn.style.left = 'auto';
        btn.style.top = '240px';
        btn.style.right = '14px';
        btn.style.bottom = 'auto';
    }

    if (typeof toastr !== 'undefined') {
        toastr.success('🎯 悬浮球已重置到屏幕右上侧安全可视区域！', '提示词截留器');
    }
}

function toggleQuickButton(show) {
    let btn = document.getElementById('pi-chat-quick-btn');
    if (!show) {
        if (btn) btn.remove();
        return;
    }

    const settings = getSettings();

    if (!btn) {
        btn = document.createElement('div');
        btn.id = 'pi-chat-quick-btn';
        btn.className = 'pi-floating-badge' + (settings.blockSend ? ' is-blocking' : '');
        btn.title = '点击查看当前截获的发往 AI 的完整提示词 (支持手势拖拽)';
        btn.innerHTML = `<i class="fa-solid fa-satellite-dish"></i><span>提示词截留</span>`;
        btn.onclick = (e) => {
            if (justDragged) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            openPromptViewerModal();
        };
        initQuickButtonInteraction(btn);
        document.body.appendChild(btn);
    } else {
        if (settings.blockSend) {
            btn.classList.add('is-blocking');
        } else {
            btn.classList.remove('is-blocking');
        }
    }
}

/**
 * 嵌入酒馆顶部/魔棒扩展菜单，确保移动端随时有一键直达入口
 */
function injectExtensionMenuItem() {
    if (document.getElementById('pi-ext-menu-item')) return;
    const extensionsMenu = document.getElementById('extensionsMenu');
    if (!extensionsMenu) {
        setTimeout(injectExtensionMenuItem, 1500);
        return;
    }

    const menuItem = document.createElement('div');
    menuItem.id = 'pi-ext-menu-item';
    menuItem.className = 'list-group-item flex-container flexGap5 interactable';
    menuItem.title = '打开提示词截留透视器';
    menuItem.style.cursor = 'pointer';
    menuItem.innerHTML = `
        <i class="fa-solid fa-satellite-dish" style="color:#ef4444; width:18px; text-align:center;"></i>
        <span>提示词截留透视</span>
    `;
    menuItem.onclick = () => openPromptViewerModal();
    extensionsMenu.appendChild(menuItem);
}

function getFallbackSettingsHtml() {
    return `
    <div class="st-prompt-interceptor-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b><i class="fa-solid fa-satellite-dish" style="color: #ef4444; margin-right: 6px;"></i> 最终提示词截留透视器 (Prompt Interceptor)</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <p class="notes" style="margin-bottom: 12px; font-size: 0.85em; opacity: 0.85;">
                    在酒馆经历预设组装、世界书匹配激活、向量记忆召回及历史裁剪后，直接截留并阻止最终发往大模型（Claude、DeepSeek、GPT等）的网络请求。
                </p>
                <div class="pi-settings-actions" style="margin-bottom: 14px; display: flex; flex-direction: column; gap: 8px;">
                    <button id="pi_btn_open_viewer" class="menu_button" style="width: 100%; justify-content: center; font-weight: bold; background: linear-gradient(135deg, #991b1b, #dc2626); color: #fff; border: 1px solid #ef4444;">
                        <i class="fa-solid fa-satellite-dish" style="margin-right: 6px;"></i> 打开截留透视全功能面板
                    </button>
                    <button id="pi_btn_reset_position" class="menu_button" style="width: 100%; justify-content: center; font-weight: bold; background: #1e293b; color: #e2e8f0; border: 1px solid #475569;">
                        <i class="fa-solid fa-arrows-to-dot" style="margin-right: 6px;"></i> 🎯 悬浮球重置到屏幕安全位置
                    </button>
                    <button id="pi_btn_quick_mock" class="menu_button" style="width: 100%; justify-content: center; font-weight: bold; background: linear-gradient(135deg, #059669, #10b981); color: #fff; border: 1px solid #34d399;">
                        <i class="fa-solid fa-masks-theater" style="margin-right: 6px;"></i> 🎭 伪装注入 AI 最新回复 (触发各插件)
                    </button>
                    <div id="pi-status-indicator" class="notes" style="font-size: 0.82em; color: #94a3b8; padding-left: 2px;">
                        ● 尚未捕获发包（发送一条消息测试拦截）
                    </div>
                </div>
                <hr style="border: 0; border-top: 1px solid var(--SmartThemeBorderColor, #3a3a4c); margin: 12px 0;">
                <div class="pi-setting-item" style="margin-bottom: 12px; background: rgba(239, 68, 68, 0.12); padding: 8px 10px; border-radius: 6px; border: 1px solid rgba(239, 68, 68, 0.3);">
                    <label class="checkbox_label" style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                        <input type="checkbox" id="pi_setting_block_send">
                        <span style="color: #fca5a5; font-weight: bold;">🛑 开启发包截留阻断 (开启后消息无法发给 AI，直接被插件截住)</span>
                    </label>
                    <div class="notes" style="margin-top: 4px; font-size: 0.78em; color: #cbd5e1; padding-left: 24px;">
                        勾选后，点击发送消息将在发包前一瞬间被插件掐断，AI 收不到任何内容，零 Token 消耗，并自动弹窗展示截留报文。
                    </div>
                </div>
                <div class="pi-setting-item" style="margin-bottom: 10px;">
                    <label class="checkbox_label" style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                        <input type="checkbox" id="pi_setting_enabled">
                        <span>启用插件</span>
                    </label>
                </div>
                <div class="pi-setting-item" style="margin-bottom: 10px;">
                    <label class="checkbox_label" style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                        <input type="checkbox" id="pi_setting_console">
                        <span>在浏览器 F12 控制台展开打印完整 Payload 报文</span>
                    </label>
                </div>
                <div class="pi-setting-item" style="margin-bottom: 10px;">
                    <label class="checkbox_label" style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                        <input type="checkbox" id="pi_setting_quick_btn">
                        <span>在屏幕上显示常驻可拖拽悬浮球 (透视入口)</span>
                    </label>
                </div>
            </div>
        </div>
    </div>
    `;
}

/**
 * 侧边栏设置界面与交互
 */
async function initUI() {
    try {
        const settings = getSettings();
        let html = '';
        try {
            html = await $.get(`/scripts/extensions/third-party/${MODULE_NAME}/settings.html`);
        } catch (_) {
            try {
                html = await $.get(`scripts/extensions/third-party/${MODULE_NAME}/settings.html`);
            } catch (__) {
                html = getFallbackSettingsHtml();
            }
        }

        if (!document.querySelector('.st-prompt-interceptor-settings')) {
            $('#extensions_settings').append(html);
        }

        $('#pi_setting_enabled').prop('checked', settings.enabled).off('change').on('change', function () {
            settings.enabled = $(this).prop('checked');
            saveSettings();
            updateStatusDisplay();
        });

        $('#pi_setting_block_send').prop('checked', settings.blockSend).off('change').on('change', function () {
            settings.blockSend = $(this).prop('checked');
            saveSettings();
            updateStatusDisplay();
            if (typeof toastr !== 'undefined') {
                if (settings.blockSend) {
                    toastr.warning('🛑 已开启发包截留阻断：后续消息将无法发给 AI，直接被插件截留！', '提示词截留器');
                } else {
                    toastr.info('已切换为透视放行模式：消息将正常发给 AI。', '提示词截留器');
                }
            }
        });

        $('#pi_setting_console').prop('checked', settings.logToConsole).off('change').on('change', function () {
            settings.logToConsole = $(this).prop('checked');
            saveSettings();
        });

        $('#pi_setting_quick_btn').prop('checked', settings.showQuickButton).off('change').on('change', function () {
            settings.showQuickButton = $(this).prop('checked');
            saveSettings();
            toggleQuickButton(settings.showQuickButton);
        });

        $('#pi_btn_open_viewer').off('click').on('click', () => openPromptViewerModal());
        $('#pi_btn_reset_position').off('click').on('click', () => resetQuickButtonPosition());
        $('#pi_btn_quick_mock').off('click').on('click', () => openPromptViewerModal(null, true));

        toggleQuickButton(settings.showQuickButton);
        injectExtensionMenuItem();
        updateStatusDisplay();
    } catch (err) {
        console.error(`[${MODULE_NAME}] 加载设置界面失败:`, err);
    }
}

jQuery(async () => {
    installFetchGuard();
    registerPromptInterceptor();
    // 立即初始化悬浮球与扩展菜单，保障移动端即时可用
    const settings = getSettings();
    toggleQuickButton(settings.showQuickButton);
    injectExtensionMenuItem();
    await initUI();
    console.log(`[${MODULE_NAME}] 插件已成功初始化 (v1.1.0)，手势拖拽悬浮球与移动端透视就绪。`);
});
