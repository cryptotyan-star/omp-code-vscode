import { hostileFixtures } from './hostile-fixtures.7a6d72b1.js';

const root = document.getElementById('app');
globalThis.__ompXss = false;

function appendTextWithSafeLinks(parent, source) {
  // Raw HTML is never parsed. Only a small Markdown link form is recognized.
  const pattern = /\[([^\]\n]{1,300})\]\(([^)\s]{1,4096})\)/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    parent.append(document.createTextNode(source.slice(cursor, match.index)));
    try {
      const url = new URL(match[2]);
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        const link = document.createElement('a');
        link.textContent = match[1];
        link.href = url.href;
        link.rel = 'noopener noreferrer';
        link.addEventListener('click', event => {
          event.preventDefault();
          post({ type: 'local.openUrl', protocolVersion: 1, url: url.href });
        });
        parent.append(link);
      } else {
        parent.append(document.createTextNode(match[0]));
      }
    } catch {
      parent.append(document.createTextNode(match[0]));
    }
    cursor = match.index + match[0].length;
  }
  parent.append(document.createTextNode(source.slice(cursor)));
}

function renderMessage(message, target = root) {
  const article = document.createElement('article');
  article.className = `message ${message.role === 'user' ? 'user' : ''}`;
  const role = document.createElement('div');
  role.className = 'role';
  role.textContent = message.role === 'user' ? 'You' : 'OMP';
  const content = document.createElement('div');
  content.className = 'content';
  appendTextWithSafeLinks(content, String(message.text ?? ''));
  article.append(role, content);
  target.append(article);
}

function renderSync(payload) {
  root.replaceChildren();
  const transcript = Array.isArray(payload?.transcript) ? payload.transcript : [];
  if (!transcript.length) {
    const empty = document.createElement('section');
    empty.className = 'empty';
    empty.textContent = 'Connected. Continue the desktop session from your phone.';
    root.append(empty);
    return;
  }
  for (const item of transcript.slice(-1000)) {
    if (item && (item.role === 'user' || item.role === 'assistant') && typeof item.text === 'string') {
      renderMessage(item);
    }
  }
}

function post(body) {
  const bridge = globalThis.ompHost;
  if (bridge && typeof bridge.postMessage === 'function') bridge.postMessage(JSON.stringify(body));
}

function runHostileFixtureSpike() {
  const sandbox = document.createElement('section');
  sandbox.hidden = true;
  for (const fixture of hostileFixtures) renderMessage({ role: 'assistant', text: fixture }, sandbox);
  root.append(sandbox);
  const forbidden = sandbox.querySelector('script,iframe,object,embed,svg,[onerror],[onclick],a[href^="javascript:"],a[href^="data:"]');
  const passed = globalThis.__ompXss === false && forbidden === null;
  sandbox.remove();
  post({ type: 'security-spike.result', protocolVersion: 1, passed, fixtureCount: hostileFixtures.length });
}

if (globalThis.ompHost) {
  globalThis.ompHost.onmessage = event => {
    if (typeof event?.data !== 'string' || event.data.length > 65536) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (!message || message.protocolVersion !== 1 || typeof message.type !== 'string') return;
    if (message.type === 'host.sync') renderSync(message.payload);
    if (message.type === 'host.transcript.append' && message.payload) renderMessage(message.payload);
  };
}

post({ type: 'renderer.ready', protocolVersion: 1 });
runHostileFixtureSpike();
