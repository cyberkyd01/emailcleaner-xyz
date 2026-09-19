/* Signed-in application: connect mailboxes, build a clean, preview, confirm. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.indexOf('on') === 0) node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, v);
    });
    (children || []).flat().forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  var state = { user: null, plan: null, usage: null, accounts: [], providers: [], stream: null };
  var nf = new Intl.NumberFormat();

  function bytes(n) {
    if (!n) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0, v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + ' ' + units[i];
  }
  function splitList(v) {
    return v.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function show(node, on) { if (node) node.classList.toggle('hidden', on === false); }
  function note(node, message, kind) {
    if (!node) return;
    if (!message) { node.classList.add('hidden'); return; }
    node.className = 'note note-' + (kind || 'danger');
    node.textContent = message;
    node.classList.remove('hidden');
  }

  // --- API ---------------------------------------------------------------
  function api(path, options) {
    options = options || {};
    return fetch(path, {
      method: options.method || 'GET',
      credentials: 'same-origin',
      headers: options.body ? { 'content-type': 'application/json' } : {},
      body: options.body ? JSON.stringify(options.body) : undefined,
    }).then(function (response) {
      if (response.status === 401) {
        window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
        throw new Error('Signed out');
      }
      return response.text().then(function (text) {
        var data = text ? JSON.parse(text) : {};
        if (!response.ok) {
          var err = new Error((data.error && data.error.message) || 'Request failed');
          err.code = data.error && data.error.code;
          err.details = data.error && data.error.details;
          throw err;
        }
        return data;
      });
    });
  }

  // --- Tabs --------------------------------------------------------------
  function activateTab(name) {
    document.querySelectorAll('[data-tab]').forEach(function (section) {
      section.classList.toggle('hidden', section.getAttribute('data-tab') !== name);
    });
    document.querySelectorAll('[data-tab-link]').forEach(function (link) {
      if (link.getAttribute('data-tab-link') === name) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    if (window.location.hash.slice(1) !== name) history.replaceState({}, '', '#' + name);
  }

  document.addEventListener('click', function (event) {
    var link = event.target.closest('[data-tab-link]');
    if (!link) return;
    event.preventDefault();
    activateTab(link.getAttribute('data-tab-link'));
  });

  // --- Providers & accounts ---------------------------------------------
  function renderProviders() {
    var host = $('providers');
    host.replaceChildren(el('h3', { style: 'font-size:var(--step-0);margin-bottom:0.5rem', text: 'Connect a mailbox' }));

    state.providers.forEach(function (provider) {
      function steps(title, list) {
        if (!list || !list.length) return null;
        return el('details', {
          style: 'margin-top:0.5rem;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface)',
        }, [
          el('summary', { style: 'padding:0.6rem 0.8rem;font-weight:600;font-size:var(--step--1);cursor:pointer', text: title }),
          el('ol', { class: 'setup-steps', style: 'padding:0 0.9rem 0.9rem 1.2rem' },
            list.map(function (step) {
              return el('li', {}, [
                el('span', {}, [
                  el('strong', { text: step.title }),
                  step.detail,
                  step.link ? el('div', { style: 'margin-top:0.25rem' }, [
                    el('a', { href: step.link, target: '_blank', rel: 'noreferrer noopener', text: step.link }),
                  ]) : null,
                ]),
              ]);
            })),
        ]);
      }

      var action = provider.id === 'imap'
        ? el('button', { class: 'btn btn-primary btn-sm', onClick: function () { toggleImapForm(host); } }, ['Connect a mailbox'])
        : el('button', {
            class: 'btn btn-primary btn-sm',
            disabled: !provider.available,
            onClick: function () { startOAuth(provider.id); },
          }, ['Connect ' + provider.label.split(' ')[0]]);

      host.append(el('div', { class: 'card', style: 'margin-top:0.75rem;background:var(--surface-2)' }, [
        el('div', { class: 'cluster' }, [
          el('strong', { text: provider.label }),
          provider.available
            ? el('span', { class: 'badge badge-ok', text: 'ready' })
            : el('span', { class: 'badge badge-warn', text: 'not configured' }),
          el('span', { style: 'flex:1' }),
          action,
        ]),
        el('p', { class: 'hint', style: 'margin-top:0.4rem', text: provider.description }),
        !provider.available && provider.unavailableReason
          ? el('div', { class: 'note note-warn', style: 'margin-top:0.5rem', text: provider.unavailableReason })
          : null,
        steps('Setup for whoever runs this server (once)', provider.operatorSetup),
        steps('Setup for you, per mailbox', provider.userSetup),
      ]));
    });
  }

  function toggleImapForm(host) {
    var existing = $('imap-form');
    if (existing) { existing.remove(); return; }

    var form = el('form', { id: 'imap-form', class: 'card', style: 'margin-top:0.85rem' }, [
      el('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));--grid-gap:0.85rem' }, [
        el('div', { class: 'field', style: 'margin:0' }, [
          el('label', { for: 'imap-email', text: 'Email address' }),
          el('input', { type: 'email', id: 'imap-email', required: 'required', autocapitalize: 'none', spellcheck: 'false' }),
        ]),
        el('div', { class: 'field', style: 'margin:0' }, [
          el('label', { for: 'imap-password', text: 'App password' }),
          el('input', { type: 'password', id: 'imap-password', required: 'required' }),
        ]),
      ]),
      el('p', { id: 'imap-guidance', class: 'hint', style: 'margin-top:0.6rem', text: 'Enter your address and the server settings are looked up automatically.' }),
      el('details', { style: 'margin-top:0.7rem;border:1px solid var(--border);border-radius:var(--radius);padding:0.5rem 0.7rem' }, [
        el('summary', { style: 'cursor:pointer;font-size:var(--step--1);font-weight:600', text: 'Server settings (only if autodiscovery gets it wrong)' }),
        el('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(min(100%,140px),1fr));--grid-gap:0.6rem;margin-top:0.6rem' }, [
          el('div', { class: 'field', style: 'margin:0' }, [el('label', { for: 'imap-host', text: 'Host' }), el('input', { type: 'text', id: 'imap-host' })]),
          el('div', { class: 'field', style: 'margin:0' }, [el('label', { for: 'imap-port', text: 'Port' }), el('input', { type: 'number', id: 'imap-port' })]),
          el('div', { class: 'field', style: 'margin:0' }, [el('label', { for: 'imap-user', text: 'Username (if not the address)' }), el('input', { type: 'text', id: 'imap-user' })]),
        ]),
      ]),
      el('div', { id: 'imap-error', class: 'note note-danger hidden', style: 'margin-top:0.7rem' }),
      el('div', { class: 'cluster', style: 'margin-top:0.8rem' }, [
        el('button', { class: 'btn btn-primary', type: 'submit' }, ['Test and connect']),
      ]),
    ]);

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      button.textContent = 'Testing…';
      note($('imap-error'), null);

      api('/api/accounts/imap', {
        method: 'POST',
        body: {
          email: $('imap-email').value,
          password: $('imap-password').value,
          host: $('imap-host').value || undefined,
          port: $('imap-port').value ? Number($('imap-port').value) : undefined,
          username: $('imap-user').value || undefined,
        },
      }).then(function (result) {
        form.remove();
        return loadAccounts().then(function () {
          if (result.guidance) note($('account-error'), result.guidance, 'ok');
        });
      }).catch(function (err) {
        note($('imap-error'), err.message);
      }).finally(function () {
        button.disabled = false;
        button.textContent = 'Test and connect';
      });
    });

    form.querySelector('#imap-email').addEventListener('change', function (event) {
      var email = event.target.value;
      if (email.indexOf('@') < 0) return;
      api('/api/providers/imap/discover?email=' + encodeURIComponent(email))
        .then(function (data) {
          var s = data.settings;
          $('imap-host').placeholder = s.host;
          $('imap-port').placeholder = String(s.port);
          $('imap-guidance').textContent = s.guidance ||
            ('Found ' + s.host + ':' + s.port + ' (' + (s.source === 'ispdb' ? 'Thunderbird autoconfig' : s.source) + ').');
        })
        .catch(function () {
          $('imap-guidance').textContent = 'Could not look up that domain — enter the host and port manually below.';
        });
    });

    host.append(form);
  }

  function startOAuth(providerId) {
    note($('account-error'), null);
    api('/api/oauth/' + providerId + '/start', { method: 'POST' })
      .then(function (data) {
        var popup = window.open(data.url, 'connect-mailbox', 'width=520,height=680');
        if (!popup) {
          note($('account-error'), 'Allow pop-ups for this site, then try connecting again.');
          return;
        }
        function onMessage(event) {
          if (event.origin !== window.location.origin || !event.data || event.data.type !== 'oauth') return;
          window.removeEventListener('message', onMessage);
          if (event.data.ok) {
            note($('account-error'), 'Connected ' + event.data.email + '.', 'ok');
            loadAccounts();
          } else {
            note($('account-error'), event.data.error);
          }
        }
        window.addEventListener('message', onMessage);
      })
      .catch(function (err) { note($('account-error'), err.message); });
  }

  var PROVIDER_GLYPH = { gmail: 'G', microsoft: 'O', imap: '@' };

  function loadAccounts() {
    return api('/api/accounts').then(function (data) {
      state.accounts = data.accounts;
      var list = $('accounts');
      list.replaceChildren();

      if (!data.accounts.length) {
        list.append(el('div', { class: 'empty' }, [
          el('strong', { text: 'No mailboxes connected' }),
          'Connect one below to start cleaning.',
        ]));
      }

      data.accounts.forEach(function (account) {
        list.append(el('div', { class: 'account-row' }, [
          el('span', { class: 'provider-dot', text: PROVIDER_GLYPH[account.provider] || '@' }),
          el('div', { class: 'grow' }, [
            el('div', { class: 'email', text: account.email }),
            el('div', { class: 'meta', text: account.provider + (account.statusDetail ? ' — ' + account.statusDetail : '') }),
          ]),
          account.status === 'active'
            ? el('span', { class: 'badge badge-ok', text: 'connected' })
            : el('span', { class: 'badge badge-danger', text: account.status.replace('_', ' ') }),
          el('button', {
            class: 'btn btn-sm',
            onClick: function (event) {
              event.target.disabled = true;
              api('/api/accounts/' + account.id + '/test', { method: 'POST' })
                .then(function () { note($('account-error'), account.email + ' is working.', 'ok'); return loadAccounts(); })
                .catch(function (err) { note($('account-error'), account.email + ': ' + err.message); })
                .finally(function () { event.target.disabled = false; });
            },
          }, ['Test']),
          el('button', {
            class: 'btn btn-sm btn-danger',
            onClick: function () {
              if (!confirm('Disconnect ' + account.email + '? Saved rules and history for it are removed too. No mail is deleted.')) return;
              api('/api/accounts/' + account.id, { method: 'DELETE' }).then(loadAccounts);
            },
          }, ['Disconnect']),
        ]));
      });

      var select = $('account-select');
      var previous = select.value;
      select.replaceChildren.apply(select, data.accounts.map(function (a) {
        return el('option', { value: a.id, text: a.email + ' (' + a.provider + ')' });
      }));
      if (data.accounts.some(function (a) { return a.id === previous; })) select.value = previous;

      show($('no-mailbox'), data.accounts.length === 0);
      if (data.accounts.length) {
        return Promise.all([loadSections(), loadRules(), loadHistory()]);
      }
      return null;
    });
  }

  // --- Sections ----------------------------------------------------------
  function loadSections() {
    var accountId = $('account-select').value;
    if (!accountId) return Promise.resolve();
    var host = $('sections');
    host.replaceChildren(el('p', { class: 'hint' }, [el('span', { class: 'spinner' }), ' Reading folders…']));

    return api('/api/accounts/' + accountId + '/sections')
      .then(function (data) {
        var sections = data.sections.sort(function (a, b) {
          return Number(b.cleanableByDefault) - Number(a.cleanableByDefault) || a.role.localeCompare(b.role);
        });
        state.sections = sections;
        host.replaceChildren.apply(host, sections.map(function (section) {
          // The tile is a div, not a label: a label would swallow clicks on the
          // "Empty all" button and toggle the checkbox instead.
          return el('div', { class: 'section-tile' }, [
            el('label', { class: 'section-pick' }, [
              el('input', { type: 'checkbox', value: section.role, class: 'section-check' }),
              el('span', {}, [
                el('span', { class: 'name', text: section.role }),
                el('div', { class: 'count', text: nf.format(section.messages) + ' messages' }),
                el('div', { class: 'count', text: section.folders.slice(0, 3).join(', ') }),
                !section.cleanableByDefault
                  ? el('div', { class: 'count', style: 'color:var(--warn-fg)', text: 'protected — think twice' })
                  : null,
              ]),
            ]),
            el('button', {
              class: 'btn btn-sm section-empty',
              type: 'button',
              title: 'Delete everything in ' + section.role,
              onClick: function () { emptySection(section); },
            }, ['Empty all']),
          ]);
        }));
      })
      .catch(function (err) {
        host.replaceChildren(el('div', { class: 'note note-danger', text: err.message }));
      });
  }

  /**
   * Clears an entire section, ignoring whatever filters are typed above. It
   * still goes through the normal preview-and-confirm path, so nothing is
   * deleted without being counted and approved first.
   */
  function emptySection(section) {
    note($('clean-error'), null);
    var warn = section.cleanableByDefault
      ? ''
      : '\n\nThis is a protected section — it holds mail you sent or filed.';
    if (!confirm(
      'Empty the entire "' + section.role + '" section?\n\n' +
      'Roughly ' + nf.format(section.messages) + ' messages.' + warn +
      '\n\nYou will see an exact count and can cancel before anything is deleted.'
    )) return;

    api('/api/jobs', {
      method: 'POST',
      body: {
        accountId: $('account-select').value,
        // Folder only: no keyword, date or size filter, so it matches the lot.
        query: {
          folders: [section.role],
          excludeStarred: $('exclude-starred').checked,
          excludeImportant: $('exclude-starred').checked,
        },
        mode: $('mode').value,
      },
    })
      .then(function (data) { watchJob(data.job.id); })
      .catch(function (err) {
        note($('clean-error'), err.message + (err.details ? ' — ' + JSON.stringify(err.details) : ''));
      });
  }

  /** Empties every ticked section in one job. */
  function emptySelectedSections() {
    var roles = Array.prototype.slice.call(document.querySelectorAll('.section-check:checked'))
      .map(function (i) { return i.value; });
    if (!roles.length) {
      return note($('clean-error'), 'Tick at least one section first.');
    }
    note($('clean-error'), null);
    if (!confirm(
      'Empty these sections completely?\n\n  ' + roles.join('\n  ') +
      '\n\nAll filters above are ignored. You will see an exact count before anything is deleted.'
    )) return;

    api('/api/jobs', {
      method: 'POST',
      body: {
        accountId: $('account-select').value,
        query: {
          folders: roles,
          excludeStarred: $('exclude-starred').checked,
          excludeImportant: $('exclude-starred').checked,
        },
        mode: $('mode').value,
      },
    })
      .then(function (data) { watchJob(data.job.id); })
      .catch(function (err) {
        note($('clean-error'), err.message + (err.details ? ' — ' + JSON.stringify(err.details) : ''));
      });
  }

  $('empty-selected').addEventListener('click', emptySelectedSections);

  $('select-default-sections').addEventListener('click', function () {
    var cleanable = {};
    (state.sections || []).forEach(function (s) { cleanable[s.role] = s.cleanableByDefault; });
    document.querySelectorAll('.section-check').forEach(function (box) {
      box.checked = cleanable[box.value] === true;
    });
  });

  $('account-select').addEventListener('change', function () {
    loadSections(); loadRules(); loadHistory();
  });

  // --- Query -------------------------------------------------------------
  function buildQuery() {
    var folders = Array.prototype.slice.call(document.querySelectorAll('.section-check:checked'))
      .map(function (i) { return i.value; });
    var query = {
      folders: folders,
      keywords: splitList($('keywords').value),
      keywordMatch: $('keyword-match').value,
      keywordScope: $('keyword-scope').value,
      from: splitList($('from').value),
      excludeKeywords: splitList($('exclude-keywords').value),
      excludeStarred: $('exclude-starred').checked,
      excludeImportant: $('exclude-starred').checked,
      readState: $('read-state').value,
    };
    if ($('older-than').value) query.olderThanDays = Number($('older-than').value);
    if ($('larger-than').value) query.largerThanBytes = Math.round(Number($('larger-than').value) * 1024 * 1024);
    return query;
  }

  $('explain-btn').addEventListener('click', function () {
    note($('clean-error'), null);
    var host = $('explain');
    host.replaceChildren(el('p', { class: 'hint' }, [el('span', { class: 'spinner' }), ' Checking…']));
    show(host, true);

    api('/api/jobs/explain', { method: 'POST', body: { accountId: $('account-select').value, query: buildQuery() } })
      .then(function (result) {
        host.replaceChildren.apply(host, [
          el('div', { class: 'note note-ok', text: result.description }),
          el('div', { class: 'cluster', style: '--cluster-gap:0.35rem;margin-top:0.5rem' },
            result.folders.map(function (f) {
              return el('span', {
                class: 'badge badge-neutral',
                text: f.path + (f.messageCount !== null ? ' · ' + nf.format(f.messageCount) : ''),
              });
            })),
        ].concat(
          result.warnings.map(function (w) { return el('div', { class: 'note note-warn', style: 'margin-top:0.5rem', text: w }); }),
          result.notes.length
            ? [el('ul', { class: 'hint', style: 'margin-top:0.6rem;padding-left:1.1rem' },
                result.notes.map(function (n) { return el('li', { text: n }); }))]
            : []
        ));
      })
      .catch(function (err) {
        show(host, false);
        note($('clean-error'), err.message + (err.details ? ' — ' + JSON.stringify(err.details) : ''));
      });
  });

  $('preview-btn').addEventListener('click', function () {
    note($('clean-error'), null);
    api('/api/jobs', {
      method: 'POST',
      body: { accountId: $('account-select').value, query: buildQuery(), mode: $('mode').value },
    })
      .then(function (data) { watchJob(data.job.id); })
      .catch(function (err) {
        note($('clean-error'), err.message + (err.details ? ' — ' + JSON.stringify(err.details) : ''));
      });
  });

  // --- Job progress ------------------------------------------------------
  var STATUS_TEXT = {
    queued: 'Queued — waiting for a worker',
    previewing: 'Counting matches. Nothing has been deleted.',
    awaiting_confirm: 'Preview ready. Nothing has been deleted yet.',
    queued_execute: 'Confirmed — waiting for a worker',
    running: 'Deleting…',
    completed: 'Done.',
    failed: 'Failed.',
    cancelled: 'Cancelled.',
    undoing: 'Restoring…',
    undone: 'Restored.',
  };

  function watchJob(jobId) {
    activateTab('clean');
    show($('job-card'), true);
    $('job-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (state.stream) state.stream.close();

    var stream = new EventSource('/api/jobs/' + jobId + '/events');
    state.stream = stream;
    stream.onmessage = function (event) {
      var job = JSON.parse(event.data);
      renderJob(job);
      if (['completed', 'failed', 'cancelled', 'undone'].indexOf(job.status) >= 0) {
        stream.close();
        loadHistory();
      }
    };
    stream.onerror = function () { stream.close(); };
  }

  function renderJob(job) {
    var body = $('job-body');
    var stats = job.stats || {};
    var progress = stats.progress || {};
    var busy = ['queued', 'previewing', 'queued_execute', 'running', 'undoing'].indexOf(job.status) >= 0;
    var nodes = [];

    nodes.push(el('div', { class: 'stat-row' }, [
      el('div', { class: 'stat' }, [
        el('div', { class: 'value', text: nf.format(job.matched) }),
        el('div', { class: 'label', text: 'will be deleted' }),
      ]),
      el('div', { class: 'stat' }, [
        el('div', { class: 'value', text: bytes(stats.bytes || 0) }),
        el('div', { class: 'label', text: 'space freed' }),
      ]),
      job.deleted > 0 ? el('div', { class: 'stat' }, [
        el('div', { class: 'value', text: nf.format(job.deleted) }),
        el('div', { class: 'label', text: 'deleted' }),
      ]) : null,
      job.failed > 0 ? el('div', { class: 'stat' }, [
        el('div', { class: 'value', style: 'color:var(--danger-fg)', text: nf.format(job.failed) }),
        el('div', { class: 'label', text: 'failed' }),
      ]) : null,
    ]));

    var kind = job.status === 'failed' ? 'danger' : job.status === 'completed' ? 'ok' : 'warn';
    nodes.push(el('div', { class: 'note note-' + kind },
      [(STATUS_TEXT[job.status] || job.status) + (progress.scanned ? ' — scanned ' + nf.format(progress.scanned) + ' so far' : '')]));

    if (busy) nodes.push(el('progress'));
    if (job.error) nodes.push(el('div', { class: 'note note-danger', text: job.error }));
    if (stats.description) nodes.push(el('p', { class: 'hint mono', text: stats.description }));

    (stats.warnings || []).forEach(function (w) {
      nodes.push(el('div', { class: 'note note-warn', text: w }));
    });

    if (job.truncated) {
      nodes.push(el('div', { class: 'note note-warn', text: 'More messages match than this run can track. Confirming deletes the tracked batch; run it again afterwards to continue.' }));
    }

    if (stats.byFolder && stats.byFolder.length) {
      nodes.push(el('div', { class: 'table-wrap', style: 'margin-top:0.75rem' }, [
        el('table', {}, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: 'Folder' }), el('th', { text: 'Role' }),
            el('th', { class: 'num', text: 'Messages' }), el('th', { class: 'num', text: 'Size' }),
          ])]),
          el('tbody', {}, stats.byFolder.map(function (f) {
            return el('tr', {}, [
              el('td', { text: f.path }),
              el('td', { class: 'muted', text: f.role }),
              el('td', { class: 'num', text: nf.format(f.matched) }),
              el('td', { class: 'num', text: bytes(f.bytes) }),
            ]);
          })),
        ]),
      ]));
    }

    if (stats.sample && stats.sample.length) {
      nodes.push(el('h3', { style: 'font-size:var(--step-0);margin:1.1rem 0 0.4rem', text: 'Sample of what would go' }));
      nodes.push(el('div', { class: 'table-wrap' }, [
        el('table', {}, [
          el('thead', {}, [el('tr', {}, [el('th', { text: 'From' }), el('th', { text: 'Subject' }), el('th', { text: 'Date' })])]),
          el('tbody', {}, stats.sample.map(function (m) {
            return el('tr', {}, [
              el('td', { class: 'muted', text: m.from || '—' }),
              el('td', { text: m.subject || '(no subject)' }),
              el('td', { class: 'muted', text: m.sentAt ? new Date(m.sentAt).toLocaleDateString() : '—' }),
            ]);
          })),
        ]),
      ]));
    }

    var actions = el('div', { class: 'cluster', style: 'margin-top:1.1rem' });

    if (job.status === 'awaiting_confirm' && job.matched > 0) {
      actions.append(el('button', {
        class: 'btn btn-primary',
        onClick: function (event) {
          var permanent = job.mode === 'permanent';
          var prompt = permanent
            ? 'Permanently delete ' + nf.format(job.matched) + ' messages? This cannot be undone.'
            : 'Move ' + nf.format(job.matched) + ' messages to Trash?';
          if (!confirm(prompt)) return;
          event.target.disabled = true;
          api('/api/jobs/' + job.id + '/confirm', { method: 'POST', body: {} })
            .then(function () { watchJob(job.id); })
            .catch(function (err) {
              if (err.code === 'conflict' && /safety limit/.test(err.message) && confirm(err.message + '\n\nProceed anyway?')) {
                return api('/api/jobs/' + job.id + '/confirm', { method: 'POST', body: { acknowledgeLargeDelete: true } })
                  .then(function () { watchJob(job.id); });
              }
              alert(err.message);
              event.target.disabled = false;
            });
        },
      }, [job.mode === 'permanent' ? 'Delete permanently' : 'Move to Trash']));
    }

    if (['queued', 'previewing', 'awaiting_confirm', 'queued_execute'].indexOf(job.status) >= 0) {
      actions.append(el('button', {
        class: 'btn',
        onClick: function () { api('/api/jobs/' + job.id + '/cancel', { method: 'POST' }).then(function () { watchJob(job.id); }); },
      }, ['Cancel']));
    }

    if (job.status === 'completed' && job.mode === 'trash' && job.deleted > 0) {
      actions.append(el('button', {
        class: 'btn',
        onClick: function () { api('/api/jobs/' + job.id + '/undo', { method: 'POST' }).then(function () { watchJob(job.id); }); },
      }, ['Undo — put ' + nf.format(job.deleted) + ' back']));
    }

    nodes.push(actions);
    body.replaceChildren.apply(body, nodes.filter(Boolean));
  }

  // --- Rules -------------------------------------------------------------
  $('save-rule').addEventListener('click', function () {
    note($('rule-error'), null);
    api('/api/rules', {
      method: 'POST',
      body: {
        accountId: $('account-select').value,
        name: $('rule-name').value || 'Untitled rule',
        query: buildQuery(),
        mode: $('mode').value,
        scheduleCron: $('rule-cron').value || null,
        autoConfirm: $('rule-auto').checked,
      },
    })
      .then(function () { $('rule-name').value = ''; $('rule-cron').value = ''; return loadRules(); })
      .catch(function (err) {
        note($('rule-error'), err.message + (err.details ? ' — ' + JSON.stringify(err.details) : ''));
      });
  });

  function loadRules() {
    var accountId = $('account-select').value;
    if (!accountId) return Promise.resolve();
    return api('/api/rules?accountId=' + encodeURIComponent(accountId)).then(function (data) {
      var host = $('rules');
      if (!data.rules.length) {
        host.replaceChildren(el('div', { class: 'empty' }, [
          el('strong', { text: 'No saved rules' }),
          'Build a filter on the Clean tab, then save it here.',
        ]));
        return;
      }
      host.replaceChildren(el('div', { class: 'table-wrap' }, [
        el('table', {}, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: 'Rule' }), el('th', { text: 'What it matches' }),
            el('th', { text: 'Schedule' }), el('th', { text: '' }),
          ])]),
          el('tbody', {}, data.rules.map(function (rule) {
            return el('tr', {}, [
              el('td', {}, [
                el('strong', { text: rule.name }),
                el('div', { class: 'muted', text: rule.mode === 'permanent' ? 'permanent delete' : 'move to trash' }),
              ]),
              el('td', { class: 'muted mono', text: rule.description }),
              el('td', { class: 'muted' }, [
                rule.scheduleCron ? el('div', { class: 'mono', text: rule.scheduleCron }) : 'manual',
                rule.nextRunAt ? el('div', { text: 'next ' + new Date(rule.nextRunAt).toLocaleString() }) : null,
                rule.autoConfirm ? el('div', { style: 'color:var(--warn-fg)', text: 'runs unattended' }) : null,
              ]),
              el('td', {}, [el('div', { class: 'cluster', style: '--cluster-gap:0.4rem' }, [
                el('button', {
                  class: 'btn btn-sm',
                  onClick: function () {
                    api('/api/rules/' + rule.id + '/run', { method: 'POST' })
                      .then(function (data) { watchJob(data.job.id); })
                      .catch(function (err) { alert(err.message); });
                  },
                }, ['Run']),
                el('button', {
                  class: 'btn btn-sm btn-danger',
                  onClick: function () { api('/api/rules/' + rule.id, { method: 'DELETE' }).then(loadRules); },
                }, ['Delete']),
              ])]),
            ]);
          })),
        ]),
      ]));
    });
  }

  function loadHistory() {
    var accountId = $('account-select').value;
    if (!accountId) return Promise.resolve();
    return api('/api/jobs?accountId=' + encodeURIComponent(accountId) + '&limit=25').then(function (data) {
      var host = $('history');
      if (!data.jobs.length) {
        host.replaceChildren(el('div', { class: 'empty' }, [
          el('strong', { text: 'Nothing run yet' }),
          'Your cleaning history will appear here.',
        ]));
        return;
      }
      host.replaceChildren(el('div', { class: 'table-wrap' }, [
        el('table', {}, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: 'When' }), el('th', { text: 'What' }), el('th', { text: 'Status' }),
            el('th', { class: 'num', text: 'Matched' }), el('th', { class: 'num', text: 'Deleted' }), el('th', { text: '' }),
          ])]),
          el('tbody', {}, data.jobs.map(function (job) {
            var badge = job.status === 'completed' ? 'ok' : job.status === 'failed' ? 'danger' : 'warn';
            return el('tr', {}, [
              el('td', { class: 'muted nowrap', text: new Date(job.createdAt).toLocaleString() }),
              el('td', { class: 'mono muted', text: (job.stats && job.stats.description ? job.stats.description : '').slice(0, 90) }),
              el('td', {}, [el('span', { class: 'badge badge-' + badge, text: job.status.replace('_', ' ') })]),
              el('td', { class: 'num', text: nf.format(job.matched) }),
              el('td', { class: 'num', text: nf.format(job.deleted) }),
              el('td', {}, [el('button', { class: 'btn btn-sm btn-ghost', onClick: function () { watchJob(job.id); } }, ['View'])]),
            ]);
          })),
        ]),
      ]));
    });
  }

  // --- Settings: plan ----------------------------------------------------
  function renderPlan() {
    if (!state.plan) return;
    $('plan-badge').textContent = state.unlimited ? 'Admin — no limits' : state.plan.name;
    $('plan-tagline').textContent = state.unlimited
      ? 'Administrator accounts are not subject to plan quotas on this deployment.'
      : state.plan.tagline;

    var limits = state.plan.limits;
    var usage = state.usage || {};
    // An admin has no ceiling, so show the counts without a bar to fill.
    var noCap = state.unlimited === true;
    var meters = [
      { k: 'Mailboxes', used: usage.mailboxes || 0, limit: noCap ? null : limits.mailboxes },
      { k: 'Jobs (30 days)', used: usage.jobsLast30Days || 0, limit: noCap ? null : limits.jobsPerMonth },
      { k: 'Saved rules', used: usage.rules || 0, limit: noCap ? null : limits.rules },
    ];

    $('quota-meters').replaceChildren.apply($('quota-meters'), meters.map(function (m) {
      var unlimited = m.limit === null || m.limit === undefined;
      var pct = unlimited ? 0 : Math.min(100, Math.round((m.used / Math.max(m.limit, 1)) * 100));
      var cls = pct >= 100 ? ' full' : pct >= 80 ? ' warn' : '';
      return el('div', { class: 'meter' }, [
        el('div', { class: 'meter-head' }, [
          el('span', { class: 'k', text: m.k }),
          el('span', { class: 'tabular', text: nf.format(m.used) + (unlimited ? ' / unlimited' : ' / ' + nf.format(m.limit)) }),
        ]),
        el('div', { class: 'meter-track' }, [
          el('div', { class: 'meter-fill' + cls, style: 'width:' + (unlimited ? 4 : pct) + '%' }),
        ]),
      ]);
    }));
  }

  // --- Settings: two-factor ---------------------------------------------
  function renderTwoFactor() {
    var host = $('tfa-body');
    note($('tfa-error'), null);

    if (state.user.twoFactorEnabled) {
      host.replaceChildren(
        el('div', { class: 'cluster', style: 'margin-bottom:1rem' }, [
          el('span', { class: 'badge badge-ok', text: 'enabled' }),
          el('span', { class: 'muted', style: 'font-size:var(--step--1)',
            text: state.user.backupCodesRemaining + ' recovery code' + (state.user.backupCodesRemaining === 1 ? '' : 's') + ' remaining' }),
        ]),
        el('div', { class: 'cluster' }, [
          el('button', { class: 'btn btn-sm', onClick: regenerateCodes }, ['Generate new recovery codes']),
          el('button', { class: 'btn btn-sm btn-danger', onClick: disableTwoFactor }, ['Turn off two-factor']),
        ]),
      );
      return;
    }

    host.replaceChildren(
      el('p', { class: 'muted', style: 'font-size:var(--step--1);margin-bottom:1rem',
        text: 'Use any authenticator app — 1Password, Authy, Google Authenticator, or your password manager.' }),
      el('button', { class: 'btn btn-primary', onClick: beginSetup }, ['Set up two-factor authentication']),
    );
  }

  function beginSetup(event) {
    event.target.disabled = true;
    api('/api/auth/2fa/setup', { method: 'POST' })
      .then(function (setup) {
        var host = $('tfa-body');
        host.replaceChildren(
          el('div', { class: 'qr-panel' }, [
            el('div', { class: 'qr-box', html: setup.qrSvg }),
            el('div', {}, [
              el('h3', { style: 'font-size:var(--step-0);margin-bottom:0.4rem', text: '1. Scan this code' }),
              el('p', { class: 'hint', style: 'margin-bottom:0.9rem', text: 'Or enter this key manually if you cannot scan:' }),
              el('div', { class: 'secret-box', text: setup.secret }),
              el('h3', { style: 'font-size:var(--step-0);margin:1.25rem 0 0.4rem', text: '2. Enter the 6-digit code' }),
              el('div', { class: 'cluster' }, [
                el('input', { type: 'text', id: 'tfa-code', class: 'input otp-input', inputmode: 'numeric',
                  maxlength: '6', autocomplete: 'one-time-code', style: 'max-width:200px' }),
                el('button', { class: 'btn btn-primary', onClick: confirmSetup }, ['Confirm']),
              ]),
            ]),
          ]),
        );
        $('tfa-code').focus();
      })
      .catch(function (err) { note($('tfa-error'), err.message); event.target.disabled = false; });
  }

  function confirmSetup(event) {
    var code = $('tfa-code').value.trim();
    if (!code) return note($('tfa-error'), 'Enter the code from your authenticator app.');
    event.target.disabled = true;
    note($('tfa-error'), null);

    api('/api/auth/2fa/confirm', { method: 'POST', body: { code: code } })
      .then(function (data) {
        state.user.twoFactorEnabled = true;
        state.user.backupCodesRemaining = data.backupCodes.length;
        showBackupCodes(data.backupCodes, 'Two-factor authentication is on.');
      })
      .catch(function (err) { note($('tfa-error'), err.message); event.target.disabled = false; });
  }

  function showBackupCodes(codes, headline) {
    note($('tfa-notice'), headline + ' Save these recovery codes now — they are shown only once.', 'ok');
    $('tfa-body').replaceChildren(
      el('p', { class: 'muted', style: 'font-size:var(--step--1);margin-bottom:0.75rem',
        text: 'Each code works once. Keep them somewhere you can reach without your phone.' }),
      el('div', { class: 'codes-grid' }, codes.map(function (c) { return el('span', { text: c }); })),
      el('div', { class: 'cluster', style: 'margin-top:1rem' }, [
        el('button', {
          class: 'btn btn-sm',
          onClick: function () {
            navigator.clipboard.writeText(codes.join('\n')).then(function () {
              note($('tfa-notice'), 'Recovery codes copied to your clipboard.', 'ok');
            });
          },
        }, ['Copy codes']),
        el('button', {
          class: 'btn btn-sm btn-primary',
          onClick: function () { note($('tfa-notice'), null); renderTwoFactor(); },
        }, ['I have saved them']),
      ]),
    );
  }

  function disableTwoFactor() {
    var password = prompt('Confirm your password to turn off two-factor authentication:');
    if (!password) return;
    api('/api/auth/2fa/disable', { method: 'POST', body: { password: password } })
      .then(function () {
        state.user.twoFactorEnabled = false;
        state.user.backupCodesRemaining = 0;
        note($('tfa-notice'), 'Two-factor authentication is off.', 'warn');
        renderTwoFactor();
      })
      .catch(function (err) { note($('tfa-error'), err.message); });
  }

  function regenerateCodes() {
    var password = prompt('Confirm your password to generate new recovery codes:');
    if (!password) return;
    api('/api/auth/2fa/backup-codes', { method: 'POST', body: { password: password } })
      .then(function (data) {
        state.user.backupCodesRemaining = data.backupCodes.length;
        showBackupCodes(data.backupCodes, 'New recovery codes generated. The old ones no longer work.');
      })
      .catch(function (err) { note($('tfa-error'), err.message); });
  }

  // --- Settings: password ------------------------------------------------
  $('password-form').addEventListener('submit', function (event) {
    event.preventDefault();
    note($('pw-error'), null); note($('pw-notice'), null);
    api('/api/auth/password', {
      method: 'POST',
      body: { currentPassword: $('current-password').value, newPassword: $('new-password').value },
    })
      .then(function () {
        $('current-password').value = ''; $('new-password').value = '';
        note($('pw-notice'), 'Password changed.', 'ok');
      })
      .catch(function (err) { note($('pw-error'), err.message); });
  });

  $('logout').addEventListener('click', function () {
    api('/api/auth/logout', { method: 'POST' }).finally(function () { window.location.href = '/'; });
  });

  // --- Boot --------------------------------------------------------------
  api('/api/auth/me')
    .then(function (data) {
      state.user = data.user;
      state.plan = data.plan;
      state.usage = data.usage;
      state.unlimited = data.unlimited === true;

      $('user-email').textContent = data.user.email;
      $('user-avatar').textContent = (data.user.email[0] || '?');
      if (data.user.isAdmin) $('admin-link').classList.remove('hidden');

      if (data.user.status === 'suspended') {
        note($('global-notice'), 'This account is suspended. Contact support.', 'danger');
      }

      renderPlan();
      renderTwoFactor();

      return api('/api/providers').then(function (p) {
        state.providers = p.providers;
        renderProviders();
        return loadAccounts();
      });
    })
    .then(function () {
      var hash = window.location.hash.slice(1);
      activateTab(['clean', 'mailboxes', 'rules', 'history', 'settings'].indexOf(hash) >= 0 ? hash : 'clean');
    })
    .catch(function (err) {
      if (err.message !== 'Signed out') note($('global-notice'), err.message, 'danger');
    });
})();
