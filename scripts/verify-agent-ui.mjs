import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// This test intercepts every /api request. It never contacts Douyin or mutates the real service.
const baseURL = process.env.BASE_URL || 'http://127.0.0.1:8765';
const output = path.resolve('artifacts/agent-ui');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const page = await context.newPage();
const checks = [];
const requests = [];
const errors = [];
const unhandled = [];
page.on('pageerror', error => errors.push(error.message));
const pass = name => { checks.push({ name, passed: true }); process.stdout.write(`PASS ${name}\n`); };
const stamp = '2026-10-27T13:00:00+00:00';
const plan = { name: '杭州销售获客测试', target: '寻找杭州有明确获客需求的销售', region: '杭州', signals: '想获客、找客户', sourceType: 'keyword_comments', keywords: ['杭州销售获客'], workKeywords: [], maxWorks: 10, maxComments: 50, scanLimit: 100, sourceUrl: '', scheduleMode: 'once', scheduleTime: '10:00', limit: 10, observeSeconds: 60, mode: 'find', channel: 'dm', authorized: false, communicationStrategy: '' };
const tasks = [{ id: 'task-other', plan: { ...plan, name: '音乐兴趣观察', target: '寻找喜欢音乐的观众' }, status: 'completed', createdAt: stamp }];
const executions = [];
const customers = [{ id: 'person-fixture', taskIds: ['task-one','task-other'], platformId: 'fixture-person-01', nickname: '隔离测试用户', profileUrl: 'https://www.douyin.com/user/fixture-public-person', discoveredAt: stamp, target: true, match: { status: 'matched', reasons: ['另一任务喜欢音乐'] }, matches: {'task-one':{status:'uncertain',reasons:['明确表达找客户需求'],missing:['杭州地域尚未核实']},'task-other':{status:'matched',reasons:['另一任务喜欢音乐'],missing:[]}}, sources: [{id:'source-one',taskId:'task-one',type:'作品评论',title:'销售获客作品',url:'https://www.douyin.com/video/123456789',text:'我做销售，希望找到更多客户',discoveredAt:stamp},{id:'source-other',taskId:'task-other',type:'直播弹幕',title:'音乐直播',url:'https://live.douyin.com/123456',text:'这首歌真好听',discoveredAt:stamp}], messages: [{id:'old-message',taskId:'task-other',channel:'dm',direction:'outbound',status:'success',text:'另一任务的历史消息',at:stamp}] }];
let knowledge = {identity:'获客顾问',service:'销售获客咨询',region:'杭州',style:'礼貌简短'};
const observation = { observationId:'observation-fixture', screenshotUrl:'/api/browser/screenshot/fixture.svg', width:800,height:500,title:'隔离测试页面',url:'https://www.douyin.com/',challenge:false,availableActions:[],message:'当前没有可操作的验证。'};
await context.route('**/api/**', async route => {
  const request = route.request();
  const url = new URL(request.url());
  const pathname = url.pathname.replace(/^\/api/,'');
  let body;
  try { body = request.postDataJSON(); } catch { body = undefined; }
  const entry = {method:request.method(),path:pathname,body}; requests.push(entry);
  let result;
  if(pathname === '/account') result={connected:true,status:'connected',nickname:'测试工作账号'};
  else if(pathname === '/knowledge' && request.method() === 'PUT') result=knowledge=body;
  else if(pathname === '/knowledge') result=knowledge;
  else if(pathname === '/events') result={events:[],cursor:0};
  else if(pathname === '/plan') result={plan,questions:[],provider:'rules'};
  else if(pathname === '/tasks' && request.method() === 'POST') { result={id:'task-one',plan:body,status:'ready',createdAt:stamp};tasks.unshift(result); }
  else if(pathname === '/tasks') result=tasks;
  else if(pathname === '/tasks/task-one/run') {
    tasks.find(task=>task.id==='task-one').status='completed';
    executions.unshift({id:`execution-${executions.length+1}`,taskId:'task-one',status:'completed',startedAt:stamp,finishedAt:stamp,steps:[{name:'搜索并筛选公开作品',status:'completed',time:stamp},{name:'读取评论与公开主页',status:'completed',time:stamp}],analyzed:1,targeted:0,contacted:0,leads:0}); result=tasks.find(task=>task.id==='task-one');
  }
  else if(pathname === '/tasks/task-one' && request.method() === 'PUT') { tasks.find(task=>task.id==='task-one').plan=body; result=tasks.find(task=>task.id==='task-one'); }
  else if(pathname === '/executions') result=executions;
  else if(pathname === '/customers') result=customers;
  else if(pathname === '/customers/person-fixture/draft') result={text:'你好，看到你提到找客户，来礼貌打个招呼，祝你今天愉快。',provider:'rules'};
  else if(pathname === '/customers/person-fixture/send') {result={id:'test-message',taskId:body.taskId,text:body.text,channel:body.channel,direction:'outbound',status:'success',at:stamp,reason:'仅测试拦截记录，没有真实发送'};customers[0].messages.push(result);}
  else if(pathname === '/browser/observation') result=observation;
  else if(pathname === '/browser/screenshot/fixture.svg') { await route.fulfill({status:200,contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#f7f3e9"/><text x="40" y="65" fill="#5a5142" font-family="sans-serif" font-size="24">Isolated browser observation fixture</text><rect x="200" y="160" width="400" height="180" rx="12" fill="white" stroke="#ddd5c4"/><text x="250" y="255" font-size="20" font-family="sans-serif" fill="#83765b">No active challenge</text></svg>'});return; }
  else {unhandled.push(entry);await route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({detail:`Unhandled fixture: ${pathname}`})});return;}
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});
});
async function go(name){await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name,exact:true}).click();}
try {
  await page.goto(baseURL, {waitUntil:'networkidle'});
  await expect(page.locator('.ag-service')).toBeVisible();
  await page.getByLabel('输入获客需求',{exact:true}).fill('找10个杭州想获客的销售，只找人。');
  await page.getByRole('button',{name:'整理执行方案',exact:true}).click();
  await expect(page.getByRole('heading',{name:'把需求变成执行方案'})).toBeVisible();
  await page.getByLabel('搜索关键词',{exact:true}).fill('杭州销售获客，杭州找客户');
  await expect(page.getByLabel('搜索关键词',{exact:true})).toHaveValue('杭州销售获客，杭州找客户');
  await page.getByLabel('作品标题筛选（可选）',{exact:true}).fill('获客，销售');
  await page.getByLabel('最多查看作品数',{exact:true}).fill('4');
  await page.getByLabel('每个作品最多查看评论数',{exact:true}).fill('20');
  await page.getByLabel('本轮最多查看候选人数',{exact:true}).fill('30');
  await page.getByLabel('目标客户',{exact:true}).fill('杭州本地、有明确找客户需求的销售');
  await page.screenshot({path:path.join(output,'01-plan-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'确认并立即执行',exact:true}).click();
  await expect(page.getByRole('heading',{name:'杭州销售获客测试',exact:true,level:2})).toBeVisible();
  const creation=requests.find(entry=>entry.path==='/tasks'&&entry.method==='POST');
  assert.deepEqual(creation.body.keywords,['杭州销售获客','杭州找客户']);
  assert.deepEqual(creation.body.workKeywords,['获客','销售']);
  assert.equal(creation.body.maxWorks,4);assert.equal(creation.body.maxComments,20);assert.equal(creation.body.scanLimit,30);
  assert.equal(requests.filter(entry=>entry.path==='/tasks/task-one/run').length,1);
  pass('需求 → 多关键词与作品筛选 → 确认保存 → 执行一轮');

  await page.getByRole('button',{name:'调整任务',exact:true}).click();
  await expect(page.getByRole('heading',{name:'调整任务执行方案'})).toBeVisible();
  await page.getByLabel('任务名称',{exact:true}).fill('杭州销售获客调整');
  await page.getByRole('button',{name:'保存调整',exact:true}).click();
  await expect(page.getByRole('heading',{name:'杭州销售获客调整',exact:true,level:2})).toBeVisible();
  assert.equal(requests.find(entry=>entry.method==='PUT'&&entry.path==='/tasks/task-one').body.name,'杭州销售获客调整');
  assert.equal(requests.filter(entry=>entry.method==='POST'&&entry.path==='/tasks').length,1);
  await page.screenshot({path:path.join(output,'02-task-desktop.png'),fullPage:true});
  pass('调整任务使用 PUT，保留同一任务与历史，不重复创建');

  await go('结果中心');
  await page.getByLabel('按任务筛选',{exact:true}).selectOption('task-one');
  await expect(page.locator('.ag-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.ag-table tbody')).toContainText('我做销售，希望找到更多客户');
  await expect(page.locator('.ag-table tbody')).not.toContainText('这首歌真好听');
  await expect(page.locator('.ag-table tbody .ag-match')).toHaveText('待核实');
  await expect(page.locator('.ag-metrics strong')).toHaveText(['1 人','0 人','0 人','0 人']);
  await page.getByRole('button',{name:'查看详情',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await expect(dialog).toContainText('当前判断对应任务：杭州销售获客调整');
  await expect(dialog).toContainText('杭州地域尚未核实');
  await expect(dialog).toContainText('所属任务：杭州销售获客调整');
  await expect(dialog).toContainText('所属任务：音乐兴趣观察');
  pass('任务筛选隔离匹配、来源摘要、发送指标；详情保留带归属历史');

  await expect(dialog.getByRole('button',{name:'发送这一条',exact:true})).toBeDisabled();
  await dialog.getByRole('button',{name:'生成话术',exact:true}).click();
  await expect(dialog.getByLabel('待发送话术',{exact:true})).not.toHaveValue('');
  assert.equal(requests.find(entry=>entry.path==='/customers/person-fixture/draft').body.taskId,'task-one');
  await expect(dialog.getByRole('button',{name:'发送这一条',exact:true})).toBeDisabled();
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button',{name:'发送这一条',exact:true}).click();
  await expect(dialog).toContainText('仅测试拦截记录，没有真实发送');
  const send=requests.find(entry=>entry.path==='/customers/person-fixture/send');
  assert.equal(send.body.taskId,'task-one');assert.equal(send.body.authorized,true);assert.equal(send.body.channel,'dm');
  assert.equal(requests.filter(entry=>entry.path.endsWith('/send')).length,1);
  await page.screenshot({path:path.join(output,'03-customer-desktop.png'),fullPage:true});
  await dialog.getByRole('button',{name:'关闭客户详情',exact:true}).click();
  pass('单条话术需要明确勾选；draft/send均携带当前任务ID（全部被测试拦截）');

  await go('账号管理');
  await page.getByRole('button',{name:/^页面处理/}).click();
  await page.getByRole('button',{name:'查看当前验证页面',exact:true}).click();
  await expect(page.getByText('当前没有可操作的验证',{exact:true})).toBeVisible();
  await expect(page.getByRole('img',{name:'当前抖音页面验证截图',exact:true})).toBeVisible();
  await page.getByRole('img',{name:'当前抖音页面验证截图',exact:true}).click({position:{x:50,y:50}});
  assert.equal(requests.filter(entry=>entry.path==='/browser/action').length,0);
  await expect(page.getByRole('button',{name:'拖动',exact:true})).toHaveCount(0);
  await page.screenshot({path:path.join(output,'04-page-assist-desktop.png'),fullPage:true});
  pass('页面处理无验证时只读展示，不发送点击/拖动动作');

  await page.setViewportSize({width:390,height:844});
  for(const name of ['提需求','任务中心','结果中心','账号管理','知识库']) {
    await go(name);
    const widths=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:document.documentElement.clientWidth}));
    assert.ok(widths.scroll<=widths.width+1,`${name} overflows: ${JSON.stringify(widths)}`);
    await page.screenshot({path:path.join(output,`mobile-${name}.png`),fullPage:true});
  }
  pass('390px 五个页面均无文档横向溢出');
  assert.deepEqual(unhandled,[]);assert.deepEqual(errors,[]);
  pass('无未覆盖API请求、无浏览器脚本错误、无真实后端写入');
  await writeFile(path.join(output,'report.json'),JSON.stringify({baseURL,checks,requests,errors,unhandled},null,2));
} catch(error) {
  await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});
  await writeFile(path.join(output,'report.json'),JSON.stringify({baseURL,checks,requests,errors,unhandled,error:String(error)},null,2));
  throw error;
} finally { await context.close();await browser.close(); }
