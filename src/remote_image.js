'use strict';

// Downloads a reference image from a link a customer gave Claude. Only public
// https addresses are reached: every connection's resolved address is checked
// (so a hostname cannot point at the server's own network), redirects are
// followed at most 3 times under the same rules, and the body is size-capped.
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const blocked = new net.BlockList();
for (const [range, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(range, bits, 'ipv4');
for (const [range, bits] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blocked.addSubnet(range, bits, 'ipv6');

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (!family) return false;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is judged by its IPv4 address. (A
  // ::ffff:0:0/96 rule in the list would also match every plain IPv4 address.)
  const mapped = family === 6 && /^::ffff:/i.test(address) ? address.slice(7) : null;
  if (mapped) return net.isIPv4(mapped) ? isPublicAddress(mapped) : false;
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) {
      return callback(Object.assign(new Error('This address is not allowed.'), { code: 'EADDRBLOCKED' }));
    }
    if (options?.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

function imageType(data) {
  if (data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length > 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const fail = message => Object.assign(new Error(message), { statusCode: 400 });

function getOnce(url, { timeoutMs, signal, maxBytes, lookup, ca, accept, label, sizeLabel, stream }) {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && !isPublicAddress(host)) return reject(fail('This ' + label + ' link points to a private address.'));
    const request = https.get(url, { lookup, ca, signal, timeout: timeoutMs, ...(label === 'video' ? { agent: false } : {}), headers: { 'user-agent': 'CMM Tools ' + label + ' fetcher', accept } }, response => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) { response.resume(); return resolve({ redirect: response.headers.location }); }
      if (status !== 200) { response.resume(); return reject(fail('The ' + label + ' link returned HTTP ' + status + '.')); }
      const length = response.headers['content-length'];
      if (Number(length) > maxBytes) { response.destroy(); return reject(fail('The ' + label + ' is larger than ' + sizeLabel + '.')); }
      if (stream) {
        // The caller attaches its pipeline after opening a temporary file.
        response.on('error', () => {});
        return resolve({ body: response, contentLength: length });
      }
      const chunks = []; let total = 0;
      response.on('data', chunk => {
        total += chunk.length;
        if (total > maxBytes) { response.destroy(); reject(fail('The ' + label + ' is larger than ' + sizeLabel + '.')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ data: Buffer.concat(chunks, total) }));
      response.on('error', () => reject(fail('The ' + label + ' download was interrupted.')));
    });
    request.on('timeout', () => request.destroy(fail('The ' + label + ' link took too long to respond.')));
    request.on('error', error => reject(error?.statusCode ? error : fail(error?.code === 'EADDRBLOCKED' ? 'This ' + label + ' link points to a private address.' : 'The ' + label + ' link could not be opened.')));
  });
}

// lookup and ca are replaceable for tests only.
async function publicMedia(link, { timeoutMs, maxBytes, lookup = guardedLookup, ca, accept, label, sizeLabel, stream = false }) {
  let url;
  try { url = new URL(String(link)); } catch { throw fail('The ' + label + ' link is not a valid URL.'); }
  const signal = label === 'video' ? AbortSignal.timeout(timeoutMs) : undefined;
  for (let hop = 0; hop <= 3; hop++) {
    if (url.protocol !== 'https:' || (label === 'video' && url.port)) throw fail(label === 'image' ? 'Image links must start with https://.' : 'Use an HTTPS video link.');
    if (url.username || url.password) throw fail(label === 'image' ? 'Image links cannot contain a username or password.' : 'The video link cannot contain a username or password.');
    const out = await getOnce(url, { timeoutMs, signal, maxBytes, lookup, ca, accept, label, sizeLabel, stream });
    if (out.redirect) { url = new URL(out.redirect, url); continue; }
    return { url, ...out };
  }
  throw fail('The ' + label + ' link redirected too many times.');
}

async function fetchPublicImage(link, { timeoutMs = 20000, maxBytes = MAX_IMAGE_BYTES, lookup, ca } = {}) {
  const { url, data } = await publicMedia(link, { timeoutMs, maxBytes, lookup, ca, accept: 'image/*', label: 'image', sizeLabel: '15 MB' });
  const mimeType = imageType(data);
  if (!mimeType) throw fail('The link is not a JPEG, PNG or WebP image.');
  const name = decodeURIComponent(url.pathname.split('/').pop() || '').replace(/[^\w.-]+/g, '_').slice(0, 100) || 'reference-image';
  return { filename: name, mimeType, data };
}

async function fetchPublicMedia(link, { timeoutMs, maxBytes, accept }) {
  const { data } = await publicMedia(link, { timeoutMs, maxBytes, accept, label: 'video', sizeLabel: Math.ceil(maxBytes / 1048576) + ' MB' });
  return data;
}

async function openPublicVideo(link, { timeoutMs, maxBytes, accept }) {
  return publicMedia(link, { timeoutMs, maxBytes, accept, label: 'video',
    sizeLabel: Math.ceil(maxBytes / 1048576) + ' MiB', stream: true });
}

module.exports = { fetchPublicImage, fetchPublicMedia, openPublicVideo, isPublicAddress, imageType, MAX_IMAGE_BYTES };
