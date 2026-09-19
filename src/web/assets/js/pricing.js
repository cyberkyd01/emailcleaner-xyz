/* Renders plan cards from the server's own plan definitions, so the pricing
   page and the limits the app enforces can never disagree. */
(function () {
  'use strict';

  var config = window.__EC__ || {};
  var plans = config.plans || [];
  var grid = document.getElementById('price-grid');
  if (!grid || !plans.length) return;

  var billing = 'monthly';

  function money(cents, currency) {
    if (cents === 0) return 'Free';
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    }).format(cents / 100);
  }

  function render() {
    grid.replaceChildren();

    plans.forEach(function (plan) {
      var card = document.createElement('article');
      card.className = 'card price-card' + (plan.featured ? ' featured' : '');

      if (plan.featured) {
        var flag = document.createElement('span');
        flag.className = 'price-flag';
        flag.textContent = 'Most popular';
        card.append(flag);
      }

      var name = document.createElement('h2');
      name.className = 'price-name';
      name.textContent = plan.name;

      var tagline = document.createElement('p');
      tagline.className = 'price-tagline';
      tagline.textContent = plan.tagline;

      var cents = billing === 'yearly' ? plan.priceYearlyCents : plan.priceMonthlyCents;
      var amount = document.createElement('div');
      amount.className = 'price-amount';
      var amt = document.createElement('span');
      amt.className = 'amt';
      amt.textContent = money(cents, plan.currency);
      amount.append(amt);
      if (cents > 0) {
        var per = document.createElement('span');
        per.className = 'per';
        per.textContent = billing === 'yearly' ? '/ year' : '/ month';
        amount.append(per);
      }

      var billed = document.createElement('p');
      billed.className = 'price-billed';
      if (cents > 0 && billing === 'yearly') {
        billed.textContent =
          money(Math.round(plan.priceYearlyCents / 12), plan.currency) + ' a month, billed yearly';
      } else if (cents > 0) {
        billed.textContent = 'Billed monthly, cancel any time';
      } else {
        billed.textContent = 'No card required';
      }

      var list = document.createElement('ul');
      list.className = 'price-list';
      (plan.highlights || []).forEach(function (text) {
        var li = document.createElement('li');
        var tick = document.createElement('span');
        tick.className = 'tick';
        tick.setAttribute('aria-hidden', 'true');
        tick.textContent = '✓';
        var label = document.createElement('span');
        label.textContent = text;
        li.append(tick, label);
        list.append(li);
      });

      var cta = document.createElement('a');
      cta.className = 'btn btn-block ' + (plan.featured ? 'btn-primary' : 'btn-outline');
      cta.href = '/login?mode=register&plan=' + encodeURIComponent(plan.id);
      cta.textContent = plan.priceMonthlyCents === 0 ? 'Start free' : 'Choose ' + plan.name;

      card.append(name, tagline, amount, billed, list, cta);
      grid.append(card);
    });
  }

  document.querySelectorAll('[data-billing]').forEach(function (button) {
    button.addEventListener('click', function () {
      billing = button.getAttribute('data-billing');
      document.querySelectorAll('[data-billing]').forEach(function (b) {
        b.setAttribute('aria-pressed', String(b === button));
      });
      render();
    });
  });

  render();
})();
