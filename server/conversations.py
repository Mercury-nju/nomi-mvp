"""Durable, opt-in conversation handling. Page observations are facts, never commands."""
import asyncio
import hashlib
import json
import re
from datetime import datetime, timezone

from .db import now, uid


class ConversationService:
    def __init__(self, db, agent, inbox):
        self.db, self.agent, self.inbox = db, agent, inbox
        self.locks = {}
        self.job = None

    def _lock(self, identity):
        return self.locks.setdefault(identity, asyncio.Lock())

    def _write(self, *items):
        # Commit related records together; no browser operation occurs in this transaction.
        with self.db.lock, self.db.conn:
            for kind, value in items:
                self.db.conn.execute('INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data',
                                     (kind, value['id'], json.dumps(value, ensure_ascii=False)))

    def _get(self, identity):
        item = self.db.get('conversations', identity)
        if not item:
            raise ValueError('会话不存在')
        return item

    def _save(self, item):
        item['updatedAt'] = now()
        self.db.put('conversations', item)
        self.db.event('conversation.updated', {'id': item['id'], 'mode': item['mode'], 'revision': item['revision']})

    def list(self):
        return sorted(self.db.all('conversations'), key=lambda c: c['updatedAt'], reverse=True)

    def detail(self, identity):
        item = self._get(identity)
        messages = sorted((m for m in self.db.all('conversation_messages') if m['conversationId'] == identity), key=lambda m: m['sequence'])
        outbox = sorted((m for m in self.db.all('conversation_outbox') if m['conversationId'] == identity), key=lambda m: m['createdAt'])
        return {**item, 'messages': messages, 'outbox': outbox}

    def create(self, customer_id):
        customer = self.db.get('customers', customer_id)
        if not customer or not customer.get('profileUrl') or not customer.get('platformId'):
            raise ValueError('请先选择有稳定公开主页标识的已知客户')
        existing = next((c for c in self.list() if c['customerId'] == customer_id), None)
        if existing:
            return self.detail(existing['id'])
        item = {'id': uid('conversation'), 'customerId': customer_id, 'nickname': customer['nickname'],
                'profileUrl': customer['profileUrl'], 'mode': 'suggest', 'revision': 0,
                'baselineEstablished': False, 'lastSyncAt': None, 'pendingCount': 0, 'pendingIds': [],
                'updatedAt': now(), 'stage': '初次回应', 'reason': '首次读取只建立历史基线，不自动回复旧消息。',
                'suggestion': None, 'snapshot': [], 'sequence': 0}
        self._save(item)
        return self.detail(item['id'])

    def configure(self, identity, mode='suggest', authorized=False):
        if mode not in ('suggest', 'auto', 'human', 'paused'):
            raise ValueError('不支持的会话模式')
        item = self._get(identity)
        if mode == 'auto' and (not authorized or not item['baselineEstablished']):
            raise ValueError('自动承接需先读取历史基线，并明确授权此会话')
        if mode == 'auto' and self._uncertain_outbox(identity):
            raise ValueError('存在发送中或结果未知的消息，请先核查，不可恢复自动承接')
        item.update(mode=mode, revision=item['revision'] + 1, suggestion=None)
        # Explicitly starting auto never processes messages accumulated before authorization.
        if mode == 'auto':
            item.update(pendingIds=[], pendingCount=0, reason='仅对授权后新观察到的消息自动承接。')
        elif mode == 'human':
            item['reason'] = '已人工接管，自动发送停止。'
        else:
            item['reason'] = '只生成建议，不自动发送。' if mode == 'suggest' else '已暂停读取和自动发送。'
        self._save(item)
        return self.detail(identity)

    def get_settings(self):
        return (self.db.get('settings', 'conversation-monitor') or {'value': {'enabled': False, 'intervalSeconds': 10, 'settleSeconds': 3}})['value']

    def configure_monitor(self, enabled, intervalSeconds=10):
        if not isinstance(enabled, bool) or not 5 <= intervalSeconds <= 300:
            raise ValueError('监听间隔应为 5–300 秒')
        value = {'enabled': enabled, 'intervalSeconds': intervalSeconds, 'settleSeconds': 3,
                 'reason': '仅轮询手动添加的已知会话；不保证平台全量消息。' if enabled else '监听已关闭'}
        self.db.put('settings', {'id': 'conversation-monitor', 'value': value})
        self.db.event('conversation.monitor', value)
        return value

    def _uncertain_outbox(self, identity):
        return any(x['conversationId'] == identity and x['status'] in ('sending', 'unknown') for x in self.db.all('conversation_outbox'))

    def resolve(self, identity, outbox_id, resolution, authorized=False, note=''):
        item = self._get(identity)
        out = self.db.get('conversation_outbox', outbox_id)
        if not authorized:
            raise ValueError('请明确确认已人工核查发送结果')
        if resolution not in ('sent', 'not_sent') or not isinstance(note, str) or not 1 <= len(note.strip()) <= 500:
            raise ValueError('请选择人工核查结果，并填写 1–500 字核查说明')
        if not out or out['conversationId'] != identity:
            raise ValueError('发送记录不属于此会话')
        if out['status'] != 'unknown':
            raise ValueError('仅允许人工核查结果未知的发送记录')
        out.update(status='resolved', resolution=resolution, resolvedAt=now(), note=note.strip(),
                   confirmationLevel='manual', pendingEcho=False,
                   reason='人工核查：已发出；不代表页面自动核验。' if resolution == 'sent' else '人工核查：未发出；原命令不会自动重试。')
        if resolution == 'sent':
            answered = set(out.get('basedOnMessageIds', []))
            item['pendingIds'] = [message_id for message_id in item['pendingIds'] if message_id not in answered]
            item['pendingCount'] = len(item['pendingIds'])
        item.update(mode='human', revision=item['revision'] + 1, suggestion=None, syncHealthy=False,
                    updatedAt=now(), reason='发送结果已由人工核查；保持人工接管，请重新同步后再处理。')
        self._write(('conversation_outbox', out), ('conversations', item))
        self.db.event('conversation.resolved', {'id': identity, 'outboxId': outbox_id, 'resolution': resolution, 'confirmationLevel': 'manual'})
        return self.detail(identity)

    async def start(self):
        if self.get_settings()['enabled']:
            self.configure_monitor(False, self.get_settings()['intervalSeconds'])
        for out in self.db.all('conversation_outbox'):
            if out['status'] == 'sending':
                out.update(status='unknown', reason='服务中断，发送结果未知，不自动重发。')
                self.db.put('conversation_outbox', out)
                item = self._get(out['conversationId'])
                item.update(mode='human', reason=out['reason'], revision=item['revision'] + 1)
                self._save(item)
        if not self.job or self.job.done():
            self.job = asyncio.create_task(self._poll())

    async def stop(self):
        if self.job:
            self.job.cancel()
            try:
                await self.job
            except asyncio.CancelledError:
                pass
            self.job = None

    async def _poll(self):
        while True:
            settings = self.get_settings()
            if settings['enabled']:
                for item in self.list():
                    if item['mode'] in ('paused',):
                        continue
                    if self.agent.browser_lock.locked():
                        item['reason'] = '浏览器正忙，等待本轮短操作结束后同步。'
                        self._save(item)
                        continue
                    try:
                        await self.sync(item['id'])
                        item = self._get(item['id'])
                        if item['pendingCount'] and item['mode'] == 'auto':
                            elapsed = (datetime.now(timezone.utc) - datetime.fromisoformat(item['lastInboundAt'])).total_seconds()
                            if elapsed >= settings['settleSeconds']:
                                await self._auto(item['id'])
                    except asyncio.CancelledError:
                        raise
                    except Exception as error:
                        item = self._get(item['id'])
                        item['reason'] = f'同步失败：{str(error)[:200]}'
                        self._save(item)
            await asyncio.sleep(settings['intervalSeconds'] if settings['enabled'] else 1)

    @staticmethod
    def _fingerprint(message):
        return (message.get('platformMessageId') or '', message['direction'], message.get('type', 'text'), message.get('text', ''), message.get('platformAt') or '')

    def _new_rows(self, previous, current):
        old, new = list(map(self._fingerprint, previous)), list(map(self._fingerprint, current))
        if old == new:
            return []
        if old and not new:
            raise ValueError('已建立基线的会话突然为空，未覆盖历史，等待人工核查。')
        if not old:
            return current
        # Appending to an unchanged window preserves repeated identical messages.
        if len(new) >= len(old) and new[:len(old)] == old:
            return current[len(old):]
        overlaps = [n for n in range(1, min(len(old), len(new)) + 1) if old[-n:] == new[:n]]
        if len(overlaps) != 1:
            raise ValueError('消息窗口无法唯一对齐，已停止自动承接，请核查历史后重新建立基线。')
        return current[overlaps[0]:]

    async def sync(self, identity):
        async with self._lock(identity):
            async with self.agent.browser_lock:
                return await self._sync_locked(identity)

    async def _sync_locked(self, identity):
        item = self._get(identity)
        if item['mode'] == 'paused':
            return self.detail(identity)
        customer = self.db.get('customers', item['customerId'])
        result = await self.inbox.read_thread(customer)
        # Configuration can change while browser operations await; never save the stale copy.
        item = self._get(identity)
        if not result.get('identityVerified') or not result.get('complete'):
            item.update(reason=result.get('reason') or '身份或消息方向未核实，未触发回复。', syncHealthy=False)
            self._save(item)
            return self.detail(identity)
        rows = result.get('messages', [])
        if any(m.get('direction') not in ('inbound', 'outbound') or not isinstance(m.get('text', ''), str) for m in rows):
            item.update(reason='存在无法确认方向的消息，未触发回复。', syncHealthy=False)
            self._save(item)
            return self.detail(identity)
        baseline = not item['baselineEstablished']
        try:
            additions = rows if baseline else self._new_rows(item.get('snapshot', []), rows)
        except ValueError as error:
            item.update(mode='human', reason=str(error), revision=item['revision'] + 1, syncHealthy=False, suggestion=None)
            self._save(item)
            return self.detail(identity)
        new_items = []
        mirrored = []
        echo_outboxes = [o for o in self.db.all('conversation_outbox') if o['conversationId'] == identity and o.get('pendingEcho') and o['status'] == 'confirmed']
        echo_outboxes.sort(key=lambda o: o['createdAt'])
        for raw in additions:
            kind = raw.get('type', 'text')
            if raw.get('platformMessageId'):
                seen = any(m.get('platformMessageId') == raw['platformMessageId'] and m['conversationId'] == identity for m in self.db.all('conversation_messages'))
                if seen:
                    continue
            echo = next((o for o in echo_outboxes if raw['direction'] == 'outbound' and o['text'] == raw.get('text', '')), None)
            if echo:
                echo.update(pendingEcho=False)
                new_items.append(('conversation_outbox', echo))
                echo_outboxes.remove(echo)
                local = self.db.get('conversation_messages', echo.get('messageId', ''))
                if local:
                    local.update(platformMessageId=raw.get('platformMessageId'), platformAt=raw.get('platformAt'), observedAt=now())
                    new_items.append(('conversation_messages', local))
                    continue
            item['sequence'] += 1
            message = {'id': uid('cm'), 'conversationId': identity, 'sequence': item['sequence'],
                       'direction': raw['direction'], 'text': raw.get('text', ''), 'type': kind,
                       'platformMessageId': raw.get('platformMessageId'), 'platformAt': raw.get('platformAt'),
                       'observedAt': now(), 'baseline': baseline, 'evidencePath': result.get('evidencePath'), 'status': 'observed'}
            new_items.append(('conversation_messages', message))
            if not baseline:
                item['revision'] += 1
                item['suggestion'] = None
                if raw['direction'] == 'inbound':
                    item['pendingIds'].append(message['id'])
                    item['lastInboundAt'] = now()
                    mirrored.append({'id': message['id'], 'direction': 'inbound', 'channel': 'dm', 'text': message['text'], 'at': message['observedAt'], 'status': 'received', 'conversationId': identity, 'demo': False})
                    if kind != 'text':
                        item.update(mode='human', stage='待人工', reason='收到非文字消息，当前规则模式需要人工处理。')
                    elif re.search(r'不要联系|别联系|不需要|别发了|停止|退订|没兴趣', message['text']):
                        item.update(mode='paused', stage='结束', reason='对方明确拒绝继续沟通，已停止自动承接。')
                    elif re.search(r'转人工|找人工|人工客服|真人', message['text']):
                        item.update(mode='human', stage='待人工', reason='对方请求人工，已停止自动承接。')
                else:
                    item.update(mode='human', stage='待人工', reason='观察到未经本系统记录的新出站消息，已暂停自动回复以避免抢答。')
        item.update(snapshot=rows, baselineEstablished=True, lastSyncAt=now(), pendingCount=len(item['pendingIds']), updatedAt=now(), syncHealthy=True)
        if baseline:
            item.update(reason='历史基线已建立；已有消息不会自动回复。')
        elif not additions and item['mode'] not in ('human', 'paused'):
            item['reason'] = '已同步，等待新消息。'
        elif additions and item['mode'] in ('suggest', 'auto'):
            item['reason'] = '收到新消息，等待处理。'
        if mirrored:
            # Re-read customer because outbound execution may have updated it.
            customer = self.db.get('customers', item['customerId'])
            customer.setdefault('messages', []).extend(mirrored)
            new_items.append(('customers', customer))
        self._write(*new_items, ('conversations', item))
        if mirrored:
            self.db.event('customer.updated', customer)
        self.db.event('conversation.synced', {'id': identity, 'newMessages': len(additions), 'baseline': baseline})
        return self.detail(identity)

    def _decision(self, item):
        detail = self.detail(item['id'])
        messages = detail['messages']
        incoming = [m for m in messages if m['direction'] == 'inbound']
        latest = incoming[-1] if incoming else None
        base = {'provider': 'rules', 'revision': item['revision'], 'basedOnMessageId': latest['id'] if latest else None, 'text': ''}
        if not latest:
            return {**base, 'action': 'wait', 'reason': '尚未读取到对方消息。'}
        text = '\n'.join(m['text'] for m in incoming if m['id'] in item['pendingIds']) or latest['text']
        if latest['type'] != 'text':
            return {**base, 'action': 'handoff', 'reason': '非文字消息需要人工处理。'}
        if re.search(r'不要联系|别联系|不需要|别发了|停止|退订|没兴趣', text):
            return {**base, 'action': 'close', 'reason': '对方已拒绝继续沟通，不再发送。'}
        if re.search(r'转人工|找人工|人工客服|真人', text):
            return {**base, 'action': 'handoff', 'reason': '对方要求人工。'}
        knowledge = self.agent.knowledge()
        if re.fullmatch(r'[\s你好您好嗨哈喽helloHiHELLO！!，,。.?？~～]+', text):
            return {**base, 'action': 'ask', 'text': '您好！请问您目前最想解决什么问题？', 'reason': '识别到问候，询问具体需求。'}
        if re.search(r'做什么|什么业务|什么服务|介绍|提供什么|干什么', text) and knowledge.get('service'):
            return {**base, 'action': 'reply', 'text': f"我们提供{knowledge['service'].strip()}。您目前主要想了解哪方面？"[:500], 'reason': '使用已配置业务资料回答服务范围。'}
        if re.search(r'价格|报价|多少钱|费用|收费', text):
            return {**base, 'action': 'handoff', 'reason': '当前未配置可核实的结构化报价规则，需要人工确认价格。'}
        if re.search(r'想了解|想咨询|了解一下|有需求|怎么合作|如何合作', text):
            return {**base, 'action': 'ask', 'text': '方便说一下您具体想解决的问题，以及希望达到的结果吗？', 'reason': '识别到咨询意向，补问需求。'}
        return {**base, 'action': 'handoff', 'reason': '当前规则无法可靠理解这条消息，需要人工处理。'}

    async def draft(self, identity):
        async with self._lock(identity):
            item = self._get(identity)
            suggestion = self._store_decision(item)
            item['suggestion'] = suggestion
            if suggestion['action'] == 'handoff':
                item.update(stage='待人工', reason=suggestion['reason'])
            self._save(item)
            return self.detail(identity)

    def _store_decision(self, item):
        decision = {**self._decision(item), 'id': uid('decision'), 'conversationId': item['id'], 'createdAt': now(), 'strategyVersion': 'rules-v1'}
        self.db.put('decisions', decision)
        return decision

    async def _auto(self, identity):
        async with self._lock(identity):
            async with self.agent.browser_lock:
                await self._sync_locked(identity)
                item = self._get(identity)
                if not self.get_settings()['enabled'] or item['mode'] != 'auto' or not item['pendingCount'] or not item.get('syncHealthy'):
                    return
                if self._uncertain_outbox(identity):
                    item.update(mode='human', reason='存在结果未知的发送，请人工核查。')
                    self._save(item)
                    return
                elapsed = (datetime.now(timezone.utc) - datetime.fromisoformat(item['lastInboundAt'])).total_seconds()
                if elapsed < self.get_settings()['settleSeconds']:
                    return
                suggestion = self._store_decision(item)
                item['suggestion'] = suggestion
                self._save(item)
                if suggestion['action'] not in ('reply', 'ask'):
                    item.update(mode='paused' if suggestion['action'] == 'close' else 'human', stage='结束' if suggestion['action'] == 'close' else '待人工', reason=suggestion['reason'])
                    self._save(item)
                    return
                request_id = 'auto-' + hashlib.sha256((':'.join(item['pendingIds']) + ':' + str(item['revision'])).encode()).hexdigest()
                await self._send_locked(identity, suggestion['text'], True, request_id, item['revision'], automatic=True)

    async def send(self, identity, text, authorized, request_id, revision):
        if not authorized:
            raise ValueError('请明确授权发送此条私信')
        async with self._lock(identity):
            async with self.agent.browser_lock:
                # Check idempotency before re-reading: a retry must never create a new send.
                existing = self._find_request(identity, request_id)
                if existing:
                    if existing['text'] != text.strip():
                        raise ValueError('同一发送命令不可更改正文')
                    return {**self.detail(identity), 'lastSend': existing, 'duplicate': True}
                await self._sync_locked(identity)
                return await self._send_locked(identity, text, authorized, request_id, revision)

    def _find_request(self, identity, request_id):
        if not isinstance(request_id, str) or not 1 <= len(request_id) <= 160:
            raise ValueError('缺少有效的发送命令标识')
        key = 'co-' + hashlib.sha256(f'{identity}:{request_id}'.encode()).hexdigest()
        return self.db.get('conversation_outbox', key)

    async def _send_locked(self, identity, text, authorized, request_id, revision, automatic=False):
        item = self._get(identity)
        text = text.strip()
        if not authorized or not 1 <= len(text) <= 500:
            raise ValueError('请授权发送，并填写 1–500 字消息')
        previous = self._find_request(identity, request_id)
        if previous:
            if previous['text'] != text:
                raise ValueError('同一发送命令不可更改正文')
            return {**self.detail(identity), 'lastSend': previous, 'duplicate': True}
        if not item.get('syncHealthy') or not item['baselineEstablished']:
            raise ValueError('最新会话读取未核实，不能发送')
        if item['revision'] != revision:
            raise ValueError('会话已变化，请查看最新消息后重新生成或确认回复')
        if item['mode'] == 'paused' or (automatic and item['mode'] != 'auto'):
            raise ValueError('此会话已暂停或人工接管，未发送')
        if not automatic and item['mode'] == 'auto':
            raise ValueError('请先人工接管此会话，再手动发送')
        if automatic and not self.get_settings()['enabled']:
            raise ValueError('全局监听已关闭，未自动发送')
        if self._uncertain_outbox(identity):
            raise ValueError('存在发送中或结果未知的消息，未再次发送')
        out_id = 'co-' + hashlib.sha256(f'{identity}:{request_id}'.encode()).hexdigest()
        out = {'id': out_id, 'conversationId': identity, 'requestId': request_id, 'text': text,
               'revision': revision, 'createdAt': now(), 'status': 'sending', 'automatic': automatic,
               'basedOnMessageIds': item['pendingIds'][:], 'pendingEcho': False,
               'decisionId': (item.get('suggestion') or {}).get('id')}
        self.db.put('conversation_outbox', out)
        expected_mode = item['mode']

        def before_submit():
            # The adapter calls this after opening/filling the editor, immediately before Enter.
            # Human takeover is synchronous and must invalidate an in-flight browser preparation.
            latest = self._get(identity)
            return (latest['revision'] == revision and latest['mode'] == expected_mode
                    and latest.get('syncHealthy', False)
                    and (not automatic or (latest['mode'] == 'auto' and self.get_settings()['enabled'])))

        try:
            result = await self.agent.send(item['customerId'], text, 'dm', locked=True, command_id=out_id, before_submit=before_submit)
            status = {'success': 'confirmed', 'failed': 'failed', 'unknown': 'unknown'}.get(result.get('status'), 'unknown')
            out.update(status=status, reason=result.get('reason'), evidencePath=result.get('evidencePath'), finishedAt=now())
        except BaseException as error:
            out.update(status='unknown', reason='发送确认中断，不自动重发。', finishedAt=now())
            self.db.put('conversation_outbox', out)
            item = self._get(identity)
            item.update(mode='human', reason=out['reason'])
            self._save(item)
            if isinstance(error, asyncio.CancelledError):
                raise
        item = self._get(identity)
        writes = []
        if out['status'] == 'confirmed':
            item['sequence'] += 1
            message = {'id': uid('cm'), 'conversationId': identity, 'sequence': item['sequence'], 'direction': 'outbound',
                       'text': text, 'type': 'text', 'platformMessageId': None, 'platformAt': None, 'observedAt': now(),
                       'baseline': False, 'status': 'confirmed', 'commandId': out_id, 'evidencePath': out.get('evidencePath')}
            out.update(messageId=message['id'], pendingEcho=True)
            writes.append(('conversation_messages', message))
            item.update(pendingIds=[], pendingCount=0, suggestion=None, revision=item['revision'] + 1, stage='需求了解', reason='页面显示本条私信已发送；未确认送达或已读。')
        elif out['status'] == 'unknown':
            item.update(mode='human', reason='发送结果未知，已停止自动承接，请人工核查。')
        else:
            # Preserve a takeover reason recorded while the adapter was preparing the editor.
            if item['revision'] == revision and item['mode'] == expected_mode:
                item.update(mode='human', reason=out.get('reason') or '平台未确认发送成功，请人工处理。',
                            suggestion=None, revision=item['revision'] + 1)
        self._write(*writes, ('conversation_outbox', out), ('conversations', {**item, 'updatedAt': now()}))
        self.db.event('conversation.sent', {'id': identity, 'outboxId': out_id, 'status': out['status']})
        return {**self.detail(identity), 'lastSend': out}
