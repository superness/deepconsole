

// ─── Grimoire System IPC ────────────────────────────────────────────────────

// Grimoires: Create a new grimoire
ipcMain.handle('grimoires:create', async (event, { name, description, ritual, power, domain, metadata }) => {
  try {
    return await httpRequest('POST', '/grimoires', { name, description, ritual, power, domain, metadata });
  } catch (e) {
    return { error: e.message };
  }
});

// Grimoires: List all grimoires
ipcMain.handle('grimoires:list', async () => {
  try {
    return await httpRequest('GET', '/grimoires');
  } catch (e) {
    return [];
  }
});

// Grimoires: Get a single grimoire by ID
ipcMain.handle('grimoires:get', async (event, id) => {
  try {
    return await httpRequest('GET', `/grimoires/${id}`);
  } catch (e) {
    return null;
  }
});

// Grimoires: Update a grimoire
ipcMain.handle('grimoires:update', async (event, { id, name, description, ritual, power, domain, metadata }) => {
  try {
    return await httpRequest('PUT', `/grimoires/${id}`, { name, description, ritual, power, domain, metadata });
  } catch (e) {
    return { error: e.message };
  }
});

// Grimoires: Delete a grimoire
ipcMain.handle('grimoires:delete', async (event, id) => {
  try {
    return await httpRequest('DELETE', `/grimoires/${id}`);
  } catch (e) {
    return { error: e.message };
  }
});

// Grimoires: Search grimoires
ipcMain.handle('grimoires:search', async (event, query) => {
  try {
    return await httpRequest('GET', `/grimoires/search?q=${encodeURIComponent(query)}`);
  } catch (e) {
    return { error: e.message };
  }
});

// Grimoires: Endow a grimoire to an agent
ipcMain.handle('grimoires:endow', async (event, { id, agentId }) => {
  try {
    return await httpRequest('POST', `/grimoires/${id}/endow`, { agent_id: agentId });
  } catch (e) {
    return { error: e.message };
  }
});

// Grimoires: Unequip a grimoire from an agent
ipcMain.handle('grimoires:unequip', async (event, { id, agentId }) => {
  try {
    return await httpRequest('POST', `/grimoires/${id}/unequip`, { agent_id: agentId });
  } catch (e) {
    return { error: e.message };
  }
});

// Grimoires: List endowed grimoires
ipcMain.handle('grimoires:endowed', async () => {
  try {
    return await httpRequest('GET', '/grimoires/endowed');
  } catch (e) {
    return { error: e.message };
  }
});
