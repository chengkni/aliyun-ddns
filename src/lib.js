'use strict';

/**
 * 纯函数工具：IP 解析 / 校验 / 子域名与 URL 列表解析。
 *
 * 这里不读 process.env、不发网络请求，方便在 CI 里直接用 node:test 覆盖。
 */

const net = require('node:net');

/** 去掉方括号、zone id，并统一小写。 */
function normalizeIp(raw) {
  return String(raw)
    .trim()
    .replace(/^\[|\]$/g, '') // [240e::1] -> 240e::1
    .replace(/%.*$/, '') // fe80::1%eth0 -> fe80::1
    .toLowerCase();
}

/** 只接受公网 IPv4；私网、回环、链路本地、CGNAT、组播/保留全部拒绝。 */
function isPublicIPv4(ip) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!match) return false;

  const octets = match.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return false;

  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a >= 224) return false;

  return true;
}

/** 只接受全局单播 2000::/3；ULA、链路本地、回环、6to4、IPv4-mapped 全部拒绝。 */
function isPublicIPv6(ip) {
  if (net.isIP(ip) !== 6) return false;

  const firstGroup = ip.startsWith('::') ? 0 : Number.parseInt(ip.split(':')[0], 16);
  if (!Number.isFinite(firstGroup) || (firstGroup & 0xe000) !== 0x2000) return false;

  // 6to4 不是原生公网单播，不作为 DDNS 目标
  if (ip.startsWith('2002:')) return false;

  return true;
}

/**
 * 从 IP 回显服务的响应里提取指定版本的地址。
 * 兼容三种常见格式：纯地址、带前缀的文本、带方括号/zone id 的地址。
 */
function extractIp(text, version) {
  const trimmed = String(text).trim();

  const direct = normalizeIp(trimmed);
  if (net.isIP(direct) === version) return direct;

  for (const token of trimmed.split(/[\s,;]+/)) {
    const candidate = normalizeIp(token);
    if (net.isIP(candidate) === version) return candidate;
  }

  // IPv4 兜底：从「Current IP Address: 1.2.3.4」这类文本里抠
  if (version === 4) {
    const match = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(text);
    if (match) return match[1];
  }

  return null;
}

/** 逗号分隔的 URL 列表，去空、去首尾空格。 */
function parseUrls(raw) {
  return String(raw)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 逗号/空白分隔的子域名列表，大小写不敏感去重，并校验 RR 字符集。 */
function parseSubdomains(raw) {
  const list = String(raw)
    .split(/[\s,;]+/)
    .map((item) => item.trim().replace(/\.$/, ''))
    .filter(Boolean);

  const seen = new Set();
  const result = [];
  for (const rr of list) {
    const key = rr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    if (!/^[A-Za-z0-9@_*-]+(\.[A-Za-z0-9@_*-]+)*$/.test(rr)) {
      throw new Error(`SUBDOMAINS 里有不合法的记录名：${rr}`);
    }
    result.push(rr);
  }

  if (result.length === 0) throw new Error('SUBDOMAINS 不能为空');
  return result;
}

module.exports = {
  normalizeIp,
  isPublicIPv4,
  isPublicIPv6,
  extractIp,
  parseUrls,
  parseSubdomains,
};
