"""Native live-mention and comment-reply browser paths on isolated local DOM."""
import asyncio
import tempfile
import unittest

from server.adapter import DouyinAdapter


class NativeReplyScenarios(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from playwright.async_api import async_playwright
        self.temp = tempfile.TemporaryDirectory()
        self.adapter = DouyinAdapter(self.temp.name)
        self.adapter._own_name = '我方账号'
        self.pw = await async_playwright().start()
        self.browser = await self.pw.chromium.launch(channel='msedge', headless=True)
        self.context = await self.browser.new_context()
        self.adapter._context = self.context

    async def asyncTearDown(self):
        await self.context.close()
        await self.browser.close()
        await self.pw.stop()
        self.temp.cleanup()

    async def setup_page(self, html, url):
        async def route(request):
            await request.fulfill(status=200, content_type='text/html; charset=utf-8', body=html)
        await self.context.route('**/*', route)
        page = await self.context.new_page()
        await page.goto(url)
        async def short_wait(ms):
            await asyncio.sleep(.015)
        page.wait_for_timeout = short_wait
        async def existing_page(url):
            return page
        self.adapter._page = existing_page
        return page

    async def comment(self, author='peer', placeholder='回复@客户甲', echo=True):
        html = '''<meta charset="utf-8"><div data-e2e="comment-item">
        <div class="comment-item-info-wrap"><a href="/user/''' + author + '''">客户甲</a></div>
        <div>我想了解价格</div><button id="reply">回复</button></div>
        <div data-e2e="comment-input" contenteditable="true" data-placeholder="''' + placeholder + '''"></div>
        <script>
        const editor=document.querySelector('[contenteditable]');
        document.querySelector('#reply').onclick=()=>editor.focus();
        editor.addEventListener('keydown',event=>{if(event.key==='Enter'){
        event.preventDefault(); const value=editor.innerText; editor.innerText='';
        if(''' + ('true' if echo else 'false') + '''){
        const row=document.createElement('div');row.setAttribute('data-e2e','comment-item');
        const author=document.createElement('a');author.href='/user/own';author.textContent='我方账号';
        const body=document.createElement('span');body.textContent=value;row.append(author,body);document.body.appendChild(row);}
        }});</script>'''
        await self.setup_page(html, 'https://www.douyin.com/video/123')
        return {'platformId': 'peer', 'nickname': '客户甲', 'sources': [{'type': '作品评论', 'url': 'https://www.douyin.com/video/123', 'text': '我想了解价格', 'nickname': '客户甲'}]}

    async def test_native_comment_reply_success_requires_new_owned_row(self):
        customer = await self.comment()
        result = await self.adapter._reply_comment(customer, '您好，这是隔离测试回复')
        self.assertEqual(result['status'], 'success')
        self.assertEqual(result['confirmationLevel'], 'visible_page')
        self.assertTrue(result['evidencePath'])

    async def test_same_name_wrong_comment_owner_never_submits(self):
        customer = await self.comment(author='different-peer')
        result = await self.adapter._reply_comment(customer, '不可发出的内容')
        self.assertEqual(result['status'], 'failed')
        self.assertIn('平台标识', result['reason'])

    async def test_wrong_native_reply_target_and_unconfirmed_submit(self):
        customer = await self.comment(placeholder='回复@另一个人')
        result = await self.adapter._reply_comment(customer, '不可发出的内容')
        self.assertEqual(result['status'], 'failed')
        self.assertIn('指定用户', result['reason'])
        await self.context.unroute('**/*')
        customer = await self.comment(echo=False)
        result = await self.adapter._reply_comment(customer, '没有回显的内容')
        self.assertEqual(result['status'], 'unknown')

    async def test_unscoped_body_text_is_not_reply_target_evidence(self):
        customer = await self.comment(placeholder='')
        result = await self.adapter._reply_comment(customer, '不可发出的内容')
        self.assertEqual(result['status'], 'failed')
        self.assertIn('指定用户', result['reason'])

    async def test_reply_target_prefix_collision_is_not_same_person(self):
        customer = await self.comment(placeholder='回复@客户甲同学')
        result = await self.adapter._reply_comment(customer, '不可发出的内容')
        self.assertEqual(result['status'], 'failed')
        self.assertIn('指定用户', result['reason'])

    async def live(self, profile='peer'):
        html = '''<meta charset="utf-8"><div class="webcast-chatroom___item-wrapper">
        <span class="v8LY0gZF">客户甲：</span><span class="cL385mHb">好听</span></div>
        <div class="NZ4dNxK4"><button class="avatar" onclick="window.open('https://www.douyin.com/user/''' + profile + '''')">头像</button>
        <button class="mention">@回复</button></div><div contenteditable="true"></div>
        <script>const editor=document.querySelector('[contenteditable]');
        document.querySelector('.mention').onclick=()=>{editor.innerText='@客户甲';editor.focus()};
        editor.addEventListener('keydown',event=>{if(event.key==='Enter'){
        event.preventDefault();const row=document.createElement('div');row.className='webcast-chatroom___item-wrapper';
        row.innerText='我方账号：'+editor.innerText;document.body.appendChild(row);editor.innerText='';}});
        </script>'''
        await self.setup_page(html, 'https://live.douyin.com/123')
        return {'platformId': 'peer', 'nickname': '客户甲', 'sources': [{'type': '直播弹幕', 'roomUrl': 'https://live.douyin.com/123', 'text': '好听', 'nickname': '客户甲'}]}

    async def test_native_live_mention_verifies_owner_and_preserves_at_reference(self):
        customer = await self.live()
        result = await self.adapter._mention(customer, '隔离测试回复')
        self.assertEqual(result['status'], 'success')
        self.assertEqual(result['text'], '@客户甲 隔离测试回复')
        self.assertTrue(result['evidencePath'])

    async def test_native_live_mention_refuses_different_stable_identity(self):
        customer = await self.live(profile='different-peer')
        result = await self.adapter._mention(customer, '不可发出的内容')
        self.assertEqual(result['status'], 'failed')
        self.assertIn('身份', result['reason'])
