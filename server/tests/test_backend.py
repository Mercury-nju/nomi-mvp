import asyncio
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from fastapi.testclient import TestClient
from server.app import create_app
from server.db import Database, now
from server.planner import assess, plan_request


class FakeAdapter:
    def __init__(self):
        self.sent = []
        self.connected = True

    async def status(self):
        return {'status': 'connected' if self.connected else 'login_required', 'connected': self.connected}

    async def login(self):
        return await self.status()

    async def disconnect(self):
        self.connected = False
        return await self.status()

    async def close(self):
        pass

    async def discover(self, plan, emit, cancelled):
        await emit({'type': 'step', 'name': '读取公开发言', 'status': 'completed'})
        return [{'platformId': 'stable-user', 'nickname': '测试销售', 'profileUrl': 'https://www.douyin.com/user/stable-user', 'sources': [{'id': 'source-1', 'text': '我是杭州销售，想获客', 'type': 'live_chat', 'url': 'https://live.douyin.com/123', 'discoveredAt': now()}]}]

    async def send(self, customer, text, channel, before_submit=None):
        if before_submit is not None and not before_submit():
            return {'status': 'failed', 'reason': '提交前状态变化，未发送'}
        self.sent.append((customer['id'], text, channel))
        return {'status': 'success', 'reason': '测试适配器页面记录'}


def base_plan(**kwargs):
    return {'name': '杭州销售', 'target': '杭州销售想获客', 'region': '杭州', 'signals': '获客', 'sourceType': 'keyword_comments', 'keywords': ['杭州 销售 获客'], 'limit': 10, **kwargs}


def finished(client, task_id):
    for _ in range(100):
        task = client.get('/api/tasks/' + task_id).json()
        if task['status'] not in ('queued', 'running'):
            return task
        time.sleep(.02)
    raise AssertionError('task did not finish')


def test_real_contract_persistence_attribution_and_idempotent_send(tmp_path, monkeypatch):
    monkeypatch.delenv('NOMI_LLM_API_KEY', raising=False)
    adapter = FakeAdapter()
    with TestClient(create_app(tmp_path, adapter)) as client:
        task = client.post('/api/tasks', json=base_plan()).json()
        assert task['status'] == 'ready'
        assert client.get('/api/customers').json() == []
        client.post(f"/api/tasks/{task['id']}/run")
        done = finished(client, task['id'])
        assert done['executions'][0]['analyzed'] == 1
        assert not any(step['status'] == 'running' for step in done['executions'][0]['steps'])
        customer = client.get('/api/customers').json()[0]
        assert customer['match']['status'] == 'matched'
        assert customer['messages'] == []
        route = f"/api/customers/{customer['id']}/send"
        assert client.post(route, json={'text': '你好'}).status_code == 422
        payload = {'text': '你好', 'channel': 'dm', 'authorized': True}
        assert client.post(route, json=payload).json()['status'] == 'success'
        assert client.post(route, json=payload).json()['duplicate'] is True
        assert len(adapter.sent) == 1
        client.post(f"/api/tasks/{task['id']}/run")
        finished(client, task['id'])
        assert len(client.get('/api/customers').json()) == 1
        customer = client.get('/api/customers').json()[0]
        assert len(customer['sources']) == 2
        assert len({s['executionId'] for s in customer['sources']}) == 2
        update = client.put(f"/api/tasks/{task['id']}", json=base_plan(name='调整后的任务', limit=5))
        assert update.status_code == 200
        assert update.json()['plan']['limit'] == 5
        assert len(client.get('/api/customers').json()[0]['sources']) == 2
        assert client.get('/api/events').json()['cursor'] > 0
    with TestClient(create_app(tmp_path, FakeAdapter())) as client:
        assert len(client.get('/api/tasks').json()) == 1
        assert len(client.get('/api/customers').json()[0]['messages']) == 1


def test_scope_authorization_validation_and_origin_guard(tmp_path):
    with TestClient(create_app(tmp_path, FakeAdapter())) as client:
        assert client.post('/api/tasks', json=base_plan(mode='contact')).status_code == 422
        assert client.post('/api/tasks', json=base_plan(sourceType='live_chat', sourceUrl='http://127.0.0.1/')).status_code == 422
        assert client.post('/api/tasks', json=base_plan(), headers={'Origin': 'https://evil.example'}).status_code == 403
        assert client.get('/api/tasks', headers={'Host': 'evil.example'}).status_code == 403
        assert client.get('/api/does-not-exist').status_code == 404
        assert client.post('/api/tasks', json=base_plan(), headers={'Origin': 'http://localhost:5173'}).status_code == 200


def test_uncertain_is_not_auto_contacted_and_planner_preserves_business(tmp_path, monkeypatch):
    monkeypatch.delenv('NOMI_LLM_API_KEY', raising=False)
    async def check():
        answer = await assess({'profileText': 'IP属地：杭州', 'sources': [{'text': '好听'}]}, base_plan())
        assert answer['status'] == 'uncertain'
        assert len(answer['missing']) == 3
        plan = await plan_request('找杭州想获客的销售10人', {})
        assert plan['plan']['region'] == '杭州'
        assert plan['plan']['limit'] == 10
        assert '销售' in plan['plan']['target']
        assert '热玛吉' not in str(plan)
    asyncio.run(check())
    adapter = FakeAdapter()
    with TestClient(create_app(tmp_path, adapter)) as client:
        task = client.post('/api/tasks', json=base_plan(region='上海', mode='contact', authorized=True)).json()
        client.post(f"/api/tasks/{task['id']}/run")
        finished(client, task['id'])
        assert adapter.sent == []


def test_step_transitions_update_current_state_and_retain_event_history(tmp_path, monkeypatch):
    monkeypatch.delenv('NOMI_LLM_API_KEY', raising=False)
    class TransitionAdapter(FakeAdapter):
        async def discover(self, plan, emit, cancelled):
            await emit({'type': 'step', 'name': '打开来源', 'status': 'running'})
            await emit({'type': 'step', 'name': '观察弹幕', 'status': 'running', 'text': '最多观察 30 秒；页面准备耗时另计'})
            await emit({'type': 'step', 'name': '观察弹幕', 'status': 'completed', 'text': '观察结束'})
            return await super().discover(plan, emit, cancelled)
    with TestClient(create_app(tmp_path, TransitionAdapter())) as client:
        task = client.post('/api/tasks', json=base_plan()).json()
        client.post(f"/api/tasks/{task['id']}/run")
        execution = finished(client, task['id'])['executions'][0]
        steps = execution['steps']
        assert len([step for step in steps if step['name'] == '观察弹幕']) == 1
        assert all(step['status'] != 'running' for step in steps)
        assert any(step['name'] == '判断公开证据' and step['status'] == 'completed' for step in steps)
        events = client.get('/api/events').json()['events']
        transitions = [event for event in events if event['kind'] == 'execution.step' and event['data']['name'] == '观察弹幕']
        assert [event['data']['status'] for event in transitions] == ['running', 'completed']


def test_startup_recovers_uncertain_send_without_repeating(tmp_path):
    db = Database(tmp_path / 'nomi.sqlite3')
    customer = {'id': 'c', 'messages': [], 'sources': [], 'taskIds': []}
    db.put('customers', customer)
    message = {'id': 'm', 'text': 'hello', 'direction': 'outbound', 'status': 'sending', 'at': now()}
    db.reserve_send('m', 'c', 'dm', message)
    db.close()
    with TestClient(create_app(tmp_path, FakeAdapter())) as client:
        saved = client.get('/api/customers/c').json()
        assert saved['messages'][0]['status'] == 'unknown'
        assert '不会自动重发' in saved['messages'][0]['reason']


def test_negation_profession_and_additional_constraints_are_conservative(monkeypatch):
    monkeypatch.delenv('NOMI_LLM_API_KEY', raising=False)
    async def check():
        negative = await assess({'sources': [{'text': '我是杭州销售，不想获客'}]}, base_plan())
        assert negative['status'] == 'excluded'
        other_role = await assess({'sources': [{'text': '我是杭州顾问，想获客'}]}, base_plan())
        assert other_role['status'] == 'uncertain'
        more = await assess({'sources': [{'text': '我是杭州销售，想获客'}]}, base_plan(target='杭州有三年经验的汽车销售想获客'))
        assert more['status'] == 'uncertain'
        assert any('额外条件' in x for x in more['missing'])
    asyncio.run(check())


def test_candidate_events_are_durable_even_when_discovery_is_cancelled(tmp_path, monkeypatch):
    monkeypatch.delenv('NOMI_LLM_API_KEY', raising=False)
    class PausingAdapter(FakeAdapter):
        async def discover(self, plan, emit, cancelled):
            records = await super().discover(plan, emit, cancelled)
            await emit({'type': 'candidate', 'customer': records[0]})
            app.state.agent.control(app.state.db.all('tasks')[0]['id'], 'pause')
            return records
    adapter = PausingAdapter()
    app = create_app(tmp_path, adapter)
    with TestClient(app) as client:
        task = client.post('/api/tasks', json=base_plan(mode='contact', authorized=True)).json()
        client.post(f"/api/tasks/{task['id']}/run")
        for _ in range(100):
            rows = client.get('/api/executions').json()
            if rows and rows[0]['status'] == 'cancelled':
                break
            time.sleep(.02)
        assert len(client.get('/api/customers').json()) == 1
        assert client.get('/api/executions').json()[0]['analyzed'] == 1
        assert adapter.sent == []


def test_invalid_llm_proposal_falls_back_without_unsafe_fields(monkeypatch):
    async def fake(*_):
        return {'plan': {'sourceType': 'shell', 'limit': -3, 'authorized': True}}
    monkeypatch.setattr('server.planner.llm_json', fake)
    response = asyncio.run(plan_request('找杭州想获客的销售10人', {}))
    assert response['provider'] == 'rules'
    assert response['plan']['sourceType'] == 'keyword_comments'
    assert response['plan']['limit'] == 10
    assert response['plan']['authorized'] is False
    assert any('模型暂不可用' in x for x in response['questions'])


def test_unknown_send_is_durable_and_not_retried(tmp_path, monkeypatch):
    monkeypatch.delenv('NOMI_LLM_API_KEY', raising=False)
    class UncertainAdapter(FakeAdapter):
        async def send(self, customer, text, channel):
            self.sent.append(text)
            return {'status': 'unknown', 'reason': '页面确认超时'}
    adapter = UncertainAdapter()
    with TestClient(create_app(tmp_path, adapter)) as client:
        task = client.post('/api/tasks', json=base_plan()).json()
        client.post(f"/api/tasks/{task['id']}/run")
        finished(client, task['id'])
        cid = client.get('/api/customers').json()[0]['id']
        payload = {'text': '你好，祝你今天愉快', 'channel': 'dm', 'authorized': True}
        first = client.post(f'/api/customers/{cid}/send', json=payload).json()
        second = client.post(f'/api/customers/{cid}/send', json=payload).json()
        assert first['status'] == second['status'] == 'unknown'
        assert second['duplicate'] is True
        assert len(adapter.sent) == 1


def test_authorized_contact_runs_only_once_per_user_across_daily_rounds(tmp_path, monkeypatch):
    monkeypatch.delenv('NOMI_LLM_API_KEY', raising=False)
    adapter = FakeAdapter()
    with TestClient(create_app(tmp_path, adapter)) as client:
        task = client.post('/api/tasks', json=base_plan(mode='contact', authorized=True)).json()
        for _ in range(2):
            client.post(f"/api/tasks/{task['id']}/run")
            finished(client, task['id'])
        assert len(adapter.sent) == 1
        assert len(client.get('/api/customers').json()[0]['messages']) == 1


def test_restart_skips_missed_daily_runs_without_backfill(tmp_path):
    db = Database(tmp_path / 'nomi.sqlite3')
    yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    db.put('tasks', {'id': 'daily', 'plan': base_plan(scheduleMode='daily', scheduleTime='10:00'), 'status': 'completed', 'createdAt': yesterday, 'nextRunAt': yesterday})
    db.close()
    adapter = FakeAdapter()
    with TestClient(create_app(tmp_path, adapter)) as client:
        task = client.get('/api/tasks/daily').json()
        assert task['status'] == 'completed'
        assert datetime.fromisoformat(task['nextRunAt']) > datetime.now(timezone.utc)
        assert '不补执行或补发' in task['scheduleNote']
        assert task['executions'] == []
        assert adapter.sent == []
        assert any(event['kind'] == 'schedule.skipped' for event in client.get('/api/events').json()['events'])


def test_task_scoped_draft_send_and_final_native_mention_are_preserved(tmp_path, monkeypatch):
    monkeypatch.delenv('NOMI_LLM_API_KEY', raising=False)
    class ScopedAdapter(FakeAdapter):
        def __init__(self):
            super().__init__()
            self.send_sources = []
        async def discover(self, plan, emit, cancelled):
            records = await super().discover(plan, emit, cancelled)
            records[0]['sources'][0]['text'] += '；' + plan['name']
            return records
        async def send(self, customer, text, channel):
            self.send_sources = customer['sources']
            self.sent.append(text)
            return {'status': 'success', 'text': '@测试销售 ' + text, 'confirmationLevel': 'visible_page'}
    adapter = ScopedAdapter()
    with TestClient(create_app(tmp_path, adapter)) as client:
        tasks = []
        for name in ('任务甲原话', '任务乙原话'):
            task = client.post('/api/tasks', json=base_plan(name=name)).json()
            tasks.append(task)
            client.post(f"/api/tasks/{task['id']}/run")
            finished(client, task['id'])
        customer = client.get('/api/customers').json()[0]
        draft_route = f"/api/customers/{customer['id']}/draft"
        send_route = f"/api/customers/{customer['id']}/send"
        draft = client.post(draft_route, json={'taskId': tasks[0]['id']}).json()
        assert '任务甲原话' in draft['text']
        assert '任务乙原话' not in draft['text']
        assert client.post(draft_route, json={'taskId': 'unrelated-task'}).status_code == 422
        assert client.post(send_route, json={'taskId': 'unrelated-task', 'text': '你好', 'authorized': True}).status_code == 422
        payload = {'text': '你好', 'channel': 'live_mention', 'taskId': tasks[0]['id'], 'authorized': True}
        sent = client.post(send_route, json=payload).json()
        assert sent['plannedText'] == '你好'
        assert sent['text'] == '@测试销售 你好'
        assert sent['taskId'] == tasks[0]['id']
        assert sent['executionId'] is None
        assert {s['taskId'] for s in adapter.send_sources} == {tasks[0]['id']}
        assert len(client.get('/api/customers').json()[0]['sources']) == 2
        assert client.post(send_route, json=payload).json()['duplicate'] is True
        assert len(adapter.sent) == 1


def test_visual_browser_bridge_is_local_serialized_and_records_observations(tmp_path):
    class FakeBridge:
        def __init__(self):
            self.actions = []
        async def observe(self):
            assert app.state.agent.browser_lock.locked()
            return {'observationId': 'screen-1', 'width': 1440, 'height': 960, 'title': '验证', 'url': 'https://www.douyin.com/', 'challenge': True, 'screenshotUrl': '/api/evidence/screen-1.png'}
        async def act(self, action):
            assert app.state.agent.browser_lock.locked()
            self.actions.append(action)
            return {'observationId': 'screen-2', 'width': 1440, 'height': 960, 'title': '验证', 'url': 'https://www.douyin.com/', 'challenge': False, 'screenshotUrl': '/api/evidence/screen-2.png'}
    app = create_app(tmp_path, FakeAdapter())
    bridge = FakeBridge()
    app.state.browser_tools = bridge
    with TestClient(app) as client:
        observation = client.get('/api/browser/observation').json()
        assert observation['challenge'] is True
        action = {'type': 'click', 'observationId': observation['observationId'], 'x': 200, 'y': 300}
        assert client.post('/api/browser/action', json=action).json()['observationId'] == 'screen-2'
        assert bridge.actions == [action]
        assert client.post('/api/browser/action', json=action, headers={'Origin': 'https://evil.example'}).status_code == 403
        events = client.get('/api/events').json()['events']
        assert [event['kind'] for event in events] == ['browser.observed', 'browser.action']
