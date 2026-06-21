// ─── State ──────────────────────────────────────────────────────────────────
let currentSessionId = null;
let isStreaming = false;
let streamBuffer = '';
let currentMessageBubble = null;
let currentToolName = '';
let eventCleanup = null;
let memoryCurrentTier = 'session';
let memoryCurrentNamespace = '';
// --- Memory Exploration State ---
let memoryViewMode = 'flat';          // 'flat' | 'grouped'
let memorySort = 'alpha';             // 'alpha' | 'alpha-desc' | 'type' | 'keylen'
let memoryTypeFilter = { str: true, num: true, bool: true, arr: true, obj: true, null: true };
let memoryCollapsedGroups = new Set();
let memoryRawData = {};               // cache of loaded memory for exploration ops


// ─── Dr. Claude State ────────────────────────────────────────────────────────
const recentToolBuffer = [];   // [{status:'call'|'result', name, args, result}]
let lastAIMessage = '';
let doctorCleanup = null;

// Reused by both the delegation panel and the agents list (line ~774)
const HAT_ICONS = {
  'product-maestro': '👑', 'feature-owner': '⭐', 'sub-ic': '🔧',
  'synthesizer': '🧩', 'browser_commander': '🌐', 'code_implementer': '💻',
};
function hatIcon(hat) { return HAT_ICONS[hat] || '🧩'; }

let delegationPanel = null; // { el, cardsEl, cards: Map<name, cardObj>, header }


// ─── DOM References ─────────────────────────────────────────────────────────
const chatMessages = document.getElementById('chat-messages');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const stopBtn = document.getElementById('stop-btn');
const newChatBtn = document.getElementById('new-chat-btn');
const statusDot = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');
const agentControls = document.getElementById('agent-controls');
const currentTool = document.getElementById('current-tool');
const askPanel = document.getElementById('ask-panel');
const askQuestion = document.getElementById('ask-question');
const askInput = document.getElementById('ask-input');
const askSubmit = document.getElementById('ask-submit');

const browserWebview = document.getElementById('browser-webview');
const browserUrl = document.getElementById('browser-url');
const browserGo = document.getElementById('browser-go');
const browserOpenBtn = document.getElementById('browser-open-btn');
const browserBack = document.getElementById('browser-back');
const browserForward = document.getElementById('browser-forward');
const browserRefresh = document.getElementById('browser-refresh');
const consoleOutput = document.getElementById('console-output');
const consoleClear = document.getElementById('console-clear');
const consoleRefresh = document.getElementById('console-refresh');
const jsCode = document.getElementById('js-code');
const jsRun = document.getElementById('js-run');
const jsClear = document.getElementById('js-clear');
const jsOutput = document.getElementById('js-output');

const doctorPanel = document.getElementById('doctor-panel');
const doctorBody = document.getElementById('doctor-body');
const doctorTitle = doctorPanel.querySelector('.doctor-title');
document.getElementById('doctor-close').addEventListener('click', () => {
  doctorPanel.style.display = 'none';
  if (doctorCleanup) { doctorCleanup(); doctorCleanup = null; }
});

const tabBrowser = document.getElementById('browser-tab');
const tabConsole = document.getElementById('console-tab');
const tabJS = document.getElementById('js-tab');
const tabAgents = document.getElementById('agents-tab');
const tabMemory = document.getElementById('memory-tab');
const viewBrowser = document.getElementById('browser-view');
const viewConsole = document.getElementById('console-view');
const viewJS = document.getElementById('js-view');
const viewAgents = document.getElementById('agents-view');
const viewMemory = document.getElementById('memory-view');

// Agent panel
const agentsList = document.getElementById('agents-list');
const agentsRefresh = document.getElementById('agents-refresh');
const agentsOpenHats = document.getElementById('agents-open-hats');
const agentDetail = document.getElementById('agent-detail');
const agentDetailBack = document.getElementById('agent-detail-back');
const agentDetailName = document.getElementById('agent-detail-name');
const agentDetailContent = document.getElementById('agent-detail-content');
const abuddiInput = document.getElementById('abuddi-input');
const abuddiScoreBtn = document.getElementById('abuddi-score-btn');
const abuddiResult = document.getElementById('abuddi-result');

// Memory panel
const memoryContent = document.getElementById('memory-content');
const memoryRefresh = document.getElementById('memory-refresh');
const memoryTierBtns = document.querySelectorAll('.memory-tier-btn');
const memoryNamespaceSelect = document.getElementById('memory-namespace-select');
const memoryKeyInput = document.getElementById('memory-key-input');
const memoryValueInput = document.getElementById('memory-value-input');
const memorySetBtn = document.getElementById('memory-set-btn');
const memoryAppendBtn = document.getElementById('memory-append-btn');
const memoryDeleteBtn = document.getElementById('memory-delete-btn');
const memorySearchInput = document.getElementById('memory-search-input');
const memorySearchBtn = document.getElementById('memory-search-btn');
const memoryStats = document.getElementById('memory-stats');
const memoryClearCurrent = document.getElementById('memory-clear-current');
// Memory exploration panel
const memViewFlat = document.getElementById('mem-view-flat');
const memViewGrouped = document.getElementById('mem-view-grouped');
const memSortSelect = document.getElementById('mem-sort-select');
const memTypeFilters = document.getElementById('mem-type-filters');
const memExpandAll = document.getElementById('mem-expand-all');
const memCollapseAll = document.getElementById('mem-collapse-all');
const memStatsBadge = document.getElementById('mem-stats-badge');
const memSearchClear = document.getElementById('memory-search-clear');
// Value inspector modal
const memInspectorModal = document.getElementById('mem-inspector-modal');
const memInspectorClose = document.getElementById('mem-inspector-close');
const memInspectorCopy = document.getElementById('mem-inspector-copy');
const memInspectorEdit = document.getElementById('mem-inspector-edit');
const memInspectorDelete = document.getElementById('mem-inspector-delete');
const memInspectorKey = document.getElementById('mem-inspector-key');
const memInspectorTier = document.getElementById('mem-inspector-tier');
const memInspectorNs = document.getElementById('mem-inspector-ns');
const memInspectorType = document.getElementById('mem-inspector-type');
const memInspectorLen = document.getElementById('mem-inspector-len');
const memInspectorValue = document.getElementById('mem-inspector-value');



// ─── Session Picker ──────────────────────────────────────────────────────────
function showSessionPicker(sessions, onPick) {
  const picker = document.getElementById('session-picker');
  const list = document.getElementById('picker-list');
  const newBtn = document.getElementById('picker-new-btn');

  list.innerHTML = '';
  let hasItems = false;
  for (const s of sessions) {
    if (s.message_count <= 1) continue;
    hasItems = true;
    const item = document.createElement('div');
    item.className = 'picker-item' + (s.summary && !s.summary_generated ? ' pending' : '');
    item.dataset.sessionId = s.id;
    const _ts = s.last_active || s.created_at;
    const _d = _ts ? new Date(_ts) : null;
    const when = (_d && !isNaN(_d)) ? _d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'unknown';
    const id8 = String(s.id).slice(0, 8);
    const title = escapeHtml(s.summary || s.id);
    item.innerHTML = `
      <div class="picker-item-info">
        <div class="picker-item-title">${title}</div>
        <div class="picker-item-meta">${escapeHtml(s.backend || '')} · ${id8} · ${when}</div>
      </div>
      <div class="picker-item-msgs">${s.message_count} msgs</div>
    `;
    item.addEventListener('click', () => { picker.style.display = 'none'; onPick(s); });
    list.appendChild(item);
  }

  // Stream in titles for sessions that don't have a generated one yet.
  if (window.deepconsole && window.deepconsole.llm && window.deepconsole.llm.onSummary) {
    const off = window.deepconsole.llm.onSummary(({ session_id, text }) => {
      const row = list.querySelector(`[data-session-id="${session_id}"]`);
      if (row) {
        const t = row.querySelector('.picker-item-title');
        if (t && text) t.textContent = text;
        row.classList.remove('pending');
      }
    });
    window.deepconsole.llm.streamSummaries().finally(() => {
      list.querySelectorAll('.picker-item.pending').forEach(r => r.classList.remove('pending'));
      if (off) off();
    });
  }

  if (!hasItems) { picker.style.display = 'none'; onPick(null); return; }

  newBtn.onclick = () => { picker.style.display = 'none'; onPick(null); };
  picker.style.display = 'flex';
}

// ─── Initialize Session ─────────────────────────────────────────────────────
async function resumeOrCreateSession() {
  try {
    setStatus('offline', 'Connecting...');
    const sessions = await window.deepconsole.llm.listSessions();
    const nonEmpty = (sessions || []).filter(s => s.message_count > 1);
    if (nonEmpty.length > 0) {
      return new Promise((resolve) => {
        showSessionPicker(sessions, async (picked) => {
          if (picked) {
            currentSessionId = picked.id;
            setStatus('online', `Ready · ${picked.model || 'DeepSeek'}`);
            await loadHistory(picked.id);
            resolve(true);
          } else {
            resolve(await initSession());
          }
        });
      });
    }
    return await initSession();
  } catch (err) {
    return await initSession();
  }
}

async function loadHistory(sessionId) {
  let data;
  try {
    data = await window.deepconsole.llm.getHistory(sessionId);
  } catch (err) {
    chatMessages.innerHTML = '';
    addMessage('ai', `⚠️ Failed to load session ${sessionId}: ${err.message || err}`);
    return;
  }
  if (data && data.error) {
    // Surface the failure instead of silently showing an empty chat.
    chatMessages.innerHTML = '';
    addMessage('ai', `⚠️ Could not load session ${sessionId}: ${data.error}`);
    return;
  }
  const history = (data && data.history) || [];
  chatMessages.innerHTML = '';
  for (const msg of history) {
    if (msg.role === 'system') continue;
    if (msg.role === 'user') {
      const text = typeof msg.content === 'string' ? msg.content : (msg.content?.[0]?.text ?? '');
      if (text) addMessage('user', text);
    } else if (msg.role === 'assistant' && msg.content) {
      const text = typeof msg.content === 'string' ? msg.content : (msg.content?.[0]?.text ?? '');
      if (text) addMessage('ai', text);
    }
  }
  if (history.filter(m => m.role !== 'system').length === 0) addWelcomeMessage();
}

async function initSession() {
  try {
    setStatus('offline', 'Connecting...');
    const session = await window.deepconsole.llm.createSession();
    currentSessionId = session.id;
    setStatus('online', `Ready · ${session.model || 'DeepSeek'}`);
    console.log('[DeepConsole] Session:', currentSessionId);
    return true;
  } catch (err) {
    setStatus('offline', 'LLM server not ready');
    console.error('Failed to create session:', err);
    return false;
  }
}

// Auto-retry when server is ready
window.deepconsole.llm.onReady(async () => {
  console.log('[DeepConsole] LLM server reported ready');
  if (!currentSessionId) {
    if (window.deepconsole.launchAutonomous) {
      // Launched with --autonomous (e.g. from the fleet manager): skip the session picker,
      // start a fresh session, and turn autonomous mode on automatically — no manual clicks.
      await initSession();
      enableAutonomousMode();
    } else {
      await resumeOrCreateSession();
    }
  }
  // Load agents
  loadAgents();
});

function setStatus(state, text) {
  statusDot.className = `status-dot ${state}`;
  statusText.textContent = text;
}

// ─── Add Message to Chat ────────────────────────────────────────────────────
function addMessage(role, text, isStreaming = false) {
  const div = document.createElement('div');
  div.className = `message ${role}`;

  const content = document.createElement('div');
  content.className = 'message-content';

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = role === 'ai' ? '⟁' : '👤';

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  if (isStreaming) bubble.classList.add('streaming-cursor');
  bubble.innerHTML = formatText(text);

  content.appendChild(avatar);
  content.appendChild(bubble);
  div.appendChild(content);
  chatMessages.appendChild(div);

  chatMessages.scrollTop = chatMessages.scrollHeight;

  if (isStreaming) {
    currentMessageBubble = bubble;
  }
  return bubble;
}

function updateStreamingText(text) {
  if (currentMessageBubble) {
    currentMessageBubble.innerHTML = formatText(text);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

function finishStreaming() {
  if (currentMessageBubble) {
    currentMessageBubble.classList.remove('streaming-cursor');
    currentMessageBubble = null;
  }
}

function addToolCall(name, args) {
  const div = document.createElement('div');
  div.className = 'tool-indicator';
  const argsStr = Object.entries(args || {}).map(([k, v]) => {
    const val = typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '...' : JSON.stringify(v);
    return `${k}=${val}`;
  }).join(', ');
  div.textContent = `🛠 ${name}(${argsStr})`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  currentToolName = name;
  recentToolBuffer.push({ status: 'call', name, args });
  if (recentToolBuffer.length > 20) recentToolBuffer.shift();
}

function addToolResult(name, result) {
  const div = document.createElement('div');
  div.className = 'tool-indicator';
  div.style.borderLeftColor = 'var(--success)';
  const resultStr = typeof result === 'string' && result.length > 200
    ? result.slice(0, 200) + '...'
    : (result ? String(result).slice(0, 200) : 'done');
  div.textContent = `✅ ${name} → ${resultStr}`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  currentToolName = '';
  const last = recentToolBuffer[recentToolBuffer.length - 1];
  if (last && last.status === 'call' && last.name === name) {
    last.status = 'result';
    last.result = resultStr;
  }
}

// ─── ABUDDI Delegation Panel (Tentacle View) ────────────────────────────────
function makeAgentCard(name, hat, depth) {
  const el = document.createElement('div');
  el.className = 'agent-card' + (depth > 0 ? ' nested' : '');
  el.innerHTML = `
    <div class="agent-card-head">
      <span class="agent-card-icon">${hatIcon(hat)}</span>
      <span class="agent-card-name"></span>
      <span class="agent-card-status">queued</span>
    </div>
    <div class="agent-bar"><div class="agent-bar-fill"></div></div>
    <div class="agent-activity"><div class="act-line"></div></div>
    <div class="agent-ticker"></div>`;
  el.querySelector('.agent-card-name').textContent = name;
  return {
    el,
    statusEl: el.querySelector('.agent-card-status'),
    barEl: el.querySelector('.agent-bar-fill'),
    actEl: el.querySelector('.act-line'),
    tickerEl: el.querySelector('.agent-ticker'),
    pct: 8,
    buf: '',
    lastTick: 0,
  };
}

function startDelegationPanel(subtasks) {
  finishStreaming();
  // The "[ABUDDI] Delegating..." line was just finalized into its own bubble.
  // Reset the buffer so the post-delegation synthesis renders into a fresh,
  // clean bubble below the panel (see the 'token' case, which re-creates the
  // bubble that finishStreaming() just cleared).
  streamBuffer = '';
  const el = document.createElement('div');
  el.className = 'delegation-panel';
  el.innerHTML = `<div class="delegation-header">${subtasks.length} agent${subtasks.length === 1 ? '' : 's'} deployed</div>
    <div class="delegation-cards"></div>`;
  const cardsEl = el.querySelector('.delegation-cards');
  const cards = new Map();
  subtasks.forEach((st) => {
    const card = makeAgentCard(st.name, st.hat, 0);
    cardsEl.appendChild(card.el);
    cards.set(st.name, card);
  });
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  delegationPanel = { el, cardsEl, cards, header: el.querySelector('.delegation-header') };
}

function getOrCreateCard(name, hat, depth) {
  if (!delegationPanel) return null;
  let card = delegationPanel.cards.get(name);
  if (!card) {
    card = makeAgentCard(name, hat, depth || 0);
    delegationPanel.cardsEl.appendChild(card.el);
    delegationPanel.cards.set(name, card);
  }
  return card;
}

function handleSubagentEvent(data) {
  if (data.phase === 'start') {
    startDelegationPanel(data.subtasks || []);
    return;
  }
  if (!delegationPanel) startDelegationPanel([]); // robustness if 'start' was missed
  const card = getOrCreateCard(data.name, data.hat, data.depth || 0);
  if (!card) return;

  switch (data.phase) {
    case 'spawned':
      card.statusEl.textContent = 'spawned';
      card.el.classList.add('active');
      card.pct = Math.max(card.pct, 12);
      card.barEl.style.width = card.pct + '%';
      break;
    case 'thinking':
      card.statusEl.textContent = 'thinking';
      card.el.classList.add('active');
      card.pct = Math.max(card.pct, 25);
      card.barEl.style.width = card.pct + '%';
      break;
    case 'tool':
      card.actEl.textContent = `🔧 ${data.tool || 'tool'}`;
      card.pct = Math.min(90, card.pct + 12);
      card.barEl.style.width = card.pct + '%';
      break;
    case 'token': {
      card.buf += data.text || '';
      const now = Date.now();
      if (now - card.lastTick > 200) {        // throttle: <= 5 updates/sec
        card.lastTick = now;
        card.tickerEl.textContent = card.buf.replace(/\s+/g, ' ').slice(-80);
      }
      break;
    }
    case 'done':
      card.el.classList.remove('active');
      card.el.classList.add('done');
      card.statusEl.textContent = '✓ done';
      card.barEl.style.width = '100%';
      if (data.result) card.actEl.textContent = `→ ${String(data.result).slice(0, 100)}`;
      card.tickerEl.textContent = '';
      break;
    case 'failed':
      card.el.classList.remove('active');
      card.el.classList.add('failed');
      card.statusEl.textContent = '✗ failed';
      card.barEl.style.width = '100%';
      if (data.error) card.actEl.textContent = `✗ ${String(data.error).slice(0, 100)}`;
      card.tickerEl.textContent = '';
      break;
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function collapseDelegationPanel() {
  if (!delegationPanel) return;
  let done = 0, failed = 0, total = delegationPanel.cards.size;
  delegationPanel.cards.forEach((c) => {
    if (c.el.classList.contains('done')) done++;
    else if (c.el.classList.contains('failed')) failed++;
  });
  const failTxt = failed ? ` · ${failed} ✗` : '';
  delegationPanel.header.textContent = `${total} agent${total === 1 ? '' : 's'} · ${done} ✓${failTxt}`;
  delegationPanel.el.classList.add('collapsed');
  delegationPanel = null;
}

// ─── Dr. Claude ─────────────────────────────────────────────────────────────

function showErrorWithDoctor(errorMsg) {
  const div = document.createElement('div');
  div.className = 'message ai';
  const content = document.createElement('div');
  content.className = 'message-content';
  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = '⟁';
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.innerHTML = `<span style="color:var(--error)">⚠️ Error: ${errorMsg.replace(/</g,'&lt;')}</span><br>
    <button class="ask-claude-btn" id="ask-dr-claude-btn">🩺 Ask Dr. Claude to diagnose this</button>`;
  content.appendChild(avatar);
  content.appendChild(bubble);
  div.appendChild(content);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  document.getElementById('ask-dr-claude-btn')?.addEventListener('click', () => {
    invokeDrClaude(errorMsg);
  });
}

async function invokeDrClaude(errorMsg) {
  doctorPanel.style.display = 'block';
  doctorTitle.textContent = '🩺 Dr. Claude is diagnosing...';
  doctorBody.innerHTML = '<span class="doctor-thinking">Consulting Dr. Claude...</span>';

  let accumulated = '';

  // Real-time token streaming — append deltas as they arrive
  if (doctorCleanup) doctorCleanup();
  doctorCleanup = window.deepconsole.claude.onStreaming(({ text }) => {
    if (text) {
      accumulated += text;
      doctorTitle.textContent = '🩺 Dr. Claude';
      doctorBody.textContent = accumulated;
      doctorBody.scrollTop = doctorBody.scrollHeight;
    }
  });

  try {
    const result = await window.deepconsole.claude.diagnose(
      errorMsg,
      lastAIMessage,
      [...recentToolBuffer],
      null,
      currentSessionId
    );
    if (doctorCleanup) { doctorCleanup(); doctorCleanup = null; }

    if (result.error) {
      doctorTitle.textContent = '🩺 Dr. Claude (unavailable)';
      doctorBody.textContent = result.error;
    } else {
      // Render final response with markdown formatting
      doctorTitle.textContent = '🩺 Dr. Claude';
      doctorBody.innerHTML = formatText(result.response || accumulated || '(no response)');
    }
  } catch (err) {
    doctorTitle.textContent = '🩺 Dr. Claude (error)';
    doctorBody.textContent = err.message;
  }
  doctorBody.scrollTop = doctorBody.scrollHeight;
}

function formatText(text) {
  if (!text) return '';
  let escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Code blocks
  escaped = escaped.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  // Inline code
  escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic
  escaped = escaped.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Links
  escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  // Line breaks
  escaped = escaped.replace(/\n/g, '<br>');
  return escaped;
}

// ─── Send Message ──────────────────────────────────────────────────────────
/**
 * Send a message to the active session and stream the agent's response.
 * @param {string} [textArg] Explicit text to send; omit to read the chat input box (manual mode).
 * @returns {Promise<string>} The agent's final response text ('' for an empty/tool-only turn).
 * @throws {Error} when a stream is already running or no session is active — thrown ONLY for
 *   programmatic (string-arg) callers so an autonomous worker can release the item; manual
 *   (no-arg) callers no-op instead.
 */
async function sendMessage(textArg) {
  const fromInput = typeof textArg !== 'string';
  const text = (fromInput ? messageInput.value : textArg).trim();
  if (!text) return '';
  if (!currentSessionId) {
    if (!fromInput) throw new Error('no active session');
    return '';
  }
  // If a stream is already running, a programmatic (autonomous) caller must know
  // it couldn't run, so it can release the item; a manual caller just no-ops.
  if (isStreaming) {
    if (!fromInput) throw new Error('chat busy');
    return '';
  }

  if (fromInput) messageInput.value = '';
  addMessage('user', text);
  isStreaming = true;
  sendBtn.style.display = 'none';
  stopBtn.style.display = '';
  setStatus('thinking', 'DeepSeek is thinking...');

  // Create placeholder for AI response
  addMessage('ai', 'Thinking...', true);

  agentControls.style.display = 'block';
  currentTool.innerHTML = '🤔 Processing...';

  streamBuffer = '';
  lastAIMessage = ''; // reset so a turn that ends without a 'done' text event can't return a stale answer

  if (eventCleanup) eventCleanup();

  let streamError = null;
  try {
    eventCleanup = window.deepconsole.llm.onEvent(({ event, data }) => {
      switch (event) {
        case 'token':
          streamBuffer += data.text;
          // After a delegation panel (or any finishStreaming) there is no live
          // bubble to write into; create one so the synthesis/final response is
          // actually shown instead of silently accumulating in the buffer.
          if (!currentMessageBubble) addMessage('ai', '', true);
          updateStreamingText(streamBuffer);
          break;

        case 'tool_call':
          finishStreaming();
          addToolCall(data.name, data.args);
          currentTool.innerHTML = `🔧 Using <span class="tool-name">${data.name}</span>`;
          if (data.name === 'browser_open' || data.name === 'navigate' || data.name === 'browser_navigate') {
            switchTab('browser');
          }
          break;

        case 'tool_result':
          addToolResult(data.name, data.result);
          streamBuffer = '';
          addMessage('ai', '', true);
          break;

        case 'ask':
          finishStreaming();
          showAskPanel(data.question);
          break;

        case 'done':
          collapseDelegationPanel();
          finishStreaming();
          agentControls.style.display = 'none';
          setStatus('online', 'Ready');
          lastAIMessage = streamBuffer;
          streamBuffer = '';
          break;

        case 'subagent':
          handleSubagentEvent(data);
          break;

        case 'warning':
          console.warn('[LLM Warning]', data.message);
          break;

        case 'error':
          collapseDelegationPanel();
          finishStreaming();
          streamError = data.message || 'stream error';
          showErrorWithDoctor(data.message);
          setStatus('online', 'Error');
          break;
      }
    });

    await window.deepconsole.llm.chat(currentSessionId, text);
  } catch (err) {
    finishStreaming();
    streamError = err.message;
    showErrorWithDoctor(err.message);
    console.error('Chat error:', err);
  }

  isStreaming = false;
  sendBtn.style.display = '';
  stopBtn.style.display = 'none';
  if (fromInput) messageInput.focus();

  if (streamError) throw new Error(streamError);
  return lastAIMessage;
}

stopBtn.addEventListener('click', async () => {
  await window.deepconsole.llm.stop();
  finishStreaming();
  agentControls.style.display = 'none';
  setStatus('online', 'Stopped');
  isStreaming = false;
  sendBtn.style.display = '';
  stopBtn.style.display = 'none';
  messageInput.focus();
});

// ─── Ask Panel ──────────────────────────────────────────────────────────────
function showAskPanel(question) {
  askPanel.style.display = 'block';
  askQuestion.textContent = `❓ ${question}`;
  askInput.value = '';
  askInput.focus();
}

function hideAskPanel() {
  askPanel.style.display = 'none';
}

askSubmit.addEventListener('click', async () => {
  const answer = askInput.value.trim();
  if (!answer) return;
  hideAskPanel();
  addMessage('user', `[Answer] ${answer}`);
  try {
    await window.deepconsole.llm.respond(currentSessionId, answer);
  } catch (err) {
    console.error('Ask response error:', err);
  }
});

askInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') askSubmit.click();
});

// ─── New Chat ───────────────────────────────────────────────────────────────
newChatBtn.addEventListener('click', async () => {
  chatMessages.innerHTML = '';
  streamBuffer = '';
  finishStreaming();
  agentControls.style.display = 'none';
  if (eventCleanup) { eventCleanup(); eventCleanup = null; }
  await initSession();
  addWelcomeMessage();
});

function addWelcomeMessage() {
  const welcome = document.createElement('div');
  welcome.className = 'message welcome';
  welcome.innerHTML = `
    <div class="message-content">
      <div class="message-avatar ai">⟁</div>
      <div class="message-bubble">
        <p>Hello! I'm <strong>DeepConsole</strong> — DeepSeek with browser control and <strong>3-tier shared working memory</strong>.</p>
        <p>I can:</p>
        <ul>
          <li>💬 Chat with you using DeepSeek</li>
          <li>🌐 Open and browse websites</li>
          <li>🔍 Execute JavaScript in the browser</li>
          <li>📊 View console logs</li>
          <li>🧠 Remember things across sessions & agents</li>
          <li>🤖 Orchestrate work via <strong>Maestro agents</strong> (try the Agents tab)</li>
        </ul>
        <p><strong>🧠 Memory Tiers:</strong> Session (chat) → Agent (per-hat) → Meta (global)</p>
        <p>Try asking: <em>"Open google.com"</em> or <em>"Remember that my name is Alice"</em></p>
      </div>
    </div>`;
  chatMessages.appendChild(welcome);
}

// ─── Event Listeners ───────────────────────────────────────────────────────
sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Hint buttons
document.querySelectorAll('.hint-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const hint = btn.dataset.hint;
    if (hint === '🌐 Browser') {
      messageInput.value = 'Open google.com in a browser';
    } else if (hint === '💻 Run JS') {
      messageInput.value = 'Go to example.com and run JavaScript to change the background color to dark blue';
    } else if (hint === '📋 Console') {
      messageInput.value = 'Check what console logs are in the browser';
    } else if (hint === '📊 Score with ABUDDI') {
      messageInput.value = 'Score this task with ABUDDI complexity: add a dark mode toggle to the settings page';
    } else if (hint === '🧠 Remember') {
      messageInput.value = 'Remember that my name is [your name] and my favorite color is [color]. Then tell me what you know about me.';
    }
    sendMessage();
  });
});

// ─── Browser Controls ──────────────────────────────────────────────────────
browserGo.addEventListener('click', () => {
  let url = browserUrl.value.trim();
  if (!url) return;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  browserWebview.src = url;
});

browserUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') browserGo.click();
});

browserOpenBtn.addEventListener('click', () => {
  let url = browserUrl.value.trim() || 'https://google.com';
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  browserWebview.src = url;
});

browserBack.addEventListener('click', () => {
  if (browserWebview.canGoBack()) browserWebview.goBack();
});

browserForward.addEventListener('click', () => {
  if (browserWebview.canGoForward()) browserWebview.goForward();
});

browserRefresh.addEventListener('click', () => {
  browserWebview.reload();
});

browserWebview.addEventListener('did-navigate', (e) => {
  browserUrl.value = e.url;
});

browserWebview.addEventListener('did-navigate-in-page', (e) => {
  browserUrl.value = e.url;
});

// ─── Tab Switching ─────────────────────────────────────────────────────────
function switchTab(tab) {
  const tabs = [tabBrowser, tabConsole, tabJS, tabAgents, tabMemory];
  const views = [viewBrowser, viewConsole, viewJS, viewAgents, viewMemory];
  tabs.forEach(t => t.classList.remove("active"));
  views.forEach(v => v.classList.remove("active"));

  if (tab === "browser") { tabBrowser.classList.add("active"); viewBrowser.classList.add("active"); }
  else if (tab === "console") { tabConsole.classList.add("active"); viewConsole.classList.add("active"); }
  else if (tab === "js") { tabJS.classList.add("active"); viewJS.classList.add("active"); }
  else if (tab === "agents") { tabAgents.classList.add("active"); viewAgents.classList.add("active"); loadAgents(); }
  else if (tab === "memory") { tabMemory.classList.add("active"); viewMemory.classList.add("active"); refreshMemoryView(); }
}

tabBrowser.addEventListener('click', () => switchTab('browser'));
tabConsole.addEventListener('click', () => switchTab('console'));
tabJS.addEventListener('click', () => switchTab('js'));
tabAgents.addEventListener('click', () => {
  switchTab('agents');
  loadAgents();
});

tabMemory.addEventListener('click', () => switchTab('memory'));

// Agent panel toggle from titlebar
document.getElementById('agent-panel-toggle')?.addEventListener('click', () => {
  switchTab('agents');
  loadAgents();
});

// ─── Console View ──────────────────────────────────────────────────────────
function addConsoleEntry(entry) {
  const div = document.createElement('div');
  div.className = 'console-entry';

  const time = document.createElement('span');
  time.className = 'entry-time';
  const d = new Date(entry.timestamp);
  time.textContent = d.toLocaleTimeString();

  const msg = document.createElement('span');
  msg.className = `entry-type-${entry.type}`;
  msg.textContent = entry.args.join(' ');

  div.appendChild(time);
  div.appendChild(msg);
  consoleOutput.appendChild(div);
  consoleOutput.scrollTop = consoleOutput.scrollHeight;
}

consoleClear.addEventListener('click', () => {
  consoleOutput.innerHTML = '<div class="console-info">Console cleared.</div>';
});

// Buffer for webview console logs (captured via console-message event)
var webviewLogBuffer = [];
var MAX_WEBVIEW_LOGS = 500;

// Capture console messages from the webview
if (browserWebview) {
  browserWebview.addEventListener('console-message', function(e) {
    var entry = { type: 'log', timestamp: new Date().toISOString(), args: [e.message] };
    if (e.level === 2) entry.type = 'warn';
    else if (e.level === 3) entry.type = 'error';
    webviewLogBuffer.push(entry);
    if (webviewLogBuffer.length > MAX_WEBVIEW_LOGS) webviewLogBuffer.shift();
    addConsoleEntry(entry);
    if (!viewConsole.classList.contains('active')) {
      tabConsole.style.color = 'var(--warning)';
      setTimeout(function() { tabConsole.style.color = ''; }, 2000);
    }
  });
}

consoleRefresh.addEventListener('click', async function() {
  consoleOutput.innerHTML = '';
  if (webviewLogBuffer.length === 0) {
    consoleOutput.innerHTML = '<div class="console-info">No console logs from browser window.</div>';
    return;
  }
  webviewLogBuffer.forEach(addConsoleEntry);
});

// Remove the old onConsoleEntry listener since we use webview events instead
// The onConsoleEntry from external browser window is no longer relevant
jsRun.addEventListener('click', async () => {
  const code = jsCode.value.trim();
  if (!code) return;

  jsOutput.innerHTML = '';

  try {
    const result = await window.deepconsole.browser.executeJS(code);
    if (result.ok) {
      const div = document.createElement('div');
      div.className = 'result-success';
      const output = typeof result.result === 'object'
        ? JSON.stringify(result.result, null, 2)
        : String(result.result);
      div.textContent = `✓ ${output}`;
      jsOutput.appendChild(div);
    } else if (result.error) {
      const div = document.createElement('div');
      div.className = 'result-error';
      div.textContent = `✗ Error: ${result.error}`;
      jsOutput.appendChild(div);
    } else {
      const div = document.createElement('div');
      div.className = 'result-error';
      div.textContent = `✗ ${result.error || 'Unknown error'}`;
      jsOutput.appendChild(div);
    }
  } catch (err) {
    const div = document.createElement('div');
    div.className = 'result-error';
    div.textContent = `✗ Error: ${err.message}`;
    jsOutput.appendChild(div);
  }

  jsOutput.scrollTop = jsOutput.scrollHeight;
});

jsClear.addEventListener('click', () => {
  jsOutput.innerHTML = '<div class="console-info">Output cleared.</div>';
});

jsCode.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.ctrlKey) {
    e.preventDefault();
    jsRun.click();
  }
});

// ─── Agent Command Center ──────────────────────────────────────────────────

async function loadAgents() {
  agentsList.innerHTML = '<div class="agents-loading">Loading agents...</div>';
  try {
    const agents = await window.deepconsole.agents.list();
    renderAgentList(agents);
  } catch (err) {
    agentsList.innerHTML = `<div class="agents-loading">⚠️ Failed to load agents: ${err.message}</div>`;
  }
}

function renderAgentList(agents) {
  if (!agents || agents.length === 0) {
    agentsList.innerHTML = '<div class="agents-loading">No agents found. Reload from disk?</div>';
    return;
  }

  agentsList.innerHTML = '';
  for (const agent of agents) {
    const card = document.createElement('div');
    card.className = 'agent-card';
    card.dataset.agentId = agent.id;

    const icon = hatIcon(agent.id);

    const decisions = (agent.decisions || []).map(d => `<span class="agent-badge">${d}</span>`).join('');

    card.innerHTML = `
      <div class="agent-card-icon">${icon}</div>
      <div class="agent-card-info">
        <div class="agent-card-name">${agent.name || agent.id}</div>
        <div class="agent-card-role">${agent.role || ''}</div>
        <div class="agent-card-decisions">${decisions}</div>
      </div>
      <div class="agent-card-meta">${(agent.expertise || []).length} skills</div>
    `;

    card.addEventListener('click', () => showAgentDetail(agent.id));
    agentsList.appendChild(card);
  }
}

async function showAgentDetail(agentId) {
  try {
    const agent = await window.deepconsole.agents.get(agentId);
    if (!agent) return;

    agentDetailName.textContent = agent.name || agent.id;
    const expertise = (agent.expertise || []).map(e => `<span class="detail-expertise-item">${e}</span>`).join('');
    const decisions = (agent.decisions || []).map(d => `<span class="agent-badge">${d}</span>`).join('');
    const tools = (agent.requiredTools || []).map(t => `<code>${t}</code>`).join(', ');
    const caps = (agent.capabilities || []).map(c => `<li>${c}</li>`).join('');

    // Only show first 1000 chars of system prompt
    const promptPreview = (agent.systemPrompt || '').slice(0, 800) + '...';

    agentDetailContent.innerHTML = `
      <div class="detail-section">
        <div class="detail-section-title">Role</div>
        <p>${agent.role || 'N/A'}</p>
      </div>
      <div class="detail-section">
        <div class="detail-section-title">Decisions</div>
        <div class="agent-card-decisions">${decisions}</div>
      </div>
      <div class="detail-section">
        <div class="detail-section-title">Expertise (${(agent.expertise || []).length})</div>
        <div class="detail-expertise">${expertise}</div>
      </div>
      ${caps ? `<div class="detail-section"><div class="detail-section-title">Capabilities</div><ul>${caps}</ul></div>` : ''}
      ${tools ? `<div class="detail-section"><div class="detail-section-title">Tools</div><p>${tools}</p></div>` : ''}
      <div class="detail-section">
        <div class="detail-section-title">System Prompt (preview)</div>
        <pre style="font-size:10px;max-height:150px;overflow-y:auto;background:var(--bg-primary);padding:8px;border-radius:4px;">${promptPreview}</pre>
      </div>
    `;

    agentsList.style.display = 'none';
    agentDetail.style.display = 'block';
  } catch (err) {
    console.error('Failed to load agent detail:', err);
  }
}

agentDetailBack.addEventListener('click', () => {
  agentDetail.style.display = 'none';
  agentsList.style.display = '';
});

agentsRefresh.addEventListener('click', loadAgents);

agentsOpenHats.addEventListener('click', async () => {
  // Open the agents directory
  try {
    const result = await window.deepconsole.browser.executeJS('void 0');
    // Just reload agents from server
    await window.deepconsole.agents.reload();
    loadAgents();
  } catch (err) {
    console.error(err);
  }
});

// ─── ABUDDI Complexity Scorer ──────────────────────────────────────────────

abuddiScoreBtn.addEventListener('click', async () => {
  const task = abuddiInput.value.trim();
  if (!task) return;

  abuddiResult.innerHTML = '<div class="console-info">Scoring task with ABUDDI...</div>';
  abuddiScoreBtn.disabled = true;

  try {
    const result = await window.deepconsole.abuddi.score(task);
    const parsed = result.parsed;

    if (parsed && parsed.complexity_score !== undefined) {
      const score = parsed.complexity_score;
      const breakdown = parsed.breakdown || {};
      const recommendation = parsed.recommendation || '';

      let html = `<div class="abuddi-total-score">${score}/60</div>`;

      // Dimensions
      const dims = [
        { key: 'atomic_scope', label: 'A - Atomic Scope' },
        { key: 'breadth', label: 'B - Breadth' },
        { key: 'uncertainty', label: 'U - Uncertainty' },
        { key: 'dependencies', label: 'D - Dependencies' },
        { key: 'depth', label: 'D - Depth' },
        { key: 'impact', label: 'I - Impact' },
      ];

      for (const dim of dims) {
        const d = breakdown[dim.key];
        if (d) {
          html += `<div class="abuddi-dimension">
            <span class="abuddi-dimension-name">${dim.label}</span>
            <span class="abuddi-dimension-score">${d.score}/10</span>
          </div>`;
        }
      }

      if (recommendation) {
        html += `<div class="abuddi-recommendation">${recommendation}</div>`;
      }

      if (parsed.suggested_hats && parsed.suggested_hats.length > 0) {
        html += `<div style="margin-top:6px;text-align:center;font-size:10px;color:var(--text-muted)">
          Suggested hats: ${parsed.suggested_hats.join(', ')}
        </div>`;
      }

      abuddiResult.innerHTML = `<div class="abuddi-score-display">${html}</div>`;
    } else {
      abuddiResult.innerHTML = `
        <div class="console-info">Could not parse complexity score. Raw response:</div>
        <pre style="font-size:10px;margin-top:4px;white-space:pre-wrap">${(result.raw_response || '').slice(0, 1000)}</pre>`;
    }
  } catch (err) {
    abuddiResult.innerHTML = `<div class="result-error">✗ Error: ${err.message}</div>`;
  }

  abuddiScoreBtn.disabled = false;
});

// ─── Start ──────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════
// ─── Working Memory Panel ────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

function getDefaultNamespace(tier) {
  if (tier === 'session') return currentSessionId ? `session_${currentSessionId}` : 'session_unknown';
  if (tier === 'agent') return 'agent_product-maestro';
  if (tier === 'meta') return 'deepconsole';
  return 'unknown';
}

async function refreshMemoryView() {
  // Update tier from active button
  document.querySelectorAll('.memory-tier-btn').forEach(btn => {
    if (btn.classList.contains('active')) {
      memoryCurrentTier = btn.dataset.tier;
    }
  });

  // Populate namespace selector from actual stored namespaces via API
  memoryNamespaceSelect.innerHTML = '';
  try {
    const nsData = await window.deepconsole.memory.namespaces(memoryCurrentTier);
    const namespaces = nsData[memoryCurrentTier] || [];
    if (namespaces.length === 0) {
      const opt = document.createElement('option');
      opt.value = getDefaultNamespace(memoryCurrentTier);
      opt.textContent = opt.value;
      memoryNamespaceSelect.appendChild(opt);
    } else {
      namespaces.forEach(ns => {
        const opt = document.createElement('option');
        opt.value = ns;
        const label = ns.replace(/^(session_|agent_)/, '');
        opt.textContent = ns === 'deepconsole' ? 'Global DeepConsole Memory' : label;
        memoryNamespaceSelect.appendChild(opt);
      });
    }
  } catch (e) {
    // Fallback: use defaults
    const fallbacks = {
      session: [getDefaultNamespace('session')],
      agent: ['agent_product-maestro', 'agent_feature-owner'],
      meta: ['deepconsole']
    };
    (fallbacks[memoryCurrentTier] || ['unknown']).forEach(ns => {
      const opt = document.createElement('option');
      opt.value = ns;
      opt.textContent = ns;
      memoryNamespaceSelect.appendChild(opt);
    });
  }

  memoryCurrentNamespace = memoryNamespaceSelect.value || getDefaultNamespace(memoryCurrentTier);

  // Load and display memory
  await loadMemoryStore();
  await updateMemoryStats();
}


function formatMemoryValue(value, depth = 0) {
  if (value === null || value === undefined) return '<span class="memory-entry-null">null</span>';
  const t = typeof value;
  if (t === 'string') return `<span class="memory-entry-string">"${value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}"</span>`;
  if (t === 'number') return `<span class="memory-entry-number">${value}</span>`;
  if (t === 'boolean') return `<span class="memory-entry-bool">${value}</span>`;
  if (Array.isArray(value)) {
    if (depth > 2) return `<span class="memory-entry-object">[Array(${value.length})]</span>`;
    const items = value.map(v => formatMemoryValue(v, depth + 1)).join(', ');
    return `<span class="memory-entry-object">[${items}]</span>`;
  }
  if (t === 'object') {
    if (depth > 2) return `<span class="memory-entry-object">{${Object.keys(value).length} keys}</span>`;
    const entries = Object.entries(value).map(([k, v]) =>
      `<span class="memory-entry-key">${k}</span>: ${formatMemoryValue(v, depth + 1)}`
    ).join(', ');
    return `<span class="memory-entry-object">{ ${entries} }</span>`;
  }
  return `<span class="memory-entry-string">${String(value)}</span>`;
}

async function loadMemoryStore() {
  if (!memoryCurrentNamespace) return;
  memoryContent.innerHTML = '<div class="console-info">Loading memory...</div>';
  try {
    const data = await window.deepconsole.memory.get(memoryCurrentTier, memoryCurrentNamespace, undefined);
    if (data.error) {
      memoryContent.innerHTML = '<div class="console-info">Error: ' + data.error + '</div>';
      return;
    }
    memoryRawData = data.memory || {};
    renderMemoryEntries();
  } catch (err) {
    memoryContent.innerHTML = '<div class="console-info">Failed to load: ' + err.message + '</div>';
  }
}

function getValueType(val) {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'string') return 'str';
  if (typeof val === 'number') return 'num';
  if (typeof val === 'boolean') return 'bool';
  if (Array.isArray(val)) return 'arr';
  if (typeof val === 'object') return 'obj';
  return 'str';
}

function getValuePreview(val, maxLen) {
  if (maxLen === undefined) maxLen = 60;
  if (val === null || val === undefined) return 'null';
  var t = typeof val;
  if (t === 'string') return '"' + val.slice(0, maxLen).replace(/\n/g, '\
') + (val.length > maxLen ? '..."' : '"');
  if (t === 'number') return String(val);
  if (t === 'boolean') return String(val);
  if (Array.isArray(val)) return '[' + val.slice(0, 3).map(function(v) { return getValuePreview(v, 20); }).join(', ') + (val.length > 3 ? ', ...]' : ']');
  if (t === 'object') return '{' + Object.keys(val).slice(0, 5).join(', ') + (Object.keys(val).length > 5 ? ', ...}' : '}');
  return String(val);
}

function getValueString(val) {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'object') return JSON.stringify(val, null, 2);
  return String(val);
}

function getTypeBadge(type) {
  var colors = { str: 'var(--memory-string)', num: 'var(--memory-number)', bool: 'var(--accent)', arr: '#74b9ff', obj: '#a29bfe', null: 'var(--text-muted)' };
  return '<span class="mem-type-badge" style="background:' + (colors[type] || '#666') + '20;color:' + (colors[type] || '#666') + ';border:1px solid ' + (colors[type] || '#666') + '40">' + type + '</span>';
}

function sortEntries(entries, sortMode) {
  var sorted = entries.slice();
  switch (sortMode) {
    case 'alpha': sorted.sort(function(a, b) { return a.key.localeCompare(b.key); }); break;
    case 'alpha-desc': sorted.sort(function(a, b) { return b.key.localeCompare(a.key); }); break;
    case 'type': sorted.sort(function(a, b) { var ta = getValueType(a.val), tb = getValueType(b.val); return ta.localeCompare(tb) || a.key.localeCompare(b.key); }); break;
    case 'keylen': sorted.sort(function(a, b) { return a.key.length - b.key.length || a.key.localeCompare(b.key); }); break;
  }
  return sorted;
}

function filterEntries(entries) {
  return entries.filter(function(e) { return memoryTypeFilter[getValueType(e.val)] !== false; });
}

function getKeyPrefix(key) {
  var parts = key.split(/[._-]/);
  return parts.length > 1 ? parts[0] : '_ungrouped';
}

function renderMemoryEntries() {
  var memory = memoryRawData;
  var keys = Object.keys(memory);
  if (keys.length === 0) {
    memoryContent.innerHTML = '<div class="console-info">Empty memory store. Use the key/value editor above to add data.</div>';
    return;
  }
  var entries = keys.map(function(k) { return { key: k, val: memory[k] }; });
  entries = filterEntries(entries);
  entries = sortEntries(entries, memorySort);
  if (entries.length === 0) {
    memoryContent.innerHTML = '<div class="console-info">No entries match the current type filter.</div>';
    return;
  }
  var html = '<div class="mem-header-bar">' + entries.length + ' of ' + keys.length + ' key(s) in ' + memoryCurrentTier + '/' + memoryCurrentNamespace + '</div>';
  if (memoryViewMode === 'grouped') {
    html += renderGroupedView(entries);
  } else {
    html += renderFlatView(entries);
  }
  memoryContent.innerHTML = html;
  // Wire up double-click to inspect
  var rows = memoryContent.querySelectorAll('.mem-entry-row');
  for (var ri = 0; ri < rows.length; ri++) {
    (function(row) {
      row.addEventListener('dblclick', function() {
        var key = row.dataset.memKey;
        var val = memory[key];
        if (key !== undefined) openInspector(key, val);
      });
    })(rows[ri]);
  }
  // Wire up single-click on value to copy
  var valEls = memoryContent.querySelectorAll('.mem-entry-value');
  for (var vi = 0; vi < valEls.length; vi++) {
    (function(el) {
      el.addEventListener('click', function(e) {
        e.stopPropagation();
        var key = el.closest('.mem-entry-row').dataset.memKey;
        var val = memory[key];
        if (val !== undefined) {
          var str = getValueString(val);
          try { navigator.clipboard.writeText(str); } catch(e) {}
          el.title = 'Copied!';
          setTimeout(function() { el.title = 'Click to copy'; }, 1000);
        }
      });
    })(valEls[vi]);
  }
  // Wire up group expand/collapse
  var hdrs = memoryContent.querySelectorAll('.mem-group-header');
  for (var hi = 0; hi < hdrs.length; hi++) {
    (function(hdr) {
      hdr.addEventListener('click', function() {
        var prefix = hdr.dataset.groupPrefix;
        var body = document.querySelector('.mem-group-body[data-group-prefix="' + prefix + '"]');
        if (body) {
          if (memoryCollapsedGroups.has(prefix)) {
            memoryCollapsedGroups.delete(prefix);
            body.style.display = '';
            hdr.querySelector('.mem-group-toggle').textContent = '\u25bc';
          } else {
            memoryCollapsedGroups.add(prefix);
            body.style.display = 'none';
            hdr.querySelector('.mem-group-toggle').textContent = '\u25b6';
          }
        }
      });
    })(hdrs[hi]);
  }
}

function renderFlatView(entries) {
  var html = '<div class="mem-view-flat">';
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var type = getValueType(e.val);
    var preview = getValuePreview(e.val, 50);
    var badge = getTypeBadge(type);
    html += '<div class="mem-entry-row" data-mem-key="' + e.key.replace(/"/g, '&quot;').replace(/'/g, '&#39;') + '">' +
      '<span class="mem-entry-key">' + e.key + '</span> ' + badge + ' ' +
      '<span class="mem-entry-value" title="Click to copy value">' + preview + '</span></div>';
  }
  html += '</div>';
  return html;
}

function renderGroupedView(entries) {
  var groups = {};
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var prefix = getKeyPrefix(e.key);
    if (!groups[prefix]) groups[prefix] = [];
    groups[prefix].push(e);
  }
  var sortedGroups = Object.keys(groups).sort(function(a, b) {
    if (a === '_ungrouped') return 1;
    if (b === '_ungrouped') return -1;
    return a.localeCompare(b);
  });
  var html = '<div class="mem-view-grouped">';
  for (var gi = 0; gi < sortedGroups.length; gi++) {
    var prefix = sortedGroups[gi];
    var groupEntries = groups[prefix];
    var isCollapsed = memoryCollapsedGroups.has(prefix);
    var displayStyle = isCollapsed ? 'display:none;' : '';
    var toggleIcon = isCollapsed ? '\u25b6' : '\u25bc';
    html += '<div class="mem-group">' +
      '<div class="mem-group-header" data-group-prefix="' + prefix + '">' +
      '<span class="mem-group-toggle">' + toggleIcon + '</span> ' +
      '<span class="mem-group-prefix">' + prefix + '</span> ' +
      '<span class="mem-group-count">' + groupEntries.length + '</span></div>' +
      '<div class="mem-group-body" data-group-prefix="' + prefix + '" style="' + displayStyle + '">';
    for (var ei = 0; ei < groupEntries.length; ei++) {
      var e2 = groupEntries[ei];
      var type2 = getValueType(e2.val);
      var preview2 = getValuePreview(e2.val, 50);
      var badge2 = getTypeBadge(type2);
      html += '<div class="mem-entry-row" data-mem-key="' + e2.key.replace(/"/g, '&quot;').replace(/'/g, '&#39;') + '">' +
        '<span class="mem-entry-key">' + e2.key + '</span> ' + badge2 + ' ' +
        '<span class="mem-entry-value" title="Click to copy value">' + preview2 + '</span></div>';
    }
    html += '</div></div>';
  }
  html += '</div>';
  return html;
}

function openInspector(key, value) {
  var type = getValueType(value);
  var valueStr = getValueString(value);
  memInspectorKey.textContent = key;
  memInspectorTier.textContent = memoryCurrentTier;
  memInspectorNs.textContent = memoryCurrentNamespace;
  memInspectorType.textContent = type;
  memInspectorLen.textContent = valueStr.length;
  memInspectorValue.textContent = valueStr;
  memInspectorModal.style.display = 'flex';
  memInspectorModal.dataset.memKey = key;
  memInspectorModal.dataset.memTier = memoryCurrentTier;
  memInspectorModal.dataset.memNs = memoryCurrentNamespace;
}

async function updateMemoryStats() {
  try {
    const stats = await window.deepconsole.memory.stats();
    if (stats && !stats.error) {
      const s = stats.session || {};
      const a = stats.agent || {};
      const m = stats.meta || {};
      memoryStats.textContent = `S:${s.keys || 0} A:${a.keys || 0} M:${m.keys || 0}`;
      // Update stats badge with type distribution
      if (memStatsBadge && Object.keys(memoryRawData).length > 0) {
        var typeCounts = {};
        Object.keys(memoryRawData).forEach(function(k) {
          var t = getValueType(memoryRawData[k]);
          typeCounts[t] = (typeCounts[t] || 0) + 1;
        });
        var parts = Object.keys(typeCounts).map(function(t) { return t + ':' + typeCounts[t]; });
        memStatsBadge.textContent = parts.join(' | ');
        memStatsBadge.title = 'Type distribution';
      }
    }
  } catch (e) {
    memoryStats.textContent = '';
  }
}

// ─── Memory Tier Button Listeners ─────────────────────────────────────────
memoryTierBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    memoryTierBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    memoryCurrentTier = btn.dataset.tier;
    refreshMemoryView();
  });
});

// ─── Memory Namespace Change ──────────────────────────────────────────────
memoryNamespaceSelect.addEventListener('change', () => {
  memoryCurrentNamespace = memoryNamespaceSelect.value;
  loadMemoryStore();
});

// ─── Memory Refresh ───────────────────────────────────────────────────────
memoryRefresh.addEventListener('click', refreshMemoryView);

// ─── Memory Clear Current View ────────────────────────────────────────────
memoryClearCurrent?.addEventListener('click', async () => {
  if (!memoryCurrentNamespace) return;
  if (!confirm(`Clear all memory in ${memoryCurrentTier}/${memoryCurrentNamespace}?`)) return;
  try {
    await window.deepconsole.memory.clear(memoryCurrentTier, memoryCurrentNamespace);
    await loadMemoryStore();
    await updateMemoryStats();
  } catch (err) {
    memoryContent.innerHTML = `<div class="result-error">Error: ${err.message}</div>`;
  }
});

// ─── Memory Set ───────────────────────────────────────────────────────────
memorySetBtn.addEventListener('click', async () => {
  const key = memoryKeyInput.value.trim();
  const val = memoryValueInput.value.trim();
  if (!key || !val) return;
  try {
    await window.deepconsole.memory.set(memoryCurrentTier, memoryCurrentNamespace, key, val);
    memoryKeyInput.value = '';
    memoryValueInput.value = '';
    await loadMemoryStore();
    await updateMemoryStats();
  } catch (err) {
    memoryContent.innerHTML = `<div class="result-error">Error: ${err.message}</div>`;
  }
});

// ─── Memory Append ────────────────────────────────────────────────────────
memoryAppendBtn.addEventListener('click', async () => {
  const key = memoryKeyInput.value.trim();
  const val = memoryValueInput.value.trim();
  if (!key || !val) return;
  try {
    await window.deepconsole.memory.append(memoryCurrentTier, memoryCurrentNamespace, key, val);
    memoryKeyInput.value = '';
    memoryValueInput.value = '';
    await loadMemoryStore();
    await updateMemoryStats();
  } catch (err) {
    memoryContent.innerHTML = `<div class="result-error">Error: ${err.message}</div>`;
  }
});

// ─── Memory Delete ────────────────────────────────────────────────────────
memoryDeleteBtn.addEventListener('click', async () => {
  const key = memoryKeyInput.value.trim();
  if (!key) return;
  try {
    await window.deepconsole.memory.delete(memoryCurrentTier, memoryCurrentNamespace, key);
    memoryKeyInput.value = '';
    await loadMemoryStore();
    await updateMemoryStats();
  } catch (err) {
    memoryContent.innerHTML = `<div class="result-error">Error: ${err.message}</div>`;
  }
});

// ─── Memory Search ────────────────────────────────────────────────────────
memorySearchBtn.addEventListener('click', async () => {
  const query = memorySearchInput.value.trim();
  if (!query) return;
  try {
    const result = await window.deepconsole.memory.search(memoryCurrentTier, memoryCurrentNamespace, query);
    const resultsObj = result.results || {};
    const results = Object.entries(resultsObj).map(([k, v]) => ({key: k, value: v}));
    if (results.length === 0) {
      memoryContent.innerHTML = '<div class="console-info">No matches found.</div>';
      return;
    }
    let html = `<div style="color:var(--text-muted);font-size:10px;padding:4px 8px;border-bottom:1px solid rgba(255,255,255,0.05);">
      ${results.length} match(es) for "${query}"
    </div>`;
    for (const r of results) {
      const formatted = formatMemoryValue(r.value);
      html += `<div class="memory-entry"><span class="memory-entry-key">${r.key}</span>: ${formatted}</div>`;
    }
    memoryContent.innerHTML = html;
  } catch (err) {
    memoryContent.innerHTML = `<div class="result-error">Error: ${err.message}</div>`;
  }
});

memorySearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') memorySearchBtn.click();
});

// Keyboard shortcut for Set (Ctrl+Enter)
memoryValueInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.ctrlKey) memorySetBtn.click();
});


// ===== Memory Exploration Feature Handlers =====

// View mode toggle
memViewFlat.addEventListener('click', function() {
  memViewFlat.classList.add('active');
  memViewGrouped.classList.remove('active');
  memoryViewMode = 'flat';
  memExpandAll.style.display = 'none';
  memCollapseAll.style.display = 'none';
  renderMemoryEntries();
});

memViewGrouped.addEventListener('click', function() {
  memViewGrouped.classList.add('active');
  memViewFlat.classList.remove('active');
  memoryViewMode = 'grouped';
  memExpandAll.style.display = '';
  memCollapseAll.style.display = '';
  renderMemoryEntries();
});

// Sort select
memSortSelect.addEventListener('change', function() {
  memorySort = memSortSelect.value;
  renderMemoryEntries();
});

// Type filter buttons
var typeBtns = document.querySelectorAll('.mem-type-btn');
for (var tbi = 0; tbi < typeBtns.length; tbi++) {
  (function(btn) {
    btn.addEventListener('click', function() {
      var type = btn.dataset.type;
      memoryTypeFilter[type] = !memoryTypeFilter[type];
      btn.classList.toggle('active');
      renderMemoryEntries();
    });
  })(typeBtns[tbi]);
}

// Expand/collapse all
memExpandAll.addEventListener('click', function() {
  memoryCollapsedGroups.clear();
  renderMemoryEntries();
});

memCollapseAll.addEventListener('click', function() {
  Object.keys(memoryRawData).forEach(function(k) {
    var prefix = getKeyPrefix(k);
    if (prefix !== '_ungrouped') memoryCollapsedGroups.add(prefix);
  });
  renderMemoryEntries();
});

// Search clear button
memorySearchInput.addEventListener('input', function() {
  memSearchClear.style.display = memorySearchInput.value.trim() ? '' : 'none';
});
memSearchClear.addEventListener('click', function() {
  memorySearchInput.value = '';
  memSearchClear.style.display = 'none';
  loadMemoryStore();
});

// ===== Value Inspector Modal =====

function closeInspector() {
  memInspectorModal.style.display = 'none';
}

// Backdrop click closes
if (memInspectorModal) {
  var backdrops = memInspectorModal.querySelectorAll('.mem-inspector-backdrop');
  for (var bdi = 0; bdi < backdrops.length; bdi++) {
    backdrops[bdi].addEventListener('click', closeInspector);
  }
}
memInspectorClose.addEventListener('click', closeInspector);

// Copy value
memInspectorCopy.addEventListener('click', function() {
  var val = memInspectorValue.textContent;
  try { navigator.clipboard.writeText(val); } catch(e) {}
  memInspectorCopy.textContent = '\u2705';
  setTimeout(function() { memInspectorCopy.textContent = '\ud83d\udccb'; }, 1500);
});

// Edit value
memInspectorEdit.addEventListener('click', async function() {
  var key = memInspectorModal.dataset.memKey;
  var tier = memInspectorModal.dataset.memTier;
  var ns = memInspectorModal.dataset.memNs;
  var currentVal = memInspectorValue.textContent;
  var newVal = prompt('Edit value for ' + key + ':', currentVal);
  if (newVal !== null && newVal !== currentVal) {
    try {
      await window.deepconsole.memory.set(tier, ns, key, newVal);
      closeInspector();
      await loadMemoryStore();
      await updateMemoryStats();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }
});

// Delete key from inspector
memInspectorDelete.addEventListener('click', async function() {
  var key = memInspectorModal.dataset.memKey;
  var tier = memInspectorModal.dataset.memTier;
  var ns = memInspectorModal.dataset.memNs;
  if (!confirm('Delete key "' + key + '" from ' + tier + '/' + ns + '?')) return;
  try {
    await window.deepconsole.memory.delete(tier, ns, key);
    closeInspector();
    memoryKeyInput.value = '';
    await loadMemoryStore();
    await updateMemoryStats();
  } catch (err) {
    alert('Error: ' + err.message);
  }
});

// Keyboard: Escape closes inspector
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && memInspectorModal.style.display !== 'none' && memInspectorModal.style.display !== '') {
    closeInspector();
  }
});

// Memory panel toggle from titlebar
var memToggle = document.getElementById('memory-panel-toggle');
if (memToggle) {
  memToggle.addEventListener('click', function() {
    switchTab('memory');
    refreshMemoryView();
  });
}



// --- Webview Control IPC (main process -> embedded webview) ---

// Listen for commands from main process to control the embedded webview
window.deepconsole._webview.onExecuteJS(function(data) {
  var webview = document.getElementById('browser-webview');
  if (!webview || !webview.executeJavaScript) {
    window.deepconsole._webview.sendResult('webview:executeJSResult', { id: data.id, error: 'webview not available' });
    return;
  }
  // <webview>.executeJavaScript swallows thrown errors at the guest-view IPC
  // boundary — a synchronous throw rejects with the generic "GUEST_VIEW_MANAGER_CALL
  // ... Script failed to execute" string, and the real message/stack stay trapped
  // in the webview's own console. Wrap the code so the error is caught *inside* the
  // page and returned as a value (values marshal back intact). eval() preserves the
  // completion-value semantics callers rely on for return values.
  var wrapped = '(function(){try{return eval(' + JSON.stringify(data.code) + ');}' +
    'catch(e){return{__deepconsoleError:true,name:(e&&e.name)||"Error",' +
    'message:(e&&e.message)||String(e),stack:e&&e.stack};}})()';
  webview.executeJavaScript(wrapped).then(function(result) {
    if (result && result.__deepconsoleError) {
      var msg = result.name + ': ' + result.message;
      if (result.stack) msg += '\n' + result.stack;
      window.deepconsole._webview.sendResult('webview:executeJSResult', { id: data.id, error: msg });
    } else {
      window.deepconsole._webview.sendResult('webview:executeJSResult', { id: data.id, result: result });
    }
  }).catch(function(err) {
    window.deepconsole._webview.sendResult('webview:executeJSResult', { id: data.id, error: err.message });
  });
});

window.deepconsole._webview.onNavigate(function(data) {
  var webview = document.getElementById('browser-webview');
  if (!webview) {
    window.deepconsole._webview.sendResult('webview:navigateResult', { id: data.id, error: 'webview not available' });
    return;
  }
  var urlInput = document.getElementById('browser-url');
  if (urlInput) urlInput.value = data.url;
  webview.src = data.url;
  switchTab('browser');
  window.deepconsole._webview.sendResult('webview:navigateResult', { id: data.id, result: { ok: true } });
});

window.deepconsole._webview.onGetURL(function(data) {
  var webview = document.getElementById('browser-webview');
  if (!webview || !webview.getURL) {
    window.deepconsole._webview.sendResult('webview:getURLResult', { id: data.id, url: 'about:blank' });
    return;
  }
  window.deepconsole._webview.sendResult('webview:getURLResult', { id: data.id, url: webview.getURL() });
});

window.deepconsole._webview.onCapture(function(data) {
  var webview = document.getElementById('browser-webview');
  if (!webview || !webview.capturePage) {
    window.deepconsole._webview.sendResult('webview:captureResult', { id: data.id, error: 'webview not available' });
    return;
  }
  webview.capturePage().then(function(img) {
    window.deepconsole._webview.sendResult('webview:captureResult', { id: data.id, dataURL: img.toDataURL() });
  }).catch(function(err) {
    window.deepconsole._webview.sendResult('webview:captureResult', { id: data.id, error: err.message });
  });
});


(async function boot() {
  if (window.deepconsole.launchAutonomous) {
    // --autonomous (fleet manager): skip the session picker, start a fresh session, auto-enable autonomous.
    const ok = await initSession();
    if (ok) enableAutonomousMode();
    return;   // if the server wasn't ready, the onReady handler retries (initSession + enableAutonomousMode)
  }
  const ok = await resumeOrCreateSession();
  if (!ok) {
    console.log('[DeepConsole] Will retry session creation when server is ready...');
  }
})();



// ═══════════════════════════════════════════════════════════════════════════
// ─── Grimoires Panel ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

// ─── Grimoires State ────────────────────────────────────────────────────────
let grimoiresList = [];
let grimoiresEndowedMap = {};
let grimoiresEditingId = null;

// ─── Grimoires DOM References ───────────────────────────────────────────────
const tabGrimoires = document.getElementById('grimoires-tab');
const viewGrimoires = document.getElementById('grimoires-view');
const grimoiresListEl = document.getElementById('grimoires-list');
const grimoiresRefresh = document.getElementById('grimoires-refresh');
const grimoiresOpenDir = document.getElementById('grimoires-open-dir');
const grimoiresEndowedSection = document.getElementById('grimoires-endowed-section');
const grimoiresEndowedList = document.getElementById('grimoires-endowed-list');

// Grimoire Modal
const grimoireModal = document.getElementById('grimoire-modal');
const grimoireModalTitle = document.getElementById('grimoire-modal-title');
const grimoireModalClose = document.getElementById('grimoire-modal-close');
const grimoireFormId = document.getElementById('grimoire-form-id');
const grimoireFormTitle = document.getElementById('grimoire-form-title');
const grimoireFormChapters = document.getElementById('grimoire-form-chapters');
const grimoireFormSave = document.getElementById('grimoire-form-save');
const grimoireFormCancel = document.getElementById('grimoire-form-cancel');

// ─── Load Grimoires ─────────────────────────────────────────────────────────
async function loadGrimoires() {
  grimoiresListEl.innerHTML = '<div class="grimoires-loading">Loading grimoires...</div>';
  try {
    const grimoires = await window.deepconsole.grimoires.list();
    const endowedResult = await window.deepconsole.grimoires.endowed();
    const endowedList = (endowedResult && !endowedResult.error) ? (endowedResult.grimoires || endowedResult) : [];

    grimoiresEndowedMap = {};
    if (Array.isArray(endowedList)) {
      endowedList.forEach(function(g) {
        var gId = typeof g === 'string' ? g : (g.id || g._id);
        if (gId) grimoiresEndowedMap[gId] = true;
      });
    } else if (typeof endowedList === 'object') {
      Object.keys(endowedList).forEach(function(k) {
        grimoiresEndowedMap[k] = true;
      });
    }

    grimoiresList = Array.isArray(grimoires) ? grimoires : [];
    renderGrimoires();
  } catch (err) {
    grimoiresListEl.innerHTML = '<div class="grimoires-loading">Error: ' + err.message + '</div>';
  }
}

// ─── Render Grimoires ───────────────────────────────────────────────────────
function renderGrimoires() {
  var endowed = [];
  var regular = [];
  for (var i = 0; i < grimoiresList.length; i++) {
    var g = grimoiresList[i];
    var gId = g.id || g._id || g.name || '';
    if (grimoiresEndowedMap[gId] || g.endowed) {
      endowed.push(g);
    } else {
      regular.push(g);
    }
  }

  if (endowed.length > 0) {
    grimoiresEndowedSection.style.display = '';
    grimoiresEndowedList.innerHTML = '';
    for (var ei = 0; ei < endowed.length; ei++) {
      var card = renderGrimoireCard(endowed[ei], true);
      grimoiresEndowedList.appendChild(card);
    }
  } else {
    grimoiresEndowedSection.style.display = 'none';
  }

  grimoiresListEl.innerHTML = '';
  if (regular.length === 0 && endowed.length === 0) {
    grimoiresListEl.innerHTML = '<div class="grimoires-loading">No grimoires yet.</div>';
    var createBtn = document.createElement('button');
    createBtn.className = 'btn btn-primary btn-sm';
    createBtn.textContent = '+ Create Grimoire';
    createBtn.style.margin = '12px auto';
    createBtn.style.display = 'block';
    createBtn.addEventListener('click', function() { openCreateModal(); });
    grimoiresListEl.appendChild(createBtn);
    return;
  }

  for (var ri = 0; ri < regular.length; ri++) {
    var card2 = renderGrimoireCard(regular[ri], false);
    grimoiresListEl.appendChild(card2);
  }

  var createBtn2 = document.createElement('button');
  createBtn2.className = 'btn btn-primary btn-sm';
  createBtn2.textContent = '+ Create Grimoire';
  createBtn2.style.margin = '8px auto';
  createBtn2.style.display = 'block';
  createBtn2.addEventListener('click', function() { openCreateModal(); });
  grimoiresListEl.appendChild(createBtn2);
}

// ─── Render Grimoire Card ───────────────────────────────────────────────────
function renderGrimoireCard(grimoire, isEndowed) {
  var card = document.createElement('div');
  card.className = 'grimoire-card' + (isEndowed ? ' endowed' : '');
  card.dataset.grimoireId = grimoire.id || grimoire._id || grimoire.name || '';

  var gId = grimoire.id || grimoire._id || '';
  var title = grimoire.title || grimoire.name || gId || 'Unnamed';
  var chapters = [];
  if (grimoire.chapters && Array.isArray(grimoire.chapters)) {
    chapters = grimoire.chapters;
  } else if (grimoire.metadata && grimoire.metadata.chapters) {
    try {
      chapters = typeof grimoire.metadata.chapters === 'string'
        ? JSON.parse(grimoire.metadata.chapters)
        : grimoire.metadata.chapters;
    } catch(e) { chapters = []; }
  }
  var chapterCount = chapters.length;

  var endowedBadge = isEndowed
    ? '<span class="grimoire-badge endowed">Endowed</span>'
    : '';

  card.innerHTML = ''
    + '<div class="grimoire-card-icon">\uD83D\uDCD6</div>'
    + '<div class="grimoire-card-info">'
    +   '<div class="grimoire-card-id">' + escapeHtml(gId) + '</div>'
    +   '<div class="grimoire-card-title">' + escapeHtml(title) + '</div>'
    +   '<div class="grimoire-card-meta">'
    +     '<span class="grimoire-card-chapters">' + chapterCount + ' chapter' + (chapterCount !== 1 ? 's' : '') + '</span>'
    +     endowedBadge
    +   '</div>'
    + '</div>'
    + '<div class="grimoire-card-actions">'
    +   '<button class="grimoire-action-btn read">Read</button>'
    +   '<button class="grimoire-action-btn">Edit</button>'
    +   '<button class="grimoire-action-btn delete">Delete</button>'
    +   (isEndowed
        ? '<button class="grimoire-action-btn unequip">Unequip</button>'
        : '<button class="grimoire-action-btn endow">Endow</button>')
    + '</div>';

  var actions = card.querySelectorAll('.grimoire-card-actions .grimoire-action-btn');
  for (var ai = 0; ai < actions.length; ai++) {
    (function(btn, grim) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var text = btn.textContent.trim();
        if (text === 'Read') {
          readGrimoire(grim);
        } else if (text === 'Edit') {
          openEditModal(grim);
        } else if (text === 'Delete') {
          deleteGrimoire(grim);
        } else if (text === 'Endow') {
          endowGrimoire(grim);
        } else if (text === 'Unequip') {
          unequipGrimoire(grim);
        }
      });
    })(actions[ai], grimoire);
  }

  return card;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Read Grimoire ──────────────────────────────────────────────────────────
function readGrimoire(grimoire) {
  var gId = grimoire.id || grimoire._id || '';
  var title = grimoire.title || grimoire.name || gId || 'Unnamed';
  var chapters = [];
  if (grimoire.chapters && Array.isArray(grimoire.chapters)) {
    chapters = grimoire.chapters;
  } else if (grimoire.metadata && grimoire.metadata.chapters) {
    try {
      chapters = typeof grimoire.metadata.chapters === 'string'
        ? JSON.parse(grimoire.metadata.chapters)
        : grimoire.metadata.chapters;
    } catch(e) { chapters = []; }
  }

  var content = '<div style="padding:12px;font-size:12px;line-height:1.6;">';
  content += '<h2 style="color:var(--accent);margin-bottom:8px;">\uD83D\uDCD6 ' + escapeHtml(title) + '</h2>';
  content += '<p style="color:var(--text-muted);margin-bottom:12px;font-family:monospace;font-size:11px;">ID: ' + escapeHtml(gId) + '</p>';

  if (chapters.length === 0) {
    content += '<p style="color:var(--text-muted);font-style:italic;">No chapters.</p>';
  } else {
    for (var ci = 0; ci < chapters.length; ci++) {
      var ch = chapters[ci];
      var heading = ch.heading || ch.title || 'Chapter ' + (ci + 1);
      var chContent = ch.content || ch.text || '(empty)';
      content += '<div style="margin-bottom:12px;padding:8px 10px;background:var(--bg-primary);border-radius:4px;border-left:3px solid var(--accent);">';
      content += '<h3 style="color:var(--text-primary);font-size:12px;font-weight:600;margin-bottom:4px;">' + escapeHtml(heading) + '</h3>';
      content += '<p style="color:var(--text-secondary);font-size:11px;white-space:pre-wrap;">' + escapeHtml(chContent) + '</p>';
      content += '</div>';
    }
  }
  content += '</div>';

  var readDiv = document.createElement('div');
  readDiv.className = 'mem-inspector-modal';
  readDiv.style.display = 'flex';
  readDiv.innerHTML = ''
    + '<div class="mem-inspector-backdrop"></div>'
    + '<div class="mem-inspector-dialog" style="width:600px;max-height:80vh;">'
    +   '<div class="mem-inspector-header">'
    +     '<span class="mem-inspector-key">\uD83D\uDCD6 ' + escapeHtml(title) + '</span>'
    +     '<div class="mem-inspector-actions">'
    +       '<button class="toolbar-btn grimoire-read-close">\u2715</button>'
    +     '</div>'
    +   '</div>'
    +   '<div class="mem-inspector-body" style="max-height:65vh;overflow-y:auto;">'
    +     content
    +   '</div>'
    + '</div>';

  document.body.appendChild(readDiv);

  var closeBtn = readDiv.querySelector('.grimoire-read-close');
  closeBtn.addEventListener('click', function() { readDiv.remove(); });
  readDiv.querySelector('.mem-inspector-backdrop').addEventListener('click', function() { readDiv.remove(); });
}

// ─── Create/Edit Modal ──────────────────────────────────────────────────────
function openCreateModal() {
  grimoiresEditingId = null;
  grimoireModalTitle.textContent = 'Create Grimoire';
  grimoireFormId.value = '';
  grimoireFormId.disabled = false;
  grimoireFormTitle.value = '';
  grimoireFormChapters.value = '[\n  {"heading": "Introduction", "content": "..."},\n  {"heading": "Usage", "content": "..."}\n]';
  grimoireModal.style.display = 'flex';
  grimoireFormId.focus();
}

function openEditModal(grimoire) {
  var gId = grimoire.id || grimoire._id || '';
  grimoiresEditingId = gId;
  grimoireModalTitle.textContent = 'Edit Grimoire: ' + escapeHtml(gId);
  grimoireFormId.value = gId;
  grimoireFormId.disabled = true;
  grimoireFormTitle.value = grimoire.title || grimoire.name || '';

  var chapters = [];
  if (grimoire.chapters && Array.isArray(grimoire.chapters)) {
    chapters = grimoire.chapters;
  } else if (grimoire.metadata && grimoire.metadata.chapters) {
    try {
      chapters = typeof grimoire.metadata.chapters === 'string'
        ? JSON.parse(grimoire.metadata.chapters)
        : grimoire.metadata.chapters;
    } catch(e) { chapters = []; }
  }
  grimoireFormChapters.value = JSON.stringify(chapters, null, 2);

  grimoireModal.style.display = 'flex';
}

function closeCreateModal() {
  grimoireModal.style.display = 'none';
  grimoiresEditingId = null;
}

// ─── Save Grimoire ──────────────────────────────────────────────────────────
async function saveGrimoire() {
  var id = grimoireFormId.value.trim();
  var title = grimoireFormTitle.value.trim();
  var chaptersRaw = grimoireFormChapters.value.trim();

  if (!id) { alert('ID is required.'); grimoireFormId.focus(); return; }
  if (!title) { alert('Title is required.'); grimoireFormTitle.focus(); return; }

  var chapters = [];
  try {
    chapters = JSON.parse(chaptersRaw);
    if (!Array.isArray(chapters)) throw new Error('Must be an array');
  } catch (e) {
    alert('Chapters must be valid JSON array of {heading, content} objects.\nError: ' + e.message);
    grimoireFormChapters.focus();
    return;
  }

  try {
    if (grimoiresEditingId) {
      await window.deepconsole.grimoires.update(id, title, chapters);
    } else {
      await window.deepconsole.grimoires.create(id, title, chapters);
    }
    closeCreateModal();
    await loadGrimoires();
  } catch (err) {
    alert('Failed to save grimoire: ' + err.message);
  }
}

// ─── Delete Grimoire ────────────────────────────────────────────────────────
async function deleteGrimoire(grimoire) {
  var gId = grimoire.id || grimoire._id || '';
  var title = grimoire.title || grimoire.name || gId;
  if (!confirm('Delete grimoire "' + title + '" (' + gId + ')?')) return;

  try {
    await window.deepconsole.grimoires.delete(gId);
    await loadGrimoires();
  } catch (err) {
    alert('Failed to delete grimoire: ' + err.message);
  }
}

// ─── Endow Grimoire ─────────────────────────────────────────────────────────
async function endowGrimoire(grimoire) {
  var gId = grimoire.id || grimoire._id || '';
  var title = grimoire.title || grimoire.name || gId;

  var agentId = prompt('Endow "' + title + '" to which agent ID?', 'product-maestro');
  if (!agentId || !agentId.trim()) return;

  try {
    var result = await window.deepconsole.grimoires.endow(gId);
    if (result && result.error) {
      alert('Failed to endow: ' + result.error);
    } else {
      await loadGrimoires();
    }
  } catch (err) {
    alert('Failed to endow grimoire: ' + err.message);
  }
}

// ─── Unequip Grimoire ───────────────────────────────────────────────────────
async function unequipGrimoire(grimoire) {
  var gId = grimoire.id || grimoire._id || '';
  var title = grimoire.title || grimoire.name || gId;

  var agentId = prompt('Unequip "' + title + '" from which agent ID?', 'product-maestro');
  if (!agentId || !agentId.trim()) return;

  try {
    var result = await window.deepconsole.grimoires.unequip(gId);
    if (result && result.error) {
      alert('Failed to unequip: ' + result.error);
    } else {
      await loadGrimoires();
    }
  } catch (err) {
    alert('Failed to unequip grimoire: ' + err.message);
  }
}

// ─── Refresh Grimoires ──────────────────────────────────────────────────────
function refreshGrimoires() {
  loadGrimoires();
}

// ─── Open Grimoires Directory ───────────────────────────────────────────────
async function openGrimoiresDir() {
  try {
    await window.deepconsole.grimoires.list();
    refreshGrimoires();
  } catch (err) {
    console.error('Failed to open grimoires dir:', err);
  }
}

// ─── Wire Up Event Listeners ───────────────────────────────────────────────

// Extend switchTab to include grimoires
(function() {
  window.switchTab = function(tab) {
    var tabs = [tabBrowser, tabConsole, tabJS, tabAgents, tabMemory, tabGrimoires];
    var views = [viewBrowser, viewConsole, viewJS, viewAgents, viewMemory, viewGrimoires];
    tabs.forEach(function(t) { t.classList.remove('active'); });
    views.forEach(function(v) { v.classList.remove('active'); });

    if (tab === 'browser') { tabBrowser.classList.add('active'); viewBrowser.classList.add('active'); }
    else if (tab === 'console') { tabConsole.classList.add('active'); viewConsole.classList.add('active'); }
    else if (tab === 'js') { tabJS.classList.add('active'); viewJS.classList.add('active'); }
    else if (tab === 'agents') { tabAgents.classList.add('active'); viewAgents.classList.add('active'); loadAgents(); }
    else if (tab === 'memory') { tabMemory.classList.add('active'); viewMemory.classList.add('active'); refreshMemoryView(); }
    else if (tab === 'grimoires') { tabGrimoires.classList.add('active'); viewGrimoires.classList.add('active'); loadGrimoires(); }
  };
})();

// Grimoires tab click
tabGrimoires.addEventListener('click', function() {
  switchTab('grimoires');
});

// Grimoires refresh
grimoiresRefresh.addEventListener('click', refreshGrimoires);

// Grimoires open dir
grimoiresOpenDir.addEventListener('click', openGrimoiresDir);

// Modal close
grimoireModalClose.addEventListener('click', closeCreateModal);
grimoireFormCancel.addEventListener('click', closeCreateModal);

// Backdrop click closes modal
var grimoireBackdrop = grimoireModal.querySelector('.grimoire-modal-backdrop');
if (grimoireBackdrop) {
  grimoireBackdrop.addEventListener('click', closeCreateModal);
}

// Save button
grimoireFormSave.addEventListener('click', saveGrimoire);

// Keyboard: Enter in ID/Title fields
grimoireFormId.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') grimoireFormTitle.focus();
});
grimoireFormTitle.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') grimoireFormChapters.focus();
});

// Keyboard: Escape closes modal
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && grimoireModal.style.display !== 'none' && grimoireModal.style.display !== '') {
    closeCreateModal();
  }
});

// ─── Export Functions (for debugging / console access) ─────────────────────
window._grimoires = {
  loadGrimoires: loadGrimoires,
  renderGrimoireCard: renderGrimoireCard,
  openCreateModal: openCreateModal,
  closeCreateModal: closeCreateModal,
  saveGrimoire: saveGrimoire,
  deleteGrimoire: deleteGrimoire,
  endowGrimoire: endowGrimoire,
  unequipGrimoire: unequipGrimoire,
  refreshGrimoires: refreshGrimoires
};

// ═══════════════════════════════════════════════════════════════════════════
// ─── Brain Worms Panel ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

// ─── DOM References ─────────────────────────────────────────────────────────
const tabBrainWorms = document.getElementById('brainworms-tab');
const viewBrainWorms = document.getElementById('brainworms-view');
const brainwormsList = document.getElementById('brainworms-list');
const brainwormsRefresh = document.getElementById('brainworms-refresh');
const brainwormsBurrowBtn = document.getElementById('brainworms-burrow-btn');
const brainwormsClear = document.getElementById('brainworms-clear');
const brainwormsStatusText = document.getElementById('brainworms-status-text');
const brainwormsCount = document.getElementById('brainworms-count');
const brainwormsFilter = document.getElementById('brainworms-filter');
const brainwormsConfigureAll = document.getElementById('brainworms-configure-all');

// ─── State ──────────────────────────────────────────────────────────────────
let brainwormsAllSightings = [];
let brainwormsStreamActive = false;

// ─── Extend switchTab for brain worms ───────────────────────────────────────
(function() {
  var origSwitch = window.switchTab;
  window.switchTab = function(tab) {
    var tabs = [tabBrowser, tabConsole, tabJS, tabAgents, tabMemory, tabGrimoires, tabBrainWorms];
    var views = [viewBrowser, viewConsole, viewJS, viewAgents, viewMemory, viewGrimoires, viewBrainWorms];
    tabs.forEach(function(t) { t.classList.remove('active'); });
    views.forEach(function(v) { v.classList.remove('active'); });

    if (tab === 'browser') { tabBrowser.classList.add('active'); viewBrowser.classList.add('active'); }
    else if (tab === 'console') { tabConsole.classList.add('active'); viewConsole.classList.add('active'); }
    else if (tab === 'js') { tabJS.classList.add('active'); viewJS.classList.add('active'); }
    else if (tab === 'agents') { tabAgents.classList.add('active'); viewAgents.classList.add('active'); loadAgents(); }
    else if (tab === 'memory') { tabMemory.classList.add('active'); viewMemory.classList.add('active'); refreshMemoryView(); }
    else if (tab === 'grimoires') { tabGrimoires.classList.add('active'); viewGrimoires.classList.add('active'); loadGrimoires(); }
    else if (tab === 'brainworms') { tabBrainWorms.classList.add('active'); viewBrainWorms.classList.add('active'); loadBrainWorms(); }
  };
})();

// ─── Tab Click ──────────────────────────────────────────────────────────────
tabBrainWorms.addEventListener('click', function() {
  switchTab('brainworms');
});

// ─── Load Brain Worms ───────────────────────────────────────────────────────
async function loadBrainWorms() {
  brainwormsList.innerHTML = '<div class="console-info">Loading brain worms...</div>';
  await loadBrainWormStatus();
  await loadBrainWormSightings();
  startBrainWormStream();
}

// ─── Load Status ────────────────────────────────────────────────────────────
async function loadBrainWormStatus() {
  try {
    const status = await window.deepconsole.brainworms.status();
    if (status && !status.error) {
      var parts = [];
      if (status.scheduler_running) {
        parts.push('🟢 Scheduler active');
      } else {
        parts.push('🔴 Scheduler stopped');
      }
      parts.push(status.total_sightings + ' sighting(s)');
      brainwormsStatusText.textContent = parts.join(' · ');

      // Update toggle states
      if (status.worms) {
        for (const [name, info] of Object.entries(status.worms)) {
          var toggle = document.getElementById('worm-toggle-' + name);
          var intervalEl = document.getElementById('worm-interval-' + name);
          if (toggle) toggle.checked = info.enabled;
          if (intervalEl) {
            var mins = Math.round(info.interval_seconds / 60);
            intervalEl.textContent = mins + 'm';
          }
        }
      }
    } else {
      brainwormsStatusText.textContent = '⚠️ Could not load worm status';
    }
  } catch (err) {
    brainwormsStatusText.textContent = '⚠️ Error: ' + err.message;
  }
}

// ─── Load Sightings ─────────────────────────────────────────────────────────
async function loadBrainWormSightings() {
  try {
    var filterVal = brainwormsFilter ? brainwormsFilter.value : 'all';
    var wormParam = filterVal === 'all' ? null : filterVal;
    var result = await window.deepconsole.brainworms.sightings(100, wormParam);
    if (result && !result.error) {
      brainwormsAllSightings = result.sightings || [];
    } else {
      brainwormsAllSightings = [];
    }
  } catch (err) {
    brainwormsAllSightings = [];
  }
  renderBrainWormSightings();
}

// ─── Render Sightings ───────────────────────────────────────────────────────
function renderBrainWormSightings() {
  var sightings = brainwormsAllSightings;
  if (!sightings || sightings.length === 0) {
    brainwormsList.innerHTML = '<div class="console-info">No brain worm sightings yet. Worms are burrowing through memory every minute or so — check back soon or click 🕳️ to trigger a manual burrow.</div>';
    brainwormsCount.textContent = '0 sightings';
    return;
  }

  brainwormsCount.textContent = sightings.length + ' sighting(s)';

  var html = '';
  for (var i = sightings.length - 1; i >= 0; i--) {
    var s = sightings[i];
    var wormIcons = { reminder: '🔔', pattern: '🔁', meta: '🔍', system: '🐛' };
    var icon = wormIcons[s.worm] || '🐛';
    var severityColors = { info: 'var(--text-secondary)', warning: 'var(--warning)', size: 'var(--accent)', pattern: '#74b9ff' };
    var color = severityColors[s.severity] || 'var(--text-secondary)';
    var ts = (s.timestamp || '').slice(11, 19); // HH:MM:SS
    var preview = s.preview || '(no preview)';
    var detail = s.detail || '';

    html += '<div class="brainworm-sighting" style="border-left:3px solid ' + color + ';">';
    html += '<div class="brainworm-sighting-header">';
    html += '<span class="brainworm-sighting-icon">' + icon + '</span>';
    html += '<span class="brainworm-sighting-worm">' + s.worm + '</span>';
    html += '<span class="brainworm-sighting-time">' + ts + '</span>';
    html += '<span class="brainworm-sighting-tier" style="color:var(--text-muted);font-size:9px;">' + (s.tier || '') + '/' + (s.namespace || '') + '</span>';
    html += '</div>';
    html += '<div class="brainworm-sighting-preview">' + escapeHtml(preview) + '</div>';
    if (detail) {
      html += '<div class="brainworm-sighting-detail" style="font-size:10px;color:var(--text-muted);margin-top:2px;">' + escapeHtml(detail) + '</div>';
    }
    html += '</div>';
  }

  brainwormsList.innerHTML = html;
}

// ─── SSE Stream for Real-time Sightings ─────────────────────────────────────
function startBrainWormStream() {
  if (brainwormsStreamActive) return;

  try {
    // Use the IPC event channel if available (preloaded event-based approach)
    var cleanup = window.deepconsole.brainworms.onSighting(function(data) {
      // data is { event: 'sighting', data: {...} }
      var sighting = data.data || data;
      // Add to front of list
      brainwormsAllSightings.unshift(sighting);
      // Keep at reasonable size
      if (brainwormsAllSightings.length > 500) brainwormsAllSightings.length = 500;

      // Re-render if we're on the brain worms tab
      if (viewBrainWorms && viewBrainWorms.classList.contains('active')) {
        renderBrainWormSightings();
        // Update status count
        brainwormsCount.textContent = brainwormsAllSightings.length + ' sighting(s)';
      } else {
        // Flash the tab
        tabBrainWorms.style.color = 'var(--warning)';
        setTimeout(function() {
          tabBrainWorms.style.color = '';
        }, 2000);
      }
    });

    brainwormsStreamActive = true;
    // Store cleanup function for later
    window._brainwormsCleanup = cleanup;
  } catch (err) {
    console.warn('Brain worm SSE stream not available:', err.message);
  }
}

// ─── Manual Burrow ──────────────────────────────────────────────────────────
async function triggerBrainWormBurrow() {
  brainwormsBurrowBtn.disabled = true;
  brainwormsBurrowBtn.textContent = '🕳️ Burrowing...';
  try {
    var result = await window.deepconsole.brainworms.burrow(null);
    if (result && result.ok) {
      // Sightings will arrive via SSE
      brainwormsList.innerHTML = '<div class="console-info">🐛 Worms burrowing... sightings arriving shortly via live stream.</div>';
    } else if (result && result.error) {
      brainwormsList.innerHTML = '<div class="result-error">Error: ' + result.error + '</div>';
    }
  } catch (err) {
    brainwormsList.innerHTML = '<div class="result-error">Error: ' + err.message + '</div>';
  }
  setTimeout(function() {
    brainwormsBurrowBtn.disabled = false;
    brainwormsBurrowBtn.textContent = '🕳️';
  }, 2000);
}

// ─── Clear Sightings ────────────────────────────────────────────────────────
async function clearBrainWormSightings() {
  if (!confirm('Clear all brain worm sightings?')) return;
  try {
    await window.deepconsole.brainworms.clear();
    brainwormsAllSightings = [];
    renderBrainWormSightings();
  } catch (err) {
    brainwormsList.innerHTML = '<div class="result-error">Error: ' + err.message + '</div>';
  }
}

// ─── Apply Config ───────────────────────────────────────────────────────────
async function applyBrainWormConfig() {
  var worms = ['reminder', 'pattern', 'meta'];
  for (var i = 0; i < worms.length; i++) {
    var name = worms[i];
    var toggle = document.getElementById('worm-toggle-' + name);
    if (!toggle) continue;
    var enabled = toggle.checked;
    try {
      await window.deepconsole.brainworms.configure(name, enabled, null);
    } catch (err) {
      console.warn('Failed to configure worm ' + name + ':', err);
    }
  }
  await loadBrainWormStatus();
  brainwormsStatusText.textContent = '✅ Config applied';
  setTimeout(function() {
    loadBrainWormStatus();
  }, 1000);
}

// ─── Event Listeners ────────────────────────────────────────────────────────
brainwormsRefresh.addEventListener('click', function() {
  loadBrainWormSightings();
});

brainwormsBurrowBtn.addEventListener('click', triggerBrainWormBurrow);

brainwormsClear.addEventListener('click', clearBrainWormSightings);

brainwormsFilter.addEventListener('change', function() {
  loadBrainWormSightings();
});

brainwormsConfigureAll.addEventListener('click', applyBrainWormConfig);

// ─── Export Functions ──────────────────────────────────────────────────────
window._brainworms = {
  load: loadBrainWorms,
  refresh: loadBrainWormSightings,
  burrow: triggerBrainWormBurrow,
  clear: clearBrainWormSightings,
};




// ═══════════════════════════════════════════════════════════════════════════
// ─── Git Workflow Panel ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

// ─── DOM References ─────────────────────────────────────────────────────────
const tabGitWorkflow = document.getElementById('gitworkflow-tab');
const viewGitWorkflow = document.getElementById('gitworkflow-view');
const gitwfStatusText = document.getElementById('gitwf-status-text');
const gitwfRefresh = document.getElementById('gitwf-refresh');
const gitwfDetails = document.getElementById('gitwf-details');
const gitwfStartBtn = document.getElementById('gitwf-start-btn');
const gitwfSubmitBtn = document.getElementById('gitwf-submit-btn');
const gitwfMergeBtn = document.getElementById('gitwf-merge-btn');
const gitwfAbortBtn = document.getElementById('gitwf-abort-btn');

// ─── Extend switchTab for git workflow ───────────────────────────────────────
(function() {
  var origSwitch = window.switchTab;
  window.switchTab = function(tab) {
    var tabs = [tabBrowser, tabConsole, tabJS, tabAgents, tabMemory, tabGrimoires, tabBrainWorms, tabGitWorkflow];
    var views = [viewBrowser, viewConsole, viewJS, viewAgents, viewMemory, viewGrimoires, viewBrainWorms, viewGitWorkflow];
    tabs.forEach(function(t) { t.classList.remove('active'); });
    views.forEach(function(v) { v.classList.remove('active'); });

    if (tab === 'browser') { tabBrowser.classList.add('active'); viewBrowser.classList.add('active'); }
    else if (tab === 'console') { tabConsole.classList.add('active'); viewConsole.classList.add('active'); }
    else if (tab === 'js') { tabJS.classList.add('active'); viewJS.classList.add('active'); }
    else if (tab === 'agents') { tabAgents.classList.add('active'); viewAgents.classList.add('active'); loadAgents(); }
    else if (tab === 'memory') { tabMemory.classList.add('active'); viewMemory.classList.add('active'); refreshMemoryView(); }
    else if (tab === 'grimoires') { tabGrimoires.classList.add('active'); viewGrimoires.classList.add('active'); loadGrimoires(); }
    else if (tab === 'brainworms') { tabBrainWorms.classList.add('active'); viewBrainWorms.classList.add('active'); loadBrainWorms(); }
    else if (tab === 'gitworkflow') { tabGitWorkflow.classList.add('active'); viewGitWorkflow.classList.add('active'); loadGitWorkflowStatus(); }
  };
})();

// ─── Tab Click ──────────────────────────────────────────────────────────────
tabGitWorkflow.addEventListener('click', function() {
  switchTab('gitworkflow');
});

// ─── Load Workflow Status ───────────────────────────────────────────────────
async function loadGitWorkflowStatus() {
  gitwfStatusText.textContent = 'Loading workflow status...';
  gitwfDetails.innerHTML = '<div class="console-info">Loading...</div>';

  try {
    const status = await window.deepconsole.gitWorkflow.status();
    if (status && !status.error) {
      renderGitWorkflowStatus(status);
    } else if (status && status.error) {
      gitwfStatusText.textContent = '⚠️ ' + status.error;
      gitwfDetails.innerHTML = '<div class="result-error">Error: ' + status.error + '</div>';
    } else {
      gitwfStatusText.textContent = '⚠️ Could not reach Git Workflow API';
      gitwfDetails.innerHTML = '<div class="console-info">The Git Workflow backend may not be available. Check that the server is running.</div>';
    }
  } catch (err) {
    gitwfStatusText.textContent = '⚠️ Error: ' + err.message;
    gitwfDetails.innerHTML = '<div class="result-error">Error: ' + err.message + '</div>';
  }
}

// ─── Render Workflow Status ─────────────────────────────────────────────────
function renderGitWorkflowStatus(status) {
  var active = status.active || status.is_in_workflow;
  var branch = status.current_branch || status.branch || 'unknown';
  var isWorkflow = status.is_in_workflow;
  var task = status.task || '(none)';
  var files = status.files_changed || [];
  var reviewStatus = status.review_status || 'none';
  var started = status.started_at || '';

  // Status bar
  var indicator = active ? '🟢' : '⚪';
  var statusText = active ? 'Active workflow on ' + branch : 'On branch: ' + branch;
  gitwfStatusText.textContent = indicator + ' ' + statusText;

  // Details panel
  var html = '<div style="padding:8px;">';

  // Branch info
  html += '<div class="memory-entry">';
  html += '<span class="memory-entry-key">Current Branch</span>: <code>' + escapeHtml(branch) + '</code>';
  html += '</div>';

  html += '<div class="memory-entry">';
  html += '<span class="memory-entry-key">In Workflow</span>: ' + (isWorkflow ? '✅ Yes' : '❌ No');
  html += '</div>';

  if (task) {
    html += '<div class="memory-entry">';
    html += '<span class="memory-entry-key">Task</span>: ' + escapeHtml(task);
    html += '</div>';
  }

  if (started) {
    html += '<div class="memory-entry">';
    html += '<span class="memory-entry-key">Started</span>: ' + escapeHtml(started);
    html += '</div>';
  }

  // Files changed
  if (files.length > 0) {
    html += '<div class="memory-entry">';
    html += '<span class="memory-entry-key">Files Changed</span>:';
    html += '<ul style="margin:4px 0 0 16px;font-size:11px;">';
    for (var fi = 0; fi < files.length; fi++) {
      html += '<li><code>' + escapeHtml(files[fi]) + '</code></li>';
    }
    html += '</ul></div>';
  }

  // Review status
  var reviewColors = {
    none: 'var(--text-muted)',
    pending: 'var(--warning)',
    approved: 'var(--success)',
    changes_requested: 'var(--error)',
  };
  var reviewLabels = {
    none: 'Not reviewed',
    pending: '⏳ Pending review',
    approved: '✅ Approved',
    changes_requested: '🔴 Changes requested',
  };

  html += '<div class="memory-entry" style="border-left:3px solid ' + (reviewColors[reviewStatus] || 'var(--text-muted)') + ';padding-left:8px;">';
  html += '<span class="memory-entry-key">Review Status</span>: <strong>' + (reviewLabels[reviewStatus] || reviewStatus) + '</strong>';
  html += '</div>';

  // Instructions
  if (!isWorkflow) {
    html += '<div style="margin-top:12px;padding:8px;background:var(--bg-primary);border-radius:4px;border-left:3px solid var(--accent);font-size:11px;">';
    html += '<strong>To start a workflow:</strong><br>';
    html += '1. Click "Start Workflow" above<br>';
    html += '2. The AI will create a feature branch<br>';
    html += '3. Make your code changes<br>';
    html += '4. Submit for ClaudePlus review<br>';
    html += '5. Merge when approved</div>';
  } else if (reviewStatus === 'approved') {
    html += '<div style="margin-top:12px;padding:8px;background:var(--bg-primary);border-radius:4px;border-left:3px solid var(--success);font-size:11px;">';
    html += '✅ <strong>Review approved!</strong> Click "Merge" to finalize, or "Abort" to discard.</div>';
  } else if (reviewStatus === 'changes_requested') {
    html += '<div style="margin-top:12px;padding:8px;background:var(--bg-primary);border-radius:4px;border-left:3px solid var(--error);font-size:11px;">';
    html += '🔴 <strong>Changes requested.</strong> Make fixes and submit again via the chat.</div>';
  } else if (reviewStatus === 'pending') {
    html += '<div style="margin-top:12px;padding:8px;background:var(--bg-primary);border-radius:4px;border-left:3px solid var(--warning);font-size:11px;">';
    html += '⏳ <strong>Review in progress...</strong> The AI is waiting for ClaudePlus response. Check back soon.</div>';
  }

  html += '</div>';
  gitwfDetails.innerHTML = html;
}

// ─── Start Workflow ─────────────────────────────────────────────────────────
async function startGitWorkflow() {
  var task = prompt('Describe the task for this workflow branch:', '');
  if (!task || !task.trim()) return;

  gitwfStatusText.textContent = '🔨 Creating branch...';
  gitwfStartBtn.disabled = true;

  try {
    var result = await window.deepconsole.gitWorkflow.start(task.trim());
    if (result && !result.error) {
      gitwfStatusText.textContent = '✅ Branch created: ' + (result.branch || '?');
      await loadGitWorkflowStatus();
    } else if (result && result.message) {
      gitwfStatusText.textContent = '⚠️ ' + result.message;
      await loadGitWorkflowStatus();
    } else {
      gitwfStatusText.textContent = '⚠️ ' + (result.error || 'Unknown error');
    }
  } catch (err) {
    gitwfStatusText.textContent = '⚠️ Error: ' + err.message;
    gitwfDetails.innerHTML = '<div class="result-error">Error: ' + err.message + '</div>';
  }

  gitwfStartBtn.disabled = false;
}

// ─── Submit for Review ──────────────────────────────────────────────────────
async function submitGitWorkflow() {
  var files = prompt('List files changed (comma-separated):', '');
  if (!files || !files.trim()) return;

  var message = prompt('Commit message / description:', '');
  if (!message || !message.trim()) return;

  var fileList = files.split(',').map(function(f) { return f.trim(); }).filter(function(f) { return f; });

  gitwfStatusText.textContent = '📤 Submitting for ClaudePlus review...';
  gitwfSubmitBtn.disabled = true;

  try {
    var result = await window.deepconsole.gitWorkflow.submit(fileList, message.trim());
    if (result && !result.error) {
      var reviewStatus = result.review_status || 'unknown';
      var reviewText = result.review_text || '(no review text)';

      if (reviewStatus === 'approved') {
        gitwfStatusText.textContent = '✅ ClaudePlus APPROVED! Merge when ready.';
        gitwfDetails.innerHTML = '<div style="padding:8px;">'
          + '<div style="padding:8px;background:rgba(0,200,83,0.1);border-left:3px solid var(--success);border-radius:4px;margin-bottom:8px;">'
          + '<strong style="color:var(--success);">✅ ClaudePlus Approved</strong>'
          + '</div>'
          + '<pre style="font-size:11px;white-space:pre-wrap;background:var(--bg-primary);padding:8px;border-radius:4px;max-height:200px;overflow-y:auto;">' + escapeHtml(reviewText) + '</pre>'
          + '<div style="margin-top:8px;font-size:11px;color:var(--text-muted);">Click "Merge" to finalize.</div>'
          + '</div>';
      } else if (reviewStatus === 'changes_requested') {
        gitwfStatusText.textContent = '🔴 ClaudePlus requests changes';
        gitwfDetails.innerHTML = '<div style="padding:8px;">'
          + '<div style="padding:8px;background:rgba(255,82,82,0.1);border-left:3px solid var(--error);border-radius:4px;margin-bottom:8px;">'
          + '<strong style="color:var(--error);">🔴 Changes Requested</strong>'
          + '</div>'
          + '<pre style="font-size:11px;white-space:pre-wrap;background:var(--bg-primary);padding:8px;border-radius:4px;max-height:200px;overflow-y:auto;">' + escapeHtml(reviewText) + '</pre>'
          + '<div style="margin-top:8px;font-size:11px;color:var(--text-muted);">Fix the issues in chat, then submit again.</div>'
          + '</div>';
      } else {
        gitwfStatusText.textContent = '⚠️ Review result: ' + reviewStatus;
        gitwfDetails.innerHTML = '<div style="padding:8px;">'
          + '<pre style="font-size:11px;white-space:pre-wrap;background:var(--bg-primary);padding:8px;border-radius:4px;">' + escapeHtml(reviewText) + '</pre>'
          + '</div>';
      }
    } else {
      gitwfStatusText.textContent = '⚠️ ' + (result.error || 'Submit failed');
    }
  } catch (err) {
    gitwfStatusText.textContent = '⚠️ Error: ' + err.message;
    gitwfDetails.innerHTML = '<div class="result-error">Error: ' + err.message + '</div>';
  }

  gitwfSubmitBtn.disabled = false;
}

// ─── Merge Branch ───────────────────────────────────────────────────────────
async function mergeGitWorkflow() {
  if (!confirm('Merge the current feature branch into main? This finalizes the changes.')) return;

  gitwfStatusText.textContent = '🔄 Merging...';
  gitwfMergeBtn.disabled = true;

  try {
    var result = await window.deepconsole.gitWorkflow.merge();
    if (result && !result.error) {
      gitwfStatusText.textContent = '✅ Merged!';
      gitwfDetails.innerHTML = '<div style="padding:8px;">'
        + '<div style="padding:8px;background:rgba(0,200,83,0.1);border-left:3px solid var(--success);border-radius:4px;">'
        + '<strong style="color:var(--success);">✅ ' + escapeHtml(result.message || 'Merged successfully') + '</strong>'
        + '</div></div>';
    } else {
      gitwfStatusText.textContent = '⚠️ ' + (result.error || 'Merge failed');
    }
  } catch (err) {
    gitwfStatusText.textContent = '⚠️ Error: ' + err.message;
  }

  gitwfMergeBtn.disabled = false;
}

// ─── Abort Workflow ─────────────────────────────────────────────────────────
async function abortGitWorkflow() {
  if (!confirm('ABORT the current workflow? ALL changes on this branch will be LOST. Are you sure?')) return;
  if (!confirm('Really abort? This discards every change on this branch.')) return;

  gitwfStatusText.textContent = '🗑️ Aborting...';
  gitwfAbortBtn.disabled = true;

  try {
    var result = await window.deepconsole.gitWorkflow.abort();
    if (result && !result.error) {
      gitwfStatusText.textContent = '🗑️ Abandoned: ' + (result.branch || 'branch');
      gitwfDetails.innerHTML = '<div style="padding:8px;">'
        + '<div style="padding:8px;background:rgba(255,165,0,0.1);border-left:3px solid orange;border-radius:4px;">'
        + '<strong style="color:orange;">🗑️ ' + escapeHtml(result.message || 'Branch abandoned') + '</strong>'
        + '</div></div>';
    } else {
      gitwfStatusText.textContent = '⚠️ ' + (result.error || 'Abort failed');
    }
  } catch (err) {
    gitwfStatusText.textContent = '⚠️ Error: ' + err.message;
  }

  gitwfAbortBtn.disabled = false;
}

// ─── Event Listeners ────────────────────────────────────────────────────────
gitwfRefresh.addEventListener('click', loadGitWorkflowStatus);
gitwfStartBtn.addEventListener('click', startGitWorkflow);
gitwfSubmitBtn.addEventListener('click', submitGitWorkflow);
gitwfMergeBtn.addEventListener('click', mergeGitWorkflow);
gitwfAbortBtn.addEventListener('click', abortGitWorkflow);

// ─── Export Functions ──────────────────────────────────────────────────────
window._gitworkflow = {
  load: loadGitWorkflowStatus,
  start: startGitWorkflow,
  submit: submitGitWorkflow,
  merge: mergeGitWorkflow,
  abort: abortGitWorkflow,
};

// ─── Overmind panel ──────────────────────────────────────────────────────────
const tabOvermind = document.getElementById('overmind-tab');
const viewOvermind = document.getElementById('overmind-view');
const overmindRoster = document.getElementById('overmind-roster');
const overmindBoard = document.getElementById('overmind-board');
const overmindAsks = document.getElementById('overmind-asks');
const overmindSelf = document.getElementById('overmind-self');
let myArmId = null;

// Extend switchTab to include overmind
(function() {
  var origSwitch = window.switchTab;
  window.switchTab = function(tab) {
    var tabs = [tabBrowser, tabConsole, tabJS, tabAgents, tabMemory, tabGrimoires, tabBrainWorms, tabGitWorkflow, tabOvermind];
    var views = [viewBrowser, viewConsole, viewJS, viewAgents, viewMemory, viewGrimoires, viewBrainWorms, viewGitWorkflow, viewOvermind];
    tabs.forEach(function(t) { t.classList.remove('active'); });
    views.forEach(function(v) { v.classList.remove('active'); });

    if (tab === 'browser') { tabBrowser.classList.add('active'); viewBrowser.classList.add('active'); }
    else if (tab === 'console') { tabConsole.classList.add('active'); viewConsole.classList.add('active'); }
    else if (tab === 'js') { tabJS.classList.add('active'); viewJS.classList.add('active'); }
    else if (tab === 'agents') { tabAgents.classList.add('active'); viewAgents.classList.add('active'); loadAgents(); }
    else if (tab === 'memory') { tabMemory.classList.add('active'); viewMemory.classList.add('active'); refreshMemoryView(); }
    else if (tab === 'grimoires') { tabGrimoires.classList.add('active'); viewGrimoires.classList.add('active'); loadGrimoires(); }
    else if (tab === 'brainworms') { tabBrainWorms.classList.add('active'); viewBrainWorms.classList.add('active'); loadBrainWorms(); }
    else if (tab === 'gitworkflow') { tabGitWorkflow.classList.add('active'); viewGitWorkflow.classList.add('active'); loadGitWorkflowStatus(); }
    else if (tab === 'overmind') { tabOvermind.classList.add('active'); viewOvermind.classList.add('active'); refreshOvermind(); }
  };
})();

tabOvermind.addEventListener('click', function() { switchTab('overmind'); });

async function refreshOvermind() {
  if (!myArmId) {
    const me = await window.deepconsole.overmind.armId();
    myArmId = me.id; overmindSelf.textContent = `you are ${me.name}`;
  }
  const { roster } = await window.deepconsole.overmind.roster();
  renderRoster(roster || []);
  const { board } = await window.deepconsole.overmind.board();
  renderBoard(board || []);
}

function renderRoster(roster) {
  overmindRoster.innerHTML = '';
  roster.forEach((arm) => {
    const row = document.createElement('div');
    row.className = 'overmind-arm';
    const dot = arm.status === 'offline' ? '⚫' : (arm.status === 'working' ? '🟢' : '🟡');
    const askBtn = arm.id === myArmId ? '' : `<button data-ask="${arm.id}" class="btn btn-secondary btn-sm">Ask</button>`;
    row.innerHTML = `<span>${dot} <strong>${arm.name}</strong> — ${arm.status}${arm.focus ? ' · ' + arm.focus : ''}</span>${askBtn}`;
    overmindRoster.appendChild(row);
  });
  overmindRoster.querySelectorAll('[data-ask]').forEach((b) => b.addEventListener('click', async () => {
    const msg = prompt(`Ask ${b.getAttribute('data-ask')}:`);
    if (msg) { const r = await window.deepconsole.overmind.ask(b.getAttribute('data-ask'), msg); alert(`Answer: ${r.answer ?? r.error ?? '(no reply)'}`); }
  }));
}

const expandedBoardItems = new Set(); // survives re-renders (board repaints on every SSE event)

// ── Board state filter (All / Open / Active / Blocked / Done) ──────────────────
let boardFilter = 'all';        // persists across SSE re-renders
let _lastBoard = [];
const BOARD_FILTERS = [['all', 'All'], ['open', 'Open'], ['claimed', 'Active'], ['blocked', 'Blocked'], ['done', 'Done']];
function boardItemState(item) {
  if (item.state === 'done') return 'done';
  if (item.state === 'claimed') return 'claimed';   // an arm is working it ("Active")
  if (item.blocked) return 'blocked';               // gated on depends_on
  return 'open';                                     // available to claim ("idle")
}

function renderBoard(board) {
  _lastBoard = board;
  overmindBoard.innerHTML = '';
  // filter bar with live counts; selection survives the SSE repaint
  const counts = { all: board.length, open: 0, claimed: 0, blocked: 0, done: 0 };
  board.forEach((it) => { counts[boardItemState(it)]++; });
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;';
  bar.innerHTML = BOARD_FILTERS.map(([k, label]) =>
    `<button data-filter="${k}" class="btn btn-sm ${boardFilter === k ? 'btn-primary' : 'btn-secondary'}">${label} (${counts[k] || 0})</button>`).join('');
  overmindBoard.appendChild(bar);
  bar.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { boardFilter = b.getAttribute('data-filter'); renderBoard(_lastBoard); }));
  const _items = boardFilter === 'all' ? board : board.filter((it) => boardItemState(it) === boardFilter);
  _items.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'overmind-item-card';
    let action = '';
    if (item.state === 'open' && item.blocked) action = `<em title="waiting on: ${(item.depends_on || []).join(', ')}">⛓ blocked (${(item.depends_on || []).length} prereq)</em>`;
    else if (item.state === 'open') action = `<button data-claim="${item.id}" class="btn btn-primary btn-sm">Claim</button>`;
    else if (item.state === 'claimed' && item.claimed_by === myArmId) action = `<button data-done="${item.id}" class="btn btn-primary btn-sm">Done</button> <button data-release="${item.id}" class="btn btn-secondary btn-sm">Release</button>`;
    else if (item.state === 'claimed') action = `<em>claimed by ${item.claimed_by}</em>`;
    else action = '<em>✓ done</em>';
    const icon = item.state === 'done' ? '✅' : item.state === 'claimed' ? '🔄' : item.blocked ? '⛓' : '🟢';
    const expanded = expandedBoardItems.has(item.id);
    card.innerHTML = `
      <div class="overmind-item-header" data-toggle="${item.id}">
        <span class="overmind-item-caret">${expanded ? '▾' : '▸'}</span>
        <span class="overmind-item-title">${icon} ${item.title}</span>
        <span class="overmind-item-action">${action}</span>
      </div>
      <div class="overmind-item-body"${expanded ? '' : ' style="display:none"'}></div>`;
    const parts = [];
    if (item.detail) parts.push(`Detail:\n${item.detail}`);
    if (item.depends_on && item.depends_on.length) parts.push(`Depends on: ${item.depends_on.join(', ')}`);
    if (item.claimed_by) parts.push(`Claimed by: ${item.claimed_by}`);
    if (item.result) parts.push(`Result:\n${item.result}`);
    card.querySelector('.overmind-item-body').textContent = parts.join('\n\n') || '(no detail)';
    overmindBoard.appendChild(card);
  });
  overmindBoard.querySelectorAll('[data-toggle]').forEach((h) => h.addEventListener('click', (e) => {
    if (e.target.closest('button')) return; // action buttons must not toggle
    const id = h.getAttribute('data-toggle');
    if (expandedBoardItems.has(id)) expandedBoardItems.delete(id); else expandedBoardItems.add(id);
    const open = expandedBoardItems.has(id);
    h.parentElement.querySelector('.overmind-item-body').style.display = open ? '' : 'none';
    h.querySelector('.overmind-item-caret').textContent = open ? '▾' : '▸';
  }));
  overmindBoard.querySelectorAll('[data-claim]').forEach((b) => b.addEventListener('click', () => window.deepconsole.overmind.claim(b.getAttribute('data-claim')).catch(console.error)));
  overmindBoard.querySelectorAll('[data-release]').forEach((b) => b.addEventListener('click', () => window.deepconsole.overmind.release(b.getAttribute('data-release')).catch(console.error)));
  overmindBoard.querySelectorAll('[data-done]').forEach((b) => b.addEventListener('click', async () => { const r = prompt('Result?') || 'done'; window.deepconsole.overmind.done(b.getAttribute('data-done'), r); }));
}

document.getElementById('overmind-post-btn').addEventListener('click', async () => {
  const input = document.getElementById('overmind-item-title');
  const title = input.value.trim();
  if (!title) return;
  await window.deepconsole.overmind.postItem({ title, detail: '', tags: [] });
  input.value = '';
});

function addIncomingAsk(ev) {
  const row = document.createElement('div');
  row.className = 'overmind-ask';
  row.innerHTML = `<span><strong>${ev.from}</strong> asks: ${ev.message}</span> <button class="btn btn-primary btn-sm">Reply</button>`;
  row.querySelector('button').addEventListener('click', async () => {
    const answer = prompt('Your reply:'); if (answer == null) return;
    await window.deepconsole.overmind.reply(ev.ask_id, answer); row.remove();
  });
  overmindAsks.appendChild(row);
}

// Resolve our own arm id eagerly so peer-asks routed to us aren't dropped
// before the Overmind tab is first opened (myArmId is otherwise null until then).
(async () => {
  try {
    const me = await window.deepconsole.overmind.armId();
    myArmId = me.id;
    if (overmindSelf) overmindSelf.textContent = `you are ${me.name}`;
  } catch (e) { console.error('[Overmind] armId fetch failed', e); }
})();

// ─── Autonomous worker ────────────────────────────────────────────────────
const autonomousToggle = document.getElementById('autonomous-toggle');
const autonomousStatus = document.getElementById('autonomous-status');

const autonomousWorker = window.createWorker({
  board: {
    claim: (id) => window.deepconsole.overmind.claim(id),
    done: (id, result) => window.deepconsole.overmind.done(id, result),
    release: (id) => window.deepconsole.overmind.release(id),
    setStatus: (status, focus) => window.deepconsole.overmind.setStatus(status, focus),
  },
  // NB: tasks run in this instance's ACTIVE chat panel (shared currentSessionId),
  // not a background session — so they appear in, and interleave with, the human
  // conversation. Intended for background/auxiliary instances. If a manual send is
  // already streaming, sendMessage throws 'chat busy' and the worker releases the item.
  runTask: (text) => sendMessage(text),
  log: (m) => { console.log('[autonomous]', m); try { window.deepconsole.overmind.log(m); } catch (e) {} },
  onChange: ({ enabled, busy, current }) => {
    if (!autonomousStatus) return;
    autonomousStatus.textContent = !enabled
      ? 'off'
      : (busy ? `working — "${current || '…'}"` : 'on · idle — watching board');
  },
});

if (autonomousToggle) {
  autonomousToggle.addEventListener('change', () => {
    autonomousWorker.setEnabled(autonomousToggle.checked);
  });
}

// Turn autonomous mode on programmatically (used by the --autonomous launch flag so a
// fleet-launched session needs no manual 'new session' + toggle clicks).
function enableAutonomousMode() {
  if (autonomousToggle) autonomousToggle.checked = true;
  autonomousWorker.setEnabled(true);
  console.log('[autonomous] auto-enabled via --autonomous launch flag');
}

// Seed the worker with the current board, then keep it fed by the live SSE stream.
window.deepconsole.overmind.board()
  .then(({ board }) => autonomousWorker.onBoard(board || []))
  .catch(() => {});

// Heartbeat poll: SSE alone strands an idle worker when the board stream goes quiet after a long
// task (open lanes remain, but no new 'board' event fires to re-trigger a claim). Re-feed the worker
// from a fresh board fetch every 15s so it keeps DRAINING the backlog. No-op while busy.
setInterval(() => {
  window.deepconsole.overmind.board()
    .then(({ board }) => autonomousWorker.onBoard(board || []))
    .catch(() => {});
}, 15000);

// Live updates — the SSE feed drives every panel; the heartbeat above backstops it.
window.deepconsole.overmind.onEvent((ev) => {
  if (ev.type === 'presence') renderRoster(ev.roster);
  else if (ev.type === 'board') { renderBoard(ev.board); autonomousWorker.onBoard(ev.board); }
  else if (ev.type === 'ask' && ev.to === myArmId) addIncomingAsk(ev);
});
