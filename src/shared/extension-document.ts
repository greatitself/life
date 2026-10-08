import type { LifeExtensionManifest } from './extensions'

/** Each extension is served in its own sandboxed frame, with a document-only nonce. */
export function extensionDocumentCSP(token: string): string {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(token)) throw new Error('Invalid extension document token')
  return `default-src 'none'; script-src 'nonce-${token}'; style-src 'unsafe-inline' https:; img-src data: https: http:; font-src data: https:; connect-src https: http:; frame-src 'none'; base-uri 'none'; form-action 'none'`
}

function literal(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/** The HTML cannot access Electron, the parent document, or a Node context. */
export function buildExtensionDocument(
  manifest: LifeExtensionManifest,
  theme: 'dark' | 'light',
  token: string,
): string {
  const policy = extensionDocumentCSP(token)
  const renderer = manifest.renderer
  const bootstrap = `(() => {
    'use strict';
    const token = ${literal(token)};
    const html = ${literal(renderer?.html || '')};
    const css = ${literal(renderer?.css || '')};
    const source = ${literal(renderer?.js || '')};
    let port;
    let sequence = 0;
    const pending = new Map();
    const listeners = new Map();
    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const context = { id: ${literal(manifest.id)}, theme: ${literal(theme)}, manifest: ${literal(manifest)}, capabilities: [] };
    function dispatch(event, data) {
      for (const callback of listeners.get(event) || []) {
        try { callback(data); } catch (error) { report(error); }
      }
    }
    function report(error) {
      if (port) port.postMessage({ kind: 'error', text: error && error.message ? error.message : String(error) });
    }
    async function request(kind, method, args) {
      await ready;
      if (typeof method !== 'string' || !method || method.length > 160) throw new Error('Specify a Life method.');
      if (pending.size >= 64) throw new Error('Too many concurrent Life requests.');
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Life request timed out.')); }, 300000);
        pending.set(id, { resolve, reject, timer });
        try { port.postMessage({ kind, id, method, args }); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    }
    const life = {
      context,
      ready,
      call: (method, args) => request('call', method, args),
      invoke: (method, args) => request('invoke', method, args),
      on(event, callback) {
        if (typeof event !== 'string' || typeof callback !== 'function') throw new Error('Subscribe with an event name and function.');
        let callbacks = listeners.get(event);
        if (!callbacks) { callbacks = new Set(); listeners.set(event, callbacks); }
        callbacks.add(callback);
        return () => { callbacks.delete(callback); if (!callbacks.size) listeners.delete(event); };
      },
    };
    Object.defineProperty(globalThis, 'life', { value: life, configurable: false });
    Object.defineProperty(globalThis, 'Life', { value: life, configurable: false });
    const style = document.createElement('style');
    style.nonce = token;
    style.textContent = css;
    document.head.appendChild(style);
    document.getElementById('life-extension-root').innerHTML = html;
    window.addEventListener('error', event => report(event.error || event.message));
    window.addEventListener('unhandledrejection', event => report(event.reason));
    window.addEventListener('pagehide', () => {
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Extension unloaded.')); }
      pending.clear();
      if (port) port.close();
    });
    window.addEventListener('message', event => {
      if (event.source !== parent || event.data?.kind !== 'life:connect' || event.data.token !== token || !event.ports[0] || port) return;
      port = event.ports[0];
      Object.assign(context, event.data.context);
      document.documentElement.dataset.theme = context.theme;
      document.body.dataset.theme = context.theme;
      port.onmessage = event => {
        const message = event.data;
        if (!message || typeof message !== 'object') return;
        if (message.kind === 'result') {
          const item = pending.get(message.id);
          if (!item) return;
          clearTimeout(item.timer);
          pending.delete(message.id);
          if (message.error) item.reject(new Error(message.error)); else item.resolve(message.value);
        }
        if (message.kind === 'event' && typeof message.event === 'string') {
          if (message.event === 'theme') { context.theme = message.data; document.documentElement.dataset.theme = message.data; document.body.dataset.theme = message.data; }
          dispatch(message.event, message.data);
        }
      };
      port.start();
      resolveReady(life);
      const script = document.createElement('script');
      script.nonce = token;
      script.textContent = source;
      document.body.appendChild(script);
      port.postMessage({ kind: 'ready' });
    });
    parent.postMessage({ kind: 'life:hello', token }, '*');
  })();`
  const baseCSS = `:root {color-scheme:dark;--bg:#161616;--surface:#202020;--text:#ededed;--muted:#a1a1a1;--border:#353535;--accent:#f3f3f3;--accent-text:#141414} :root[data-theme="light"] {color-scheme:light;--bg:#ffffff;--surface:#f6f6f6;--text:#181818;--muted:#686868;--border:#dedede;--accent:#161616;--accent-text:#ffffff} * {box-sizing:border-box} html,body {margin:0;min-height:100%;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif} body {font-size:14px} button,input,textarea,select {font:inherit} button {cursor:pointer} a {color:inherit} #life-extension-root {min-height:100vh}`
  return `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${policy}"><style nonce="${token}">${baseCSS}</style><title>Life extension</title></head><body data-theme="${theme}"><div id="life-extension-root"></div><script nonce="${token}">${bootstrap}</script></body></html>`
}
