from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)


js_path = Path('client/admin/admin.js')
js = js_path.read_text()

js = replace_once(
    js,
    "  currentPanel: 'overview',\n  infrastructure: null,",
    "  currentPanel: 'overview',\n  refreshRevision: 0,\n  infrastructure: null,",
    'refresh revision state',
)

js = replace_once(
    js,
    "  clearOperationConfirmation();\n  $('#app-view').hidden = true;",
    "  clearOperationConfirmation();\n  state.refreshRevision += 1;\n  document.body.dataset.adminSession = 'login';\n  const refresh = $('#refresh');\n  refresh.disabled = false;\n  refresh.removeAttribute('aria-busy');\n  $('#app-view').removeAttribute('aria-busy');\n  $('#app-view').hidden = true;",
    'showLogin session state',
)

js = replace_once(
    js,
    "  state.capabilities = new Set(payload.capabilities || []);\n  $('#admin-name').textContent = payload.admin.name;",
    "  state.capabilities = new Set(payload.capabilities || []);\n  document.body.dataset.adminSession = 'active';\n  $('#admin-name').textContent = payload.admin.name;",
    'activate session state',
)

js = replace_once(
    js,
    "  for (const item of $$('.panel')) item.hidden = item.id !== `panel-${name}`;\n  for (const item of $$('#tabs [data-panel]')) item.classList.toggle('active', item.dataset.panel === name);\n  refreshCurrent();",
    "  for (const item of $$('.panel')) item.hidden = item.id !== `panel-${name}`;\n  for (const item of $$('#tabs [data-panel]')) {\n    const active = item.dataset.panel === name;\n    item.classList.toggle('active', active);\n    if (active) item.setAttribute('aria-current', 'page');\n    else item.removeAttribute('aria-current');\n  }\n  const activeButton = $(`#tabs [data-panel=\"${name}\"]`);\n  activeButton?.scrollIntoView({\n    block: 'nearest',\n    inline: 'center',\n    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'\n  });\n  refreshCurrent();",
    'active tab visibility',
)

js = replace_once(
    js,
    "  const card = document.createElement('article');\n  card.className = 'stat';\n  appendText(card, 'span', label, 'label');",
    "  const card = document.createElement('article');\n  card.className = `stat${tone ? ` stat-${tone}` : ''}`;\n  appendText(card, 'span', label, 'label');",
    'stat tone class',
)

start = js.index('async function refreshCurrent() {')
end = js.index("\n\n$('#login-form').addEventListener", start)
new_refresh = """async function refreshCurrent() {
  const loaders = {
    overview: loadOverview,
    infrastructure: loadInfrastructure,
    analytics: loadAnalytics,
    players: loadPlayers,
    moderation: loadModeration,
    operations: loadOperations,
    audit: loadAudit
  };
  const panel = state.currentPanel;
  const loader = loaders[panel];
  if (!loader) return;

  const revision = ++state.refreshRevision;
  const refresh = $('#refresh');
  refresh.disabled = true;
  refresh.setAttribute('aria-busy', 'true');
  $('#app-view').setAttribute('aria-busy', 'true');
  setStatus('Обновляю данные…');

  try {
    const result = await loader();
    if (revision !== state.refreshRevision || panel !== state.currentPanel) return;
    if (result?.statusText) setStatus(result.statusText, result.tone || '');
    else setStatus(`Данные обновлены в ${new Date().toLocaleTimeString('ru-RU')}`, 'good');
  } catch (error) {
    if (revision !== state.refreshRevision || panel !== state.currentPanel) return;
    if (error.status === 401) return showLogin('Сессия администратора завершена. Войдите снова.');
    setStatus(`Ошибка: ${error.message}`, 'bad');
  } finally {
    if (revision === state.refreshRevision) {
      refresh.disabled = false;
      refresh.removeAttribute('aria-busy');
      $('#app-view').removeAttribute('aria-busy');
    }
  }
}
"""
js = js[:start] + new_refresh + js[end:]
js_path.write_text(js)

css_path = Path('client/admin/admin.css')
css = css_path.read_text().rstrip() + '\n\n'
css += r'''/* PR72: mobile-first control-plane polish. */
[hidden] {
  display: none !important;
}

button,
.primary,
.ghost,
.tabs button,
.case-open {
  min-height: 44px;
  touch-action: manipulation;
}

button:disabled {
  cursor: wait;
  opacity: 0.58;
}

button:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible,
summary:focus-visible {
  outline: 3px solid rgba(152, 162, 255, 0.42);
  outline-offset: 2px;
}

.tabs {
  scroll-snap-type: x proximity;
  scroll-padding-inline: 12px;
  overscroll-behavior-inline: contain;
}

.tabs button {
  scroll-snap-align: center;
}

.toolbar {
  padding: 9px 10px;
  border: 1px solid #262d43;
  border-radius: 13px;
  background: rgba(16, 19, 33, 0.72);
}

#status-line {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  line-height: 1.4;
}

#status-line::before {
  width: 7px;
  height: 7px;
  flex: 0 0 7px;
  border-radius: 999px;
  background: #788095;
  content: '';
}

#status-line.good::before {
  background: #74e0b1;
  box-shadow: 0 0 0 4px rgba(116, 224, 177, 0.08);
}

#status-line.warn::before {
  background: #ffd37a;
  box-shadow: 0 0 0 4px rgba(255, 211, 122, 0.08);
}

#status-line.bad::before {
  background: #ff879a;
  box-shadow: 0 0 0 4px rgba(255, 135, 154, 0.08);
}

.stat {
  position: relative;
  overflow: hidden;
}

.stat::before {
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: transparent;
  content: '';
}

.stat-good::before {
  background: #74e0b1;
}

.stat-warn::before {
  background: #ffd37a;
}

.stat-bad::before {
  background: #ff879a;
}

.stat-good {
  border-color: rgba(116, 224, 177, 0.2);
}

.stat-warn {
  border-color: rgba(255, 211, 122, 0.25);
}

.stat-bad {
  border-color: rgba(255, 135, 154, 0.28);
}

.help-card summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  list-style: none;
}

.help-card summary::-webkit-details-marker {
  display: none;
}

.help-card summary::after {
  flex: 0 0 auto;
  color: #8f98b3;
  content: '⌄';
  font-size: 1.05rem;
  transition: transform 0.16s ease-out;
}

.help-card[open] summary::after {
  transform: rotate(180deg);
}

.table-wrap {
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-inline: contain;
  scrollbar-width: thin;
}

body[data-admin-session='active'] .topbar {
  margin-bottom: 16px;
}

@media (max-width: 560px) {
  .shell {
    padding-top: max(12px, env(safe-area-inset-top));
  }

  body[data-admin-session='active'] .topbar {
    flex-direction: column;
    gap: 10px;
  }

  body[data-admin-session='active'] .topbar h1 {
    font-size: 1.6rem;
  }

  .identity {
    width: 100%;
    max-width: none;
    justify-content: flex-start;
  }

  #logout {
    margin-left: auto;
  }

  .tabs {
    position: sticky;
    top: env(safe-area-inset-top);
    z-index: 20;
    margin-right: -12px;
    margin-left: -12px;
    padding: 8px 12px;
    border-top: 1px solid rgba(43, 49, 72, 0.7);
    border-bottom: 1px solid rgba(43, 49, 72, 0.92);
    background: rgba(9, 11, 19, 0.92);
    backdrop-filter: blur(14px);
  }

  .toolbar {
    margin-top: 10px;
  }

  #status-line {
    font-size: 0.78rem;
  }

  .details {
    grid-template-columns: minmax(108px, 0.9fr) minmax(0, 1.1fr);
    gap: 8px 11px;
    font-size: 0.88rem;
  }

  .help-card summary {
    padding: 13px 14px;
  }

  .help-card p {
    padding-right: 14px;
    padding-left: 14px;
    font-size: 0.86rem;
  }

  .card {
    box-shadow: none;
  }

  #panel-infrastructure table {
    min-width: 560px;
  }
}

@media (max-width: 390px) {
  .toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .toolbar .ghost {
    width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .panel {
    animation: none;
  }

  .help-card summary::after {
    transition: none;
  }
}
'''
css_path.write_text(css + '\n')
