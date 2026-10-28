import asyncio
import hashlib
import json
import logging
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from .db import now, uid
from .planner import assess, draft_message

logger = logging.getLogger('uvicorn.error')


def next_daily(plan):
    if plan['scheduleMode'] != 'daily':
        return None
    current = datetime.now(ZoneInfo('Asia/Shanghai'))
    hour, minute = map(int, plan['scheduleTime'].split(':'))
    target = current.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target <= current:
        target += timedelta(days=1)
    return target.isoformat()


class Agent:
    def __init__(self, db, adapter):
        self.db, self.adapter = db, adapter
        self.browser_lock = asyncio.Lock()
        self.jobs = {}
        self.scheduler_task = None
        self.stopping = False

    def log(self, event, execution=None, **values):
        logger.info(json.dumps({'event': event, 'at': now(), **({'taskId': execution['taskId'], 'executionId': execution['id']} if execution else {}), **values}, ensure_ascii=False))

    def step(self, execution, name, status, reason=None):
        """A step is current state; its event stream retains every transition."""
        timestamp = now()
        previous = next((item for item in execution['steps'] if item['name'] == name), None)
        update = {'name': name, 'status': status, 'time': timestamp, 'reason': reason}
        if previous:
            previous.update(update)
        else:
            execution['steps'].append({**update, 'startedAt': timestamp})
        self.db.put('executions', execution)
        self.db.event('execution.step', {'executionId': execution['id'], 'taskId': execution['taskId'], **update})
        self.db.event('execution.updated', execution)
        self.log('step', execution, name=name, status=status, reason=reason)

    def finish_steps(self, execution, status, reason=None):
        for step in list(execution['steps']):
            if step['status'] in ('running', 'pending'):
                self.step(execution, step['name'], status, reason or step.get('reason'))

    async def start(self):
        self.db.recover_sends()
        for execution in self.db.all('executions'):
            if execution['status'] == 'running':
                execution.update(status='partial', finishedAt=now(), reason='服务重启，原执行已中断；不会自动补发消息。')
                self.finish_steps(execution, 'cancelled', execution['reason'])
                self.db.put('executions', execution)
            elif any(step['status'] in ('running', 'pending') for step in execution.get('steps', [])):
                terminal = 'completed' if execution['status'] == 'completed' else 'cancelled' if execution['status'] == 'cancelled' else 'failed'
                self.finish_steps(execution, terminal, execution.get('reason'))
        for task in self.db.all('tasks'):
            if task['status'] in ('running', 'queued'):
                task.update(status='paused', updatedAt=now(), reason='服务重启后暂停，请检查记录再继续。')
                self.db.put('tasks', task)
            elif task['status'] not in ('paused', 'cancelled') and task['plan']['scheduleMode'] == 'daily' and task.get('nextRunAt'):
                if datetime.fromisoformat(task['nextRunAt']) <= datetime.now(ZoneInfo('Asia/Shanghai')):
                    skipped = task['nextRunAt']
                    note = '服务停止期间错过的计划已跳过，不补执行或补发；按下一次时间继续。'
                    task.update(nextRunAt=next_daily(task['plan']), updatedAt=now(), scheduleNote=note)
                    self.db.put('tasks', task)
                    self.db.event('schedule.skipped', {'taskId': task['id'], 'skippedAt': skipped, 'nextRunAt': task['nextRunAt'], 'reason': note})
                    self.db.event('task.updated', task)
                    self.log('schedule.skipped', taskId=task['id'], skippedAt=skipped, nextRunAt=task['nextRunAt'])
        self.scheduler_task = asyncio.create_task(self.scheduler())

    async def stop(self):
        self.stopping = True
        if self.scheduler_task:
            self.scheduler_task.cancel()
        for job in self.jobs.values():
            job.cancel()
        if self.jobs:
            await asyncio.gather(*self.jobs.values(), return_exceptions=True)
        await self.adapter.close()

    async def scheduler(self):
        while not self.stopping:
            if (self.db.get('settings', 'conversation-monitor') or {}).get('value', {}).get('enabled'):
                await asyncio.sleep(3)
                continue
            for task in self.db.all('tasks'):
                if task.get('nextRunAt') and task['status'] not in ('paused', 'cancelled', 'running', 'queued'):
                    if datetime.fromisoformat(task['nextRunAt']) <= datetime.now(ZoneInfo('Asia/Shanghai')):
                        self.run(task['id'])
            await asyncio.sleep(3)

    def run(self, task_id):
        if (self.db.get('settings', 'conversation-monitor') or {}).get('value', {}).get('enabled'):
            raise ValueError('私信承接监听中，请先停止监听再运行找客任务；本版将两种浏览器工作分时执行。')
        task = self.db.get('tasks', task_id)
        if not task:
            raise ValueError('任务不存在')
        if task_id in self.jobs and not self.jobs[task_id].done():
            raise ValueError('任务已经排队或执行中')
        task.update(status='queued', updatedAt=now(), reason=None)
        self.db.put('tasks', task)
        self.db.event('task.updated', task)
        job = asyncio.create_task(self.execute(task_id))
        self.jobs[task_id] = job
        return task

    def control(self, task_id, action):
        task = self.db.get('tasks', task_id)
        if not task:
            raise ValueError('任务不存在')
        if action == 'resume':
            job = self.jobs.get(task_id)
            if job and not job.done():
                raise ValueError('上一轮仍在停止，请等待执行结束后恢复')
            task.update(status='ready', updatedAt=now(), nextRunAt=next_daily(task['plan']))
        else:
            task.update(status='paused' if action == 'pause' else 'cancelled', updatedAt=now())
            if action == 'cancel':
                task['nextRunAt'] = None
        self.db.put('tasks', task)
        self.db.event('task.updated', task)
        return task

    def cancelled(self, task_id):
        task = self.db.get('tasks', task_id)
        return self.stopping or not task or task['status'] in ('paused', 'cancelled')

    async def save_customer(self, raw, task, execution):
        stable = raw.get('platformId') or raw.get('profileUrl')
        if not stable:
            # Names alone are not stable user identities and are never merged.
            identity = uid('customer')
        else:
            identity = 'customer-' + hashlib.sha256(stable.encode()).hexdigest()[:24]
        existing = self.db.get('customers', identity)
        customer = existing or {'id': identity, 'accountId': 'local', 'taskIds': [], 'discoveredAt': now(), 'messages': [], 'sources': [], 'demo': False}
        for key in ('platformId', 'profileUrl', 'avatarUrl', 'nickname', 'profileText', 'liveContext', 'commentContext'):
            if raw.get(key):
                customer[key] = raw[key]
        customer['taskIds'] = list(dict.fromkeys(customer['taskIds'] + [task['id']]))
        seen = {x['id'] for x in customer['sources']}
        for source in raw.get('sources', []):
            observation_id = f"{source['id']}:{execution['id']}" if source.get('id') else uid('source')
            source = {**source, 'id': observation_id, 'taskId': task['id'], 'executionId': execution['id'], 'accountId': 'local', 'demo': False}
            if source['id'] not in seen:
                customer['sources'].append(source)
                seen.add(source['id'])
        scoped = {**customer, 'sources': [x for x in customer['sources'] if x.get('executionId') == execution['id']]}
        match = await assess(scoped, task['plan'])
        customer['match'] = match
        customer.setdefault('matches', {})[task['id']] = match
        customer.setdefault('executionMatches', {})[execution['id']] = match
        customer['target'] = match['status'] == 'matched'
        self.db.put('customers', customer)
        self.db.event('customer.updated', customer)
        return customer

    async def execute(self, task_id):
        execution = None
        try:
            async with self.browser_lock:
                if self.cancelled(task_id):
                    return
                task = self.db.get('tasks', task_id)
                task.update(status='running', lastRunAt=now(), updatedAt=now())
                self.db.put('tasks', task)
                execution = {'id': uid('execution'), 'taskId': task_id, 'status': 'running', 'startedAt': now(), 'finishedAt': None, 'steps': [], 'analyzed': 0, 'targeted': 0, 'contacted': 0, 'leads': 0, 'customerIds': []}
                self.db.put('executions', execution)
                self.db.event('task.updated', task)
                self.db.event('execution.updated', execution)
                self.log('run.started', execution, sourceType=task['plan']['sourceType'], targetLimit=task['plan']['limit'], scanLimit=task['plan'].get('scanLimit', 100), observeSeconds=task['plan'].get('observeSeconds'))
                observed = {}
                async def observe(candidate):
                    key = candidate.get('platformId') or candidate.get('profileUrl') or json.dumps([candidate.get('nickname'), candidate.get('sources')], sort_keys=True, ensure_ascii=False)
                    if key in observed:
                        old = observed[key]
                        existing_sources = {s['id'] for s in old.get('sources', [])}
                        if not any(f"{s['id']}:{execution['id']}" not in existing_sources for s in candidate.get('sources', []) if s.get('id')):
                            return old
                        self.step(execution, '判断公开证据', 'running', f"正在复核第 {execution['analyzed']} 位用户的新发言")
                        customer = await self.save_customer(candidate, task, execution)
                        execution['targeted'] += int(customer['target']) - int(old['target'])
                        observed[key] = customer
                        self.db.put('executions', execution)
                        self.db.event('execution.updated', execution)
                        self.step(execution, '判断公开证据', 'completed', f"已分析 {execution['analyzed']} 人，明确匹配 {execution['targeted']} 人")
                        self.log('candidate.assessed', execution, customerId=customer['id'], status=customer['match']['status'], provider=customer['match'].get('provider'), analyzed=execution['analyzed'], targeted=execution['targeted'])
                        return customer
                    self.step(execution, '判断公开证据', 'running', f"正在分析第 {execution['analyzed'] + 1} 位用户")
                    customer = await self.save_customer(candidate, task, execution)
                    observed[key] = customer
                    execution['customerIds'].append(customer['id'])
                    execution['analyzed'] += 1
                    execution['targeted'] += int(customer['target'])
                    self.db.put('executions', execution)
                    self.db.event('execution.updated', execution)
                    self.step(execution, '判断公开证据', 'completed', f"已分析 {execution['analyzed']} 人，明确匹配 {execution['targeted']} 人")
                    self.log('candidate.assessed', execution, customerId=customer['id'], status=customer['match']['status'], provider=customer['match'].get('provider'), analyzed=execution['analyzed'], targeted=execution['targeted'])
                    return customer
                async def emit(event):
                    if event.get('type') == 'candidate' and event.get('customer'):
                        customer = await observe(event['customer'])
                        return {'matched': customer['target'], 'status': customer['match']['status'], 'customerId': customer['id']}
                    else:
                        step_status = event.get('status', 'running')
                        if self.cancelled(task_id) and step_status in ('running', 'completed'):
                            step_status = 'cancelled'
                        self.step(execution, event.get('name') or '执行中', step_status, event.get('reason') or event.get('text'))
                self.step(execution, '校验登录会话', 'running')
                status = await self.adapter.status()
                if not status.get('connected'):
                    raise ValueError(status.get('reason') or '请先在账号管理中登录抖音')
                self.step(execution, '校验登录会话', 'completed', '已确认当前账号登录状态')
                raw = await self.adapter.discover(task['plan'], emit, lambda: self.cancelled(task_id))
                for candidate in raw:
                    # Keep evidence already observed even if the user paused meanwhile.
                    await observe(candidate)
                for customer in observed.values():
                    if customer['target'] and task['plan']['mode'] == 'contact' and task['plan']['authorized'] and not self.cancelled(task_id):
                        # Do not repeatedly approach one user on subsequent daily runs.
                        if not any(m['direction'] == 'outbound' and m['status'] in ('success', 'unknown', 'sending') for m in customer['messages']):
                            self.step(execution, '生成触达话术', 'running')
                            scoped_customer = {**customer, 'sources': [source for source in customer['sources'] if source.get('taskId') == task_id]}
                            draft = await draft_message(scoped_customer, self.knowledge(), task['plan'].get('communicationStrategy', ''))
                            self.step(execution, '生成触达话术', 'completed', f"生成方式：{draft['provider']}；已记录最终内容，等待执行")
                            if self.cancelled(task_id):
                                break
                            self.step(execution, '执行触达', 'running', f"渠道：{task['plan']['channel']}")
                            result = await self.send(customer['id'], draft['text'], task['plan']['channel'], task_id, execution['id'], locked=True)
                            self.step(execution, '执行触达', 'completed' if result['status'] == 'success' else 'failed' if result['status'] == 'failed' else 'unknown', result.get('reason'))
                            if result['status'] == 'success':
                                execution['contacted'] += 1
                    self.db.put('executions', execution)
                    self.db.event('execution.updated', execution)
                was_cancelled = self.cancelled(task_id)
                execution.update(status='cancelled' if was_cancelled else 'completed', finishedAt=now())
                self.finish_steps(execution, 'cancelled' if was_cancelled else 'completed', '本轮已取消，保留已采集证据' if was_cancelled else None)
                if not raw and not was_cancelled:
                    execution['reason'] = '本轮未取得可解析用户；未编造结果。请查看步骤中的跳过或限制原因。'
                elif not was_cancelled and execution['targeted'] < task['plan']['limit']:
                    execution['reason'] = f"本轮分析 {execution['analyzed']} 人，明确匹配 {execution['targeted']} 人；未达到 {task['plan']['limit']} 人目标，待核实用户未计入目标。"
                self.db.put('executions', execution)
                self.db.event('execution.updated', execution)
                self.log('run.finished', execution, status=execution['status'], analyzed=execution['analyzed'], targeted=execution['targeted'], contacted=execution['contacted'], reason=execution.get('reason'))
                latest = self.db.get('tasks', task_id)
                if latest['status'] not in ('paused', 'cancelled'):
                    latest.update(status='completed', updatedAt=now(), nextRunAt=next_daily(task['plan']))
                    self.db.put('tasks', latest)
                    self.db.event('task.updated', latest)
        except asyncio.CancelledError:
            if execution:
                execution.update(status='cancelled', finishedAt=now(), reason='执行服务停止；未自动重发任何消息。')
                self.finish_steps(execution, 'cancelled', execution['reason'])
                self.db.put('executions', execution)
                self.log('run.cancelled', execution)
            raise
        except Exception as error:
            reason = str(error)[:1500]
            if execution:
                execution.update(status='partial' if execution['analyzed'] else 'failed', finishedAt=now(), reason=reason)
                self.finish_steps(execution, 'failed', reason)
                self.db.put('executions', execution)
                self.db.event('execution.updated', execution)
                self.log('run.failed', execution, reason=reason, analyzed=execution['analyzed'])
            task = self.db.get('tasks', task_id)
            if task and task['status'] not in ('paused', 'cancelled'):
                task.update(status='failed', updatedAt=now(), reason=reason, nextRunAt=next_daily(task['plan']))
                self.db.put('tasks', task)
                self.db.event('task.updated', task)

    def knowledge(self):
        return (self.db.get('settings', 'knowledge') or {'value': {}})['value']

    async def verify_message(self, customer_id, message_id, locked=False):
        """Read a freshly opened thread; never send or infer delivery/read status."""
        if not locked:
            async with self.browser_lock:
                return await self.verify_message(customer_id, message_id, locked=True)
        from .inbox_adapter import InboxAdapter
        customer = self.db.get('customers', customer_id)
        if not customer:
            raise ValueError('客户不存在')
        message = next((m for m in customer.get('messages', []) if m.get('id') == message_id), None)
        if not message:
            raise ValueError('该客户没有这条发送记录')
        if message.get('direction') != 'outbound' or message.get('channel') != 'dm':
            raise ValueError('仅支持复核已记录的外发私信')
        if message.get('status') == 'sending':
            raise ValueError('发送尚在进行，请等待操作结束后复核')
        # Preserve the initial receipt separately from subsequent observations.
        if 'originalReceipt' not in message:
            message['originalReceipt'] = json.loads(json.dumps(message, ensure_ascii=False))
        try:
            snapshot = await InboxAdapter(self.adapter).read_thread(customer)
        except Exception:
            snapshot = {'identityVerified': False, 'complete': False, 'messages': [],
                        'reason': '重开会话读取中断，无法复核；不自动重发。'}
        verified_window = bool(snapshot.get('identityVerified') and snapshot.get('complete'))
        count = sum(m.get('direction') == 'outbound' and m.get('text') == message.get('text')
                    for m in snapshot.get('messages', [])) if verified_window else 0
        verified = verified_window and count > 0
        status = 'success' if verified else 'failed' if message.get('status') == 'failed' else 'unknown'
        observation = {'at': now(), 'identityVerified': bool(snapshot.get('identityVerified')),
                       'complete': bool(snapshot.get('complete')), 'windowOnly': True,
                       'outgoingTextCount': count, 'evidencePath': snapshot.get('evidencePath'),
                       'status': status,
                       'reason': snapshot.get('reason')}
        message.setdefault('verifications', []).append(observation)
        message['verification'] = observation
        message.update(status=status,
                       confirmationLevel='reopened_thread' if verified else 'unconfirmed',
                       reason=('重新打开并核对目标会话，找到完整外发原文；未确认送达或已读。' if verified else
                               message.get('reason', '原发送未成功；复核未找到外发原文，不自动重发。') if status == 'failed' else
                               '重开会话后未取得完整外发原文确认；不代表未送达，不自动重发。'))
        # Keep the initial evidence in originalReceipt, and latest observation
        # evidence on the current record for the result UI.
        message['evidencePath'] = snapshot.get('evidencePath')
        latest = self.db.get('customers', customer_id)
        latest['messages'] = [message if m.get('id') == message_id else m for m in latest.get('messages', [])]
        self.db.finish_send(message_id, message)
        self.db.put('customers', latest)
        self.db.event('customer.updated', latest)
        self.log('message.verified', customerId=customer_id, messageId=message_id,
                 status=message['status'], outgoingTextCount=count, confirmationLevel=message['confirmationLevel'])
        return message

    async def send(self, customer_id, text, channel, task_id=None, execution_id=None, locked=False, command_id=None, before_submit=None):
        if not locked:
            async with self.browser_lock:
                return await self.send(customer_id, text, channel, task_id, execution_id, locked=True, command_id=command_id, before_submit=before_submit)
        customer = self.db.get('customers', customer_id)
        if not customer:
            raise ValueError('客户不存在')
        if task_id and (task_id not in customer.get('taskIds', []) or not self.db.get('tasks', task_id)):
            raise ValueError('该客户不属于所选任务')
        scoped_customer = {**customer, 'sources': [source for source in customer.get('sources', []) if source.get('taskId') == task_id]} if task_id else customer
        key = f'{customer_id}:{channel}:command:{command_id}' if command_id else f'{customer_id}:{channel}:{text.strip()}'
        identity = 'message-' + hashlib.sha256(key.encode()).hexdigest()[:32]
        message = {'id': identity, 'text': text.strip(), 'plannedText': text.strip(), 'channel': channel, 'at': now(), 'direction': 'outbound', 'status': 'sending', 'taskId': task_id, 'executionId': execution_id, 'demo': False}
        reserved, saved = self.db.reserve_send(identity, customer_id, channel, message)
        if not reserved:
            if command_id and saved.get('plannedText', saved.get('text')) != text.strip():
                raise ValueError('同一发送命令不能改为另一条消息，请创建新的发送命令。')
            return {**saved, 'duplicate': True}
        customer['messages'].append(message)
        self.db.put('customers', customer)
        self.db.event('customer.updated', customer)
        try:
            if before_submit is None:
                result = await self.adapter.send(scoped_customer, text.strip(), channel)
            else:
                result = await self.adapter.send(scoped_customer, text.strip(), channel, before_submit=before_submit)
            status = result.get('status', 'unknown')
            if status not in ('success', 'failed', 'unknown'):
                status = 'unknown'
            message.update({k: v for k, v in result.items() if k not in ('id', 'text', 'plannedText', 'channel', 'direction', 'taskId', 'executionId', 'demo')})
            actual_text = result.get('text')
            if isinstance(actual_text, str) and 0 < len(actual_text.strip()) <= 2000:
                message['text'] = actual_text.strip()
            elif actual_text is not None:
                status = 'unknown'
                message['reason'] = '发送回执中的实际文本格式异常，无法确认最终内容；不自动重发。'
            message['status'] = status
        except asyncio.CancelledError:
            message.update(status='unknown', reason='服务停止，无法确认发送结果，不会自动重发。')
            self.db.finish_send(identity, message)
            customer['messages'] = [message if m['id'] == identity else m for m in customer['messages']]
            self.db.put('customers', customer)
            raise
        except Exception as error:
            message.update(status='unknown', reason=f'未取得发送确认：{str(error)[:500]}；不会自动重发。')
        needs_reopen = channel == 'dm' and message['status'] == 'success'
        if needs_reopen:
            message['originalReceipt'] = json.loads(json.dumps(message, ensure_ascii=False))
            # The local bubble is provisional: polling clients must not see it
            # as final success while the independent thread check is in flight.
            message.update(status='unknown', confirmationLevel='unconfirmed',
                           reason='本地出现外发气泡，正在重新打开目标会话复核；不自动重发。')
        self.db.finish_send(identity, message)
        self.log('message.result', customerId=customer_id, taskId=task_id, executionId=execution_id, messageId=identity, channel=channel, status=message['status'], confirmationLevel=message.get('confirmationLevel'))
        customer = self.db.get('customers', customer_id)
        customer['messages'] = [message if m['id'] == identity else m for m in customer['messages']]
        self.db.put('customers', customer)
        self.db.event('customer.updated', customer)
        if needs_reopen:
            return await self.verify_message(customer_id, identity, locked=True)
        return message
