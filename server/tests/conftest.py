"""Explicit inbox boundary for the in-memory FakeAdapter; never launch a browser."""
import pytest
from server.inbox_adapter import InboxAdapter
from server.tests.test_backend import FakeAdapter


@pytest.fixture(autouse=True)
def fake_adapter_reopened_thread(monkeypatch):
    original = InboxAdapter.read_thread

    async def read(self, customer):
        if isinstance(self.adapter, FakeAdapter) or (type(self.adapter).__name__ == 'FakeAdapter' and type(self.adapter).__module__ == 'test_backend'):
            return {'identityVerified': True, 'complete': True, 'windowOnly': True,
                    'messages': [{'direction': 'outbound', 'text': text}
                                 for identity, text, channel in self.adapter.sent
                                 if identity == customer['id'] and channel == 'dm'],
                    'evidencePath': '/api/evidence/fake-reopened.png'}
        return await original(self, customer)

    monkeypatch.setattr(InboxAdapter, 'read_thread', read)
