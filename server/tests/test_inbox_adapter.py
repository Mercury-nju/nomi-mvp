"""Actual browser DOM checks for inbound observations; all requests intercepted."""
import asyncio
import tempfile
import unittest
from pathlib import Path

from server.adapter import DouyinAdapter
from server.inbox_adapter import InboxAdapter, read_message_rows


class InboxDOMTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from playwright.async_api import async_playwright
        self.temp = tempfile.TemporaryDirectory()
        self.pw = await async_playwright().start()
        try:
            self.browser = await self.pw.chromium.launch(channel='msedge', headless=True)
        except Exception:
            await self.pw.stop()
            self.temp.cleanup()
            self.skipTest('Microsoft Edge unavailable for isolated DOM checks')
        self.page = await self.browser.new_page()
        self.adapter = DouyinAdapter(self.temp.name)
        self.customer = {'profileUrl': 'https://www.douyin.com/user/peer', 'platformId': 'peer', 'nickname': '测试用户'}

    async def asyncTearDown(self):
        if hasattr(self, 'page'):
            await self.browser.close()
            await self.pw.stop()
            self.temp.cleanup()

    async def parse(self, html):
        await self.page.set_content('<meta charset="utf-8"><section id="panel">' + html + '</section>')
        return await read_message_rows(self.page.locator('#panel'), 'peer')

    def native_row(self, value, mine=False):
        a = ' messageMessageBoxisFromMe' if mine else ''
        b = ' MessageBoxContentisFromMe' if mine else ''
        return ('<div class="messageMessageBoxmessageBox"><div class="messageMessageBoxcontentBox' + a + '">'
                '<div class="MessageBoxContentcolumnBox' + b + '"><div data-e2e="msg-item-content">'
                '<div class="MessageItemTextbubbleTextContent"><span>' + value + '</span></div></div></div></div></div>')

    async def test_native_layout_chronological_direction_and_system_exclusion(self):
        # Structure observed from the actual logged-in test conversation 2026-10-27.
        result = await self.parse('<div class="messageMessageListlist" style="display:flex;flex-direction:column-reverse">' +
                                  self.native_row('第二条', True) + self.native_row('第一条') +
                                  '<div class="messageMessageBoxmessageBox messageMessageBoxisFullRowCenterMessage">系统限制</div></div>')
        self.assertTrue(result['complete'])
        self.assertEqual([(m['direction'], m['text']) for m in result['messages']], [('inbound', '第一条'), ('outbound', '第二条')])
        self.assertNotIn('platformMessageId', result['messages'][0])

    async def test_same_text_distinct_occurrences_are_not_deduplicated(self):
        result = await self.parse(self.native_row('好的') + self.native_row('好的') + self.native_row('好的', True))
        self.assertTrue(result['complete'])
        self.assertEqual(len(result['messages']), 3)
        self.assertEqual(sum(m['direction'] == 'inbound' for m in result['messages']), 2)

    async def test_unknown_or_conflicting_direction_fails_closed(self):
        for html in [
            '<div data-message-id="a"><div class="message-content">无方向</div></div>',
            '<div data-message-id="a" data-direction="inbound" data-is-self="true"><div class="message-content">冲突</div></div>',
            self.native_row('冲突', True).replace('MessageBoxContentcolumnBox MessageBoxContentisFromMe', 'MessageBoxContentcolumnBox'),
        ]:
            with self.subTest(html=html):
                result = await self.parse(html)
                self.assertFalse(result['complete'])
                self.assertEqual(result['messages'], [])

    async def test_media_not_interpreted_as_text_and_metadata_retained(self):
        result = await self.parse('<div data-message-id="m1" data-direction="inbound" data-message-type="image" data-create-time="2026-10-27T10:00:00Z"><div data-message-type="image">not a text answer</div></div>')
        self.assertTrue(result['complete'])
        self.assertEqual(result['messages'], [{'direction': 'inbound', 'text': '', 'type': 'image', 'platformMessageId': 'm1', 'platformAt': '2026-10-27T10:00:00Z'}])

    async def test_unknown_message_structure_not_flattened_and_empty_explicit(self):
        result = await self.parse('<div data-message-id="a" data-direction="inbound">作者 时间 操作</div>')
        self.assertFalse(result['complete'])
        self.assertEqual(result['messages'], [])
        self.assertFalse((await self.parse('<h2>测试用户</h2>'))['complete'])
        self.assertTrue((await self.parse('<div data-e2e="im-empty">暂无消息</div>'))['complete'])

    async def test_genuine_native_system_only_window_empty_but_not_loading_or_unknown(self):
        notice = ('<div class="messageMessageListlist" style="display:flex;flex-direction:column-reverse">'
                  '<div class="messageMessageBoxmessageBox messageMessageBoxisFullRowCenterMessage">'
                  '<div class="SystemNormalSystemtext">对方回复或关注你之前，只能发送一条文字消息。请礼貌发言，自觉遵守</div>'
                  '</div></div><div class="messageEditorinputArea" contenteditable="true">输入</div>')
        result = await self.parse(notice)
        self.assertTrue(result['complete'])
        self.assertEqual(result['messages'], [])
        for other in [notice + '<div role="progressbar">加载中</div>',
                      notice.replace('对方回复或关注你之前，只能发送一条文字消息', '未知系统通知'),
                      notice.replace('请礼貌发言', '加载失败'),
                      '<div class="messageMessageListlist"></div>']:
            with self.subTest(other=other):
                self.assertFalse((await self.parse(other))['complete'])

    async def test_existing_rows_do_not_make_loading_or_error_window_complete(self):
        content = '<div class="messageMessageListlist">' + self.native_row('旧消息')
        for extra in ['<div role="progressbar">正在加载</div>', '<div>加载失败，请重试</div>']:
            with self.subTest(extra=extra):
                result = await self.parse(content + extra + '</div>')
                self.assertFalse(result['complete'])
                # Evidence may be retained, but incomplete observations cannot
                # advance the synchronization baseline or trigger a reply.
                self.assertEqual(result['messages'][0]['text'], '旧消息')

    async def fixture(self, target='peer'):
        fixture = ('<meta charset="utf-8"><button>私信</button><section data-e2e="im-dialog"><div class="StackLayoutStackChatHeaderuser">'
                   '<a href="/user/' + target + '">头像</a><div class="StackLayoutStackChatHeadertitle">测试用户</div></div>'
                   '' + self.native_row('已有文字', True) +
                   '<div contenteditable="true" class="messageEditorinputArea"></div></section>')
        await self.page.route('**/*', lambda route: route.fulfill(status=200, content_type='text/html; charset=utf-8', body=fixture))
        await self.page.goto('https://www.douyin.com/user/peer')
        async def status():
            return {'connected': True}
        async def page(url):
            return self.page
        async def wait(ms):
            await asyncio.sleep(0.001)
        self.adapter.status = status
        self.adapter._page = page
        self.page.wait_for_timeout = wait

    async def test_reader_identity_and_only_read_no_input(self):
        await self.fixture()
        result = await InboxAdapter(self.adapter).read_thread(self.customer)
        self.assertTrue(result['identityVerified'])
        self.assertTrue(result['complete'])
        self.assertEqual(result['messages'][0]['direction'], 'outbound')
        self.assertTrue(result['evidencePath'])

    async def test_same_name_wrong_identity_does_not_expose_messages(self):
        await self.fixture('different-person')
        result = await InboxAdapter(self.adapter).read_thread(self.customer)
        self.assertFalse(result['identityVerified'])
        self.assertFalse(result['complete'])
        self.assertEqual(result['messages'], [])

    async def test_reader_waits_for_async_thread_instead_of_double_click_race(self):
        await self.fixture()
        await self.page.evaluate('''() => {
          const editor = document.querySelector('.messageEditorinputArea');
          editor.style.display = 'none';
          let timer = null;
          document.querySelector('button').onclick = () => {
            if (timer) { clearTimeout(timer); timer = null; return; }
            timer = setTimeout(() => { editor.style.display = ''; timer = null; }, 900);
          };
        }''')
        result = await InboxAdapter(self.adapter).read_thread(self.customer)
        self.assertTrue(result['identityVerified'])
        self.assertTrue(result['complete'])
        self.assertEqual(len(result['messages']), 1)


    async def test_reader_waits_for_message_list_without_reclick_or_input(self):
        await self.fixture()
        await self.page.evaluate("""() => {
          const panel=document.querySelector('[data-e2e="im-dialog"]');
          const loader=document.createElement('div');loader.setAttribute('role','progressbar');panel.appendChild(loader);
          window.clicks=0;window.keys=0;
          document.querySelector('button').onclick=()=>{window.clicks++;setTimeout(()=>loader.remove(),40)};
          document.querySelector('[contenteditable]').addEventListener('keydown',()=>window.keys++);
        }""")
        # Keep deterministic short DOM updates, while exercising repeated reads.
        original_close = self.page.close
        async def keep_page(): pass
        self.page.close = keep_page
        try:
            result = await InboxAdapter(self.adapter).read_thread(self.customer)
            self.assertTrue(result['identityVerified'])
            self.assertTrue(result['complete'])
            self.assertEqual(result['messages'][0]['text'], '已有文字')
            self.assertEqual(await self.page.evaluate('window.clicks'), 1)
            self.assertEqual(await self.page.evaluate('window.keys'), 0)
        finally:
            self.page.close = original_close
            await self.page.close()

    async def test_reader_never_calls_unknown_blank_window_complete(self):
        await self.fixture()
        await self.page.locator('.messageMessageBoxmessageBox').evaluate('e=>e.remove()')
        result = await InboxAdapter(self.adapter).read_thread(self.customer)
        self.assertTrue(result['identityVerified'])
        self.assertFalse(result['complete'])
        self.assertEqual(result['messages'], [])


if __name__ == '__main__':
    unittest.main()
