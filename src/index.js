#!/usr/bin/env node
'use strict';

/**
 * aliyun-ddns —— 用阿里云 DNS OpenAPI 维护一组 A / AAAA 记录
 *
 * 设计要点：
 *   - 官方 v2 SDK（@alicloud/alidns20150109）
 *   - IPv4 始终维护；IPv6 由 ENABLE_IPV6 控制，默认关闭
 *   - 只更新 SUBDOMAINS 里列出的 RR，只碰 A / AAAA
 *   - 拒绝把私网、回环、链路本地、ULA、CGNAT 地址写进 DNS
 *   - DRY_RUN=1 时只查询和打印计划，不调用任何写接口
 *   - RUN_ONCE=1 时跑完一轮就退出（调试用）
 *
 * 环境变量见仓库根目录的 README。
 */

const {
  default: AlidnsClient,
  DescribeDomainRecordsRequest,
  AddDomainRecordRequest,
  UpdateDomainRecordRequest,
} = require('@alicloud/alidns20150109');
const { $OpenApiUtil } = require('@alicloud/openapi-core');
const $dara = require('@darabonba/typescript');
const {
  isPublicIPv4,
  isPublicIPv6,
  extractIp,
  parseUrls,
  parseSubdomains,
} = require('./lib');

const {
  ALIYUN_ACCESS_KEY_ID = '',
  ALIYUN_ACCESS_KEY_SECRET = '',
  DOMAIN = '',
  SUBDOMAINS = '',
  RECORD_TTL = '600',
  INTERVAL_SECONDS = '600',
  IP_URLS = 'https://ddns.oray.com/checkip,https://4.ipw.cn,https://api.ipify.org,https://ifconfig.me/ip',
  IPV6_URLS = 'https://6.ipw.cn,https://ipv6.icanhazip.com,https://ipv6.ident.me',
  IP_TIMEOUT_MS = '10000',
  ENABLE_IPV6 = '0',
  DRY_RUN = '0',
  RUN_ONCE = '0',
} = process.env;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const boolEnv = (value) => ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());

const DRY = boolEnv(DRY_RUN);
const RUN_ONCE_ENABLED = boolEnv(RUN_ONCE);
const IPV6_ENABLED = boolEnv(ENABLE_IPV6);
const TTL = Number.parseInt(RECORD_TTL, 10) || 600;
const INTERVAL_MS = Math.max(60, Number.parseInt(INTERVAL_SECONDS, 10) || 600) * 1000;
const FETCH_TIMEOUT_MS = Math.max(1000, Number.parseInt(IP_TIMEOUT_MS, 10) || 10_000);

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function fatal(message) {
  console.error(`[配置错误] ${message}`);
  process.exit(2);
}

if (!ALIYUN_ACCESS_KEY_ID) fatal('ALIYUN_ACCESS_KEY_ID 为空');
if (!ALIYUN_ACCESS_KEY_SECRET) fatal('ALIYUN_ACCESS_KEY_SECRET 为空');
if (!DOMAIN) fatal('DOMAIN 为空');

let subdomains;
try {
  subdomains = parseSubdomains(SUBDOMAINS);
} catch (error) {
  fatal(error.message);
}

const config = new $OpenApiUtil.Config({
  accessKeyId: ALIYUN_ACCESS_KEY_ID,
  accessKeySecret: ALIYUN_ACCESS_KEY_SECRET,
  protocol: 'HTTPS',
  endpoint: 'alidns.aliyuncs.com',
});
const client = new AlidnsClient(config);

// 显式设超时，避免网络半死时整轮无限挂住
const runtime = new $dara.RuntimeOptions({
  connectTimeout: 10_000,
  readTimeout: 15_000,
});

async function fetchPublicIp({ label, urls, isValid, version }) {
  if (urls.length === 0) throw new Error(`${label} 的探测地址为空`);

  const failures = [];
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': 'aliyun-ddns/2.1' },
        redirect: 'follow',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const text = await response.text();
      const ip = extractIp(text, version);
      if (!ip) throw new Error(`响应里没有 ${label} 地址：${text.trim().slice(0, 100)}`);
      if (!isValid(ip)) throw new Error(`拿到非公网 ${label} 地址（${ip}），拒绝写入`);
      return ip;
    } catch (error) {
      const message = error && error.name === 'TimeoutError' ? '超时' : error.message || String(error);
      log(`${label} 来源失败 ${url}: ${message}`);
      failures.push(`${url}: ${message}`);
    }
  }

  throw new Error(`所有 ${label} 来源均失败：\n  ${failures.join('\n  ')}`);
}

async function listRecords(rr, type) {
  const request = new DescribeDomainRecordsRequest({
    domainName: DOMAIN,
    RRKeyWord: rr,
    typeKeyWord: type,
    pageNumber: 1,
    pageSize: 100,
  });
  const response = await client.describeDomainRecordsWithOptions(request, runtime);
  const records = response?.body?.domainRecords?.record || [];

  // RRKeyWord 是模糊匹配，这里再按 RR 和类型做一次精确过滤
  return records.filter(
    (record) => record.RR === rr && String(record.type || '').toUpperCase() === type,
  );
}

async function addRecord(rr, ip, type) {
  const request = new AddDomainRecordRequest({
    domainName: DOMAIN,
    RR: rr,
    type,
    value: ip,
    TTL,
  });
  const response = await client.addDomainRecordWithOptions(request, runtime);
  log(`新增 ${rr}.${DOMAIN} ${type} -> ${ip}（RecordId=${response?.body?.recordId ?? '?'}）`);
}

async function updateRecord(record, ip, type) {
  const request = new UpdateDomainRecordRequest({
    recordId: record.recordId,
    RR: record.RR,
    type,
    value: ip,
    TTL,
  });
  const response = await client.updateDomainRecordWithOptions(request, runtime);
  log(
    `更新 ${record.RR}.${DOMAIN} ${type}: ${record.value} -> ${ip}` +
      `（RecordId=${response?.body?.recordId ?? record.recordId}）`,
  );
}

async function syncOne(rr, ip, type) {
  const records = await listRecords(rr, type);
  const record = records[0];

  if (record && record.value === ip) {
    log(`无需变更 ${rr}.${DOMAIN} ${type} = ${ip}`);
    return 'unchanged';
  }

  if (records.length > 1) {
    log(`⚠️ ${rr}.${DOMAIN} 有 ${records.length} 条 ${type} 记录，只更新第一条（${record.recordId}）`);
  }

  if (DRY) {
    const action = record ? `更新 ${record.value} ->` : '新增';
    log(`[DRY_RUN] ${action} ${rr}.${DOMAIN} ${type} = ${ip}`);
    return 'dry-run';
  }

  if (!record) {
    await addRecord(rr, ip, type);
    return 'added';
  }

  await updateRecord(record, ip, type);
  return 'updated';
}

async function tick() {
  log(
    `===== 开始一轮：${subdomains.length} 个子域名，` +
      `IPv6=${IPV6_ENABLED ? 'on' : 'off'}，TTL=${TTL}s，DRY_RUN=${DRY ? 'on' : 'off'} =====`,
  );

  // 先探测地址。某一族探测失败不影响另一族。
  const families = [];
  for (const family of [
    {
      type: 'A',
      label: 'IPv4',
      urls: parseUrls(IP_URLS),
      isValid: isPublicIPv4,
      version: 4,
    },
    ...(IPV6_ENABLED
      ? [
          {
            type: 'AAAA',
            label: 'IPv6',
            urls: parseUrls(IPV6_URLS),
            isValid: isPublicIPv6,
            version: 6,
          },
        ]
      : []),
  ]) {
    try {
      const ip = await fetchPublicIp(family);
      log(`${family.label} 公网地址: ${ip}`);
      families.push({ ...family, ip });
    } catch (error) {
      log(`${family.label} 本轮跳过：${error.message}`);
    }
  }

  if (families.length === 0) throw new Error('没有任何可用的公网地址');

  const stats = { added: 0, updated: 0, unchanged: 0, 'dry-run': 0, failed: 0 };

  for (const family of families) {
    for (const rr of subdomains) {
      try {
        const result = await syncOne(rr, family.ip, family.type);
        stats[result] = (stats[result] || 0) + 1;
      } catch (error) {
        stats.failed += 1;
        const code = error?.code ? `${error.code}: ` : '';
        const message = error?.message || String(error);

        if (/DomainRecordDuplicateError/.test(`${code}${message}`)) {
          log(`${rr}.${DOMAIN} ${family.type} 已存在相同记录（DomainRecordDuplicateError），跳过`);
        } else {
          log(`处理 ${rr}.${DOMAIN} ${family.type} 失败 -> ${code}${message}`);
        }
      }
      await sleep(200); // 温和限速，避免瞬间打满 API
    }
  }

  log(
    `本轮完成：新增 ${stats.added}，更新 ${stats.updated}，无变化 ${stats.unchanged}，` +
      `DRY_RUN ${stats['dry-run']}，失败 ${stats.failed}`,
  );
}

async function safeTick() {
  try {
    await tick();
  } catch (error) {
    log(`本轮失败：${error?.message || error}`);
  }
}

async function main() {
  log('aliyun-ddns 启动');
  log(`域名=${DOMAIN}`);
  log(`子域名=${subdomains.join(',')}`);
  log(
    `轮询间隔=${INTERVAL_MS / 1000}s，TTL=${TTL}s，IPv6=${IPV6_ENABLED ? 'on' : 'off'}，` +
      `DRY_RUN=${DRY ? 'on' : 'off'}`,
  );

  await safeTick();

  if (RUN_ONCE_ENABLED) {
    log('RUN_ONCE 已启用，退出');
    return;
  }

  const timer = setInterval(safeTick, INTERVAL_MS);

  const shutdown = (signal) => {
    log(`收到 ${signal}，退出`);
    clearInterval(timer);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  log(`进入轮询，每 ${INTERVAL_MS / 1000}s 一次`);
}

main().catch((error) => {
  console.error(`[致命错误] ${error?.stack || error}`);
  process.exit(1);
});
