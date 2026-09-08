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
 * 核心事件拦截挂载
 */
function registerPromptInterceptor() {
    const context = SillyTavern.getContext();
    if (!context.eventSource || !context.event_types) {
        console.warn(`[${MODULE_NAME}] 未检测到 eventSource 或 event_types，拦截器挂载延后`);
        return;
    }

    // 1. Chat Completion 提示词装配完成
    if (context.event_types.CHAT_COMPLETION_PROMPT_READY) {
        context.eventSource.on(context.event_types.CHAT_COMPLETION_PROMPT_READY, (eventData) => {
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
    }

    // 2. Chat Completion 即将发包网络层
    if (context.event_types.CHAT_COMPLETION_SETTINGS_READY) {
        context.eventSource.on(context.event_types.CHAT_COMPLETION_SETTINGS_READY, async (generateData) => {
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
    }

    // 3. Text Completion 兼容
    if (context.event_types.TEXT_COMPLETION_SETTINGS_READY) {
        context.eventSource.on(context.event_types.TEXT_COMPLETION_SETTINGS_READY, async (params) => {
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
 * 弹出全量透视模态面板
 */
export function openPromptViewerModal(selectedSnapId = null, openWithMockDrawer = false) {
    let snap = currentSnapshot;
    if (selectedSnapId) {
        const found = capturedHistory.find(item => item.id === selectedSnapId);
        if (found) snap = found;
    }

    if (!snap) {
        // 如果没有快照但用户直接要求注入伪装回复，构造一个空快照
        if (openWithMockDrawer) {
            snap = {
                id: 'snap_empty',
                type: 'Manual',
                timestamp: new Date().toLocaleTimeString(),
                fullTime: new Date().toLocaleString(),
                messages: [],
                model: 'Manual',
                fullPayload: null,
                isBlocked: false,
            };
        } else {
            if (typeof toastr !== 'undefined') {
                toastr.info('尚未捕获到发给 AI 的提示词，请先在输入框发送一条消息测试。', '提示词截留器');
            } else {
                alert('尚未捕获到发给 AI 的提示词，请先在输入框发送一条消息测试。');
            }
            return;
        }
    }

    const settings = getSettings();
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
                <div class="pi-modal-title">
                    <i class="fa-solid fa-satellite-dish"></i> 最终发往 AI 的完整提示词截获报文
                    ${snap.isBlocked ? '<span class="pi-badge-blocked">🛑 已截留阻断 (AI 未收到)</span>' : '<span class="pi-badge-passed">已放行</span>'}
                </div>
                <div class="pi-modal-actions">
                    <div style="display:flex; align-items:center; gap:6px; margin-right:4px;">
                        <span style="font-size:0.82rem; color:#94a3b8;">快照:</span>
                        <select id="pi-history-selector" class="pi-select">${historyOptionsHtml}</select>
                    </div>

                    <!-- 伪装注入 AI 回复按钮 -->
                    <button class="menu_button pi-btn-action pi-btn-mock" id="pi-toggle-mock-drawer-btn" title="输入外部获取的回复，伪装成 AI 原生回复写入酒馆并触发插件">
                        <i class="fa-solid fa-masks-theater"></i> 伪装注入 AI 回复
                    </button>

                    ${snap.isBlocked ? `
                        <button class="menu_button pi-btn-action pi-btn-release" id="pi-release-send-btn" title="放行本次截留的消息，让 AI 开始生成">
                            <i class="fa-solid fa-paper-plane"></i> 放行发送给 AI
                        </button>
                    ` : ''}
                    <button class="menu_button pi-btn-action" id="pi-copy-all-json" title="复制完整发包 Payload (JSON)"><i class="fa-solid fa-copy"></i> 复制 JSON</button>
                    <button class="menu_button pi-btn-action pi-close-btn" title="关闭"><i class="fa-solid fa-xmark"></i></button>
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
            
            <!-- 核心主区域：左侧导航 + 右侧大滚动区 -->
            <div class="pi-modal-main">
                <!-- 左侧导航 -->
                <div class="pi-sidebar">
                    <div class="pi-sidebar-header">
                        <span>消息层级列表 (${isChat ? snap.messages.length : 1})</span>
                        <span style="font-size:0.75rem; color:#64748b;">${totalChars.toLocaleString()} 字</span>
                    </div>
                    <div class="pi-nav-list" id="pi-sidebar-nav">
                        ${renderSidebarNav(snap, isChat)}
                    </div>
                </div>

                <!-- 右侧内容阅读展示区 -->
                <div class="pi-content-pane">
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

    // 粘贴剪贴板
    const pasteBtn = modal.querySelector('#pi-paste-clipboard-btn');
    const mockInput = modal.querySelector('#pi-mock-reply-input');
    if (pasteBtn && mockInput) {
        pasteBtn.onclick = async () => {
            try {
                const text = await navigator.clipboard.readText();
                if (text) {
                    mockInput.value = text;
                    if (typeof toastr !== 'undefined') toastr.info('已从剪贴板粘贴文本！');
                }
            } catch (err) {
                if (typeof toastr !== 'undefined') toastr.warning('无法自动读取剪贴板，请手动 Ctrl+V 粘贴。');
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

    // 复制完整 JSON
    modal.querySelector('#pi-copy-all-json').onclick = () => {
        const payloadToCopy = snap.fullPayload || snap.messages;
        navigator.clipboard.writeText(JSON.stringify(payloadToCopy, null, 2)).then(() => {
            if (typeof toastr !== 'undefined') toastr.success('已复制完整 Payload JSON 到剪贴板！');
        });
    };

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
        copyBtn.onclick = () => {
            navigator.clipboard.writeText(textToCopy).then(() => {
                if (typeof toastr !== 'undefined') toastr.success('已复制当前显示的提示词内容到剪贴板！');
            });
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
    if (indicator && currentSnapshot) {
        const blockStatus = settings.blockSend 
            ? '<span style="color:#ef4444; font-weight:bold;">[🛑截留阻断生效中]</span>' 
            : '<span style="color:#40c057">[透视放行]</span>';
        indicator.innerHTML = `${blockStatus} 最新: <strong>${currentSnapshot.timestamp}</strong> [${currentSnapshot.model}] (${currentSnapshot.messages?.length || 1} 层)`;
    }
}

/**
 * 侧边栏设置界面与交互
 */
async function initUI() {
    try {
        const settings = getSettings();
        const html = await $.get(`/scripts/extensions/third-party/${MODULE_NAME}/settings.html`);
        $('#extensions_settings').append(html);

        $('#pi_setting_enabled').prop('checked', settings.enabled).on('change', function () {
            settings.enabled = $(this).prop('checked');
            saveSettings();
            updateStatusDisplay();
        });

        $('#pi_setting_block_send').prop('checked', settings.blockSend).on('change', function () {
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

        $('#pi_setting_console').prop('checked', settings.logToConsole).on('change', function () {
            settings.logToConsole = $(this).prop('checked');
            saveSettings();
        });

        $('#pi_setting_quick_btn').prop('checked', settings.showQuickButton).on('change', function () {
            settings.showQuickButton = $(this).prop('checked');
            saveSettings();
            toggleQuickButton(settings.showQuickButton);
        });

        $('#pi_btn_open_viewer').on('click', () => openPromptViewerModal());
        $('#pi_btn_quick_mock').on('click', () => openPromptViewerModal(null, true));

        toggleQuickButton(settings.showQuickButton);
        updateStatusDisplay();
    } catch (err) {
        console.error(`[${MODULE_NAME}] 加载设置界面失败:`, err);
    }
}

function toggleQuickButton(show) {
    let btn = document.getElementById('pi-chat-quick-btn');
    if (!show) {
        if (btn) btn.remove();
        return;
    }

    if (!btn) {
        btn = document.createElement('div');
        btn.id = 'pi-chat-quick-btn';
        btn.className = 'pi-floating-badge';
        btn.title = '点击查看当前截获的发往 AI 的完整提示词 (Prompt Interceptor)';
        btn.innerHTML = `<i class="fa-solid fa-satellite-dish"></i><span>提示词截留</span>`;
        btn.onclick = () => openPromptViewerModal();
        document.body.appendChild(btn);
    }
}

jQuery(async () => {
    installFetchGuard();
    registerPromptInterceptor();
    await initUI();
    console.log(`[${MODULE_NAME}] 插件已成功初始化，伪装注入 AI 回复功能已就绪。`);
});
