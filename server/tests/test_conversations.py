import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from server.conversations import ConversationService
from server.db import Database, now


class Agent:
    def __init__(self):
        self.browser_lock = asyncio.Lock()
        self.sent = []
        self.result = 'success'
        self.before_submit_hook = None

    def knowledge(self):
        return {'service': '销售获客咨询'}

    async def send(self, customer_id, text, channel, locked=False, command_id=None, before_submit=None):
        assert locked and self.browser_lock.locked()
        if self.before_submit_hook:
            self.before_submit_hook()
            self.before_submit_hook = None
        if before_submit is not None and not before_submit():
            return {'status': 'failed', 'reason': '发送前会话状态已变化，没有提交。'}
        self.sent.append((customer_id, text, command_id))
        return {'status': self.result, 'reason': '隔离测试页面回显'}


class Inbox:
    def __init__(self):
        self.rows = []
        self.verified = True
        self.hook = None

    async def read_thread(self, customer):
        assert customer['platformId'] == 'verified-user'
        if self.hook:
            self.hook()
            self.hook = None
        return {'identityVerified': self.verified, 'complete': True, 'messages': self.rows[:], 'reason': '身份未核对' if not self.verified else None}


def row(text, direction='inbound', identity=None, kind='text'):
    return {'text': text, 'direction': direction, 'type': kind, 'platformMessageId': identity}


def setup(tmp_path):
    db = Database(tmp_path / 'conversations.sqlite3')
    db.put('customers', {'id': 'c1', 'nickname': '测试客户', 'platformId': 'verified-user', 'profileUrl': 'https://www.douyin.com/user/verified-user', 'messages': []})
    agent, inbox = Agent(), Inbox()
    service = ConversationService(db, agent, inbox)
    identity = service.create('c1')['id']
    return db, agent, inbox, service, identity


def test_baseline_then_repeated_identical_messages_not_text_dedup(tmp_path):
    async def run():
        db, agent, inbox, service, identity = setup(tmp_path)
        assert service.get_settings()['enabled'] is False
        inbox.rows = [row('你好')]
        first = await service.sync(identity)
        assert first['baselineEstablished'] and first['pendingCount'] == 0
        assert first['messages'][0]['baseline'] is True
        inbox.rows.append(row('你好'))
        second = await service.sync(identity)
        assert len(second['messages']) == 2 and second['pendingCount'] == 1
        again = await service.sync(identity)
        assert len(again['messages']) == 2
        assert agent.sent == []
        assert len(db.get('customers', 'c1')['messages']) == 1
        db.close()
    asyncio.run(run())


def test_stale_reply_rejected_and_manual_takeover_while_reading(tmp_path):
    async def run():
        db, agent, inbox, service, identity = setup(tmp_path)
        await service.sync(identity)
        inbox.rows.append(row('你好', identity='m1'))
        detail = await service.sync(identity)
        draft = await service.draft(identity)
        assert draft['suggestion']['action'] == 'ask'
        inbox.rows.append(row('还有一个问题', identity='m2'))
        with pytest.raises(ValueError, match='会话已变化'):
            await service.send(identity, '您好', True, 'request-1', detail['revision'])
        revision = service.detail(identity)['revision']
        inbox.hook = lambda: service.configure(identity, 'human')
        with pytest.raises(ValueError, match='会话已变化'):
            await service.send(identity, '您好', True, 'request-2', revision)
        assert service.detail(identity)['mode'] == 'human'
        assert not agent.sent
        db.close()
    asyncio.run(run())


def test_command_idempotency_but_same_text_on_later_turn_is_valid(tmp_path):
    async def run():
        db, agent, inbox, service, identity = setup(tmp_path)
        await service.sync(identity)
        inbox.rows.append(row('你好', identity='in-1'))
        detail = await service.sync(identity)
        first = await service.send(identity, '您好！', True, 'turn-one', detail['revision'])
        assert first['lastSend']['status'] == 'confirmed'
        retry = await service.send(identity, '您好！', True, 'turn-one', detail['revision'])
        assert retry['duplicate'] and len(agent.sent) == 1
        with pytest.raises(ValueError, match='不可更改正文'):
            await service.send(identity, '改过的正文', True, 'turn-one', first['revision'])
        inbox.rows += [row('您好！', 'outbound', 'out-1'), row('你好', identity='in-2')]
        second = await service.sync(identity)
        assert second['mode'] == 'suggest'  # Our visible echo is not an external human reply.
        assert len(second['messages']) == 3
        await service.send(identity, '您好！', True, 'turn-two', second['revision'])
        assert len(agent.sent) == 2 and agent.sent[0][2] != agent.sent[1][2]
        db.close()
    asyncio.run(run())


def test_unknown_send_and_restart_never_automatically_retry(tmp_path):
    async def run():
        db, agent, inbox, service, identity = setup(tmp_path)
        await service.sync(identity)
        agent.result = 'unknown'
        first = await service.send(identity, '您好', True, 'request', 0)
        assert first['mode'] == 'human' and first['lastSend']['status'] == 'unknown'
        with pytest.raises(ValueError, match='结果未知'):
            service.configure(identity, 'auto', True)
        db.put('conversation_outbox', {'id': 'crashed', 'conversationId': identity, 'text': '未知消息', 'status': 'sending', 'createdAt': now()})
        service.configure_monitor(True, 10)
        await service.start()
        assert db.get('conversation_outbox', 'crashed')['status'] == 'unknown'
        assert not service.get_settings()['enabled']
        await service.stop()
        assert len(agent.sent) == 1
        db.close()
    asyncio.run(run())


def test_auto_is_opt_in_only_future_incoming_and_rule_unknown_handoffs(tmp_path):
    async def run():
        db, agent, inbox, service, identity = setup(tmp_path)
        with pytest.raises(ValueError, match='历史基线'):
            service.configure(identity, 'auto', True)
        inbox.rows = [row('你好', identity='historical')]
        await service.sync(identity)
        with pytest.raises(ValueError, match='明确授权'):
            service.configure(identity, 'auto', False)
        service.configure(identity, 'auto', True)
        service.configure_monitor(True, 10)
        await service._auto(identity)
        assert not agent.sent
        inbox.rows += [row('你们提供什么服务', identity='future')]
        await service.sync(identity)
        item = service._get(identity)
        item['lastInboundAt'] = (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat()
        service._save(item)
        await service._auto(identity)
        assert len(agent.sent) == 1 and '销售获客咨询' in agent.sent[0][1]
        inbox.rows += [row(agent.sent[0][1], 'outbound', 'visible-echo'), row('一个无法可靠理解的问题', identity='future-2')]
        await service.sync(identity)
        item = service._get(identity)
        item['lastInboundAt'] = (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat()
        service._save(item)
        await service._auto(identity)
        assert service.detail(identity)['mode'] == 'human'
        assert len(agent.sent) == 1
        assert db.all('decisions')
        db.close()
    asyncio.run(run())


@pytest.mark.parametrize('text,kind,mode', [('别联系我了', 'text', 'paused'), ('我要人工客服', 'text', 'human'), ('[图片]', 'image', 'human')])
def test_rejection_media_and_handoff_stop_automatic_reply(tmp_path, text, kind, mode):
    async def run():
        db, agent, inbox, service, identity = setup(tmp_path)
        await service.sync(identity)
        service.configure(identity, 'auto', True)
        inbox.rows.append(row(text, identity='new', kind=kind))
        detail = await service.sync(identity)
        assert detail['mode'] == mode
        await service._auto(identity)
        assert not agent.sent
        db.close()
    asyncio.run(run())


def test_wrong_identity_and_ambiguous_window_never_trigger_send(tmp_path):
    async def run():
        db, agent, inbox, service, identity = setup(tmp_path)
        inbox.rows = [row('好的'), row('好的')]
        await service.sync(identity)
        service.configure(identity, 'auto', True)
        inbox.verified = False
        inbox.rows.append(row('你好'))
        detail = await service.sync(identity)
        assert not detail['syncHealthy'] and detail['pendingCount'] == 0
        inbox.verified = True
        inbox.rows = [row('好的'), row('好的'), row('新的消息')]
        await service.sync(identity)  # Prefix append is unambiguous.
        inbox.rows = [row('好的'), row('好的'), row('好的')]
        detail = await service.sync(identity)  # No unique overlap with prior message tail.
        assert detail['mode'] == 'human' and not detail['syncHealthy']
        assert not agent.sent
        db.close()
    asyncio.run(run())


def test_external_outbound_stops_auto_and_disappearing_history_is_not_reset(tmp_path):
    async def run():
        db, agent, inbox, service, identity = setup(tmp_path)
        inbox.rows = [row('你好', identity='first')]
        await service.sync(identity)
        service.configure(identity, 'auto', True)
        inbox.rows.append(row('我是人工客服', 'outbound', 'phone-send'))
        detail = await service.sync(identity)
        assert detail['mode'] == 'human'
        inbox.rows = []
        detail = await service.sync(identity)
        assert len(detail['messages']) == 2 and detail['snapshot']
        assert not detail['syncHealthy']
        db.close()
    asyncio.run(run())


def test_monitor_disabled_during_read_prevents_automatic_send(tmp_path):
    async def run():
        db, agent, inbox, service, identity = setup(tmp_path)
        await service.sync(identity)
        service.configure(identity, 'auto', True)
        service.configure_monitor(True, 10)
        inbox.rows.append(row('你好', identity='new'))
        await service.sync(identity)
        item = service._get(identity)
        item['lastInboundAt'] = (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat()
        service._save(item)
        inbox.hook = lambda: service.configure_monitor(False, 10)
        await service._auto(identity)
        assert not agent.sent
        assert not service.get_settings()['enabled']
        db.close()
    asyncio.run(run())


def test_takeover_during_auto_read_prevents_automatic_send(tmp_path):
    async def run():
        db, agent, inbox, service, identity = setup(tmp_path)
        await service.sync(identity)
        service.configure(identity, 'auto', True)
        service.configure_monitor(True, 10)
        inbox.rows.append(row('你好', identity='new'))
        await service.sync(identity)
        item = service._get(identity)
        item['lastInboundAt'] = (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat()
        service._save(item)
        inbox.hook = lambda: service.configure(identity, 'human')
        await service._auto(identity)
        assert not agent.sent
        assert service.detail(identity)['mode'] == 'human'
        db.close()
    asyncio.run(run())


def test_unknown_manual_resolution_is_scoped_authorized_and_not_a_resend(tmp_path):
    async def run():
        db, agent, inbox, service, identity = setup(tmp_path)
        await service.sync(identity)
        inbox.rows.append(row('你好', identity='inbound-one'))
        before = await service.sync(identity)
        old_message_id = before['pendingIds'][0]
        agent.result = 'unknown'
        sent = await service.send(identity, '您好', True, 'unknown-attempt', before['revision'])
        outbox_id = sent['lastSend']['id']
        inbox.rows.append(row('还有一件事', identity='inbound-two'))
        newest = await service.sync(identity)
        new_message_id = newest['pendingIds'][-1]
        db.put('customers', {'id': 'c2', 'nickname': '另一个人', 'platformId': 'other', 'profileUrl': 'https://www.douyin.com/user/other'})
        other_id = service.create('c2')['id']
        with pytest.raises(ValueError, match='人工核查'):
            service.resolve(identity, outbox_id, 'sent', False, '已查看双方页面')
        with pytest.raises(ValueError, match='不属于'):
            service.resolve(other_id, outbox_id, 'sent', True, '不能跨会话')
        with pytest.raises(ValueError, match='核查说明'):
            service.resolve(identity, outbox_id, 'sent', True, '')
        resolved = service.resolve(identity, outbox_id, 'sent', True, '已人工查看对方页面，确有本条消息')
        out = resolved['outbox'][0]
        assert out['status'] == 'resolved' and out['resolution'] == 'sent'
        assert out['confirmationLevel'] == 'manual'
        assert old_message_id not in resolved['pendingIds'] and new_message_id in resolved['pendingIds']
        assert resolved['mode'] == 'human' and not resolved['syncHealthy']
        assert not service._uncertain_outbox(identity)
        assert len(agent.sent) == 1
        retry = await service.send(identity, '您好', True, 'unknown-attempt', resolved['revision'])
        assert retry['duplicate'] and retry['lastSend']['status'] == 'resolved'
        assert len(agent.sent) == 1
        with pytest.raises(ValueError, match='仅允许'):
            service.resolve(identity, outbox_id, 'sent', True, '不能重复改结论')
        db.close()
    asyncio.run(run())


def test_not_sent_resolution_preserves_pending_and_auto_requires_takeover_for_manual_send(tmp_path):
    async def run():
        db, agent, inbox, service, identity = setup(tmp_path)
        await service.sync(identity)
        service.configure(identity, 'auto', True)
        with pytest.raises(ValueError, match='人工接管'):
            await service.send(identity, '手动抢答', True, 'manual-auto', service.detail(identity)['revision'])
        service.configure(identity, 'human')
        inbox.rows.append(row('你好', identity='incoming'))
        detail = await service.sync(identity)
        agent.result = 'unknown'
        sent = await service.send(identity, '您好', True, 'unknown', detail['revision'])
        pending = sent['pendingIds'][:]
        resolved = service.resolve(identity, sent['lastSend']['id'], 'not_sent', True, '人工检查确认未发出')
        assert resolved['pendingIds'] == pending and len(agent.sent) == 1
        assert resolved['outbox'][0]['resolution'] == 'not_sent'
        assert not service._uncertain_outbox(identity)
        db.close()
    asyncio.run(run())


def test_takeover_during_adapter_preparation_prevents_actual_submit(tmp_path):
    async def run():
        db, agent, inbox, service, identity = setup(tmp_path)
        await service.sync(identity)
        inbox.rows.append(row('你好', identity='incoming'))
        detail = await service.sync(identity)
        agent.before_submit_hook = lambda: service.configure(identity, 'human')
        result = await service.send(identity, '您好', True, 'prepared-not-submitted', detail['revision'])
        assert not agent.sent
        assert result['lastSend']['status'] == 'failed'
        assert result['mode'] == 'human'
        assert '人工接管' in result['reason']
        db.close()
    asyncio.run(run())


def test_global_stop_during_adapter_preparation_prevents_auto_submit(tmp_path):
    async def run():
        db, agent, inbox, service, identity = setup(tmp_path)
        await service.sync(identity)
        service.configure(identity, 'auto', True)
        service.configure_monitor(True, 10)
        inbox.rows.append(row('你好', identity='incoming'))
        await service.sync(identity)
        item = service._get(identity)
        item['lastInboundAt'] = (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat()
        service._save(item)
        agent.before_submit_hook = lambda: service.configure_monitor(False, 10)
        await service._auto(identity)
        assert not agent.sent
        assert service.detail(identity)['outbox'][0]['status'] == 'failed'
        db.close()
    asyncio.run(run())
