// CMM Tools — exact-amount Easypaisa checkout, manual verification only.
(() => {
  'use strict';
  const QRS = Object.freeze({
    creator: Object.freeze({ amount: 5000, image: '/assets/payments/easypaisa-5000.svg' }),
    studio: Object.freeze({ amount: 10000, image: '/assets/payments/easypaisa-10000.svg' }),
  });
  const EXPIRES_AT = Date.parse('2026-11-27T23:59:59+05:00');
  const $pay = id => document.getElementById(id);
  let selected = null;

  function makeDialog() {
    if ($pay('planPaymentDialog')) return $pay('planPaymentDialog');
    const dialog = document.createElement('dialog');
    dialog.id = 'planPaymentDialog';
    dialog.className = 'plan-payment-dialog';
    dialog.setAttribute('aria-labelledby','planPayTitle');
    dialog.setAttribute('aria-describedby','planPayInfo');
    dialog.innerHTML = [
      '<div class="plan-pay-head"><div><span class="plan-pay-kicker">Easypaisa payment</span><h2 id="planPayTitle">Pay for your plan</h2></div>',
      '<button type="button" class="plan-pay-close" aria-label="Close payment details">×</button></div>',
      '<div class="plan-pay-body">',
      '<div id="planPayQrSection"><div class="plan-pay-amount" id="planPayAmount"></div>',
      '<p class="plan-pay-instruction">Scan this QR code with a supported bank or Easypaisa app. Check the recipient and amount before sending.</p>',
      '<div class="plan-pay-code"><img id="planPayQr" alt="" width="328" height="328"></div>',
      '<div class="plan-pay-beneficiary"><span>Recipient</span><strong>MEHROOZ MUSHARRAF</strong><span>Easypaisa · account ending 0512</span>',
      '<small>QR expires 27 November 2026</small></div>',
      '<a id="planPayDownload" class="plan-pay-download" download>Save QR to pay on this phone</a></div>',
      '<p id="planPayExpired" class="plan-pay-expired" role="alert" hidden>This QR expired on 27 November 2026. Please contact support for new payment details. Do not pay using the expired QR.</p>',
      '<p id="planPayInfo" class="plan-pay-info">Credits are granted after admin payment verification, not when you click the button.</p>',
      '<button id="planPaySubmit" type="button" class="btn primary plan-pay-submit">I have paid — submit for review</button>',
      '<a id="planPayProof" class="btn secondary plan-pay-submit" target="_blank" rel="noopener" hidden>Send receipt / transaction ID on WhatsApp</a>',
      '<div id="planPayMessage" class="msg muted" role="status" aria-live="polite"></div>',
      '</div>'
    ].join('');
    dialog.querySelector('.plan-pay-close').addEventListener('click', () => dialog.close());
    dialog.querySelector('#planPaySubmit').addEventListener('click', submitPaymentClaim);
    dialog.addEventListener('close', () => { selected = null; });
    document.body.append(dialog);
    return dialog;
  }

  function proofUrl(plan, requestId) {
    const number = String(config?.support?.whatsapp || '+923000499907').replace(/\D/g, '');
    const message = 'Hello CMM Tools, I paid for the ' + plan.name + ' plan (' + formatPkr(plan.pricePkr) +
      '). Purchase request #' + requestId + '. Here is my receipt / transaction ID for verification.';
    return 'https://wa.me/' + number + '?text=' + encodeURIComponent(message);
  }

  function showReceiptLink(plan, requestId) {
    const link = $pay('planPayProof');
    link.href = proofUrl(plan, requestId);
    link.hidden = false;
  }

  window.openPlanPayment = function (code) {
    const plan = (config?.plans || []).find(p => p.code === code && !p.contact);
    const qr = QRS[code];
    if (!plan || !qr || Number(plan.pricePkr) !== qr.amount) return;
    const pending = planStatus?.pendingRequest || null;
    if (pending && pending.plan_code !== code) {
      const message = $pay('planMsg');
      if (message) { message.className = 'msg err'; message.textContent = 'You already have a pending ' + pending.plan_code + ' purchase. Resolve that request before starting another.'; }
      return;
    }
    const dialog = makeDialog();
    selected = code;
    const expired = Date.now() > EXPIRES_AT;
    $pay('planPayTitle').textContent = plan.name + ' · Easypaisa payment';
    $pay('planPayAmount').textContent = formatPkr(plan.pricePkr);
    $pay('planPayQr').src = qr.image;
    $pay('planPayQr').alt = 'Easypaisa ' + formatPkr(plan.pricePkr) + ' QR for MEHROOZ MUSHARRAF';
    $pay('planPayDownload').href = qr.image;
    $pay('planPayDownload').download = 'cmmtools-easypaisa-' + qr.amount + '.svg';
    $pay('planPayQrSection').hidden = expired;
    $pay('planPayExpired').hidden = !expired;
    $pay('planPaySubmit').hidden = expired || !!pending;
    $pay('planPaySubmit').disabled = false;
    $pay('planPayProof').hidden = true;
    $pay('planPayProof').removeAttribute('href');
    $pay('planPayInfo').textContent = pending
      ? 'Purchase request #' + pending.id + ' is awaiting admin verification. Send your receipt or transaction ID using WhatsApp below.'
      : 'After paying, submit your purchase request. No credits are granted until an admin independently verifies payment.';
    const m = $pay('planPayMessage'); m.className = 'msg muted'; m.textContent = '';
    if (pending) showReceiptLink(plan, pending.id);
    if (!dialog.open) dialog.showModal();
  };

  async function submitPaymentClaim() {
    const code = selected;
    const plan = (config?.plans || []).find(p => p.code === code);
    const qr = QRS[code];
    if (!plan || !qr || Number(plan.pricePkr) !== qr.amount || Date.now() > EXPIRES_AT || planStatus?.pendingRequest) return;
    const button = $pay('planPaySubmit');
    if (button.disabled) return;
    button.disabled = true;
    const message = $pay('planPayMessage'); message.className = 'msg muted'; message.textContent = 'Submitting your request…';
    try {
      const response = await api('/api/plan-requests', { method: 'POST', body: JSON.stringify({ planCode: code }) });
      const id = response.request.id;
      message.className = 'msg ok';
      message.textContent = 'Request #' + id + ' is pending verification. Send your payment receipt or transaction ID to support.';
      $pay('planPayInfo').textContent = 'No credits have been granted. An admin must verify receipt of the payment before approving this plan.';
      button.hidden = true;
      showReceiptLink(plan, id);
      const status = $pay('planMsg');
      if (status) { status.className = 'msg ok'; status.textContent = plan.name + ' request #' + id + ' is pending payment verification.'; }
      await loadPlanStatus();
    } catch (error) {
      message.className = 'msg err';
      message.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  window.openCheckoutFromUrl = function () {
    const code = new URLSearchParams(location.search).get('plan');
    if (!QRS[code]) return;
    history.replaceState(null, '', location.pathname);
    go('plans');
    window.openPlanPayment(code);
  };
})();
