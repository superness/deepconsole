"""
Build the complete app.js for DeepConsole with Memory panel support.
"""
import sys

# Read the original file
with open('C:/github/deepconsole/renderer/app.js', 'r', encoding='utf-8') as f:
    content = f.read()

lines = content.split('\n')

# ─── 1. Add memory state after eventCleanup ─────────────────────────────
state_insert = """let memoryCurrentTier = 'session';
let memoryCurrentNamespace = '';
"""

for i, line in enumerate(lines):
    if 'let eventCleanup = null;' in line:
        lines.insert(i + 1, state_insert)
        break

# ─── 2. Add memory DOM refs after abuddiResult ──────────────────────────
dom_insert = """
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
"""

for i, line in enumerate(lines):
    if "const abuddiResult = document.getElementById('abuddi-result');" in line:
        lines.insert(i + 1, dom_insert)
        break

# ─── 3. Add memory tab to tab list ──────────────────────────────────────
for i, line in enumerate(lines):
    if "const tabAgents = document.getElementById('agents-tab');" in line:
        lines.insert(i + 1, "const tabMemory = document.getElementById('memory-tab');")
        break

for i, line in enumerate(lines):
    if "const viewAgents = document.getElementById('agents-view');" in line:
        lines.insert(i + 1, "const viewMemory = document.getElementById('memory-view');")
        break

# ─── 4. Update switchTab to include memory ──────────────────────────────
for i, line in enumerate(lines):
    if line.strip().startswith("function switchTab(tab) {"):
        # Find the closing brace of the function
        for j in range(i, min(i + 40, len(lines))):
            l = lines[j].strip()
            if l.startswith("tabBrowser.addEventListener"):
                # Insert before this line
                # Rewrite the switchTab to include memory
                insert_at = j
                break
        
        # Replace the switchTab function body
        switch_tab_lines = []
        in_func = False
        brace_count = 0
        for j in range(i, min(i + 30, len(lines))):
            switch_tab_lines.append(lines[j])
            if '{' in lines[j]:
                brace_count += lines[j].count('{')
            if '}' in lines[j]:
                brace_count -= lines[j].count('}')
            if brace_count <= 0 and j > i:
                break
        
        # Build new switchTab
        new_func = [
            'function switchTab(tab) {',
            '  const tabs = [tabBrowser, tabConsole, tabJS, tabAgents, tabMemory];',
            '  const views = [viewBrowser, viewConsole, viewJS, viewAgents, viewMemory];',
            '  tabs.forEach(t => t.classList.remove("active"));',
            '  views.forEach(v => v.classList.remove("active"));',
            '',
            '  if (tab === "browser") { tabBrowser.classList.add("active"); viewBrowser.classList.add("active"); }',
            '  else if (tab === "console") { tabConsole.classList.add("active"); viewConsole.classList.add("active"); }',
            '  else if (tab === "js") { tabJS.classList.add("active"); viewJS.classList.add("active"); }',
            '  else if (tab === "agents") { tabAgents.classList.add("active"); viewAgents.classList.add("active"); loadAgents(); }',
            '  else if (tab === "memory") { tabMemory.classList.add("active"); viewMemory.classList.add("active"); refreshMemoryView(); }',
            '}',
        ]
        
        # Replace the old function
        for k, new_line in enumerate(new_func):
            lines[i + k] = new_line
        
        # Remove remaining old lines
        remaining = len(switch_tab_lines) - len(new_func)
        for _ in range(remaining):
            lines.pop(i + len(new_func))
        break

# ─── 5. Update tab click handlers ───────────────────────────────────────
for i, line in enumerate(lines):
    if line.strip().startswith("tabAgents.addEventListener('click',") and 'loadAgents' in line:
        lines.insert(i + 1, "tabMemory.addEventListener('click', () => { switchTab('memory'); refreshMemoryView(); });")
        break

# ─── 6. Update titlebar toggle ─────────────────────────────────────────
for i, line in enumerate(lines):
    if 'agent-panel-toggle' in line and 'loadAgents' in line:
        lines.insert(i + 1, """
// Memory panel toggle from titlebar
document.getElementById('memory-panel-toggle')?.addEventListener('click', () => {
  switchTab('memory');
  refreshMemoryView();
});
""")
        break

# ─── 7. Add hint button for memory ─────────────────────────────────────
for i, line in enumerate(lines):
    if "messageInput.value = 'Score this task with ABUDDI" in line:
        lines.insert(i + 1, "    } else if (hint === '\U0001f9e0 Remember') {")
        lines.insert(i + 2, "      messageInput.value = 'Remember that my name is [your name] and my favorite color is [color]';")
        break

# ─── 8. Add Memory Panel controller code at end ────────────────────────
for i, line in enumerate(lines):
    if '(async function boot()' in line:
        insert_idx = i
        break

memory_code = r'''
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

  // Populate namespace selector
  memoryNamespaceSelect.innerHTML = '';
  if (memoryCurrentTier === 'session') {
    // List session namespaces
    try {
      const sessions = await window.deepconsole.llm.listSessions();
      const namespaces = (sessions || []).map(s => ({
        value: `session_${s.id}`,
        text: `Session ${s.id.slice(0, 8)} (${s.message_count} msgs)`
      }));
      if (currentSessionId) {
        namespaces.unshift({ value: `session_${currentSessionId}`, text: `Current session ${currentSessionId.slice(0, 8)}` });
      }
      namespaces.forEach(ns => {
        const opt = document.createElement('option');
        opt.value = ns.value;
        opt.textContent = ns.text;
        memoryNamespaceSelect.appendChild(opt);
      });
    } catch (e) {
      const opt = document.createElement('option');
      opt.value = `session_${currentSessionId || 'unknown'}`;
      opt.textContent = `Session ${(currentSessionId || 'unknown').slice(0, 8)}`;
      memoryNamespaceSelect.appendChild(opt);
    }
  } else if (memoryCurrentTier === 'agent') {
    try {
      const agents = await window.deepconsole.agents.list();
      (agents || []).forEach(a => {
        const opt = document.createElement('option');
        opt.value = `agent_${a.id}`;
        opt.textContent = `${a.name || a.id}`;
        memoryNamespaceSelect.appendChild(opt);
      });
    } catch (e) {
      ['agent_product-maestro', 'agent_feature-owner', 'agent_sub-ic', 'agent_browser_commander', 'agent_code_implementer', 'agent_synthesizer'].forEach(id => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = id.replace('agent_', '');
        memoryNamespaceSelect.appendChild(opt);
      });
    }
  } else {
    ['deepconsole'].forEach(ns => {
      const opt = document.createElement('option');
      opt.value = ns;
      opt.textContent = 'Global DeepConsole Memory';
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
    const data = await window.deepconsole.memory.get(memoryCurrentTier, memoryCurrentNamespace, 'all');
    if (data.error) {
      memoryContent.innerHTML = `<div class="console-info">Error: ${data.error}</div>`;
      return;
    }

    const memory = data.memory || {};
    const keys = Object.keys(memory);

    if (keys.length === 0) {
      memoryContent.innerHTML = '<div class="console-info">Empty memory store. Use the key/value editor above to add data.</div>';
      return;
    }

    let html = `<div style="color:var(--text-muted);font-size:10px;padding:4px 8px;border-bottom:1px solid rgba(255,255,255,0.05);">
      ${keys.length} key(s) in ${memoryCurrentTier}/${memoryCurrentNamespace}
    </div>`;

    for (const key of keys) {
      const val = memory[key];
      const formatted = formatMemoryValue(val);
      html += `<div class="memory-entry"><span class="memory-entry-key">${key}</span>: ${formatted}</div>`;
    }

    memoryContent.innerHTML = html;
  } catch (err) {
    memoryContent.innerHTML = `<div class="console-info">Failed to load: ${err.message}</div>`;
  }
}

async function updateMemoryStats() {
  try {
    const stats = await window.deepconsole.memory.stats();
    if (stats && !stats.error) {
      const s = stats.session || {};
      const a = stats.agent || {};
      const m = stats.meta || {};
      memoryStats.textContent = `S:${s.keys || 0} A:${a.keys || 0} M:${m.keys || 0}`;
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
    const results = result.results || [];
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
'''

new_content = '\n'.join(lines[:insert_idx]) + '\n' + memory_code + '\n' + '\n'.join(lines[insert_idx:])

with open('C:/github/deepconsole/renderer/app.js', 'w', encoding='utf-8') as f:
    f.write(new_content)

print("Done! app.js updated with memory panel support.")
print(f"Original lines: {len(lines)}")
print(f"New file length: {len(new_content)}")
