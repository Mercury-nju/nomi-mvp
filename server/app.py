"""Local Nomi control plane. Run: uvicorn server.app:app --host 127.0.0.1 --port 8765."""
import os
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from .agent import Agent, next_daily
from .db import Database, now, uid
from .models import Plan, PlanRequest, DraftRequest, SendRequest, KnowledgeRequest
from .planner import configured, plan_request, draft_message
from .models import ConversationCreate, ConversationControl, ConversationSend, MonitorSettings, ConversationResolution
from .conversations import ConversationService
from .inbox_adapter import InboxAdapter

ROOT = Path(__file__).resolve().parent.parent


def create_app(data_dir=None, adapter=None):
    directory = Path(data_dir or os.getenv('NOMI_DATA_DIR', str(ROOT / '.data'))).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    database = Database(directory / 'nomi.sqlite3')
    if adapter is None:
        from .adapter import DouyinAdapter
        adapter = DouyinAdapter(directory)
    worker = Agent(database, adapter)
    conversations = ConversationService(database, worker, InboxAdapter(adapter))

    @asynccontextmanager
    async def lifespan(application):
        await worker.start()
        await conversations.start()
        yield
        await conversations.stop()
        await worker.stop()
        database.close()

    application = FastAPI(title='Nomi Local Agent', version='2.0.0', lifespan=lifespan)
    application.state.db = database
    application.state.agent = worker
    application.state.conversations = conversations
    application.state.browser_tools = None
    application.add_middleware(CORSMiddleware, allow_origins=[f'http://{host}:{port}' for host in ('localhost', '127.0.0.1') for port in (5173, 5174, 8765)], allow_methods=['GET', 'POST', 'PUT'], allow_headers=['Content-Type'])

    @application.middleware('http')
    async def local_requests(request: Request, call_next):
        host = request.headers.get('host', '').split(':')[0]
        if host not in ('localhost', '127.0.0.1', 'testserver', '[::1]'):
            return JSONResponse({'detail': '只接受本机请求'}, status_code=403)
        origin = request.headers.get('origin')
        if request.url.path.startswith('/api') and origin:
            parsed = urlparse(origin)
            if parsed.scheme != 'http' or parsed.hostname not in ('localhost', '127.0.0.1') or parsed.port not in (5173, 5174, 8765):
                return JSONResponse({'detail': '不接受此页面来源的请求'}, status_code=403)
        if request.method in ('POST', 'PUT') and request.headers.get('sec-fetch-site') == 'cross-site':
            return JSONResponse({'detail': '不接受跨站操作'}, status_code=403)
        return await call_next(request)

    @application.exception_handler(ValueError)
    async def invalid(_, error):
        return JSONResponse({'detail': str(error)}, status_code=409)

    @application.get('/api/health')
    async def health():
        return {'ok': True, 'version': '2.0.0', 'agent': 'local', 'llmConfigured': configured()}

    @application.get('/api/account')
    async def account():
        return {'id': 'local', **await adapter.status()}

    def browser_tools():
        if application.state.browser_tools is None:
            from .browser_tools import BrowserTools
            application.state.browser_tools = BrowserTools(adapter, directory)
        return application.state.browser_tools

    @application.get('/api/browser/observation')
    async def browser_observation():
        async with worker.browser_lock:
            observation = await browser_tools().observe()
        database.event('browser.observed', {key: observation.get(key) for key in ('observationId', 'challenge', 'title', 'url', 'screenshotUrl')})
        return observation

    @application.post('/api/browser/action')
    async def browser_action(action: dict):
        async with worker.browser_lock:
            observation = await browser_tools().act(action)
        database.event('browser.action', {'action': action.get('type') or action.get('action'), 'observationId': observation.get('observationId'), 'challenge': observation.get('challenge'), 'screenshotUrl': observation.get('screenshotUrl')})
        return observation

    @application.post('/api/account/login')
    async def login():
        async with worker.browser_lock:
            value = await adapter.login()
        database.event('account.updated', value)
        return value

    @application.post('/api/account/disconnect')
    async def disconnect():
        conversations.configure_monitor(False, conversations.get_settings()['intervalSeconds'])
        for task in database.all('tasks'):
            if task['status'] in ('running', 'queued', 'ready'):
                worker.control(task['id'], 'pause')
        async with worker.browser_lock:
            value = await adapter.disconnect()
        database.event('account.updated', value)
        return value

    @application.post('/api/plan')
    async def plan(body: PlanRequest):
        return await plan_request(body.text, body.knowledge if body.knowledge is not None else worker.knowledge())

    @application.get('/api/tasks')
    async def tasks():
        return database.all('tasks')

    @application.post('/api/tasks')
    async def create_task(plan: Plan):
        value = plan.model_dump()
        record = {'id': uid('task'), 'accountId': 'local', 'plan': value, 'status': 'ready', 'createdAt': now(), 'updatedAt': now(), 'lastRunAt': None, 'nextRunAt': next_daily(value), 'demo': False}
        database.put('tasks', record)
        database.event('task.created', record)
        return record

    @application.get('/api/tasks/{task_id}')
    async def task(task_id: str):
        record = database.get('tasks', task_id)
        if not record:
            raise HTTPException(404, '任务不存在')
        return {**record, 'executions': [e for e in database.all('executions') if e['taskId'] == task_id]}

    @application.put('/api/tasks/{task_id}')
    async def update_task(task_id: str, plan: Plan):
        record = database.get('tasks', task_id)
        if not record:
            raise HTTPException(404, '任务不存在')
        job = worker.jobs.get(task_id)
        if record['status'] in ('running', 'queued') or (job and not job.done()):
            raise HTTPException(409, '请先暂停任务并等待本轮结束，再调整未来执行方案')
        record.update(plan=plan.model_dump(), updatedAt=now(), nextRunAt=next_daily(plan.model_dump()))
        if record['status'] not in ('paused', 'cancelled'):
            record['status'] = 'ready'
        database.put('tasks', record)
        database.event('task.updated', record)
        return record

    @application.post('/api/tasks/{task_id}/run')
    async def run(task_id: str):
        return worker.run(task_id)

    @application.post('/api/tasks/{task_id}/pause')
    async def pause(task_id: str):
        return worker.control(task_id, 'pause')

    @application.post('/api/tasks/{task_id}/resume')
    async def resume(task_id: str):
        return worker.control(task_id, 'resume')

    @application.post('/api/tasks/{task_id}/cancel')
    async def cancel(task_id: str):
        return worker.control(task_id, 'cancel')

    @application.get('/api/executions')
    async def executions(taskId: str | None = None):
        return [e for e in database.all('executions') if not taskId or e['taskId'] == taskId]

    @application.get('/api/customers')
    async def customers(taskId: str | None = None, executionId: str | None = None):
        result = database.all('customers')
        selected = [c for c in result if (not taskId or taskId in c['taskIds']) and (not executionId or any(s.get('executionId') == executionId for s in c['sources']))]
        for customer in selected:
            scoped = customer.get('executionMatches', {}).get(executionId) if executionId else customer.get('matches', {}).get(taskId) if taskId else None
            if scoped:
                customer['match'] = scoped
                customer['target'] = scoped['status'] == 'matched'
        return selected

    @application.get('/api/customers/{customer_id}')
    async def customer(customer_id: str):
        record = database.get('customers', customer_id)
        if not record:
            raise HTTPException(404, '客户不存在')
        return record

    @application.post('/api/customers/{customer_id}/messages/{message_id}/verify')
    async def verify_message(customer_id: str, message_id: str):
        record = database.get('customers', customer_id)
        if not record:
            raise HTTPException(404, '客户不存在')
        if not any(m.get('id') == message_id for m in record.get('messages', [])):
            raise HTTPException(404, '该客户没有这条发送记录')
        return await worker.verify_message(customer_id, message_id)

    @application.post('/api/customers/{customer_id}/draft')
    async def draft(customer_id: str, body: DraftRequest):
        record = database.get('customers', customer_id)
        if not record:
            raise HTTPException(404, '客户不存在')
        if body.taskId:
            if body.taskId not in record['taskIds'] or not database.get('tasks', body.taskId):
                raise HTTPException(422, '该客户不属于所选任务')
            record = {**record, 'sources': [source for source in record['sources'] if source.get('taskId') == body.taskId]}
        return await draft_message(record, body.knowledge if body.knowledge is not None else worker.knowledge(), body.strategy)

    @application.post('/api/customers/{customer_id}/send')
    async def send(customer_id: str, body: SendRequest):
        if not body.authorized:
            raise HTTPException(422, '请明确授权这条消息的实际发送')
        record = database.get('customers', customer_id)
        if not record:
            raise HTTPException(404, '客户不存在')
        if body.taskId and (body.taskId not in record['taskIds'] or not database.get('tasks', body.taskId)):
            raise HTTPException(422, '该客户不属于所选任务')
        return await worker.send(customer_id, body.text, body.channel, task_id=body.taskId)

    @application.get('/api/knowledge')
    async def knowledge():
        return worker.knowledge()

    @application.put('/api/knowledge')
    async def knowledge_save(body: KnowledgeRequest):
        value = body.model_dump()
        database.put('settings', {'id': 'knowledge', 'value': value})
        database.event('knowledge.updated', {'saved': True})
        return value

    @application.get('/api/conversation-monitor')
    async def monitor_status():
        return conversations.get_settings()

    @application.put('/api/conversation-monitor')
    async def monitor_control(body: MonitorSettings):
        result = conversations.configure_monitor(body.enabled, body.intervalSeconds)
        if body.enabled:
            for task in database.all('tasks'):
                if task['status'] in ('running', 'queued', 'ready'):
                    worker.control(task['id'], 'pause')
            jobs = [job for job in worker.jobs.values() if not job.done()]
            for job in jobs:
                job.cancel()
            if jobs:
                await asyncio.gather(*jobs, return_exceptions=True)
        return result

    @application.get('/api/conversations')
    async def conversation_list():
        return conversations.list()

    @application.post('/api/conversations')
    async def conversation_create(body: ConversationCreate):
        return conversations.create(body.customerId)

    @application.get('/api/conversations/{conversation_id}')
    async def conversation_detail(conversation_id: str):
        return conversations.detail(conversation_id)

    @application.put('/api/conversations/{conversation_id}')
    async def conversation_control(conversation_id: str, body: ConversationControl):
        return conversations.configure(conversation_id, body.mode, body.authorized)

    @application.post('/api/conversations/{conversation_id}/sync')
    async def conversation_sync(conversation_id: str):
        if worker.browser_lock.locked():
            raise HTTPException(409, '浏览器正忙，请暂停找客任务或稍后重试')
        return await conversations.sync(conversation_id)

    @application.post('/api/conversations/{conversation_id}/draft')
    async def conversation_draft(conversation_id: str):
        return await conversations.draft(conversation_id)

    @application.post('/api/conversations/{conversation_id}/send')
    async def conversation_send(conversation_id: str, body: ConversationSend):
        if worker.browser_lock.locked():
            raise HTTPException(409, '浏览器正忙，请暂停找客任务或稍后重试')
        return await conversations.send(conversation_id, body.text, body.authorized, body.requestId, body.revision)

    @application.post('/api/conversations/{conversation_id}/outbox/{outbox_id}/resolve')
    async def conversation_resolve(conversation_id: str, outbox_id: str, body: ConversationResolution):
        return conversations.resolve(conversation_id, outbox_id, body.resolution, body.authorized, body.note)

    @application.get('/api/events')
    async def events(after: int = 0):
        return database.events(max(0, after))

    @application.get('/api/evidence/{file_path:path}')
    async def evidence(file_path: str):
        base = (directory / 'evidence').resolve()
        candidate = (base / file_path).resolve()
        if not candidate.is_relative_to(base) or not candidate.is_file() or candidate.suffix.lower() not in ('.png', '.jpg', '.jpeg', '.txt', '.json'):
            raise HTTPException(404, '证据文件不存在')
        return FileResponse(candidate)

    @application.get('/{path:path}')
    async def frontend(path: str):
        if path == 'api' or path.startswith('api/'):
            raise HTTPException(404, '接口不存在')
        dist = (ROOT / 'dist').resolve()
        candidate = (dist / path).resolve()
        if candidate.is_relative_to(dist) and candidate.is_file():
            return FileResponse(candidate)
        if (dist / 'index.html').is_file():
            return FileResponse(dist / 'index.html')
        raise HTTPException(404, '请先运行 npm run build 或使用 Vite 开发服务器')

    return application


app = create_app()
