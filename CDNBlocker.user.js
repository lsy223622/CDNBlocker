// ==UserScript==
// @name         Bilibili CDN Blocker
// @namespace    https://github.com/lsy22/CDNBlocker
// @version      1.2.0
// @description  屏蔽指定的 Bilibili CDN 主机，并可一键禁用 mcdn PCDN 节点。
// @author       lsy223622
// @license      GPL-3.0-or-later
// @match        https://www.bilibili.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
    'use strict';

    const SCRIPT_NAME = 'Bilibili CDN Blocker';
    const STORAGE_KEY = 'cdnBlockerConfig';
    const RESUME_KEY = 'cdnBlockerResumeState';
    const RUNTIME_KEY = '__CDNBlockerRuntime__';
    const BLOCKED_SINK = 'https://cdnblocker.invalid/blocked';
    const MCDN_ROOT = 'mcdn.bilivideo.cn';
    const P2P_TYPE_KEY = '__DASH_P2P_TYPE__';
    const PLAYINFO_KEY = '__playinfo__';
    const BUTTON_CLASS = 'cdn-blocker-host-button';
    const STYLE_ID = 'cdn-blocker-style';
    const MODAL_ID = 'cdn-blocker-modal';
    const DEFAULT_CONFIG = Object.freeze({
        version: 1,
        blockMcdn: false,
        blockedHosts: [],
    });

    const pageWindow = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
    const previousRuntime = pageWindow[RUNTIME_KEY];
    if (previousRuntime && typeof previousRuntime.destroy === 'function') {
        previousRuntime.destroy();
    }

    function normalizeHost(value) {
        if (typeof value !== 'string') {
            return '';
        }

        const trimmed = value.trim();
        if (!trimmed || /\s/.test(trimmed)) {
            return '';
        }

        try {
            const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
                ? trimmed
                : `https://${trimmed}`;
            return new URL(candidate).hostname.toLowerCase().replace(/\.+$/, '');
        } catch (_error) {
            return '';
        }
    }

    function normalizeHostList(hosts) {
        const normalized = Array.isArray(hosts) ? hosts.map(normalizeHost).filter(Boolean) : [];
        return [...new Set(normalized)].sort();
    }

    function sanitizeConfig(value) {
        const source = value && typeof value === 'object' ? value : DEFAULT_CONFIG;
        return {
            version: 1,
            blockMcdn: source.blockMcdn === true,
            blockedHosts: normalizeHostList(source.blockedHosts),
        };
    }

    function isMcdnHost(host) {
        return host === MCDN_ROOT || host.endsWith(`.${MCDN_ROOT}`);
    }

    function getUrlString(input) {
        if (typeof input === 'string') {
            return input;
        }
        if (input && typeof input.url === 'string') {
            return input.url;
        }
        return String(input || '');
    }

    let config = sanitizeConfig(GM_getValue(STORAGE_KEY, DEFAULT_CONFIG));

    // Bilibili's PCDN SDK can load media in its own loader/Worker and bypass the
    // page's XMLHttpRequest and fetch functions. Keep the player on its native
    // HTTP candidate list whenever a blocking rule is active, so every media
    // request remains enforceable by the hooks below.
    const nativeP2pTypeDescriptor = Object.getOwnPropertyDescriptor(pageWindow, P2P_TYPE_KEY);
    let p2pTypeGuardInstalled = false;
    if (config.blockMcdn || config.blockedHosts.length > 0) {
        try {
            Object.defineProperty(pageWindow, P2P_TYPE_KEY, {
                configurable: true,
                get: () => undefined,
                set: () => {},
            });
            p2pTypeGuardInstalled = true;
        } catch (_error) {
            // The request hooks still cover the player's ordinary HTTP loader.
        }
    }

    function isBlockedHost(host) {
        return Boolean(host) && (
            config.blockedHosts.includes(host)
            || (config.blockMcdn && isMcdnHost(host))
        );
    }

    function shouldBlockUrl(input) {
        try {
            const url = new URL(getUrlString(input), location.href);
            return isBlockedHost(normalizeHost(url.hostname));
        } catch (_error) {
            return false;
        }
    }

    function hasBlockingRules() {
        return config.blockMcdn || config.blockedHosts.length > 0;
    }

    function sanitizeUrlFields(representation, baseKey, backupKey) {
        if (!Object.prototype.hasOwnProperty.call(representation, baseKey)) {
            return null;
        }

        const primary = representation[baseKey];
        const backups = Array.isArray(representation[backupKey])
            ? representation[backupKey]
            : [];
        const allowed = [];
        for (const candidate of [primary, ...backups]) {
            if (
                typeof candidate === 'string'
                && candidate
                && !shouldBlockUrl(candidate)
                && !allowed.includes(candidate)
            ) {
                allowed.push(candidate);
            }
        }

        if (allowed.length === 0) {
            return false;
        }

        representation[baseKey] = allowed[0];
        if (Object.prototype.hasOwnProperty.call(representation, backupKey)) {
            representation[backupKey] = allowed.slice(1);
        }
        return true;
    }

    function sanitizeRepresentationList(list) {
        if (!Array.isArray(list)) {
            return list;
        }

        return list.filter((representation) => {
            if (!representation || typeof representation !== 'object') {
                return true;
            }

            const results = [
                sanitizeUrlFields(representation, 'base_url', 'backup_url'),
                sanitizeUrlFields(representation, 'baseUrl', 'backupUrl'),
            ].filter((result) => result !== null);
            return results.length === 0 || results.every(Boolean);
        });
    }

    function isDashManifest(value) {
        if (!value || typeof value !== 'object') {
            return false;
        }
        const tracks = [value.video, value.audio].filter(Array.isArray);
        return tracks.some((track) => track.some((representation) => (
            representation
            && typeof representation === 'object'
            && (
                Object.prototype.hasOwnProperty.call(representation, 'base_url')
                || Object.prototype.hasOwnProperty.call(representation, 'baseUrl')
            )
        )));
    }

    function sanitizeDashManifest(dash) {
        if (Array.isArray(dash.video)) {
            dash.video = sanitizeRepresentationList(dash.video);
        }
        if (Array.isArray(dash.audio)) {
            dash.audio = sanitizeRepresentationList(dash.audio);
        }
    }

    function sanitizePlayurlPayload(payload) {
        if (!hasBlockingRules() || !payload || typeof payload !== 'object') {
            return payload;
        }

        const seen = new Set();
        const containerKeys = ['data', 'result', 'dash', 'playurl', 'video_info', 'videoInfo'];
        const visit = (value, depth) => {
            if (!value || typeof value !== 'object' || seen.has(value) || depth > 6) {
                return;
            }
            seen.add(value);
            if (isDashManifest(value)) {
                sanitizeDashManifest(value);
            }
            for (const key of containerKeys) {
                if (Object.prototype.hasOwnProperty.call(value, key)) {
                    visit(value[key], depth + 1);
                }
            }
        };
        visit(payload, 0);
        return payload;
    }

    function saveConfig(nextConfig) {
        config = sanitizeConfig(nextConfig);
        return Promise.resolve(GM_setValue(STORAGE_KEY, config));
    }

    const blockingRulesActive = hasBlockingRules();
    const nativeXhrOpen = pageWindow.XMLHttpRequest.prototype.open;
    const nativeXhrResponseDescriptor = Object.getOwnPropertyDescriptor(
        pageWindow.XMLHttpRequest.prototype,
        'response',
    );
    const nativeFetch = typeof pageWindow.fetch === 'function' ? pageWindow.fetch : null;
    const nativeJsonParse = pageWindow.JSON.parse;
    const nativePlayinfoDescriptor = Object.getOwnPropertyDescriptor(pageWindow, PLAYINFO_KEY);
    let playinfoGuardInstalled = false;
    let guardedPlayinfo;
    const guardedPlayinfoGetter = () => guardedPlayinfo;
    const guardedPlayinfoSetter = (value) => {
        guardedPlayinfo = sanitizePlayurlPayload(value);
    };

    function patchedXhrOpen(method, url) {
        if (!shouldBlockUrl(url)) {
            return Reflect.apply(nativeXhrOpen, this, arguments);
        }

        const args = Array.from(arguments);
        args[1] = BLOCKED_SINK;
        return Reflect.apply(nativeXhrOpen, this, args);
    }

    function isPlayurlRequest(input) {
        const url = getUrlString(input);
        return /(?:playurl|\/x\/player\/)/i.test(url);
    }

    function wrapPlayurlResponse(response) {
        if (!response || typeof response.json !== 'function') {
            return response;
        }
        try {
            const nativeJson = response.json.bind(response);
            Object.defineProperty(response, 'json', {
                configurable: true,
                value: () => nativeJson().then(sanitizePlayurlPayload),
            });
        } catch (_error) {
            // JSON.parse and XHR hooks still cover the other common paths.
        }
        return response;
    }

    function patchedFetch(input) {
        if (shouldBlockUrl(input)) {
            return Promise.reject(new TypeError(`${SCRIPT_NAME}: blocked CDN request`));
        }
        const result = Reflect.apply(nativeFetch, this, arguments);
        return blockingRulesActive && isPlayurlRequest(input)
            ? result.then(wrapPlayurlResponse)
            : result;
    }

    function patchedJsonParse(text, reviver) {
        return sanitizePlayurlPayload(Reflect.apply(nativeJsonParse, this, arguments));
    }

    function patchedXhrResponseGetter() {
        const response = Reflect.apply(nativeXhrResponseDescriptor.get, this, []);
        return this.responseType === 'json' ? sanitizePlayurlPayload(response) : response;
    }

    function installPlayinfoGuard() {
        if (!blockingRulesActive) {
            return;
        }

        if (nativePlayinfoDescriptor && !nativePlayinfoDescriptor.configurable) {
            sanitizePlayurlPayload(pageWindow[PLAYINFO_KEY]);
            return;
        }
        if (nativePlayinfoDescriptor?.get || nativePlayinfoDescriptor?.set) {
            sanitizePlayurlPayload(pageWindow[PLAYINFO_KEY]);
            return;
        }

        guardedPlayinfo = sanitizePlayurlPayload(nativePlayinfoDescriptor?.value);
        try {
            Object.defineProperty(pageWindow, PLAYINFO_KEY, {
                configurable: true,
                enumerable: nativePlayinfoDescriptor?.enumerable ?? true,
                get: guardedPlayinfoGetter,
                set: guardedPlayinfoSetter,
            });
            playinfoGuardInstalled = true;
        } catch (_error) {
            // Subsequent playurl responses are still sanitized by the hooks below.
        }
    }

    installPlayinfoGuard();
    pageWindow.XMLHttpRequest.prototype.open = patchedXhrOpen;
    if (
        blockingRulesActive
        && nativeXhrResponseDescriptor?.get
        && nativeXhrResponseDescriptor.configurable
    ) {
        Object.defineProperty(pageWindow.XMLHttpRequest.prototype, 'response', {
            ...nativeXhrResponseDescriptor,
            get: patchedXhrResponseGetter,
        });
    }
    if (blockingRulesActive) {
        pageWindow.JSON.parse = patchedJsonParse;
    }
    if (nativeFetch) {
        pageWindow.fetch = patchedFetch;
    }

    function saveResumeState() {
        const video = document.querySelector('#bilibili-player video, video');
        if (!video || !Number.isFinite(video.currentTime)) {
            sessionStorage.removeItem(RESUME_KEY);
            return;
        }

        sessionStorage.setItem(RESUME_KEY, JSON.stringify({
            path: location.pathname,
            time: video.currentTime,
            wasPlaying: !video.paused && !video.ended,
            savedAt: Date.now(),
        }));
    }

    function readResumeState() {
        const raw = sessionStorage.getItem(RESUME_KEY);
        sessionStorage.removeItem(RESUME_KEY);
        if (!raw) {
            return null;
        }

        try {
            const state = JSON.parse(raw);
            if (
                state.path !== location.pathname
                || !Number.isFinite(state.time)
                || Date.now() - state.savedAt > 60_000
            ) {
                return null;
            }
            return state;
        } catch (_error) {
            return null;
        }
    }

    let resumeObserver = null;

    function restorePlaybackState() {
        const state = readResumeState();
        if (!state) {
            return;
        }

        let restored = false;
        const tryRestore = () => {
            if (restored) {
                return true;
            }

            const video = document.querySelector('#bilibili-player video, video');
            if (!video) {
                return false;
            }

            const apply = () => {
                if (restored) {
                    return;
                }
                restored = true;
                const maxTime = Number.isFinite(video.duration) && video.duration > 0
                    ? Math.max(0, video.duration - 0.1)
                    : state.time;
                video.currentTime = Math.min(Math.max(0, state.time), maxTime);
                if (state.wasPlaying) {
                    const resume = () => video.play().catch(() => {});
                    if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
                        resume();
                    } else {
                        video.addEventListener('canplay', resume, { once: true });
                    }
                }
                resumeObserver?.disconnect();
                resumeObserver = null;
            };

            if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
                apply();
            } else {
                video.addEventListener('loadedmetadata', apply, { once: true });
            }
            return true;
        };

        if (!tryRestore()) {
            resumeObserver = new MutationObserver(tryRestore);
            resumeObserver.observe(document.documentElement, { childList: true, subtree: true });
            setTimeout(() => {
                resumeObserver?.disconnect();
                resumeObserver = null;
            }, 30_000);
        }
    }

    function applyConfigAndReload(nextConfig) {
        saveResumeState();
        saveConfig(nextConfig).then(() => location.reload());
    }

    function addStyle() {
        if (document.getElementById(STYLE_ID)) {
            return;
        }

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            .${BUTTON_CLASS} {
                margin-left: 7px;
                padding: 1px 7px;
                border: 1px solid rgba(255, 255, 255, .35);
                border-radius: 4px;
                color: #fff;
                background: rgba(255, 255, 255, .12);
                font: inherit;
                line-height: 18px;
                cursor: pointer;
                vertical-align: middle;
            }
            .${BUTTON_CLASS}:hover:not(:disabled) {
                border-color: #00aeec;
                background: #00aeec;
            }
            .${BUTTON_CLASS}:disabled {
                opacity: .55;
                cursor: default;
            }
            .${BUTTON_CLASS}.cdn-blocker-host-button--pending:disabled {
                border-color: #00a1d6;
                color: #7dd9f5;
                opacity: 1;
            }
            #${MODAL_ID} {
                position: fixed;
                inset: 0;
                z-index: 1000000;
                display: flex;
                align-items: center;
                justify-content: center;
                color: #18191c;
                background: rgba(0, 0, 0, .58);
                font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }
            #${MODAL_ID} .cdn-blocker-dialog {
                box-sizing: border-box;
                width: min(520px, calc(100vw - 32px));
                max-height: min(640px, calc(100vh - 32px));
                overflow: auto;
                padding: 22px;
                border-radius: 10px;
                background: #fff;
                box-shadow: 0 16px 60px rgba(0, 0, 0, .35);
            }
            #${MODAL_ID} h2 { margin: 0 0 18px; font-size: 20px; }
            #${MODAL_ID} .cdn-blocker-switch { display: flex; gap: 10px; align-items: center; }
            #${MODAL_ID} .cdn-blocker-hint { margin: 5px 0 16px 26px; color: #61666d; font-size: 12px; }
            #${MODAL_ID} .cdn-blocker-add { display: flex; gap: 8px; margin: 10px 0; }
            #${MODAL_ID} input[type="text"] {
                min-width: 0;
                flex: 1;
                padding: 8px 10px;
                border: 1px solid #c9ccd0;
                border-radius: 6px;
            }
            #${MODAL_ID} .cdn-blocker-error { min-height: 20px; color: #f03e3e; font-size: 12px; }
            #${MODAL_ID} .cdn-blocker-list {
                max-height: 260px;
                overflow: auto;
                margin: 8px 0 18px;
                padding: 0;
                border: 1px solid #e3e5e7;
                border-radius: 6px;
                list-style: none;
            }
            #${MODAL_ID} .cdn-blocker-row {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 8px 10px;
                border-bottom: 1px solid #e3e5e7;
            }
            #${MODAL_ID} .cdn-blocker-row:last-child { border-bottom: 0; }
            #${MODAL_ID} .cdn-blocker-row span { min-width: 0; flex: 1; overflow-wrap: anywhere; }
            #${MODAL_ID} .cdn-blocker-empty { padding: 18px; color: #9499a0; text-align: center; }
            #${MODAL_ID} .cdn-blocker-actions { display: flex; gap: 8px; justify-content: flex-end; }
            #${MODAL_ID} button {
                padding: 7px 14px;
                border: 1px solid #c9ccd0;
                border-radius: 6px;
                background: #fff;
                cursor: pointer;
            }
            #${MODAL_ID} button:hover { border-color: #00aeec; color: #00aeec; }
            #${MODAL_ID} .cdn-blocker-primary { border-color: #00aeec; color: #fff; background: #00aeec; }
            #${MODAL_ID} .cdn-blocker-primary:hover { color: #fff; background: #00a1d6; }
            #${MODAL_ID} .cdn-blocker-danger { margin-right: auto; color: #f03e3e; }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function getHostFromInfoLine(line) {
        const data = line.querySelector('.info-data');
        return normalizeHost(data?.textContent || '');
    }

    function syncStatsButtons(panel) {
        addStyle();
        for (const line of panel.querySelectorAll('.info-line')) {
            const title = line.querySelector('.info-title')?.textContent?.trim();
            if (title !== 'Video Host:' && title !== 'Audio Host:') {
                continue;
            }

            const host = getHostFromInfoLine(line);
            let button = line.querySelector(`.${BUTTON_CLASS}`);
            if (!button) {
                button = document.createElement('button');
                button.type = 'button';
                button.className = BUTTON_CLASS;
                button.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const currentHost = getHostFromInfoLine(line);
                    if (!currentHost) {
                        return;
                    }
                    if (isMcdnHost(currentHost) && !config.blockMcdn) {
                        applyConfigAndReload({ ...config, blockMcdn: true });
                        return;
                    }
                    if (isBlockedHost(currentHost)) {
                        return;
                    }
                    applyConfigAndReload({
                        ...config,
                        blockedHosts: [...config.blockedHosts, currentHost],
                    });
                });
                line.appendChild(button);
            }

            button.dataset.host = host;
            const isMcdn = isMcdnHost(host);
            const blocked = isBlockedHost(host);
            const waitingForSwitch = Boolean(host && blocked && (!isMcdn || config.blockMcdn));
            button.disabled = !host || waitingForSwitch;
            button.classList.toggle('cdn-blocker-host-button--pending', waitingForSwitch);
            const label = !host
                ? '屏蔽'
                : waitingForSwitch
                    ? '已屏蔽，等待切换'
                    : isMcdn
                        ? '屏蔽所有 MCDN'
                        : '屏蔽';
            if (button.textContent !== label) {
                button.textContent = label;
            }
            button.title = !host
                ? '未检测到 CDN Host'
                : waitingForSwitch
                    ? `${host} 已命中规则；统计面板可能保留上一分片的调度地址，等待下一分片后更新`
                    : isMcdn
                        ? '开启“禁用所有 mcdn 节点”并刷新播放器'
                        : `屏蔽 ${host}`;
        }
    }

    let rootObserver = null;
    let panelObserver = null;
    let currentPanel = null;
    let syncQueued = false;

    function queuePanelSync() {
        if (syncQueued || !currentPanel?.isConnected) {
            return;
        }
        syncQueued = true;
        queueMicrotask(() => {
            syncQueued = false;
            if (currentPanel?.isConnected) {
                syncStatsButtons(currentPanel);
            }
        });
    }

    function attachStatsPanel() {
        if (currentPanel?.isConnected) {
            return;
        }

        const panel = document.querySelector('#bilibili-player .bpx-player-info-panel');
        if (!panel) {
            return;
        }

        panelObserver?.disconnect();
        currentPanel = panel;
        syncStatsButtons(panel);
        panelObserver = new MutationObserver(queuePanelSync);
        panelObserver.observe(panel, { childList: true, subtree: true, characterData: true });
    }

    function startStatsObserver() {
        attachStatsPanel();
        rootObserver = new MutationObserver(attachStatsPanel);
        rootObserver.observe(document.documentElement, { childList: true, subtree: true });
    }

    function createElement(tag, properties = {}) {
        const element = document.createElement(tag);
        for (const [key, value] of Object.entries(properties)) {
            if (key === 'text') {
                element.textContent = value;
            } else if (key === 'className') {
                element.className = value;
            } else {
                element[key] = value;
            }
        }
        return element;
    }

    function openManager() {
        addStyle();
        document.getElementById(MODAL_ID)?.remove();

        const draft = sanitizeConfig(config);
        const overlay = createElement('div', { id: MODAL_ID });
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'cdn-blocker-title');
        const dialog = createElement('div', { className: 'cdn-blocker-dialog' });
        const title = createElement('h2', { id: 'cdn-blocker-title', text: 'CDN 屏蔽管理' });

        const switchRow = createElement('label', { className: 'cdn-blocker-switch' });
        const mcdnToggle = createElement('input', { type: 'checkbox', checked: draft.blockMcdn });
        switchRow.append(mcdnToggle, createElement('span', { text: '禁用所有 mcdn 节点' }));
        const hint = createElement('p', {
            className: 'cdn-blocker-hint',
            text: '匹配 mcdn.bilivideo.cn 及其全部子域。',
        });

        const addRow = createElement('div', { className: 'cdn-blocker-add' });
        const input = createElement('input', {
            type: 'text',
            placeholder: '输入 hostname 或 URL（端口会被忽略）',
        });
        input.setAttribute('aria-label', '要屏蔽的 CDN Host');
        const addButton = createElement('button', { type: 'button', text: '添加' });
        addRow.append(input, addButton);
        const error = createElement('div', { className: 'cdn-blocker-error' });
        error.setAttribute('role', 'status');
        const list = createElement('ul', { className: 'cdn-blocker-list' });

        const renderList = () => {
            list.replaceChildren();
            if (draft.blockedHosts.length === 0) {
                list.appendChild(createElement('li', { className: 'cdn-blocker-empty', text: '暂无精确 Host 规则' }));
                return;
            }
            for (const host of draft.blockedHosts) {
                const row = createElement('li', { className: 'cdn-blocker-row' });
                const removeButton = createElement('button', { type: 'button', text: '删除' });
                removeButton.setAttribute('aria-label', `删除 ${host}`);
                removeButton.addEventListener('click', () => {
                    draft.blockedHosts = draft.blockedHosts.filter((item) => item !== host);
                    renderList();
                });
                row.append(createElement('span', { text: host }), removeButton);
                list.appendChild(row);
            }
        };

        const addHost = () => {
            const host = normalizeHost(input.value);
            if (!host) {
                error.textContent = '请输入有效的 hostname 或 URL。';
                return;
            }
            if (draft.blockedHosts.includes(host)) {
                error.textContent = '该 Host 已在屏蔽列表中。';
                return;
            }
            draft.blockedHosts = normalizeHostList([...draft.blockedHosts, host]);
            input.value = '';
            error.textContent = '';
            renderList();
            input.focus();
        };

        addButton.addEventListener('click', addHost);
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                addHost();
            }
        });

        const actions = createElement('div', { className: 'cdn-blocker-actions' });
        const clearButton = createElement('button', {
            type: 'button',
            className: 'cdn-blocker-danger',
            text: '清空列表',
        });
        const cancelButton = createElement('button', { type: 'button', text: '取消' });
        const saveButton = createElement('button', {
            type: 'button',
            className: 'cdn-blocker-primary',
            text: '保存并应用',
        });
        actions.append(clearButton, cancelButton, saveButton);

        const close = () => overlay.remove();
        clearButton.addEventListener('click', () => {
            draft.blockedHosts = [];
            renderList();
        });
        cancelButton.addEventListener('click', close);
        saveButton.addEventListener('click', () => {
            draft.blockMcdn = mcdnToggle.checked;
            applyConfigAndReload(draft);
        });
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                close();
            }
        });
        overlay.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                close();
            }
        });

        renderList();
        dialog.append(title, switchRow, hint, addRow, error, list, actions);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        input.focus();
    }

    function destroy() {
        rootObserver?.disconnect();
        panelObserver?.disconnect();
        resumeObserver?.disconnect();
        rootObserver = null;
        panelObserver = null;
        resumeObserver = null;
        document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((button) => button.remove());
        document.getElementById(STYLE_ID)?.remove();
        document.getElementById(MODAL_ID)?.remove();
        if (pageWindow.XMLHttpRequest.prototype.open === patchedXhrOpen) {
            pageWindow.XMLHttpRequest.prototype.open = nativeXhrOpen;
        }
        const currentResponseDescriptor = Object.getOwnPropertyDescriptor(
            pageWindow.XMLHttpRequest.prototype,
            'response',
        );
        if (currentResponseDescriptor?.get === patchedXhrResponseGetter) {
            Object.defineProperty(
                pageWindow.XMLHttpRequest.prototype,
                'response',
                nativeXhrResponseDescriptor,
            );
        }
        if (pageWindow.JSON.parse === patchedJsonParse) {
            pageWindow.JSON.parse = nativeJsonParse;
        }
        if (nativeFetch && pageWindow.fetch === patchedFetch) {
            pageWindow.fetch = nativeFetch;
        }
        const currentPlayinfoDescriptor = Object.getOwnPropertyDescriptor(pageWindow, PLAYINFO_KEY);
        if (
            playinfoGuardInstalled
            && currentPlayinfoDescriptor?.get === guardedPlayinfoGetter
            && currentPlayinfoDescriptor?.set === guardedPlayinfoSetter
        ) {
            if (nativePlayinfoDescriptor) {
                Object.defineProperty(pageWindow, PLAYINFO_KEY, {
                    ...nativePlayinfoDescriptor,
                    value: guardedPlayinfo,
                });
            } else {
                Object.defineProperty(pageWindow, PLAYINFO_KEY, {
                    configurable: true,
                    enumerable: true,
                    writable: true,
                    value: guardedPlayinfo,
                });
            }
        }
        if (p2pTypeGuardInstalled) {
            if (nativeP2pTypeDescriptor) {
                Object.defineProperty(pageWindow, P2P_TYPE_KEY, nativeP2pTypeDescriptor);
            } else {
                delete pageWindow[P2P_TYPE_KEY];
            }
        }
        if (pageWindow[RUNTIME_KEY]?.destroy === destroy) {
            delete pageWindow[RUNTIME_KEY];
        }
    }

    Object.defineProperty(pageWindow, RUNTIME_KEY, {
        configurable: true,
        value: { destroy, openManager },
    });

    GM_registerMenuCommand('管理 CDN 屏蔽列表', openManager);
    restorePlaybackState();
    startStatsObserver();
})();
