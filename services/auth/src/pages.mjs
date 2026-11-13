/** Minimal server-rendered pages: no template engine, no client framework. */

/**
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&#39;'
    }
  })
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; background: #f6f7f9; color: #1f2328; }
  main { max-width: 22rem; margin: 12vh auto; padding: 2rem; background: #fff; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.08); }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  label { display: block; font-size: .85rem; margin: .9rem 0 .35rem; }
  input { width: 100%; box-sizing: border-box; padding: .6rem .7rem; border: 1px solid #d0d7de; border-radius: 8px; font-size: 1rem; }
  button { width: 100%; margin-top: 1.2rem; padding: .7rem; border: 0; border-radius: 8px; background: #1f6feb; color: #fff; font-size: 1rem; cursor: pointer; }
  button:hover { background: #1a5fd0; }
  .error { margin: 1rem 0 0; padding: .6rem .7rem; border-radius: 8px; background: #ffebe9; color: #82071e; font-size: .9rem; }
  .muted { color: #57606a; font-size: .9rem; }
  a { color: #1f6feb; }
  @media (prefers-color-scheme: dark) {
    body { background: #0d1117; color: #e6edf3; }
    main { background: #161b22; box-shadow: 0 8px 30px rgba(0,0,0,.4); }
    input { background: #0d1117; color: #e6edf3; border-color: #30363d; }
    .muted { color: #8b949e; }
  }
`

/**
 * @param {string} title
 * @param {string} body
 * @returns {string}
 */
export function layout(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`
}

/**
 * @param {{next: string, error?: string, username?: string}} options
 * @returns {string}
 */
export function loginPage({ next, error, username = '' }) {
  const errorBlock = error ? `<p class="error">${escapeHtml(error)}</p>` : ''
  return layout('登录 · multi-dsh', `
<h1>登录 multi-dsh</h1>
<p class="muted">使用平台账号登录后进入你的 DSH 实例。</p>
${errorBlock}
<form method="post" action="/login" autocomplete="on">
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  <label for="username">用户名</label>
  <input id="username" name="username" autocomplete="username" required value="${escapeHtml(username)}">
  <label for="password">密码</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">登录</button>
</form>`)
}

/**
 * @param {{title: string, message: string, link?: {href: string, text: string}}} options
 * @returns {string}
 */
export function messagePage({ title, message, link }) {
  const linkBlock = link ? `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.text)}</a></p>` : ''
  return layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${linkBlock}`)
}

/**
 * @param {{code: string, error?: string, username?: string}} options
 * @returns {string}
 */
export function registerPage({ code, error, username = '' }) {
  const errorBlock = error ? `<p class="error">${escapeHtml(error)}</p>` : ''
  return layout('注册 · multi-dsh', `
<h1>创建 multi-dsh 账号</h1>
<p class="muted">邀请码有效，设置你的登录凭据。</p>
${errorBlock}
<form method="post" action="/register" autocomplete="on">
  <input type="hidden" name="code" value="${escapeHtml(code)}">
  <label for="username">用户名</label>
  <input id="username" name="username" autocomplete="username" required value="${escapeHtml(username)}"
         pattern="[a-z0-9][a-z0-9_-]{2,31}" title="3-32 位，小写字母/数字/下划线/中划线">
  <label for="password">密码（至少 12 位）</label>
  <input id="password" name="password" type="password" autocomplete="new-password" minlength="12" required>
  <label for="confirm">确认密码</label>
  <input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="12" required>
  <button type="submit">创建账号</button>
</form>`)
}

/**
 * @param {{code: string, error?: string}} options
 * @returns {string}
 */
export function resetPage({ code, error }) {
  const errorBlock = error ? `<p class="error">${escapeHtml(error)}</p>` : ''
  return layout('重置密码 · multi-dsh', `
<h1>重置密码</h1>
<p class="muted">设置一个新的登录密码，所有旧会话会失效。</p>
${errorBlock}
<form method="post" action="/reset" autocomplete="on">
  <input type="hidden" name="code" value="${escapeHtml(code)}">
  <label for="password">新密码（至少 12 位）</label>
  <input id="password" name="password" type="password" autocomplete="new-password" minlength="12" required>
  <label for="confirm">确认新密码</label>
  <input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="12" required>
  <button type="submit">重置密码</button>
</form>`)
}


