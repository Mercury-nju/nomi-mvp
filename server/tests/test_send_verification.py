"""Fresh-thread verification is independent of optimistic local send receipts."""
import pytest
from fastapi.testclient import TestClient
from server.app import create_app
from server.inbox_adapter import InboxAdapter
from server.tests.test_backend import FakeAdapter


def seed(app, status='success', channel='dm', direction='outbound'):
    message = {'id': 'message-one', 'text': '测试原文', 'channel': channel,
               'direction': direction, 'status': status,
               'confirmationLevel': 'visible_page', 'evidencePath': '/api/evidence/original.png'}
    customer = {'id': 'customer-one', 'nickname': '测试用户', 'platformId': 'peer',
                'profileUrl': 'https://www.douyin.com/user/peer', 'messages': [message],
                'taskIds': [], 'sources': []}
    app.state.db.put('customers', customer)
    app.state.db.reserve_send(message['id'], customer['id'], channel, message)
    return '/api/customers/customer-one/messages/message-one/verify'


@pytest.mark.parametrize('identity,complete,messages,expected,count', [
    (True, True, [{'direction':'outbound','text':'测试原文'}], 'success', 1),
    (True, True, [], 'unknown', 0),
    (False, True, [{'direction':'outbound','text':'测试原文'}], 'unknown', 0),
    (True, False, [{'direction':'outbound','text':'测试原文'}], 'unknown', 0),
    (True, True, [{'direction':'inbound','text':'测试原文'}], 'unknown', 0),
    (True, True, [{'direction':'outbound','text':'测试原文另有后缀'}], 'unknown', 0),
])
def test_verify_requires_identity_complete_exact_outgoing(tmp_path, monkeypatch, identity, complete, messages, expected, count):
    adapter = FakeAdapter()
    app = create_app(tmp_path, adapter)
    async def read(self, customer):
        assert app.state.agent.browser_lock.locked()
        return {'identityVerified':identity, 'complete':complete, 'messages':messages,
                'evidencePath':'/api/evidence/verification.png'}
    monkeypatch.setattr(InboxAdapter, 'read_thread', read)
    with TestClient(app) as client:
        route = seed(app)
        result = client.post(route).json()
        assert result['status'] == expected
        assert result['confirmationLevel'] == ('reopened_thread' if expected == 'success' else 'unconfirmed')
        assert result['verification']['outgoingTextCount'] == count
        assert result['originalReceipt']['status'] == 'success'
        assert result['originalReceipt']['evidencePath'] == '/api/evidence/original.png'
        assert len(result['verifications']) == 1
        assert result['evidencePath'] == '/api/evidence/verification.png'
        assert not adapter.sent
        assert client.get('/api/customers/customer-one').json()['messages'][0]['status'] == expected
        again = client.post(route).json()
        assert len(again['verifications']) == 2
        assert 'originalReceipt' not in again['originalReceipt']
        assert not adapter.sent


def test_failed_without_submission_stays_failed_when_no_message_found(tmp_path, monkeypatch):
    adapter = FakeAdapter()
    app = create_app(tmp_path, adapter)
    with TestClient(app) as client:
        route = seed(app, status='failed')
        result = client.post(route).json()
        assert result['status'] == 'failed'
        assert result['verification']['outgoingTextCount'] == 0
        assert result['originalReceipt']['status'] == 'failed'
        assert not adapter.sent


def test_verify_does_not_cross_customer_or_allow_non_dm(tmp_path):
    app = create_app(tmp_path, FakeAdapter())
    with TestClient(app) as client:
        assert client.post('/api/customers/other/messages/message-one/verify').status_code == 404
        route = seed(app, channel='video_comment')
        assert client.post(route).status_code == 409
        assert client.post(route.replace('message-one', 'wrong-message')).status_code == 404
        seed(app, status='sending')
        assert client.post(route).status_code == 409


def test_new_send_automatically_reopens_and_unknown_prevents_resend(tmp_path, monkeypatch):
    adapter = FakeAdapter()
    app = create_app(tmp_path, adapter)
    async def empty(self, customer):
        assert app.state.agent.browser_lock.locked()
        return {'identityVerified':True, 'complete':True, 'messages':[]}
    monkeypatch.setattr(InboxAdapter, 'read_thread', empty)
    with TestClient(app) as client:
        seed(app)
        route = '/api/customers/customer-one/send'
        body = {'text':'新测试消息','channel':'dm','authorized':True}
        result = client.post(route, json=body).json()
        assert result['status'] == 'unknown'
        assert result['originalReceipt']['status'] == 'success'
        assert len(adapter.sent) == 1
        duplicate = client.post(route, json=body).json()
        assert duplicate['duplicate'] and duplicate['status'] == 'unknown'
        assert len(adapter.sent) == 1
