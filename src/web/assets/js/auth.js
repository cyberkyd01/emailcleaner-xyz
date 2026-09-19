/* Sign-in and registration, including the TOTP second step and captcha. */
(function () {
  'use strict';

  var config = window.__EC__ || {};
  var captcha = config.captcha || { provider: 'none' };

  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(window.location.search);
  var isRegister = params.get('mode') === 'register';
  var challengeId = null;
  var usingBackupCode = false;

  // --- Captcha ------------------------------------------------------------
  // Loaded lazily and only when configured, so a deployment without bot
  // protection ships no third-party script at all.
  var captchaReady = Promise.resolve(null);

  if (captcha.provider === 'recaptcha' && captcha.siteKey) {
    captchaReady = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = 'https://www.google.com/recaptcha/api.js?render=' + encodeURIComponent(captcha.siteKey);
      s.async = true;
      s.onload = function () { resolve('recaptcha'); };
      s.onerror = function () { resolve(null); };
      document.head.append(s);
    });
    var badgeNote = document.createElement('p');
    badgeNote.className = 'auth-legal';
    badgeNote.innerHTML =
      'This site is protected by reCAPTCHA. Google\'s ' +
      '<a href="https://policies.google.com/privacy" target="_blank" rel="noopener">Privacy Policy</a> and ' +
      '<a href="https://policies.google.com/terms" target="_blank" rel="noopener">Terms of Service</a> apply.';
    var mount = $('captcha-mount');
    if (mount) { mount.classList.remove('hidden'); mount.append(badgeNote); }
  } else if (captcha.provider === 'turnstile' && captcha.siteKey) {
    captchaReady = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = function () { resolve('turnstile'); };
      s.onerror = function () { resolve(null); };
      document.head.append(s);
    });
    var tsMount = $('captcha-mount');
    if (tsMount) {
      tsMount.classList.remove('hidden');
      var holder = document.createElement('div');
      holder.id = 'turnstile-widget';
      tsMount.append(holder);
      captchaReady.then(function (kind) {
        if (kind === 'turnstile' && window.turnstile) {
          window.turnstile.render('#turnstile-widget', { sitekey: captcha.siteKey });
        }
      });
    }
  }

  function captchaToken(action) {
    return captchaReady.then(function (kind) {
      if (kind === 'recaptcha' && window.grecaptcha) {
        return new Promise(function (resolve) {
          window.grecaptcha.ready(function () {
            window.grecaptcha
              .execute(captcha.siteKey, { action: action })
              .then(resolve)
              .catch(function () { resolve(undefined); });
          });
        });
      }
      if (kind === 'turnstile' && window.turnstile) {
        try { return window.turnstile.getResponse(); } catch (e) { return undefined; }
      }
      return undefined;
    });
  }

  // --- API ----------------------------------------------------------------
  function api(path, body) {
    return fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (response) {
      return response.text().then(function (text) {
        var data = text ? JSON.parse(text) : {};
        if (!response.ok) {
          var err = new Error((data.error && data.error.message) || 'Request failed');
          err.code = data.error && data.error.code;
          throw err;
        }
        return data;
      });
    });
  }

  function showError(el, message) {
    if (!message) { el.classList.add('hidden'); return; }
    el.textContent = message;
    el.classList.remove('hidden');
  }

  // --- Panels -------------------------------------------------------------
  function showPanel(name) {
    ['step-credentials', 'step-interest', 'step-thanks', 'step-mfa'].forEach(function (id) {
      var node = $(id);
      if (node) node.classList.toggle('hidden', id !== name);
    });
  }

  // When sign-ups are closed the "new here" path leads to the interest form
  // rather than a registration form that would only ever be refused.
  var registrationOpen = config.registrationOpen !== false;

  function applyMode() {
    if (isRegister && !registrationOpen) {
      showPanel('step-interest');
      $('i-email').focus();
      return;
    }
    showPanel('step-credentials');
    $('auth-title').textContent = isRegister ? 'Create your account' : 'Welcome back';
    $('auth-subtitle').textContent = isRegister
      ? 'Start with one mailbox, free. No card required.'
      : 'Sign in to clean your mailboxes.';
    $('auth-submit').textContent = isRegister ? 'Create account' : 'Sign in';
    $('auth-alt-text').textContent = isRegister ? 'Already have an account?' : 'New here?';
    $('auth-toggle').textContent = isRegister
      ? 'Sign in instead'
      : (registrationOpen ? 'Create an account' : 'Request access');
    $('password').setAttribute('autocomplete', isRegister ? 'new-password' : 'current-password');
    $('password-hint').classList.toggle('hidden', !isRegister);
    $('terms-field').classList.toggle('hidden', !isRegister);
    $('auth-submit').disabled = false;
    showError($('auth-error'), null);
  }

  $('auth-toggle').addEventListener('click', function () {
    isRegister = !isRegister;
    var url = new URL(window.location.href);
    if (isRegister) url.searchParams.set('mode', 'register');
    else url.searchParams.delete('mode');
    window.history.replaceState({}, '', url);
    applyMode();
  });

  $('interest-back').addEventListener('click', function () {
    isRegister = false;
    var url = new URL(window.location.href);
    url.searchParams.delete('mode');
    window.history.replaceState({}, '', url);
    applyMode();
    $('email').focus();
  });

  // --- Interest form ------------------------------------------------------
  $('interest-form').addEventListener('submit', function (event) {
    event.preventDefault();
    showError($('interest-error'), null);

    var email = $('i-email').value.trim();
    if (!email || email.indexOf('@') < 0) {
      return showError($('interest-error'), 'Please enter an email address we can reply to.');
    }

    var button = $('interest-submit');
    button.disabled = true;
    button.textContent = 'Sending...';

    captchaToken('interest')
      .then(function (token) {
        return api('/api/interest', {
          name: $('i-name').value.trim() || undefined,
          email: email,
          company: $('i-company').value.trim() || undefined,
          phone: $('i-phone').value.trim() || undefined,
          plan: $('i-plan').value,
          mailboxes: $('i-mailboxes').value || undefined,
          message: $('i-message').value.trim() || undefined,
          source: params.get('plan') ? 'pricing:' + params.get('plan') : 'login',
          website: $('i-website').value,
          captchaToken: token,
        });
      })
      .then(function (data) {
        if (data.duplicate) {
          $('thanks-text').textContent =
            'We already have a request from that address, so there is no need to send another. We will be in touch.';
        }
        showPanel('step-thanks');
      })
      .catch(function (err) {
        showError($('interest-error'), err.message);
      })
      .finally(function () {
        button.disabled = false;
        button.textContent = 'Request access';
      });
  });

  // A plan chosen on the pricing page preselects here.
  (function () {
    var wanted = params.get('plan');
    if (wanted && ['free', 'pro', 'business'].indexOf(wanted) >= 0) $('i-plan').value = wanted;
  })();

  // --- Credentials step ---------------------------------------------------
  $('auth-form').addEventListener('submit', function (event) {
    event.preventDefault();
    showError($('auth-error'), null);

    var email = $('email').value.trim();
    var password = $('password').value;

    if (!email || !password) return showError($('auth-error'), 'Enter your email and password.');
    if (isRegister && password.length < 10) {
      return showError($('auth-error'), 'Choose a password of at least 10 characters.');
    }
    if (isRegister && !$('accept-terms').checked) {
      return showError($('auth-error'), 'Please accept the Terms of Service and Privacy Policy.');
    }

    var button = $('auth-submit');
    button.disabled = true;
    button.textContent = isRegister ? 'Creating account…' : 'Signing in…';

    captchaToken(isRegister ? 'register' : 'login')
      .then(function (token) {
        var payload = { email: email, password: password, captchaToken: token };
        if (isRegister) payload.acceptTerms = true;
        return api(isRegister ? '/api/auth/register' : '/api/auth/login', payload);
      })
      .then(function (data) {
        if (data.mfaRequired) {
          challengeId = data.challengeId;
          showPanel('step-mfa');
          $('mfa-code').focus();
          return;
        }
        window.location.href = params.get('next') || '/app';
      })
      .catch(function (err) {
        showError($('auth-error'), err.message);
      })
      .finally(function () {
        button.disabled = false;
        button.textContent = isRegister ? 'Create account' : 'Sign in';
      });
  });

  // --- Two-factor step ----------------------------------------------------
  $('mfa-form').addEventListener('submit', function (event) {
    event.preventDefault();
    showError($('mfa-error'), null);

    var code = $('mfa-code').value.trim();
    if (!code) return showError($('mfa-error'), 'Enter your code.');

    var button = $('mfa-submit');
    button.disabled = true;
    button.textContent = 'Verifying…';

    api('/api/auth/login/mfa', { challengeId: challengeId, code: code })
      .then(function () {
        window.location.href = params.get('next') || '/app';
      })
      .catch(function (err) {
        showError($('mfa-error'), err.message);
        $('mfa-code').value = '';
        $('mfa-code').focus();
      })
      .finally(function () {
        button.disabled = false;
        button.textContent = 'Verify and sign in';
      });
  });

  $('use-backup').addEventListener('click', function () {
    usingBackupCode = !usingBackupCode;
    var input = $('mfa-code');
    if (usingBackupCode) {
      $('mfa-label').textContent = 'Recovery code';
      $('mfa-hint').textContent = 'One of the ten codes you saved when enabling two-factor. Each works once.';
      input.classList.remove('otp-input');
      input.setAttribute('maxlength', '20');
      input.removeAttribute('inputmode');
      $('use-backup').textContent = 'Use an authenticator code instead';
    } else {
      $('mfa-label').textContent = 'Authentication code';
      $('mfa-hint').textContent = 'The code changes every 30 seconds.';
      input.classList.add('otp-input');
      input.setAttribute('maxlength', '6');
      input.setAttribute('inputmode', 'numeric');
      $('use-backup').textContent = 'Use a recovery code instead';
    }
    input.value = '';
    input.focus();
  });

  $('mfa-cancel').addEventListener('click', function () {
    challengeId = null;
    showPanel('step-credentials');
    $('password').value = '';
    $('email').focus();
  });

  // Auto-submit once six digits are in, which is what people expect.
  $('mfa-code').addEventListener('input', function () {
    if (!usingBackupCode && $('mfa-code').value.replace(/\D/g, '').length === 6) {
      $('mfa-form').requestSubmit();
    }
  });

  applyMode();
  if (!$('step-credentials').classList.contains('hidden')) $('email').focus();
})();
