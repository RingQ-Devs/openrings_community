// OpenRings Community — progressive enhancements (the site works without JS).
(function () {
  const base = document.querySelector('link[href$="/static/css/style.css"]')?.getAttribute('href')?.replace(/\/static\/css\/style\.css$/, '') || '';
  const csrf = () => document.querySelector('input[name=_csrf]')?.value || '';

  // Light / dark switch (same behaviour and storage key as openrings.org)
  const root = document.documentElement;
  document.getElementById('theme')?.addEventListener('click', () => {
    const cur = root.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const next = cur === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    try {
      localStorage.setItem('or-theme', next);
    } catch {}
  });

  // Mobile menu
  const nav = document.getElementById('nav');
  const menu = document.getElementById('menu');
  menu?.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    menu.setAttribute('aria-expanded', String(open));
  });

  // Close user menu on outside click
  document.addEventListener('click', (e) => {
    document.querySelectorAll('details.user-menu[open]').forEach((d) => {
      if (!d.contains(e.target)) d.removeAttribute('open');
    });
  });

  // Confirm dangerous actions (delegated, so it also works for posts added live)
  document.addEventListener('submit', (e) => {
    const form = e.target.closest('form[data-confirm]');
    if (form && !confirm(form.dataset.confirm)) e.preventDefault();
  });

  // Markdown editor helpers
  function wrap(textarea, before, after = before, placeholder = '') {
    const { selectionStart: s, selectionEnd: e, value } = textarea;
    const selected = value.slice(s, e) || placeholder;
    textarea.setRangeText(before + selected + after, s, e, 'end');
    textarea.focus();
    textarea.setSelectionRange(s + before.length, s + before.length + selected.length);
  }
  function prefixLines(textarea, prefixFn) {
    const { selectionStart: s, selectionEnd: e, value } = textarea;
    const start = value.lastIndexOf('\n', s - 1) + 1;
    const lines = value.slice(start, e).split('\n').map((l, i) => prefixFn(i) + l).join('\n');
    textarea.setRangeText(lines, start, e, 'end');
    textarea.focus();
  }

  document.querySelectorAll('[data-editor]').forEach((editor) => {
    const textarea = editor.querySelector('textarea');
    const preview = editor.querySelector('.editor-preview');
    editor.querySelectorAll('[data-md]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const kind = btn.dataset.md;
        if (kind === 'bold') wrap(textarea, '**', '**', 'bold text');
        if (kind === 'italic') wrap(textarea, '_', '_', 'italic text');
        if (kind === 'code') {
          const sel = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
          sel.includes('\n') ? wrap(textarea, '```\n', '\n```', '') : wrap(textarea, '`', '`', 'code');
        }
        if (kind === 'link') wrap(textarea, '[', '](https://)', 'link text');
        if (kind === 'list') prefixLines(textarea, (i) => `${i + 1}. `);
        if (kind === 'quote') prefixLines(textarea, () => '> ');
      }),
    );
    editor.querySelectorAll('[data-tab]').forEach((tab) =>
      tab.addEventListener('click', async () => {
        editor.querySelectorAll('[data-tab]').forEach((t) => t.classList.toggle('is-active', t === tab));
        const showPreview = tab.dataset.tab === 'preview';
        textarea.hidden = showPreview;
        preview.hidden = !showPreview;
        if (showPreview) {
          preview.textContent = 'Loading preview…';
          try {
            const res = await fetch(base + '/preview', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
              body: JSON.stringify({ body: textarea.value }),
            });
            const data = await res.json();
            preview.innerHTML = data.html || '<p class="muted">Nothing to preview.</p>';
          } catch {
            preview.textContent = 'Preview unavailable.';
          }
        }
      }),
    );
  });

  // Quote a post into the reply box (delegated)
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-quote]');
    if (!btn) return;
    const textarea = document.getElementById('reply-body');
    const src = document.getElementById(btn.dataset.quoteSrc);
    if (!textarea || !src) return;
    const text = src.content.textContent.trim().split('\n').map((l) => '> ' + l).join('\n');
    textarea.value += (textarea.value ? '\n\n' : '') + `> **@${btn.dataset.quote} wrote:**\n${text}\n\n`;
    textarea.focus();
    textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  // Like without reloading (delegated)
  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-like]');
    if (!form) return;
    e.preventDefault();
    const btn = form.querySelector('button');
    try {
      const res = await fetch(form.action, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(new FormData(form)),
      });
      if (!res.ok) return;
      const { liked, count } = await res.json();
      btn.classList.toggle('is-liked', liked);
      btn.setAttribute('aria-pressed', String(liked));
      btn.querySelector('[data-like-label]').textContent = liked ? 'Liked' : 'Like';
      const id = form.action.match(/posts\/(\d+)/)[1];
      const counter = document.querySelector(`[data-like-count="${id}"]`);
      if (counter) counter.textContent = count ? `${count} ${count === 1 ? 'like' : 'likes'}` : '';
    } catch {
      form.submit();
    }
  });

  // Live thread: new replies appear without reloading the page.
  const postsEl = document.querySelector('[data-posts][data-live]');
  if (postsEl) {
    const threadId = postsEl.dataset.threadId;
    const statusEl = document.querySelector('[data-live-status]');
    let after = Number(postsEl.dataset.lastPost) || 0;
    let lastActivity = Date.now();
    const nextDelay = () => {
      const idle = Date.now() - lastActivity;
      return idle < 3 * 60_000 ? 3000 : idle < 15 * 60_000 ? 15_000 : 60_000;
    };
    const poll = async () => {
      if (!document.hidden) {
        try {
          const res = await fetch(`${base}/threads/${threadId}/live?after=${after}`, { headers: { Accept: 'application/json' } });
          if (res.ok) {
            const data = await res.json();
            for (const p of data.posts) {
              if (document.getElementById(`post-${p.id}`)) continue;
              postsEl.insertAdjacentHTML('beforeend', p.html);
              const el = document.getElementById(`post-${p.id}`);
              el?.classList.add('post--new');
              after = Math.max(after, p.id);
              lastActivity = Date.now();
            }
            const countEl = document.querySelector('[data-reply-count]');
            if (countEl && Number.isInteger(data.replyCount)) countEl.textContent = `${data.replyCount} ${data.replyCount === 1 ? 'reply' : 'replies'}`;
            if (statusEl) statusEl.hidden = !data.pending;
            if (data.pending) lastActivity = Date.now();
          }
        } catch {
          // offline for a moment: try again later
        }
      }
      setTimeout(poll, nextDelay());
    };
    setTimeout(poll, 1500);
  }

  // Admin → AI provider: show only the selected provider's settings.
  const providerSelect = document.querySelector('[data-provider-select]');
  if (providerSelect) {
    const sync = () =>
      document.querySelectorAll('[data-provider-section]').forEach((el) => {
        el.hidden = el.dataset.providerSection !== providerSelect.value;
      });
    providerSelect.addEventListener('change', sync);
    sync();
  }

})();
