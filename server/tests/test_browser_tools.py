import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from server.browser_tools import BrowserTools


class BrowserToolChecks(unittest.IsolatedAsyncioTestCase):
    async def test_visual_actions_are_scoped_fresh_and_never_arbitrary_scripts(self):
        from playwright.async_api import async_playwright
        with tempfile.TemporaryDirectory() as directory:
            async with async_playwright() as pw:
                try:
                    browser = await pw.chromium.launch(channel='msedge', headless=True)
                except Exception:
                    self.skipTest('Edge unavailable for visual-tool DOM test')
                context = await browser.new_context(viewport={'width': 900, 'height': 700})
                page = await context.new_page()
                await page.route('**/*', lambda route: route.fulfill(body='<meta charset="utf-8"><title>验证码中间页</title><button onclick="this.textContent=\'已选择\'">点击两个形状相同的物体</button>', content_type='text/html; charset=utf-8'))
                await page.goto('https://www.douyin.com/search/local-test')
                tools = BrowserTools(SimpleNamespace(_context=context), directory)
                observation = await tools.observe()
                self.assertTrue(observation['challenge'])
                self.assertTrue((Path(directory) / 'evidence' / observation['screenshotUrl'].split('/')[-1]).is_file())
                with self.assertRaises(ValueError):
                    await tools.act({'observationId': observation['observationId'], 'action': 'evaluate', 'x': 10, 'y': 10})
                with self.assertRaises(ValueError):
                    await tools.act({'observationId': observation['observationId'], 'action': 'click', 'x': -1, 'y': 10})
                after = await tools.act({'observationId': observation['observationId'], 'action': 'click', 'x': 20, 'y': 16})
                self.assertNotEqual(after['observationId'], observation['observationId'])
                self.assertEqual(await page.locator('button').inner_text(), '已选择')
                with self.assertRaises(ValueError):
                    await tools.act({'observationId': observation['observationId'], 'action': 'click', 'x': 10, 'y': 10})
                await page.set_content('<title>登录抖音</title><input placeholder="密码">')
                self.assertFalse((await tools.observe())['challenge'])
                await browser.close()
