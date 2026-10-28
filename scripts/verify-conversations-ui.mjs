import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Every API call is intercepted. This test cannot send a real Douyin message.
const output = path.resolve('artifacts/conversations-ui');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const page = await context.newPage();
const requests = [], errors = [], unhandled = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
const stamp = '2026-10-27T14:00:00+00:00';
const customer = { id: 'fixture-customer', nickname: '承接测试客户', platformId: 'fixture-person', profileUrl: 'https://www.douyin.com/user/fixture-person', taskIds: [], sources: [], messages: [] };
let conversations = [];
let monitor = { enabled: false, intervalSeconds: 10 };
const detail = () => conversations[0];
const pass = name => { checks.push({ name, passed: true }); process.stdout.write(`PASS ${name}\n`); };
await context.route('**/api/**', async route => {
  const request = route.request();
  const url = new URL(request.url());
  const pathname = url.pathname.replace(/^\/api/, '').replace(/\/$/, '');
  let body; try { body = request.postDataJSON(); } catch { body = undefined; }
  const method = request.method(); const entry = { method, path: pathname, body }; requests.push(entry);
  let result;
  if (pathname === '/account') result = { connected: true, status: 'connected', nickname: '隔离工作账号' };
  else if (pathname === '/tasks' || pathname === '/executions') result = [];
  else if (pathname === '/customers') result = [customer];
  else if (pathname === '/knowledge') result = {};
  else if (pathname === '/events') result = { events: [], cursor: 0 };
  else if (pathname === '/conversation-monitor') { if (method === 'PUT') monitor = body; result = monitor; }
  else if (pathname === '/conversations' && method === 'POST') {
    result = { id: 'fixture-conversation', customerId: body.customerId, nickname: customer.nickname, profileUrl: customer.profileUrl, mode: 'suggest', revision: 0, baselineEstablished: false, pendingCount: 0, updatedAt: stamp, stage: 'new', messages: [], outbox: [] }; conversations.push(result);
  }
  else if (pathname === '/conversations') result = conversations;
  else if (pathname === '/conversations/fixture-conversation') {
    if (method === 'PUT') { assert.notEqual(body.mode === 'auto' && !body.authorized, true); detail().mode = body.mode; detail().revision += 1; }
    result = detail();
  }
  else if (pathname === '/conversations/fixture-conversation/sync') {
    detail().baselineEstablished = true; detail().lastSyncAt = stamp; detail().revision += 1;
    detail().messages = [{ id: 'message-history', text: '你好，我想了解获客服务', direction: 'inbound', type: 'text', at: stamp, baseline: true }]; result = detail();
  }
  else if (pathname === '/conversations/fixture-conversation/draft') result = { text: '你好，请问你主要服务哪个行业？', action: 'ask', reason: '建议先了解业务需求', revision: detail().revision };
  else if (pathname === '/conversations/fixture-conversation/send') {
    assert.equal(body.authorized, true); assert.equal(body.revision, detail().revision);
    result = { id: `outbox-${detail().outbox.length}`, text: body.text, direction: 'outbound', status: 'confirmed', at: stamp, reason: '隔离测试记录，未真实发送' };
    detail().outbox.push(result); detail().messages.push(result); detail().revision += 1;
  }
  else if (pathname === '/conversations/fixture-conversation/outbox/outbox-unknown/resolve') {
    assert.equal(body.authorized, true); assert.equal(body.resolution, 'not_sent'); assert.match(body.note, /真实抖音会话/);
    detail().outbox.find(item => item.id === 'outbox-unknown').status = 'resolved'; detail().revision += 1; result = detail();
  }
  else { unhandled.push(entry); await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: `Unhandled fixture ${pathname}` }) }); return; }
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
});
try {
  await page.goto(process.env.BASE_URL || 'http://127.0.0.1:8765', { waitUntil: 'networkidle' });
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '私信承接', exact: true }).click();
  await expect(page.getByRole('heading', { name: '私信承接', exact: true })).toBeVisible();
  await expect(page.getByText('还没有会话', { exact: true })).toBeVisible();
  assert.equal(requests.filter(item => item.path.endsWith('/send')).length, 0);
  pass('初始只读空状态，不自动创建会话或发送消息');
  await page.getByLabel('加入已知客户', { exact: true }).selectOption(customer.id);
  await page.getByRole('button', { name: '加入会话', exact: true }).click();
  await expect(page.getByText('首次同步仅导入可见历史，不自动回复历史消息。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '开启此会话自动承接', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '同步消息', exact: true }).click();
  await expect(page.getByLabel('双方消息记录')).toContainText('你好，我想了解获客服务');
  await page.getByRole('button', { name: '生成建议回复', exact: true }).click();
  await expect(page.getByLabel('本轮回复内容')).toHaveValue('你好，请问你主要服务哪个行业？');
  await expect(page.getByRole('button', { name: '发送本条私信', exact: true })).toBeDisabled();
  pass('加入指定客户并建立历史基线，生成建议不会直接发送');
  await page.screenshot({ path: path.join(output, '01-suggestion-desktop.png'), fullPage: true });
  await page.getByLabel('确认发送本条私信', { exact: true }).check();
  await page.getByRole('button', { name: '发送本条私信', exact: true }).click();
  await expect(page.getByRole('heading', { name: '发送记录', exact: true })).toBeVisible();
  const send = requests.find(item => item.path.endsWith('/send'));
  assert.equal(send.body.authorized, true); assert.equal(typeof send.body.requestId, 'string'); assert.equal(send.body.revision, 1);
  pass('单条发送必须明确勾选，携带会话版本与幂等命令ID');
  await page.getByRole('button', { name: '生成建议回复', exact: true }).click();
  await expect(page.getByLabel('本轮回复内容')).not.toHaveValue('');
  detail().revision += 1;
  detail().messages.push({ id: 'message-new', text: '补充一下，我是做汽车销售的', direction: 'inbound', type: 'text', at: stamp });
  await expect(page.getByLabel('本轮回复内容')).toHaveValue('', { timeout: 10000 });
  await expect(page.getByLabel('确认发送本条私信')).not.toBeChecked();
  pass('新消息更新会话版本后，旧草稿及发送授权自动失效');
  await page.getByLabel('授权此会话自动承接', { exact: true }).check();
  await page.getByRole('button', { name: '开启此会话自动承接', exact: true }).click();
  await expect(page.getByText('会话已切换为自动承接。', { exact: true })).toBeVisible();
  const auto = requests.find(item => item.method === 'PUT' && item.body?.mode === 'auto'); assert.equal(auto.body.authorized, true);
  await page.getByRole('button', { name: '人工接管', exact: true }).click();
  await expect(page.getByText('已接管该会话，未发送的自动回复将停止。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '开启观察并暂停找客', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止观察', exact: true })).toBeVisible();
  assert.equal(requests.find(item => item.path === '/conversation-monitor' && item.method === 'PUT').body.enabled, true);
  pass('逐会话授权自动承接、人工接管与观察开关均调用正确接口');
  detail().outbox.push({ id: 'outbox-unknown', text: '发送中断的隔离测试消息', direction: 'outbound', status: 'unknown', at: stamp, reason: '等待人工核查，禁止自动重发' });
  await expect(page.getByRole('button', { name: '已人工核对：确实未发出', exact: true })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('button', { name: '已人工核对：确实已发出', exact: true })).toBeDisabled();
  await page.getByLabel('已在抖音会话核对这条消息的实际状态', { exact: true }).check();
  await page.getByRole('button', { name: '已人工核对：确实未发出', exact: true }).click();
  await expect(page.getByText('人工核查已记录', { exact: true })).toBeVisible();
  assert.equal(requests.filter(item => item.path.endsWith('/send')).length, 1);
  pass('未知发送状态需核查勾选与明确结论，仅记录人工结果，不自动重发');
  await page.screenshot({ path: path.join(output, '02-conversation-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(output, '03-conversation-mobile.png'), fullPage: true });
  pass('390px 会话列表、消息与回复区无文档横向溢出');
  const navigation = page.getByRole('navigation', { name: '主导航', exact: true });
  for (const name of ['提需求', '任务中心', '结果中心', '账号管理', '知识库', '私信承接']) {
    const button = navigation.getByRole('button', { name, exact: true });
    await expect(button).toBeVisible();
    await button.click();
    await expect(button).toHaveAttribute('aria-current', 'page');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} mobile overflow`);
  }
  pass('390px 六个导航均可访问、可切换且无文档横向溢出');
  assert.deepEqual(errors, []); assert.deepEqual(unhandled, []);
  pass('所有API请求均被拦截，无页面脚本错误、无真实发送');
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
  checks.push({ name: error.message, passed: false }); throw error;
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ checks, requests, errors, unhandled }, null, 2));
  await browser.close();
}
