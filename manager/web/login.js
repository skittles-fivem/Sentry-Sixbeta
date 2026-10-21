'use strict';

(async () => {
  const $ = (id) => document.getElementById(id);
  // Only ever continue to a page on this server: resolve against our origin
  // and refuse anything that ends up elsewhere (//host, /\host, tabs, ...).
  const safeNext = (() => {
    const raw = new URLSearchParams(location.search).get('next') || '/';
    try {
      const u = new URL(raw, location.origin);
      if (u.origin !== location.origin || !raw.startsWith('/') || /[\\\s]/.test(raw)) return '/';
      return u.pathname + u.search + u.hash;
    } catch {
      return '/';
    }
  })();
  const me = await fetch('/api/auth/me').then((r) => r.json()).catch(() => ({}));
  if (me.user) return location.replace(safeNext);
  if (location.protocol !== 'https:') $('insecure').hidden = false;
  const setup = me.needsSetup;
  if (setup) {
    $('title').textContent = 'Create your account';
    $('lead').textContent = 'This is the first start. Enter the setup code from the container log, then choose the user name and password that protect this Sentry Six Manager.';
    $('confirm-row').hidden = false;
    $('code-row').hidden = false;
    $('submit').textContent = 'Create account';
    document.querySelector('[name=password]').autocomplete = 'new-password';
    document.querySelector('[name=password]').minLength = 8;
    document.querySelector('[name=code]').required = true;
  }
  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    if (setup && f.get('password') !== f.get('confirm')) {
      $('err').textContent = 'The passwords do not match.';
      return;
    }
    $('submit').disabled = true;
    const res = await fetch(setup ? '/api/auth/setup' : '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager' },
      body: JSON.stringify({ username: f.get('username'), password: f.get('password'), ...(setup ? { code: f.get('code') } : {}) })
    }).catch(() => null);
    $('submit').disabled = false;
    if (res && res.ok) return location.replace(safeNext);
    const data = res ? await res.json().catch(() => ({})) : {};
    $('err').textContent = data.error || 'Could not reach Sentry Six Manager.';
  });
})();
