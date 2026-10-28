"""A narrow visual-tool surface for an operator or a vision-capable agent.

Only an observed public Douyin verification page can be clicked or dragged.
No arbitrary scripts, passwords, filesystem access, or communication tools.
Rule-mode planning does not pretend to understand verification images.
"""
import asyncio
import secrets
import time
from pathlib import Path

from .adapter import douyin_url


class BrowserTools:
    def __init__(self, adapter, data_dir):
        self.adapter = adapter
        self.directory = Path(data_dir) / 'evidence'
        self.directory.mkdir(parents=True, exist_ok=True)
        self.observation = None

    async def _challenge(self, page):
        if page.is_closed():
            return False
        try:
            douyin_url(page.url)
            title = await page.title()
            if '验证码' in title or '安全验证' in title:
                return True
            # Exact challenge instructions only; a normal login dialog is not a
            # verification challenge and must never become an input surface.
            for frame in page.frames:
                text = (await frame.locator('body').inner_text(timeout=1500))[:3000]
                if any(x in text for x in ('点击两个形状相同的物体', '拖动滑块完成拼图', '请完成下列验证')):
                    return True
        except Exception:
            return False
        return False

    async def observe(self):
        self.observation = None
        context = getattr(self.adapter, '_context', None)
        if not context:
            return {'challenge': False, 'availableActions': [], 'message': '请先连接抖音浏览器。'}
        pages = list(context.pages)
        for page in reversed(pages):
            if not await self._challenge(page):
                continue
            await page.bring_to_front()
            identity = secrets.token_urlsafe(18)
            name = f'visual-{identity}.png'
            size = await page.evaluate('({width:innerWidth,height:innerHeight})')
            await page.screenshot(path=str(self.directory / name), scale='css')
            self.observation = {'id': identity, 'page': page, 'at': time.monotonic(), 'url': page.url, **size}
            return {'observationId': identity, 'screenshotUrl': f'/api/evidence/{name}', 'title': await page.title(),
                    'url': page.url, **size, 'challenge': True, 'availableActions': ['click', 'drag'],
                    'message': '根据当前画面操作；每次操作后会重新观察。'}
        return {'challenge': False, 'availableActions': [], 'message': '当前没有待处理的验证页面。验证通过后可以重新执行原任务。'}

    async def act(self, action):
        old = self.observation
        if not old or not secrets.compare_digest(str(action.get('observationId', '')), old['id']):
            raise ValueError('画面已更新，请先重新查看页面。')
        if time.monotonic() - old['at'] > 120:
            self.observation = None
            raise ValueError('画面已过期，请重新查看后操作。')
        page = old['page']
        if page.is_closed() or page.url != old['url'] or not await self._challenge(page):
            self.observation = None
            raise ValueError('页面已变化，不再执行旧画面中的操作。')
        kind = action.get('action')
        if kind not in ('click', 'drag'):
            raise ValueError('页面处理仅支持点击和拖动。')
        def point(x_key, y_key):
            x, y = action.get(x_key), action.get(y_key)
            if isinstance(x, bool) or isinstance(y, bool) or not isinstance(x, (float, int)) or not isinstance(y, (float, int)):
                raise ValueError('请提供有效的画面坐标。')
            if not (0 <= x < old['width'] and 0 <= y < old['height']):
                raise ValueError('操作超出当前画面。')
            return x, y
        start = point('x', 'y')
        end = point('toX', 'toY') if kind == 'drag' else None
        # Invalidate before input. A client timeout must not repeat an action.
        self.observation = None
        await page.bring_to_front()
        if kind == 'click':
            await page.mouse.click(*start)
        else:
            await page.mouse.move(*start)
            await page.mouse.down()
            try:
                for step in range(1, 25):
                    fraction = step / 24
                    await page.mouse.move(start[0] + (end[0] - start[0]) * fraction, start[1] + (end[1] - start[1]) * fraction)
                    await asyncio.sleep(.05)
            finally:
                await page.mouse.up()
        await asyncio.sleep(.7)
        return await self.observe()
