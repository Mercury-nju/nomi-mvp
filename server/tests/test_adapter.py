"""Adapter invariants and actual DOM interaction tests; no external messages."""
import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from server.adapter import DouyinAdapter, douyin_url, profile_id, stable_id


class URLTests(unittest.TestCase):
    def test_only_public_douyin_https_navigation(self):
        for value in ['https://evil.com', 'http://www.douyin.com/user/a', 'https://douyin.com.evil.com', 'https://user:pass@douyin.com', 'https://live.douyin.com:444/12', 'file:///etc/passwd', 'https://127.0.0.1']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                douyin_url(value)
        self.assertEqual(douyin_url('https://www.douyin.com/user/abc', 'profile'), 'https://www.douyin.com/user/abc')
        with self.assertRaises(ValueError):
            douyin_url('https://www.douyin.com/user/abc', 'live')
        self.assertEqual(douyin_url('https://live.douyin.com/123', 'live'), 'https://live.douyin.com/123')

    def test_identity_uses_platform_identifier_not_nickname(self):
        self.assertEqual(profile_id('https://www.douyin.com/user/MS4w-id?x=1'), 'MS4w-id')
        self.assertEqual(profile_id('/user/MS4w-id'), 'MS4w-id')
        self.assertEqual(profile_id('https://www.douyin.com/video/123'), '')
        self.assertNotEqual(stable_id('roomA', 'name', 'hello'), stable_id('roomB', 'name', 'hello'))


class LocalBrowserTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            self.skipTest('Install server requirements for browser DOM checks')
        self.temp = tempfile.TemporaryDirectory()
        self.adapter = DouyinAdapter(self.temp.name)
        self.pw = await async_playwright().start()
        try:
            self.browser = await self.pw.chromium.launch(channel='msedge', headless=True)
        except Exception:
            await self.pw.stop()
            self.temp.cleanup()
            self.skipTest('Microsoft Edge unavailable for isolated browser checks')

    async def asyncTearDown(self):
        if hasattr(self, 'browser'):
            await self.browser.close()
            await self.pw.stop()
            self.temp.cleanup()

    async def _fixture(self, name='测试用户'):
        page = await self.browser.new_page()
        fixture = '''<meta charset="utf-8"><button>私信</button><section data-e2e="im-dialog"><div class="StackLayoutStackChatHeaderuser"><a href="/user/test">头像</a><div class="StackLayoutStackChatHeadertitle">''' + name + '''</div></div><h2>''' + name + '''</h2><div id="messages"><div data-e2e="im-empty">暂无消息</div></div><div contenteditable="true" class="messageEditorinputArea"></div></section>
        <script>document.querySelector('[contenteditable]').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();let p=document.createElement('p');p.setAttribute('data-e2e','im-message');p.setAttribute('data-direction','outbound');let span=document.createElement('span');span.setAttribute('data-e2e','message-content');span.textContent=e.target.innerText;p.appendChild(span);document.querySelector('#messages').appendChild(p);e.target.textContent=''}})</script>'''
        await page.route('**/*', lambda route: route.fulfill(status=200, content_type='text/html', body=fixture))
        await page.goto('https://www.douyin.com/user/test')
        async def short_wait(ms):
            await asyncio.sleep(0.01)
        page.wait_for_timeout = short_wait
        async def local_page(url):
            return page
        self.adapter._page = local_page
        return page

    async def _live_fixture(self, profile_name):
        context = await self.browser.new_context()
        room_html = '<meta charset="utf-8"><div class="webcast-chatroom___item-wrapper"><span class="v8LY0gZF">发言者：</span><span class="cL385mHb">好听</span></div><div class="NZ4dNxK4"><div class="user_name"><h3>发言者</h3></div><button class="avatar" onclick="window.open(\'https://www.douyin.com/user/stable-speaker\')">头像</button></div>'
        profile_html = '<meta charset="utf-8"><div data-e2e="user-info"><h1>' + profile_name + '</h1></div>'
        async def route(request):
            await request.fulfill(status=200, content_type='text/html; charset=utf-8', body=profile_html if '/user/' in request.request.url else room_html)
        await context.route('**/*', route)
        page = await context.new_page()
        await page.goto('https://live.douyin.com/123')
        async def short_wait(ms):
            await asyncio.sleep(0.01)
        page.wait_for_timeout = short_wait
        self.adapter._context = context
        async def local_page(url):
            return page
        self.adapter._page = local_page
        return context

    async def test_live_does_not_bind_another_profile_to_observed_speaker(self):
        context = await self._live_fixture('另一个用户')
        events = []
        async def emit(event):
            events.append(event)
            return {'matched': False}
        try:
            result = await self.adapter._live({'sourceUrl':'https://live.douyin.com/123','limit':1,'observeSeconds':5}, emit, lambda:any(e.get('name') == '核对公开主页身份' for e in events))
            self.assertEqual(result, [])
            self.assertFalse(any(e.get('type') == 'candidate' for e in events))
        finally:
            await context.close()

    async def test_live_identity_and_source_have_same_verified_owner(self):
        context = await self._live_fixture('发言者')
        async def emit(event):
            return {'matched': event.get('type') == 'candidate'}
        try:
            result = await self.adapter._live({'sourceUrl':'https://live.douyin.com/123','limit':1,'observeSeconds':5}, emit, lambda:False)
            self.assertEqual(len(result), 1)
            source = result[0]['sources'][0]
            self.assertEqual(result[0]['nickname'], source['nickname'])
            self.assertEqual(source['id'], stable_id('https://live.douyin.com/123','stable-speaker','好听'))
            self.assertTrue(source['evidencePath'])
        finally:
            await context.close()

    async def test_dm_requires_target_identity_and_visible_sent_text(self):
        await self._fixture()
        receipt = await self.adapter._dm({'platformId':'test','nickname': '测试用户', 'profileUrl': 'https://www.douyin.com/user/test'}, '礼貌的本地链路测试')
        self.assertEqual(receipt['status'], 'success')
        self.assertEqual(receipt['confirmationLevel'], 'visible_page')
        self.assertIn('未确认送达或已读', receipt['reason'])
        self.assertTrue(receipt['evidencePath'])

    async def test_dm_refuses_wrong_conversation(self):
        page = await self._fixture('另一个用户')
        await page.locator('.StackLayoutStackChatHeaderuser a').evaluate("e=>e.href='/user/other-person'")
        receipt = await self.adapter._dm({'platformId':'test','nickname': '测试用户', 'profileUrl': 'https://www.douyin.com/user/test'}, '不得发送')
        self.assertEqual(receipt['status'], 'failed')
        self.assertIn('无法核对', receipt['reason'])

    async def test_dm_refuses_same_name_with_different_platform_identity(self):
        page = await self._fixture()
        await page.locator('.StackLayoutStackChatHeaderuser a').evaluate("e=>e.href='/user/other-person'")
        receipt = await self.adapter._dm({'platformId':'test','nickname':'测试用户','profileUrl':'https://www.douyin.com/user/test'}, '不得向同名者发送')
        self.assertEqual(receipt['status'], 'failed')
        self.assertIn('平台标识', receipt['reason'])

    async def test_dm_identity_allows_changed_nickname_only_with_same_id(self):
        for name in ['测试用户🌹', '示例公司\u00a0\u00a0\u00a0联系人']:
            with self.subTest(name=name):
                page = await self._fixture(name)
                self.assertTrue(await self.adapter._verify_dm_identity(page, {'nickname':'旧昵称'}, 'test'))
                await page.close()

    async def test_dm_identity_ignores_hidden_and_unrelated_headers(self):
        page = await self._fixture()
        await page.locator('body').evaluate("""e=>e.insertAdjacentHTML('beforeend', '<div class="StackLayoutStackChatHeaderuser"><a href="/user/wrong">外部头像</a><div class="StackLayoutStackChatHeadertitle">别的会话</div></div><section data-e2e="im-dialog" style="display:none"><div class="StackLayoutStackChatHeaderuser"><a href="/user/wrong">隐藏头像</a><div class="StackLayoutStackChatHeadertitle">旧会话</div></div></section>')""")
        self.assertTrue(await self.adapter._verify_dm_identity(page, {'nickname':'测试用户'}, 'test'))

    async def test_dm_identity_native_header_sibling_of_editor_panel(self):
        page = await self._fixture()
        await page.locator('[data-e2e="im-dialog"]').evaluate("""dialog=>{
            const root=document.createElement('div');root.className='StackLayoutpagespageRoot';
            const right=document.createElement('div');right.className='componentsRightPanelwrapper';
            const header=dialog.querySelector('.StackLayoutStackChatHeaderuser');root.appendChild(header);
            while(dialog.firstChild)right.appendChild(dialog.firstChild);
            root.appendChild(right);dialog.appendChild(root);
        }""")
        self.assertEqual(await page.locator('.componentsRightPanelwrapper .StackLayoutStackChatHeaderuser').count(), 0)
        self.assertTrue(await self.adapter._verify_dm_identity(page, {'nickname':'旧昵称'}, 'test'))
        await page.locator('.StackLayoutStackChatHeaderuser a').evaluate("e=>e.href='/user/wrong'")
        self.assertFalse(await self.adapter._verify_dm_identity(page, {'nickname':'测试用户'}, 'test'))

    async def test_dm_identity_never_uses_matching_name_as_proof(self):
        page = await self._fixture()
        await page.locator('.StackLayoutStackChatHeaderuser a').evaluate("e=>e.remove()")
        self.assertFalse(await self.adapter._verify_dm_identity(page, {'nickname':'测试用户'}, 'test'))
        await page.locator('.StackLayoutStackChatHeadertitle').evaluate("e=>e.textContent='' ")
        self.assertFalse(await self.adapter._verify_dm_identity(page, {'nickname':'测试用户'}, 'test'))

    async def test_dm_avatar_card_counts_visible_links_consistently(self):
        page = await self._fixture('已更新昵称')
        await page.locator('.StackLayoutStackChatHeaderuser a').evaluate("""e=>{const b=document.createElement('button');b.setAttribute('data-apm-action','个人页卡片');b.textContent='头像';b.onclick=()=>document.querySelector('#native-card').style.display='block';e.replaceWith(b)}""")
        await page.locator('body').evaluate("""e=>e.insertAdjacentHTML('beforeend','<div style="display:none"><a href="/user/test">隐藏预存链接</a></div><div id="native-card" style="display:none"><a href="/user/test">新可见主页</a></div>')""")
        await page.locator('[contenteditable]').evaluate("e=>e.addEventListener('click',()=>document.querySelector('#native-card').style.display='none')")
        self.assertTrue(await self.adapter._verify_dm_identity(page, {'nickname':'旧昵称'}, 'test'))
        self.assertTrue(await page.locator('[contenteditable]').is_visible())

    async def test_dm_avatar_popup_must_have_expected_public_profile_id(self):
        for target, expected in [('test', True), ('other-person', False)]:
            with self.subTest(target=target):
                page = await self._fixture('同名用户')
                await page.locator('.StackLayoutStackChatHeaderuser a').evaluate("(e,target)=>{const b=document.createElement('button');b.setAttribute('data-apm-action','个人页卡片');b.textContent='头像';b.onclick=()=>window.open('https://www.douyin.com/user/'+target);e.replaceWith(b)}", target)
                self.assertEqual(await self.adapter._verify_dm_identity(page, {'nickname':'同名用户'}, 'test'), expected)
                self.assertTrue(await page.locator('[contenteditable]').is_visible())
                await page.close()

    async def test_dm_avatar_same_tab_restores_conversation_before_approval(self):
        page = await self._fixture('已更名')
        await page.locator('.StackLayoutStackChatHeaderuser a').evaluate("""e=>{const b=document.createElement('button');b.setAttribute('data-apm-action','个人页卡片');b.textContent='头像';b.onclick=()=>history.pushState({},'', '/user/test?native-card=1');e.replaceWith(b)}""")
        self.assertTrue(await self.adapter._verify_dm_identity(page, {'nickname':'旧昵称'}, 'test'))
        self.assertEqual(page.url, 'https://www.douyin.com/user/test')
        self.assertTrue(await page.locator('[contenteditable]').is_visible())

    async def test_plain_input_clear_is_not_success(self):
        page = await self._fixture()
        await page.evaluate("document.querySelector('[contenteditable]').replaceWith(document.querySelector('[contenteditable]').cloneNode())")
        await page.evaluate("document.querySelector('[contenteditable]').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();e.target.textContent=''}})")
        receipt = await self.adapter._dm({'platformId':'test','nickname': '测试用户', 'profileUrl': 'https://www.douyin.com/user/test'}, '没有回显的消息')
        self.assertEqual(receipt['status'], 'unknown')
        self.assertIn('不自动重发', receipt['reason'])

    async def test_inbound_same_text_is_not_outgoing_receipt(self):
        page = await self._fixture()
        await page.evaluate("""() => {
          const old=document.querySelector('[contenteditable]');
          const editor=old.cloneNode();old.replaceWith(editor);
          editor.addEventListener('keydown',e=>{if(e.key==='Enter'){
            e.preventDefault();const row=document.createElement('div');
            row.setAttribute('data-e2e','im-message');row.setAttribute('data-direction','inbound');
            const content=document.createElement('span');content.setAttribute('data-e2e','message-content');
            content.textContent=e.target.innerText;row.appendChild(content);
            document.querySelector('#messages').appendChild(row);e.target.textContent='';
          }});
        }""")
        receipt = await self.adapter._dm({'platformId':'test','nickname':'测试用户','profileUrl':'https://www.douyin.com/user/test'}, '同文消息')
        self.assertEqual(receipt['status'], 'unknown')

    async def test_takeover_guard_cancels_before_enter(self):
        page = await self._fixture()
        submitted = []
        await page.expose_function('recordSubmit', lambda: submitted.append(True))
        await page.evaluate("document.querySelector('[contenteditable]').addEventListener('keydown',e=>{if(e.key==='Enter')window.recordSubmit()})")
        receipt = await self.adapter._dm({'platformId':'test','nickname':'测试用户','profileUrl':'https://www.douyin.com/user/test'}, '已取消消息', before_submit=lambda: False)
        self.assertEqual(receipt['status'], 'failed')
        self.assertIn('提交前已取消', receipt['reason'])
        self.assertEqual(submitted, [])

    async def test_unverified_window_never_submits(self):
        page = await self._fixture()
        await page.locator('[data-e2e="im-empty"]').evaluate('(el)=>el.remove()')
        submitted = []
        await page.expose_function('recordSubmit', lambda: submitted.append(True))
        await page.evaluate("document.querySelector('[contenteditable]').addEventListener('keydown',e=>{if(e.key==='Enter')window.recordSubmit()})")
        receipt = await self.adapter._dm({'platformId':'test','nickname':'测试用户','profileUrl':'https://www.douyin.com/user/test'}, '不得发送')
        self.assertEqual(receipt['status'], 'failed')
        self.assertIn('窗口尚未核实', receipt['reason'])
        self.assertEqual(submitted, [])

    async def test_failed_outgoing_bubble_is_not_success(self):
        page = await self._fixture()
        await page.evaluate("""() => {
          document.querySelector('[contenteditable]').addEventListener('keydown',event=>{
            if(event.key==='Enter') {
              const error=document.createElement('span'); error.textContent='发送失败';
              document.querySelector('#messages').lastElementChild.appendChild(error);
            }
          });
        }""")
        receipt = await self.adapter._dm({'platformId':'test','nickname':'测试用户','profileUrl':'https://www.douyin.com/user/test'}, '失败回显测试')
        self.assertEqual(receipt['status'], 'failed')
        self.assertIn('本次消息', receipt['reason'])

    async def test_historical_failure_and_quoted_failure_do_not_reject_new_send(self):
        page = await self._fixture()
        await page.locator('#messages').evaluate("el=>{const notice=document.createElement('span');notice.textContent='发送失败';el.appendChild(notice)}")
        receipt = await self.adapter._dm({'platformId':'test','nickname':'测试用户','profileUrl':'https://www.douyin.com/user/test'}, '我看到发送失败这个提示')
        self.assertEqual(receipt['status'], 'success')


if __name__ == '__main__':
    unittest.main()
