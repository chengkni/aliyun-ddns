'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeIp,
  isPublicIPv4,
  isPublicIPv6,
  extractIp,
  parseUrls,
  parseSubdomains,
} = require('../src/lib');

test('normalizeIp 去括号、zone id、统一小写', () => {
  assert.equal(normalizeIp('[240E:3B7::1]'), '240e:3b7::1');
  assert.equal(normalizeIp('fe80::1%eth0'), 'fe80::1');
  assert.equal(normalizeIp(' 1.2.3.4 '), '1.2.3.4');
});

test('isPublicIPv4 只放行公网地址', () => {
  for (const ip of ['1.2.3.4', '8.8.8.8', '172.32.0.1', '192.169.0.1']) {
    assert.equal(isPublicIPv4(ip), true, ip);
  }
  for (const ip of [
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '127.0.0.1',
    '169.254.1.1',
    '100.64.0.1',
    '224.0.0.1',
    '0.0.0.0',
    '256.1.1.1',
    'not-an-ip',
  ]) {
    assert.equal(isPublicIPv4(ip), false, ip);
  }
});

test('isPublicIPv6 只放行 2000::/3', () => {
  for (const ip of ['240e:3b7:1234::1', '2408:8207::1', '2001:4860:4860::8888']) {
    assert.equal(isPublicIPv6(ip), true, ip);
  }
  for (const ip of [
    'fe80::1',
    'fd00::1',
    'fc00::1',
    '::1',
    '::',
    '2002:c000:204::1',
    '64:ff9b::1.2.3.4',
    'not-an-ip',
  ]) {
    assert.equal(isPublicIPv6(ip), false, ip);
  }
});

test('extractIp 兼容常见回显格式', () => {
  assert.equal(extractIp('Current IP Address: 1.2.3.4', 4), '1.2.3.4');
  assert.equal(extractIp('1.2.3.4\n', 4), '1.2.3.4');
  assert.equal(extractIp('240e:3b7:1234::1', 6), '240e:3b7:1234::1');
  assert.equal(extractIp('[240E:3B7:1234::1]', 6), '240e:3b7:1234::1');
  assert.equal(extractIp('240e:1::1%eth0', 6), '240e:1::1');
  assert.equal(extractIp('no address here', 4), null);
  assert.equal(extractIp('1.2.3.4', 6), null);
});

test('parseUrls 去空去空格', () => {
  assert.deepEqual(parseUrls(' a , b ,, c '), ['a', 'b', 'c']);
  assert.deepEqual(parseUrls(''), []);
});

test('parseSubdomains 去重并校验', () => {
  assert.deepEqual(parseSubdomains('llm, home ,api.minio'), ['llm', 'home', 'api.minio']);
  assert.deepEqual(parseSubdomains('llm,LLM,llm'), ['llm']);
  assert.deepEqual(parseSubdomains('llm\nhome'), ['llm', 'home']);
  assert.throws(() => parseSubdomains(''), /不能为空/);
  assert.throws(() => parseSubdomains('bad/name'), /不合法/);
  assert.throws(() => parseSubdomains('llm..home'), /不合法/);
});
