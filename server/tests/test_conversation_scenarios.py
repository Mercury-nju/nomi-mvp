"""Cross-conversation and multi-turn acceptance scenarios, entirely isolated."""
import asyncio
from datetime import datetime, timedelta, timezone

from server.conversations import ConversationService
from server.db import Database


class ScenarioAgent:
    def __init__(self):
        self.browser_lock = asyncio.Lock()
        self.sent = []

    def knowledge(self):
        return {'service': '销售获客咨询'}

    async def send(self, customer_id, text, channel, locked=False, command_id=None, before_submit=None):
        assert locked and self.browser_lock.locked()
        if before_submit and not before_submit():
            return {'status': 'failed', 'reason': '提交前状态变更'}
        self.sent.append((customer_id, text, command_id))
        return {'status': 'success', 'reason': '隔离场景已确认出站'}


class ScenarioInbox:
    def __init__(self):
        self.rows = {'a': [], 'b': []}

    async def read_thread(self, customer):
        return {'identityVerified': True, 'complete': True, 'messages': list(self.rows[customer['id']])}


def message(text, identity, direction='inbound'):
    return {'text': text, 'platformMessageId': identity, 'direction': direction, 'type': 'text'}


def scenario(tmp_path):
    db = Database(tmp_path / 'scenarios.sqlite3')
    for identity in ('a', 'b'):
        db.put('customers', {'id': identity, 'nickname': '同名客户', 'platformId': identity,
            'profileUrl': 'https://www.douyin.com/user/' + identity, 'messages': [], 'taskIds': [], 'sources': []})
    agent, inbox = ScenarioAgent(), ScenarioInbox()
    service = ConversationService(db, agent, inbox)
    return db, agent, inbox, service, [service.create(identity)['id'] for identity in ('a', 'b')]


def age_pending(service, identity):
    record = service._get(identity)
    record['lastInboundAt'] = (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat()
    service._save(record)


def test_interleaved_same_name_same_message_ids_and_request_ids_stay_scoped(tmp_path):
    async def run():
        db, agent, inbox, service, (a, b) = scenario(tmp_path)
        await service.sync(a)
        await service.sync(b)
        # Platform IDs are only guaranteed unique within a conversation in this fixture.
        inbox.rows['a'] = [message('你好', 'same-id')]
        inbox.rows['b'] = [message('你好', 'same-id')]
        da, dbb = await service.sync(a), await service.sync(b)
        assert da['pendingCount'] == dbb['pendingCount'] == 1
        sa = await service.send(a, '您好', True, 'same-request', da['revision'])
        sb = await service.send(b, '您好', True, 'same-request', dbb['revision'])
        assert sa['lastSend']['id'] != sb['lastSend']['id']
        assert [sent[0] for sent in agent.sent] == ['a', 'b']
        assert all(m['conversationId'] == a for m in service.detail(a)['messages'])
        assert all(m['conversationId'] == b for m in service.detail(b)['messages'])
        assert db.get('customers', 'a')['messages'][0]['conversationId'] == a
        assert db.get('customers', 'b')['messages'][0]['conversationId'] == b
        db.close()
    asyncio.run(run())


def test_continuous_inputs_settle_to_one_reply_and_visible_echo_does_not_retrigger(tmp_path):
    async def run():
        db, agent, inbox, service, (identity, _) = scenario(tmp_path)
        await service.sync(identity)
        service.configure(identity, 'auto', True)
        service.configure_monitor(True, 10)
        inbox.rows['a'] = [message('你好', 'in-1'), message('你们提供什么服务', 'in-2')]
        observed = await service.sync(identity)
        assert observed['pendingCount'] == 2
        await service._auto(identity)
        assert not agent.sent  # The quiet window has not passed.
        age_pending(service, identity)
        await service._auto(identity)
        assert len(agent.sent) == 1
        assert '销售获客咨询' in agent.sent[0][1]
        out = service.detail(identity)['outbox'][0]
        assert len(out['basedOnMessageIds']) == 2
        inbox.rows['a'].append(message(agent.sent[0][1], 'out-1', 'outbound'))
        await service.sync(identity)
        await service._auto(identity)
        after = service.detail(identity)
        assert after['mode'] == 'auto' and after['pendingCount'] == 0
        assert len(after['messages']) == 3 and len(agent.sent) == 1
        db.close()
    asyncio.run(run())


def test_confirmed_pending_echo_survives_restart_without_duplicate_or_false_handoff(tmp_path):
    async def run():
        db, agent, inbox, service, (identity, _) = scenario(tmp_path)
        await service.sync(identity)
        inbox.rows['a'] = [message('你好', 'incoming')]
        current = await service.sync(identity)
        await service.send(identity, '您好', True, 'saved-command', current['revision'])
        service.configure(identity, 'auto', True)
        service.configure_monitor(True, 10)
        db.close()
        restored_db = Database(tmp_path / 'scenarios.sqlite3')
        restored = ConversationService(restored_db, agent, inbox)
        await restored.start()
        assert not restored.get_settings()['enabled']
        inbox.rows['a'].append(message('您好', 'server-out', 'outbound'))
        current = await restored.sync(identity)
        assert current['mode'] == 'auto'
        assert len(current['messages']) == 2
        assert not current['outbox'][0]['pendingEcho']
        repeated = await restored.send(identity, '您好', True, 'saved-command', 0)
        assert repeated['duplicate'] and len(agent.sent) == 1
        await restored.stop()
        restored_db.close()
    asyncio.run(run())
