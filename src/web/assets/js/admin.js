/* Admin dashboard. Charts are hand-built inline SVG — no chart library, and no
   dual-axis: signups and jobs are different scales, so they get one chart each. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var SVG_NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.indexOf('on') === 0) node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, v);
    });
    (children || []).flat().forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.append(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function svg(tag, attrs, children) {
    var node = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (attrs[k] === null || attrs[k] === undefined || attrs[k] === false) return;
      node.setAttribute(k, String(attrs[k]));
    });
    (children || []).flat().forEach(function (c) { if (c) node.append(c); });
    return node;
  }

  var nf = new Intl.NumberFormat();
  function bytes(n) {
    if (!n) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0, v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + ' ' + units[i];
  }
  function money(cents) {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
      .format(cents / 100);
  }
  function ago(iso) {
    if (!iso) return 'never';
    var secs = (Date.now() - new Date(iso).getTime()) / 1000;
    if (secs < 60) return 'just now';
    if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
    if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
    return Math.floor(secs / 86400) + 'd ago';
  }
  function note(node, message, kind) {
    if (!message) { node.classList.add('hidden'); return; }
    node.className = 'note note-' + (kind || 'danger');
    node.textContent = message;
    node.classList.remove('hidden');
  }

  /* Palette validated with the dataviz validator against both surfaces.
     Slots are assigned by identity and never cycled or re-ranked. */
  function isDark() {
    var explicit = document.documentElement.getAttribute('data-theme');
    if (explicit) return explicit === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function palette() {
    return isDark()
      ? { s1: '#3987e5', s2: '#d95926', s3: '#199e70', grid: '#26303d', ink: '#96a3b4', surface: '#131a24' }
      : { s1: '#2a78d6', s2: '#eb6834', s3: '#1baf7a', grid: '#dfe4ec', ink: '#5b6875', surface: '#ffffff' };
  }

  function api(path, options) {
    options = options || {};
    return fetch(path, {
      method: options.method || 'GET',
      credentials: 'same-origin',
      headers: options.body ? { 'content-type': 'application/json' } : {},
      body: options.body ? JSON.stringify(options.body) : undefined,
    }).then(function (response) {
      if (response.status === 401) { window.location.href = '/login?next=/admin'; throw new Error('Signed out'); }
      return response.text().then(function (text) {
        var data = text ? JSON.parse(text) : {};
        if (!response.ok) throw new Error((data.error && data.error.message) || 'Request failed');
        return data;
      });
    });
  }

  // =====================================================================
  // Charts
  // =====================================================================

  /**
   * Single-series area + line over time. One measure per chart: signups and
   * jobs have different scales, and a second y-axis would make the comparison
   * meaningless, so each gets its own.
   */
  function timeChart(container, points, valueKey, color, label) {
    container.replaceChildren();

    var W = 520, H = 170;
    var pad = { top: 12, right: 10, bottom: 24, left: 34 };
    var iw = W - pad.left - pad.right;
    var ih = H - pad.top - pad.bottom;

    var values = points.map(function (p) { return p[valueKey]; });
    var max = Math.max.apply(null, values.concat([1]));
    // Round the top of the scale up so the axis reads in whole numbers.
    var step = Math.max(1, Math.ceil(max / 4));
    var top = step * 4;

    var x = function (i) { return pad.left + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw); };
    var y = function (v) { return pad.top + ih - (v / top) * ih; };

    var root = svg('svg', {
      class: 'chart', viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'xMidYMid meet',
      role: 'img', 'aria-label': label + ': ' + values.reduce(function (a, b) { return a + b; }, 0) + ' over the last 30 days',
    });

    // Recessive gridlines and axis labels.
    for (var g = 0; g <= 4; g++) {
      var gv = (top / 4) * g;
      root.append(svg('line', {
        x1: pad.left, x2: W - pad.right, y1: y(gv), y2: y(gv),
        stroke: palette().grid, 'stroke-width': 1, 'shape-rendering': 'crispEdges',
      }));
      root.append(svg('text', {
        x: pad.left - 6, y: y(gv) + 3.5, 'text-anchor': 'end',
        'font-size': 9, fill: palette().ink,
      }, [document.createTextNode(String(Math.round(gv)))]));
    }

    var line = points.map(function (p, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p[valueKey]).toFixed(1); }).join(' ');
    var area = line + ' L' + x(points.length - 1).toFixed(1) + ' ' + y(0) + ' L' + x(0).toFixed(1) + ' ' + y(0) + ' Z';

    var gradId = 'grad-' + valueKey;
    var defs = svg('defs', {}, [
      svg('linearGradient', { id: gradId, x1: 0, y1: 0, x2: 0, y2: 1 }, [
        svg('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': 0.28 }),
        svg('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0.02 }),
      ]),
    ]);
    root.append(defs);
    root.append(svg('path', { d: area, fill: 'url(#' + gradId + ')' }));
    root.append(svg('path', { d: line, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

    // First and last date labels only — a label per point would be noise.
    root.append(svg('text', { x: pad.left, y: H - 6, 'font-size': 9, fill: palette().ink },
      [document.createTextNode(points[0].date.slice(5))]));
    root.append(svg('text', { x: W - pad.right, y: H - 6, 'font-size': 9, fill: palette().ink, 'text-anchor': 'end' },
      [document.createTextNode(points[points.length - 1].date.slice(5))]));

    // Hover layer: crosshair, marker and tooltip.
    var crosshair = svg('line', { y1: pad.top, y2: pad.top + ih, stroke: palette().ink, 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0 });
    var marker = svg('circle', { r: 4, fill: color, stroke: palette().surface, 'stroke-width': 2, opacity: 0 });
    root.append(crosshair, marker);

    var tip = el('div', {
      class: 'note',
      style: 'position:absolute;pointer-events:none;opacity:0;transition:opacity .1s;padding:0.35rem 0.55rem;font-size:var(--step--1);white-space:nowrap;z-index:5',
    });

    var wrap = el('div', { style: 'position:relative' }, [root, tip]);
    var overlay = svg('rect', { x: pad.left, y: pad.top, width: iw, height: ih, fill: 'transparent', style: 'cursor:crosshair' });
    root.append(overlay);

    overlay.addEventListener('mousemove', function (event) {
      var box = root.getBoundingClientRect();
      var rel = ((event.clientX - box.left) / box.width) * W;
      var i = Math.round(((rel - pad.left) / iw) * (points.length - 1));
      i = Math.max(0, Math.min(points.length - 1, i));
      var p = points[i];

      crosshair.setAttribute('x1', x(i)); crosshair.setAttribute('x2', x(i)); crosshair.setAttribute('opacity', 0.5);
      marker.setAttribute('cx', x(i)); marker.setAttribute('cy', y(p[valueKey])); marker.setAttribute('opacity', 1);

      tip.textContent = new Date(p.date + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        + ' · ' + nf.format(p[valueKey]) + ' ' + label.toLowerCase();
      tip.style.opacity = '1';
      tip.style.left = Math.min(Math.max(0, (x(i) / W) * box.width - 60), box.width - 130) + 'px';
      tip.style.top = '0px';
    });
    overlay.addEventListener('mouseleave', function () {
      crosshair.setAttribute('opacity', 0);
      marker.setAttribute('opacity', 0);
      tip.style.opacity = '0';
    });

    container.append(wrap);
  }

  /**
   * Plan distribution. Three categories with direct labels — the light-mode
   * aqua sits under 3:1 on white, so the relief rule requires visible labels
   * rather than colour alone.
   */
  function planChart(container, plans) {
    container.replaceChildren();
    var colors = [palette().s1, palette().s2, palette().s3];
    var max = Math.max.apply(null, plans.map(function (p) { return p.users; }).concat([1]));

    var rows = plans.map(function (plan, i) {
      var pct = Math.round((plan.users / max) * 100);
      return el('div', { style: 'margin-bottom:0.85rem' }, [
        el('div', { style: 'display:flex;justify-content:space-between;gap:1rem;font-size:var(--step--1);margin-bottom:0.3rem' }, [
          el('span', { style: 'display:inline-flex;align-items:center;gap:0.45rem;font-weight:600' }, [
            el('span', { class: 'legend-swatch', style: 'background:' + colors[i] }),
            plan.name,
          ]),
          el('span', { class: 'tabular muted' }, [
            nf.format(plan.users) + ' user' + (plan.users === 1 ? '' : 's'),
            plan.mrrCents > 0 ? ' · ' + money(plan.mrrCents) + '/mo' : '',
          ]),
        ]),
        el('div', { style: 'height:10px;border-radius:5px;background:var(--surface-2);overflow:hidden;border:1px solid var(--border)' }, [
          el('div', { style: 'height:100%;width:' + pct + '%;background:' + colors[i] + ';border-radius:5px' }),
        ]),
      ]);
    });

    var totalMrr = plans.reduce(function (sum, p) { return sum + p.mrrCents; }, 0);
    rows.push(el('p', { class: 'hint', style: 'margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid var(--border)' },
      ['Estimated MRR: ', el('strong', { text: money(totalMrr) })]));

    container.append.apply(container, rows);
  }

  // =====================================================================
  // Rendering
  // =====================================================================

  function renderOverview(data) {
    var o = data.overview;
    var p = palette();

    $('kpis').replaceChildren.apply($('kpis'), [
      { label: 'Total users', value: nf.format(o.users.total), delta: '+' + nf.format(o.users.new30d) + ' in 30 days' },
      { label: 'Active (7 days)', value: nf.format(o.users.active7d), delta: o.users.total ? Math.round((o.users.active7d / o.users.total) * 100) + '% of all users' : '—' },
      { label: 'Mailboxes', value: nf.format(o.mailboxes.total), delta: o.mailboxes.needingReauth + ' need reconnecting' },
      { label: 'Messages deleted', value: nf.format(o.messages.deletedTotal), delta: nf.format(o.messages.deletedLast30d) + ' in 30 days' },
      { label: 'Jobs run', value: nf.format(o.jobs.total), delta: nf.format(o.jobs.running) + ' running now' },
      { label: 'Database usage', value: bytes(o.storage.totalBytes), delta: nf.format(o.storage.trackedItems) + ' tracked messages' },
    ].map(function (k) {
      return el('div', { class: 'kpi' }, [
        el('div', { class: 'label', text: k.label }),
        el('div', { class: 'value', text: k.value }),
        el('div', { class: 'delta', text: k.delta }),
      ]);
    }));

    timeChart($('chart-signups'), o.timeline, 'signups', p.s1, 'Sign-ups');
    timeChart($('chart-jobs'), o.timeline, 'jobs', p.s2, 'Jobs');
    planChart($('chart-plans'), o.plans);

    $('health').replaceChildren.apply($('health'), [
      { k: 'Two-factor adoption', v: o.users.total ? Math.round((o.users.withTwoFactor / o.users.total) * 100) + '%' : '—',
        sub: nf.format(o.users.withTwoFactor) + ' of ' + nf.format(o.users.total) + ' accounts' },
      { k: 'Suspended accounts', v: nf.format(o.users.suspended), sub: o.users.suspended ? 'review these' : 'none' },
      { k: 'Failed jobs (30d)', v: nf.format(o.jobs.failed30d), sub: o.jobs.last30d ? 'of ' + nf.format(o.jobs.last30d) + ' started' : 'no jobs yet' },
      { k: 'Mailboxes by provider', v: String(o.mailboxes.byProvider.length),
        sub: o.mailboxes.byProvider.map(function (x) { return x.provider + ' ' + x.count; }).join(' · ') || 'none connected' },
    ].map(function (h) {
      return el('div', {}, [
        el('div', { class: 'label', style: 'color:var(--text-muted);font-size:0.72rem;text-transform:uppercase;letter-spacing:0.05em;font-weight:650', text: h.k }),
        el('div', { style: 'font-size:var(--step-1);font-weight:700;margin-top:0.2rem', text: h.v }),
        el('div', { class: 'hint', text: h.sub }),
      ]);
    }));

    $('refreshed').textContent = 'updated ' + new Date(o.generatedAt).toLocaleTimeString();
  }

  var ACTIVITY_BADGE = { active: 'ok', idle: 'warn', dormant: 'neutral', never: 'neutral' };

  function renderUsers(data) {
    $('user-count').textContent = nf.format(data.total) + ' user' + (data.total === 1 ? '' : 's');
    var body = $('users-body');

    if (!data.users.length) {
      body.replaceChildren(el('tr', {}, [
        el('td', { colspan: '9' }, [el('div', { class: 'empty' }, [el('strong', { text: 'No users match' }), 'Try clearing the filters.'])]),
      ]));
      return;
    }

    body.replaceChildren.apply(body, data.users.map(function (u) {
      var quota = u.quota.mailboxes;
      return el('tr', {}, [
        el('td', {}, [el('div', { class: 'user-cell' }, [
          el('span', { class: 'avatar', text: (u.email[0] || '?') }),
          el('div', { style: 'min-width:0' }, [
            el('div', { class: 'email', text: u.email }),
            el('div', { class: 'sub' }, [
              u.isAdmin ? el('span', { class: 'badge badge-accent', style: 'margin-right:0.3rem', text: 'admin' }) : null,
              u.status === 'suspended' ? el('span', { class: 'badge badge-danger', style: 'margin-right:0.3rem', text: 'suspended' }) : null,
              'joined ' + new Date(u.createdAt).toLocaleDateString(),
            ]),
          ]),
        ])]),
        el('td', {}, [el('span', { class: 'badge badge-neutral', text: u.planName })]),
        el('td', {}, [
          el('span', { class: 'badge badge-' + (ACTIVITY_BADGE[u.activity] || 'neutral'), text: u.activity }),
          el('div', { class: 'sub muted', style: 'font-size:0.72rem;margin-top:0.15rem', text: ago(u.lastSeenAt) }),
        ]),
        el('td', { class: 'num tabular', text: u.mailboxes + ' / ' + quota.limit }),
        el('td', { class: 'num tabular', text: nf.format(u.jobsLast30Days) }),
        el('td', { class: 'num tabular', text: nf.format(u.messagesDeleted) }),
        el('td', { class: 'num tabular', text: bytes(u.storageBytes) }),
        el('td', {}, [u.twoFactorEnabled
          ? el('span', { class: 'badge badge-ok', text: 'on' })
          : el('span', { class: 'badge badge-neutral', text: 'off' })]),
        el('td', {}, [el('button', { class: 'btn btn-sm btn-ghost', onClick: function () { openDrawer(u.id); } }, ['Manage'])]),
      ]);
    }));
  }

  var PLAN_LABEL = { free: 'Free', pro: 'Pro', business: 'Business', undecided: 'Undecided' };

  function renderWaitlist(data) {
    $('waitlist-count').textContent = nf.format(data.total);

    $('waitlist-plans').replaceChildren.apply($('waitlist-plans'),
      data.byPlan
        .sort(function (a, b) { return b.count - a.count; })
        .map(function (p) {
          return el('span', { class: 'badge badge-neutral' },
            [(PLAN_LABEL[p.plan] || p.plan) + ': ' + nf.format(p.count)]);
        }));

    var body = $('waitlist-body');
    if (!data.entries.length) {
      body.replaceChildren(el('tr', {}, [
        el('td', { colspan: '6' }, [el('div', { class: 'empty' }, [
          el('strong', { text: 'No requests yet' }),
          'They will appear here as people submit the form.',
        ])]),
      ]));
      return;
    }

    body.replaceChildren.apply(body, data.entries.map(function (e) {
      return el('tr', { style: e.contacted ? 'opacity:0.55' : null }, [
        el('td', { class: 'muted nowrap', text: new Date(e.createdAt).toLocaleDateString() + ' ' + ago(e.createdAt) }),
        el('td', {}, [
          el('div', {}, [el('a', { href: 'mailto:' + e.email, text: e.email })]),
          el('div', { class: 'sub muted', style: 'font-size:0.75rem' },
            [[e.name, e.company, e.phone].filter(Boolean).join(' · ') || '—']),
        ]),
        el('td', {}, [el('span', { class: 'badge badge-accent', text: PLAN_LABEL[e.plan] || e.plan || '—' })]),
        el('td', { class: 'muted', text: e.mailboxes || '—' }),
        el('td', { class: 'muted', style: 'max-width:280px', text: e.message || '—' }),
        el('td', {}, [el('div', { class: 'cluster', style: '--cluster-gap:0.35rem' }, [
          el('button', {
            class: 'btn btn-sm',
            onClick: function () {
              api('/api/admin/waitlist/' + e.id + '/contacted', {
                method: 'PUT', body: { contacted: !e.contacted },
              }).then(refresh);
            },
          }, [e.contacted ? 'Mark new' : 'Mark done']),
          el('button', {
            class: 'btn btn-sm btn-danger',
            onClick: function () {
              if (!confirm('Delete the request from ' + e.email + '?')) return;
              api('/api/admin/waitlist/' + e.id, { method: 'DELETE' }).then(refresh);
            },
          }, ['Delete']),
        ])]),
      ]);
    }));
  }

  function renderAudit(entries) {
    var body = $('audit-body');
    if (!entries.length) {
      body.replaceChildren(el('tr', {}, [el('td', { class: 'muted', text: 'No activity recorded yet.' })]));
      return;
    }
    body.replaceChildren.apply(body, entries.slice(0, 40).map(function (e) {
      return el('tr', {}, [
        el('td', { class: 'muted nowrap', style: 'width:1%', text: new Date(e.createdAt).toLocaleString() }),
        el('td', { class: 'mono', text: e.action }),
        el('td', { class: 'muted', text: e.email || '—' }),
        el('td', { class: 'muted mono', style: 'font-size:0.72rem', text: e.ip || '' }),
      ]);
    }));
  }

  // =====================================================================
  // User drawer
  // =====================================================================

  function closeDrawer() { $('drawer-root').replaceChildren(); }

  function openDrawer(userId) {
    api('/api/admin/users/' + userId).then(function (detail) {
      var u = detail.user;

      function action(label, cls, handler) {
        return el('button', {
          class: 'btn btn-sm ' + cls,
          onClick: function (event) {
            event.target.disabled = true;
            handler().then(function () { closeDrawer(); return refresh(); })
              .catch(function (err) { alert(err.message); event.target.disabled = false; });
          },
        }, [label]);
      }

      var planSelect = el('select', { id: 'drawer-plan', style: 'max-width:180px' },
        ['free', 'pro', 'business'].map(function (p) {
          return el('option', { value: p, text: p.charAt(0).toUpperCase() + p.slice(1), selected: u.plan === p ? 'selected' : null });
        }));

      var drawer = el('div', { class: 'drawer-backdrop', onClick: function (e) { if (e.target.classList.contains('drawer-backdrop')) closeDrawer(); } }, [
        el('div', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Manage ' + u.email }, [
          el('header', {}, [
            el('span', { class: 'avatar', style: 'width:38px;height:38px;font-size:0.95rem', text: (u.email[0] || '?') }),
            el('div', { style: 'flex:1;min-width:0' }, [
              el('h2', { text: u.email }),
              el('p', { class: 'hint' }, [
                'Joined ' + new Date(u.createdAt).toLocaleDateString(),
                ' · ' + nf.format(u.loginCount) + ' sign-ins',
                ' · last seen ' + ago(u.lastSeenAt),
              ]),
            ]),
            el('button', { class: 'btn btn-sm btn-ghost', onClick: closeDrawer }, ['Close']),
          ]),

          el('div', { class: 'cluster', style: 'margin-bottom:1.25rem' }, [
            u.isAdmin ? el('span', { class: 'badge badge-accent', text: 'admin' }) : null,
            el('span', { class: 'badge badge-' + (u.status === 'active' ? 'ok' : 'danger'), text: u.status }),
            el('span', { class: 'badge badge-neutral', text: u.planName + ' plan' }),
            el('span', { class: 'badge badge-' + (u.twoFactorEnabled ? 'ok' : 'neutral'), text: '2FA ' + (u.twoFactorEnabled ? 'on' : 'off') }),
            u.acceptedTermsAt ? el('span', { class: 'badge badge-neutral', text: 'terms accepted' }) : null,
          ]),

          el('h3', { style: 'font-size:var(--step-0);margin-bottom:0.6rem', text: 'Quota usage' }),
          el('div', { class: 'grid grid-3', style: 'margin-bottom:1.5rem' }, [
            { k: 'Mailboxes', used: detail.usage.mailboxes, limit: detail.plan.limits.mailboxes },
            { k: 'Jobs (30 days)', used: detail.usage.jobsLast30Days, limit: detail.plan.limits.jobsPerMonth },
            { k: 'Saved rules', used: detail.usage.rules, limit: detail.plan.limits.rules },
          ].map(function (m) {
            var unlimited = m.limit === null;
            var pct = unlimited ? 4 : Math.min(100, Math.round((m.used / Math.max(m.limit, 1)) * 100));
            return el('div', { class: 'meter' }, [
              el('div', { class: 'meter-head' }, [
                el('span', { class: 'k', text: m.k }),
                el('span', { class: 'tabular', text: m.used + (unlimited ? ' / ∞' : ' / ' + m.limit) }),
              ]),
              el('div', { class: 'meter-track' }, [
                el('div', { class: 'meter-fill' + (pct >= 100 ? ' full' : pct >= 80 ? ' warn' : ''), style: 'width:' + pct + '%' }),
              ]),
            ]);
          })),

          el('h3', { style: 'font-size:var(--step-0);margin-bottom:0.6rem', text: 'Connected mailboxes' }),
          detail.accounts.length
            ? el('div', { class: 'table-wrap', style: 'margin-bottom:1.5rem' }, [
                el('table', {}, [
                  el('thead', {}, [el('tr', {}, [el('th', { text: 'Provider' }), el('th', { text: 'Address' }), el('th', { text: 'Status' })])]),
                  el('tbody', {}, detail.accounts.map(function (a) {
                    return el('tr', {}, [
                      el('td', { class: 'muted', text: a.provider }),
                      el('td', { text: a.email }),
                      el('td', {}, [el('span', { class: 'badge badge-' + (a.status === 'active' ? 'ok' : 'warn'), text: a.status })]),
                    ]);
                  })),
                ]),
              ])
            : el('p', { class: 'hint', style: 'margin-bottom:1.5rem', text: 'No mailboxes connected.' }),

          el('h3', { style: 'font-size:var(--step-0);margin-bottom:0.6rem', text: 'Recent jobs' }),
          detail.recentJobs.length
            ? el('div', { class: 'table-wrap', style: 'margin-bottom:1.5rem' }, [
                el('table', {}, [
                  el('thead', {}, [el('tr', {}, [el('th', { text: 'When' }), el('th', { text: 'Status' }), el('th', { class: 'num', text: 'Matched' }), el('th', { class: 'num', text: 'Deleted' })])]),
                  el('tbody', {}, detail.recentJobs.slice(0, 8).map(function (j) {
                    return el('tr', {}, [
                      el('td', { class: 'muted nowrap', text: new Date(j.created_at).toLocaleString() }),
                      el('td', {}, [el('span', { class: 'badge badge-' + (j.status === 'completed' ? 'ok' : j.status === 'failed' ? 'danger' : 'warn'), text: j.status })]),
                      el('td', { class: 'num tabular', text: nf.format(j.matched_count) }),
                      el('td', { class: 'num tabular', text: nf.format(j.deleted_count) }),
                    ]);
                  })),
                ]),
              ])
            : el('p', { class: 'hint', style: 'margin-bottom:1.5rem', text: 'No jobs run yet.' }),

          el('h3', { style: 'font-size:var(--step-0);margin-bottom:0.6rem', text: 'Administration' }),
          el('div', { class: 'cluster', style: 'margin-bottom:0.75rem' }, [
            planSelect,
            action('Apply plan', 'btn-primary', function () {
              return api('/api/admin/users/' + userId + '/plan', { method: 'PUT', body: { plan: planSelect.value } });
            }),
          ]),
          el('div', { class: 'cluster' }, [
            u.twoFactorEnabled
              ? action('Reset 2FA', '', function () {
                  if (!confirm('Reset two-factor for ' + u.email + '? They will sign in with a password alone until they re-enrol.')) {
                    return Promise.reject(new Error('Cancelled'));
                  }
                  return api('/api/admin/users/' + userId + '/reset-2fa', { method: 'POST' });
                })
              : null,
            u.status === 'active'
              ? action('Suspend', 'btn-danger', function () {
                  if (!confirm('Suspend ' + u.email + '? They keep their data but cannot sign in.')) return Promise.reject(new Error('Cancelled'));
                  return api('/api/admin/users/' + userId + '/status', { method: 'PUT', body: { status: 'suspended' } });
                })
              : action('Unsuspend', '', function () {
                  return api('/api/admin/users/' + userId + '/status', { method: 'PUT', body: { status: 'active' } });
                }),
            action('Delete account', 'btn-danger', function () {
              if (!confirm('Permanently delete ' + u.email + ' and all their rules, jobs and stored credentials?\n\nThis does NOT delete anything in their actual mailbox. It cannot be undone.')) {
                return Promise.reject(new Error('Cancelled'));
              }
              return api('/api/admin/users/' + userId, { method: 'DELETE' });
            }),
          ]),
          el('p', { class: 'hint', style: 'margin-top:0.9rem' }, [
            'Message subjects, senders and content are never visible to administrators.',
          ]),
        ]),
      ]);

      $('drawer-root').replaceChildren(drawer);
    }).catch(function (err) { note($('admin-error'), err.message); });
  }

  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });

  // =====================================================================
  // Boot
  // =====================================================================

  function loadUsers() {
    var params = new URLSearchParams();
    if ($('user-search').value.trim()) params.set('search', $('user-search').value.trim());
    if ($('plan-filter').value) params.set('plan', $('plan-filter').value);
    if ($('status-filter').value) params.set('status', $('status-filter').value);
    params.set('limit', '200');
    return api('/api/admin/users?' + params.toString()).then(renderUsers);
  }

  function refresh() {
    return Promise.all([
      api('/api/admin/overview').then(renderOverview),
      loadUsers(),
      api('/api/admin/audit?limit=60').then(function (d) { renderAudit(d.entries); }),
      api('/api/admin/waitlist?limit=200').then(renderWaitlist),
    ]).catch(function (err) {
      if (err.message !== 'Signed out') note($('admin-error'), err.message);
    });
  }

  var searchTimer = null;
  ['user-search', 'plan-filter', 'status-filter'].forEach(function (id) {
    $(id).addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(loadUsers, 250);
    });
  });
  $('refresh').addEventListener('click', refresh);

  // Charts are drawn with explicit colours, so redraw them when the theme flips.
  document.addEventListener('click', function (event) {
    if (event.target.closest('[data-theme-toggle]')) setTimeout(refresh, 30);
  });

  refresh();
})();
