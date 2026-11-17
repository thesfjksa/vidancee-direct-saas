"use strict";

// Local visual customization only. Never reads credentials, cookies, billing
// details, account responses or data from authentication providers.
const DEFAULTS = Object.freeze({
  hideBilling: true,
  hideReferral: true,
  hideBranding: true,
  hideFooter: true,
  lockCreditButton: true,
  customCSS: ""
});

const DISPLAY_TITLE = "CMMTools Video Studio";
const HIDDEN_MENU_CLASS = "cmm-studio-hide-nav";
const HIDDEN_BRAND_CLASS = "cmm-studio-hide-brand";
const HIDDEN_FOOTER_CLASS = "cmm-studio-hide-footer";
const CUSTOM_STYLE_ID = "cmm-studio-custom-css";
const CREDIT_LOCK_CLASS = "cmm-studio-credit-locked";
const CREDIT_BALANCE_LABEL = /^(?:⚡\s*)?(?:[\d,.]+)\s*credits?$/i;
const CREDIT_BALANCE_REVERSE = /^credits?\s*[:：-]?\s*[\d,.]+$/i;
const CREDIT_BUTTON_ELEMENTS = "button, a[href], [role=\"button\"], [class*=\"cursor-pointer\"], [onclick]";
const BILLING_LABEL = /^(?:billing|billings|subscription|subscriptions|pricing|plans?|payment|payments|my plan|upgrade(?: plan)?|manage plan|top ?up|recharge|充值|账单|计费|套餐|订阅|支付|付款)$/i;
const REFERRAL_LABEL = /^(?:referral|referrals|refer(?: a friend)?|invite(?: friends?)?|invitation|invitations|affiliates?|affiliate program|邀请|推广|邀请好友|推荐奖励|分销)$/i;
const BILLING_PATH = /\/(?:billing|subscriptions?|pricing|plans?|payments?|recharge|top-up)(?:\/|$)/i;
const REFERRAL_PATH = /\/(?:referrals?|invitations?|invites?|affiliates?)(?:\/|$)/i;
const BRAND_LABEL = /^\s*aivid(?:\.dev)?(?:\s*[-–—|:]?\s*(?:dev|ai\s+video\s+generator|ai|studio|video|workspace))?\s*$/i;
const NAV_ITEMS = [
  "nav a", "aside a", "header a", "[role='navigation'] a", "[role='menu'] a",
  "[role='menuitem']", "[role='tab']", "nav button", "aside button",
  "header button", "[role='navigation'] button", "[role='menu'] button"
].join(",");
const BRAND_ZONE = "nav, aside, header, [role='navigation'], [class*='sidebar' i], [data-sidebar]";
const FOOTER_ZONE = "footer, [role='contentinfo'], #footer, [data-testid*='footer' i], [class*='footer' i]";
let settings = { ...DEFAULTS };
let observer;
let queued = false;
let scanning = false;

function norm(input) {
  return String(input || "").replace(/\s+/g, " ").trim();
}

function toggleClass(element, className, enabled) {
  // Idempotency is important: class mutations are watched by the observer.
  if (element.classList.contains(className) !== enabled) {
    element.classList.toggle(className, enabled);
  }
}

function getMenuLabel(element) {
  return norm(element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent);
}

function getLinkPath(element) {
  const link = element.closest("a[href]") || element.querySelector("a[href]");
  if (!link) return "";
  try { return new URL(link.getAttribute("href"), location.href).pathname; }
  catch { return ""; }
}

function shouldHideMenu(element) {
  const label = getMenuLabel(element);
  const path = getLinkPath(element);
  return Boolean(
    (settings.hideBilling && (BILLING_LABEL.test(label) || BILLING_PATH.test(path))) ||
    (settings.hideReferral && (REFERRAL_LABEL.test(label) || REFERRAL_PATH.test(path)))
  );
}

function setFlags() {
  if (!document.documentElement) return;
  const root = document.documentElement;
  const flags = {
    cmmBilling: settings.hideBilling ? "on" : "off",
    cmmReferral: settings.hideReferral ? "on" : "off",
    cmmBranding: settings.hideBranding ? "on" : "off",
    cmmFooter: settings.hideFooter ? "on" : "off",
    cmmCreditLock: settings.lockCreditButton ? "on" : "off"
  };
  for (const [key, value] of Object.entries(flags)) {
    if (root.dataset[key] !== value) root.dataset[key] = value;
  }
}

function updateTitleAndIcon() {
  if (!settings.hideBranding || !document.head) return;

  // The tab/window title is taken from document.title, not chrome.windows.
  // Reapply when a React/Next route or metadata manager changes it.
  if (document.title !== DISPLAY_TITLE) document.title = DISPLAY_TITLE;

  const targetIcon = chrome.runtime.getURL("brand/icon-48.png");
  const icons = [...document.head.querySelectorAll('link[rel~="icon"]')];
  if (!icons.length) {
    const icon = document.createElement("link");
    icon.rel = "icon";
    icon.href = targetIcon;
    document.head.appendChild(icon);
  } else {
    for (const icon of icons) {
      if (icon.href !== targetIcon) icon.href = targetIcon;
    }
  }
}

function updateCustomCSS() {
  if (!document.documentElement) return;
  let style = document.getElementById(CUSTOM_STYLE_ID);
  const css = typeof settings.customCSS === "string" ? settings.customCSS : "";
  if (!css.trim()) {
    if (style) style.remove();
    return;
  }
  if (!style) {
    style = document.createElement("style");
    style.id = CUSTOM_STYLE_ID;
    (document.head || document.documentElement).appendChild(style);
  }
  if (style.textContent !== css) style.textContent = css;
}

// Disables only the small credit-balance purchase trigger in the TOP BAR.
// Does not touch the pricing-per-video readout in the editor or card content.
function isCreditBalanceTrigger(element) {
  if (!(element instanceof Element) || !element.matches(CREDIT_BUTTON_ELEMENTS)) return false;
  const text = norm(element.textContent);
  const ariaLabel = norm(element.getAttribute("aria-label"));
  if (![text, ariaLabel].some(label => CREDIT_BALANCE_LABEL.test(label) || CREDIT_BALANCE_REVERSE.test(label))) return false;
  // Header markup varies by provider release. Limit to app toolbar elements,
  // or controls visually within the top strip of the page (not editor widgets).
  const rect = element.getBoundingClientRect();
  const inHeader = Boolean(element.closest("header, [role='banner']"));
  const inTopStrip = rect.width > 0 && rect.width < 310 && rect.height > 0 &&
    rect.height < 110 && rect.top >= 0 && rect.top < 155;
  return inHeader || inTopStrip;
}

function setCreditLocked(element, locked) {
  toggleClass(element, CREDIT_LOCK_CLASS, locked);
  if (locked) {
    if (!element.hasAttribute("data-cmm-credit-original-tabindex")) {
      element.setAttribute("data-cmm-credit-original-tabindex", element.hasAttribute("tabindex") ? element.getAttribute("tabindex") : "__unset__");
      element.setAttribute("data-cmm-credit-original-aria", element.hasAttribute("aria-disabled") ? element.getAttribute("aria-disabled") : "__unset__");
    }
    if (element.getAttribute("aria-disabled") !== "true") element.setAttribute("aria-disabled", "true");
    if (element.getAttribute("tabindex") !== "-1") element.setAttribute("tabindex", "-1");
  } else if (element.hasAttribute("data-cmm-credit-original-tabindex")) {
    const oldTab = element.getAttribute("data-cmm-credit-original-tabindex");
    const oldAria = element.getAttribute("data-cmm-credit-original-aria");
    if (oldTab === "__unset__") element.removeAttribute("tabindex");
    else element.setAttribute("tabindex", oldTab);
    if (oldAria === "__unset__") element.removeAttribute("aria-disabled");
    else element.setAttribute("aria-disabled", oldAria);
    element.removeAttribute("data-cmm-credit-original-tabindex");
    element.removeAttribute("data-cmm-credit-original-aria");
  }
}

function updateCreditPurchaseTrigger() {
  for (const element of document.querySelectorAll(CREDIT_BUTTON_ELEMENTS)) {
    const shouldLock = settings.lockCreditButton && isCreditBalanceTrigger(element);
    if (shouldLock || element.classList.contains(CREDIT_LOCK_CLASS)) {
      setCreditLocked(element, shouldLock);
    }
  }
}

// Capturing prevents React/Vue delegated click handlers and pointer handlers
// from opening the purchase modal, including interactions during DOM updates.
function blockCreditPurchaseInteraction(event) {
  if (!settings.lockCreditButton) return;
  if (event.type === "keydown" && !["Enter", " ", "Spacebar"].includes(event.key)) return;
  let element = event.target instanceof Element ? event.target : event.target?.parentElement;
  while (element && element !== document.documentElement) {
    if (element.classList.contains(CREDIT_LOCK_CLASS) || isCreditBalanceTrigger(element)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      return;
    }
    element = element.parentElement;
  }
}

for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "auxclick", "touchstart", "touchend", "keydown"]) {
  document.addEventListener(type, blockCreditPurchaseInteraction, {capture: true, passive: false});
}

function updateNavigation() {
  // Toggle only when actual state changes; never remove and re-add classes
  // on every observer tick (that causes an endless mutation loop).
  for (const item of document.querySelectorAll(NAV_ITEMS)) {
    toggleClass(item, HIDDEN_MENU_CLASS, shouldHideMenu(item));
  }
  // Clear stale classes that were hidden before settings changed or menu moved.
  for (const item of document.querySelectorAll(`.${HIDDEN_MENU_CLASS}`)) {
    if (!item.matches(NAV_ITEMS)) toggleClass(item, HIDDEN_MENU_CLASS, false);
  }
}

// Footer contains links and service branding that the user chose to hide.
// Limit this to semantic footer regions and explicit footer containers;
// never suppress navigation elsewhere solely based on an outbound URL.
function updateFooter() {
  for (const element of document.querySelectorAll(FOOTER_ZONE)) {
    toggleClass(element, HIDDEN_FOOTER_CLASS, settings.hideFooter);
  }
  for (const element of document.querySelectorAll(`.${HIDDEN_FOOTER_CLASS}`)) {
    if (!element.matches(FOOTER_ZONE)) toggleClass(element, HIDDEN_FOOTER_CLASS, false);
  }
}

// Hide the smallest header/sidebar logo-and-name lockup, never the whole
// navigation or content area. Handles a simple icon next to "AIVid Dev".
function getBrandLockup(textParent) {
  const direct = textParent.closest('a, button, [role="link"]');
  if (direct && norm(direct.textContent).length <= 90 && BRAND_LABEL.test(norm(direct.textContent))) return direct;
  let current = textParent;
  let best = textParent;
  for (let i = 0; i < 5 && current; i++, current = current.parentElement) {
    if (current.matches('header, nav, aside, [role="navigation"], [role="banner"], body, html')) break;
    const label = norm(current.textContent);
    if (!BRAND_LABEL.test(label)) break;
    best = current;
    // Select a compact row with an icon and a brand label, not just text.
    if (current.children.length >= 2 || current.querySelector('svg, img, [role="img"]')) return current;
  }
  return best;
}

function updateBranding() {
  if (!settings.hideBranding) {
    for (const el of document.querySelectorAll(`.${HIDDEN_BRAND_CLASS}`)) {
      toggleClass(el, HIDDEN_BRAND_CLASS, false);
    }
    return;
  }

  // Explicitly marked logo artwork anywhere in header and sidebar regions.
  for (const item of document.querySelectorAll(`${BRAND_ZONE} img, ${BRAND_ZONE} svg, ${BRAND_ZONE} a, ${BRAND_ZONE} [role='img']`)) {
    const alt = norm(item.getAttribute("alt") || item.getAttribute("aria-label") || item.getAttribute("title"));
    const classname = typeof item.className === "string" ? item.className : "";
    const src = item.getAttribute("src") || "";
    const obviousLogo = BRAND_LABEL.test(alt) || /(?:^|[\s_-])(?:aivid[-_]?logo|brand[-_]?logo)(?:[\s_-]|$)/i.test(classname) || /(?:aivid|brand)[-_]?logo\.(?:svg|png|webp|jpg)/i.test(src);
    toggleClass(item, HIDDEN_BRAND_CLASS, obviousLogo);
  }

  // Identify a brand label even when the site's sidebar is just <div>s.
  // The fallback is limited to a compact logo-like row in the top-left.
  if (document.body) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent || parent.closest('script, style, noscript, textarea, input, [contenteditable="true"]')) continue;
      if (!BRAND_LABEL.test(norm(node.nodeValue))) continue;
      const recognizedZone = Boolean(parent.closest(BRAND_ZONE));
      const rect = parent.getBoundingClientRect();
      const headerFallback = rect.width > 0 && rect.top >= 0 && rect.top < 170 && rect.left < 380;
      if (!recognizedZone && !headerFallback) continue;
      const unit = getBrandLockup(parent);
      toggleClass(unit, HIDDEN_BRAND_CLASS, true);
    }
  }
}

function scan() {
  if (scanning || !document.documentElement) return;
  scanning = true;
  try {
    setFlags();
    updateNavigation();
    updateCreditPurchaseTrigger();
    updateFooter();
    updateBranding();
    updateTitleAndIcon();
    updateCustomCSS();
  } finally {
    scanning = false;
  }
}

function scheduleScan() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    scan();
  });
}

function start() {
  if (!document.documentElement || observer) return;
  scan();
  observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["href", "src", "alt", "aria-label", "title", "class"]
  });
}

// document_start might precede the root element on some sites.
if (document.documentElement) start();
else {
  const rootObserver = new MutationObserver(() => {
    if (!document.documentElement) return;
    rootObserver.disconnect();
    start();
  });
  rootObserver.observe(document, { childList: true });
}

chrome.storage.sync.get(DEFAULTS, saved => {
  if (chrome.runtime.lastError) return;
  settings = { ...DEFAULTS, ...saved };
  scheduleScan();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  for (const key of Object.keys(DEFAULTS)) {
    if (changes[key]) settings[key] = changes[key].newValue ?? DEFAULTS[key];
  }
  scheduleScan();
});
