/**
 * Callosum Protocol — Client
 */

export class CallosumClient {
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl || process.env.CALLOSUM_URL || 'http://localhost:7700';
    this.instanceId = opts.instanceId || `inst-${Math.random().toString(36).slice(2, 10)}`;
  }

  async _fetch(method, path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  }

  async intercept(tool, action, params = {}) {
    return this._fetch('POST', '/intercept', { instance: this.instanceId, tool, action, params });
  }

  async complete(contextKey, id, result = 'ok') {
    return this._fetch('POST', '/complete', { instance: this.instanceId, contextKey, id, result });
  }

  async execute(tool, action, params, executeFn) {
    const decision = await this.intercept(tool, action, params);
    if (!decision.proceed) return { blocked: true, ...decision };
    try {
      const result = await executeFn();
      await this.complete(decision.contextKey, decision.id, 'ok');
      return { blocked: false, result, ...decision };
    } catch (err) {
      await this.complete(decision.contextKey, decision.id, { error: err.message });
      throw err;
    }
  }

  async lock(contextKey, tier = 3) {
    return this._fetch('POST', '/lock', { instance: this.instanceId, contextKey, tier });
  }

  async unlock(contextKey) {
    return this._fetch('DELETE', `/lock/${encodeURIComponent(contextKey)}`, { instance: this.instanceId });
  }

  async status(contextKey) {
    const qs = contextKey ? `?contextKey=${encodeURIComponent(contextKey)}` : '';
    return this._fetch('GET', `/status${qs}`);
  }
}

export default CallosumClient;
