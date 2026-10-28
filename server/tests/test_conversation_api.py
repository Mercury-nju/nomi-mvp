"""HTTP integration of opt-in conversations; no external browser or sends."""
from fastapi.testclient import TestClient
from server.app import create_app
from server.db import now
from server.tests.test_backend import FakeAdapter, base_plan


class ReadOnlyInbox:
    def __init__(self):
        self.messages = []

    async def read_thread(self, customer):
        return {'identityVerified': True, 'complete': True, 'messages': list(self.messages)}


def test_opt_in_monitor_pauses_discovery_and_api_guards(tmp_path):
    adapter = FakeAdapter()
    app = create_app(tmp_path, adapter)
    inbox = ReadOnlyInbox()
    app.state.conversations.inbox = inbox
    with TestClient(app) as client:
        db = app.state.db
        db.put('customers', {'id': 'test-customer', 'nickname': '测试客户', 'platformId': 'stable',
            'profileUrl': 'https://www.douyin.com/user/stable', 'taskIds': [], 'messages': [], 'sources': [], 'discoveredAt': now()})
        assert client.get('/api/conversations').json() == []
        assert not client.get('/api/conversation-monitor').json()['enabled']
        assert client.post('/api/conversations', json={'customerId': 'missing'}).status_code == 409
        result = client.post('/api/conversations', json={'customerId': 'test-customer'})
        assert result.status_code == 200
        record = result.json()
        route = '/api/conversations/' + record['id']
        assert record['mode'] == 'suggest'
        assert client.put(route, json={'mode': 'auto', 'authorized': True}).status_code == 409
        assert client.post(route + '/sync').json()['baselineEstablished']
        assert client.put(route, json={'mode': 'auto'}).status_code == 409
        inbox.messages.append({'platformMessageId': 'incoming-1', 'direction': 'inbound', 'text': '你好', 'type': 'text'})
        synced = client.post(route + '/sync').json()
        assert len(synced['messages']) == 1
        assert not adapter.sent
        assert client.post(route + '/send', json={'text': '你好', 'revision': synced['revision'], 'requestId': 'request-1234'}).status_code in (409, 422)
        assert client.post(route + '/send', json={'text': '你好', 'authorized': True, 'revision': 0, 'requestId': 'request-1234'}).status_code == 409
        assert client.post(route + '/send', json={'text': '你好', 'authorized': True, 'revision': synced['revision'], 'requestId': 'bad'}).status_code == 422
        task = client.post('/api/tasks', json=base_plan()).json()
        assert client.put('/api/conversation-monitor', json={'enabled': True, 'intervalSeconds': 300}).status_code == 200
        assert client.get('/api/tasks/' + task['id']).json()['status'] == 'paused'
        assert client.post('/api/tasks/' + task['id'] + '/run').status_code == 409
        assert client.put('/api/conversation-monitor', json={'enabled': False, 'intervalSeconds': 15}).status_code == 200
        assert not adapter.sent


def test_command_idempotency_allows_same_text_next_turn(tmp_path):
    import asyncio
    from server.agent import Agent
    from server.db import Database

    async def check():
        db = Database(tmp_path / 'commands.sqlite3')
        db.put('customers', {'id': 'c', 'messages': [], 'sources': [], 'taskIds': []})
        adapter = FakeAdapter()
        worker = Agent(db, adapter)
        first = await worker.send('c', '好的', 'dm', command_id='turn-1')
        repeated = await worker.send('c', '好的', 'dm', command_id='turn-1')
        second = await worker.send('c', '好的', 'dm', command_id='turn-2')
        assert repeated['duplicate']
        assert first['id'] != second['id']
        assert len(adapter.sent) == 2
        try:
            await worker.send('c', '改了文字', 'dm', command_id='turn-1')
            raise AssertionError('must reject changed content for the same command')
        except ValueError:
            pass
        assert len(adapter.sent) == 2
        db.close()
    asyncio.run(check())
