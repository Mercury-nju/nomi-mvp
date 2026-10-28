"""Visible-browser Douyin adapter. No private endpoints, cookies, or fake receipts.

One persistent browser identity is owned by this adapter. Callers serialize operations.
Selectors are deliberately centralized: platform UI changes fail visibly, never simulate success.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlsplit, urljoin


def now():
    return datetime.now(timezone.utc).isoformat()


def douyin_url(value: str, kind: str | None = None) -> str:
    """Allow only real public platform navigation, never arbitrary URLs or credentials."""
    parsed = urlsplit(value or '')
    host = (parsed.hostname or '').lower()
    if parsed.scheme != 'https' or host not in {'douyin.com', 'www.douyin.com', 'live.douyin.com'} or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError('请填写 https://www.douyin.com 或 https://live.douyin.com 的公开链接。')
    if kind == 'profile' and not parsed.path.startswith('/user/'):
        raise ValueError('请填写抖音用户主页链接。')
    if kind == 'live' and (host != 'live.douyin.com' or not re.fullmatch(r'/\d+/?', parsed.path)):
        raise ValueError('请填写直播间链接，例如 https://live.douyin.com/29206553569。')
    return value


def profile_id(url):
    m = re.search(r'/user/([^/?#]+)', url or '')
    return m.group(1) if m else ''


def stable_id(*parts):
    return hashlib.sha256('\x1f'.join(str(p) for p in parts).encode()).hexdigest()[:24]


def text_with_emoji_script():
    return """el => { const walk=n=>n.nodeType===Node.TEXT_NODE?n.textContent:n.nodeType===Node.ELEMENT_NODE?(n.tagName==='IMG'?(n.alt||''):Array.from(n.childNodes).map(walk).join('')):'';return walk(el).trim(); }"""


class DouyinAdapter:
    LIVE_ROWS = '.webcast-chatroom___item-wrapper'
    LIVE_NAME = '.v8LY0gZF'
    LIVE_TEXT = '.cL385mHb'
    LIVE_CARD = '.NZ4dNxK4'
    COMMENT_ROWS = '[data-e2e="comment-item"]'
    COMMENT_TEXT = '[data-e2e="comment-content"], .comment-item-info-wrap + div'
    COMMENT_AUTHOR = '.comment-item-info-wrap a[href*="/user/"]'
    WORK_LINKS = 'a[href*="/video/"], a[href*="/note/"]'

    def __init__(self, data_dir):
        self.data_dir = Path(data_dir).resolve()
        self.evidence = self.data_dir / 'evidence'
        self.evidence.mkdir(parents=True, exist_ok=True)
        self.profile = Path(os.environ.get('NOMI_BROWSER_PROFILE', self.data_dir / 'browser-profile')).resolve()
        self._pw = None
        self._context = None
        self._browser = None
        self._external = False
        self._login_page = None
        self._live_pages = {}
        self._own_name = ''
        self._state = {'status': 'worker_offline', 'connected': False, 'reason': '浏览器尚未启动。'}

    async def _ensure(self):
        if self._context:
            try:
                _ = self._context.pages
                return self._context
            except Exception:
                self._context = None
        from playwright.async_api import async_playwright
        self._pw = self._pw or await async_playwright().start()
        cdp = os.environ.get('NOMI_BROWSER_CDP', '').strip()
        if cdp:
            # CDP is operator configuration, restricted to loopback.
            u = urlsplit(cdp)
            if u.scheme != 'http' or u.hostname not in ('127.0.0.1', 'localhost'):
                raise ValueError('NOMI_BROWSER_CDP 仅支持本机浏览器地址。')
            self._browser = await self._pw.chromium.connect_over_cdp(cdp)
            if not self._browser.contexts:
                raise RuntimeError('浏览器没有可用会话。')
            self._context = self._browser.contexts[0]
            self._external = True
        else:
            self.profile.mkdir(parents=True, exist_ok=True)
            self._context = await self._pw.chromium.launch_persistent_context(
                str(self.profile), channel=os.environ.get('NOMI_BROWSER_CHANNEL', 'msedge'),
                headless=False, viewport={'width': 1440, 'height': 960},
            )
        self._context.set_default_timeout(7000)
        return self._context

    async def _page(self, url=None):
        context = await self._ensure()
        if url and urlsplit(url).path.startswith('/search/'):
            for existing in context.pages:
                if existing.url == url and not existing.is_closed():
                    await self._guard(existing)
                    return existing
        page = await context.new_page()
        if url:
            await page.goto(douyin_url(url), wait_until='domcontentloaded', timeout=45000)
            await page.wait_for_timeout(1500)
            douyin_url(page.url)
            await self._guard(page)
        return page

    async def _guard(self, page):
        # Challenges are never solved or bypassed by automation.
        title = await page.title()
        if any(x in title for x in ['验证码', '安全验证', '验证中间页']):
            await page.bring_to_front()
            raise RuntimeError('抖音要求手动完成验证码，请在已打开浏览器完成后重试；没有绕过验证。')
        body = (await page.locator('body').inner_text())[:18000]
        if any(x in body for x in ['请完成下列验证', '请完成安全验证', '拖动滑块完成拼图', '验证后继续访问']):
            raise RuntimeError('页面需要手动完成验证，请在浏览器完成后重新运行。')
        if any(x in body for x in ['该账号已被封禁', '账号已注销']):
            raise RuntimeError('该公开账号不可访问，已停止此操作。')
        return body

    async def status(self):
        if not self._context:
            return self._state
        try:
            page = self._login_page
            if not page or page.is_closed():
                page = await self._page('https://www.douyin.com/')
                self._login_page = page
            # Look for an actual signed-in identity link or signed-in account menu.
            own = page.locator('a[href*="/user/self"], [data-e2e="user-info"] a[href*="/user/"], [data-e2e="user-avatar"]')
            login = page.get_by_text('登录', exact=True)
            own_visible = any([await own.nth(i).is_visible() for i in range(min(await own.count(), 5))])
            logged = own_visible and not (await login.count() and await login.first.is_visible())
            # Existing Douyin layout exposes "我的" as /user/self only after login.
            if logged and not self._own_name:
                own_page = await self._page('https://www.douyin.com/user/self')
                try:
                    await own_page.wait_for_timeout(1000)
                    title = own_page.locator('[data-e2e="user-info"] h1, [data-e2e="user-title"], [data-e2e="user-detail"] h1')
                    if await title.count():
                        self._own_name = (await title.first.inner_text()).strip()
                finally:
                    await own_page.close()
            logged = bool(logged and self._own_name)
            state = 'connected' if logged else 'login_required'
            self._state = {'status': state, 'connected': bool(logged), 'nickname': self._own_name, 'reason': '已检测到登录后的账号入口。' if logged else '请在浏览器手动登录；登录完成后刷新状态。'}
        except Exception:
            self._state = {'status': 'error', 'connected': False, 'reason': '无法检测浏览器登录状态，请重新打开登录窗口。'}
        return self._state

    async def login(self):
        await self._ensure()
        if not self._login_page or self._login_page.is_closed():
            self._login_page = await self._page('https://www.douyin.com/')
        await self._login_page.bring_to_front()
        button = self._login_page.get_by_text('登录', exact=True)
        if await button.count() and await button.first.is_visible():
            await button.first.click()
        return await self.status()

    async def disconnect(self):
        # Disconnect the worker; do not silently claim a platform sign-out or delete user credentials.
        await self.close()
        self._state = {'status': 'worker_offline', 'connected': False, 'reason': '已断开执行器，浏览器登录资料保留。'}
        return self._state

    async def close(self):
        if self._context and not self._external:
            try:
                await self._context.close()
            except Exception:
                pass
        if self._pw:
            await self._pw.stop()
        self._context = self._pw = self._browser = self._login_page = None

    async def _shot(self, page, label, locator=None):
        name = f'{int(time.time()*1000)}-{label}-{stable_id(page.url)[:6]}.png'
        try:
            await (locator or page).screenshot(path=str(self.evidence / name))
            return f'/api/evidence/{name}'
        except Exception:
            return None

    async def _emit(self, emit, **event):
        if emit:
            return await emit(event)

    async def discover(self, plan, emit, cancelled):
        if not (await self.status()).get('connected'):
            # First login is always explicit, never invent a connected account.
            raise RuntimeError('尚未确认抖音登录，请先连接账号并刷新状态。')
        source_type = plan.get('sourceType', 'keyword_comments')
        await self._emit(emit, type='step', name='打开抖音来源', status='running')
        if source_type == 'live_chat':
            return await self._live(plan, emit, cancelled)
        if source_type not in ('keyword_comments', 'account_comments'):
            raise ValueError('不支持的抖音来源类型。')
        return await self._comments(plan, emit, cancelled)

    async def _identity(self, page, source):
        url = douyin_url(page.url, 'profile')
        body = await self._guard(page)
        if any(x in body for x in ['私密账号', '该用户设置了隐私', '该账号已设为私密']):
            return None
        name = page.locator('[data-e2e="user-title"], [data-e2e="user-info"] h1')
        try:
            await name.first.wait_for(state='visible', timeout=7000)
        except Exception:
            return None
        nickname = (await name.first.inner_text()).strip()
        if not nickname:
            return None
        ident = profile_id(url)
        if not ident:
            return None
        info = page.locator('[data-e2e="user-info"]')
        profile_text = (await info.first.inner_text())[:3500] if await info.count() else nickname
        return {'platformId': ident, 'nickname': nickname or source.get('nickname', ''), 'profileUrl': url,
                'avatarUrl': '', 'profileText': profile_text, 'sources': [source], 'demo': False}

    async def _live(self, plan, emit, cancelled):
        room = douyin_url(plan.get('sourceUrl', ''), 'live')
        page = self._live_pages.get(room)
        if not page or page.is_closed():
            page = await self._page(room)
            self._live_pages[room] = page
        context = self._context
        result, seen = {}, set()
        target_limit = max(1, min(int(plan.get('limit', 10)), 100))
        limit = max(1, min(int(plan.get('scanLimit', 100)), 500))
        matched_count = 0
        seconds = max(5, min(int(plan.get('observeSeconds', 60)), 3600))
        deadline = time.monotonic() + seconds
        try:
            await page.wait_for_timeout(3000)
            body = await self._guard(page)
            if any(x in body for x in ['直播已结束', '主播暂未开播', '直播间不存在']):
                raise RuntimeError('直播间未开播或已经结束。')
            await self._emit(emit, type='step', name='观察直播弹幕', status='running', text=f'最多观察 {seconds} 秒；打开页面和主页解析耗时另计')
            while time.monotonic() < deadline and len(result) < limit and matched_count < target_limit and not cancelled():
                rows = page.locator(self.LIVE_ROWS)
                for i in range(await rows.count()):
                    if cancelled() or len(result) >= limit or matched_count >= target_limit or time.monotonic() >= deadline:
                        break
                    row = rows.nth(i)
                    try:
                        name_el = row.locator(self.LIVE_NAME)
                        content = row.locator(self.LIVE_TEXT)
                        if not await name_el.count() or not await content.count():
                            continue
                        nickname = (await name_el.inner_text()).strip().rstrip('：:')
                        text = await content.evaluate(text_with_emoji_script())
                        key = (nickname, text)
                        if not text or key in seen:
                            continue
                        # Virtualized chat rows can change between reads and clicks.
                        # Re-check the exact observed row before associating any identity.
                        if (await name_el.inner_text()).strip().rstrip('：:') != nickname or await content.evaluate(text_with_emoji_script()) != text:
                            continue
                        row_shot = await self._shot(page, 'live-source', row)
                        if (await name_el.inner_text()).strip().rstrip('：:') != nickname or await content.evaluate(text_with_emoji_script()) != text:
                            continue
                        await name_el.click()
                        card = page.locator(self.LIVE_CARD)
                        await card.wait_for(state='visible')
                        card_name = card.locator('.user_name h3, .user_name').first
                        card_matches = False
                        for _ in range(6):
                            if await card_name.count() and (await card_name.inner_text()).strip() == nickname:
                                card_matches = True
                                break
                            await page.wait_for_timeout(150)
                        if not card_matches:
                            await self._emit(emit, type='warning', name='核对弹幕身份', status='failed', reason='弹幕与用户名片不一致，已跳过，不关联证据。')
                            await page.keyboard.press('Escape')
                            continue
                        card_text = await card.inner_text()
                        if any(x in card_text for x in ['私密账号', '隐私保护']):
                            await page.keyboard.press('Escape')
                            await self._emit(emit, type='warning', name='跳过隐私账号', status='completed', reason='用户名片表明隐私保护。')
                            continue
                        async with context.expect_page(timeout=7000) as popup:
                            # Recheck immediately before the avatar action as cards are reactive.
                            if (await card_name.inner_text()).strip() != nickname:
                                raise RuntimeError('用户名片已经变化')
                            await card.locator('.avatar').click()
                        profile = await popup.value
                        try:
                            await profile.wait_for_url('**/user/**', timeout=10000)
                            await profile.wait_for_load_state('domcontentloaded')
                            source = {'id': '', 'type': '直播弹幕', 'title': await page.title(),
                                      'url': room, 'platformId': room.rsplit('/', 1)[-1], 'text': text,
                                      'nickname': nickname, 'discoveredAt': now(), 'demo': False,
                                      'evidencePath': row_shot, 'roomUrl': room, 'channel': 'live_mention'}
                            customer = await self._identity(profile, source)
                            if not customer or customer['nickname'].strip() != nickname:
                                await self._emit(emit, type='warning', name='核对公开主页身份', status='failed', reason='主页昵称与原弹幕及名片不一致，已跳过，不关联证据。')
                                continue
                            ident = customer['platformId']
                            source['id'] = stable_id(room, ident, text)
                            seen.add(key)
                            if ident in result:
                                if not any(s['id'] == source['id'] for s in result[ident]['sources']):
                                    result[ident]['sources'].append(source)
                            else:
                                result[ident] = customer
                                verdict = await self._emit(emit, type='candidate', name='识别公开发言者', status='completed', customer=customer)
                                if verdict is True or isinstance(verdict, dict) and verdict.get('matched'):
                                    matched_count += 1
                        finally:
                            await profile.close()
                            await page.bring_to_front()
                            await page.keyboard.press('Escape')
                    except Exception:
                        await self._emit(emit, type='warning', name='读取一条弹幕', status='failed', reason='该发言或名片已变化，跳过此条。')
                await page.wait_for_timeout(1200)
            await self._emit(emit, type='step', name='观察直播弹幕', status='completed', text=f'取得 {len(result)} 位公开发言者')
            return list(result.values())
        finally:
            # Keep the observed room open so native @ can still target its buffered source.
            pass

    async def _work_urls(self, page, limit=10):
        urls = []
        for _ in range(4):
            values = await page.locator(self.WORK_LINKS).evaluate_all('(es)=>es.map(e=>e.href)')
            for value in values:
                try:
                    douyin_url(value)
                    if value not in urls:
                        urls.append(value)
                except ValueError:
                    pass
            if len(urls) >= limit:
                break
            await page.mouse.wheel(0, 700)
            await page.wait_for_timeout(1000)
        return urls[:limit]

    async def _comments(self, plan, emit, cancelled):
        target_limit = max(1, min(int(plan.get('limit', 10)), 100))
        limit = max(1, min(int(plan.get('scanLimit', 100)), 500))
        matched_count = 0
        keyword_list = [str(x).strip() for x in plan.get('keywords', []) if str(x).strip()]
        if plan.get('sourceType') == 'account_comments':
            start_url = douyin_url(plan.get('sourceUrl', ''), 'profile')
        else:
            if not keyword_list:
                raise ValueError('关键词搜索任务至少需要一个关键词。')
            start_url = 'https://www.douyin.com/search/' + quote(' '.join(keyword_list)) + '?type=video'
        page = await self._page(start_url)
        result = {}
        try:
            await page.wait_for_timeout(3000)
            body = await self._guard(page)
            if '私密账号' in body:
                await self._emit(emit, type='warning', name='隐私账号', status='completed', reason='已跳过私密账号。')
                return []
            urls = await self._work_urls(page, max(1, min(int(plan.get('maxWorks', 10)), 50)))
            if not urls:
                raise RuntimeError('未在可见页面取得作品链接。请检查登录、验证或搜索条件；没有生成替代结果。')
            await self._emit(emit, type='step', name='搜索并筛选公开作品', status='completed', text=f'取得 {len(urls)} 个公开作品入口')
            for work_url in urls:
                if cancelled() or len(result) >= limit or matched_count >= target_limit:
                    break
                work = await self._page(work_url)
                try:
                    await work.wait_for_timeout(1800)
                    title_el = work.locator('[data-e2e="video-desc"]')
                    title = (await title_el.first.inner_text()) if await title_el.count() else await work.title()
                    # Visible title relevance, optional explicit terms; no invented filter outcomes.
                    terms = plan.get('workKeywords') or []
                    if terms and not any(str(t).lower() in title.lower() for t in terms):
                        continue
                    comment_button = work.locator('[data-e2e="comment-icon"], [data-e2e="feed-comment-icon"]')
                    if not await work.locator(self.COMMENT_ROWS).count():
                        for n in range(await comment_button.count()):
                            if await comment_button.nth(n).is_visible():
                                await comment_button.nth(n).click()
                                break
                    await work.wait_for_timeout(1200)
                    rows = work.locator(self.COMMENT_ROWS)
                    if not await rows.count():
                        await self._emit(emit, type='warning', name='读取作品评论', status='failed', reason='该作品没有可见评论或评论结构已变化。')
                        continue
                    seen_comments = set()
                    max_comments = max(1, min(int(plan.get('maxComments', 50)), 500))
                    for turn in range(max(3, min(20, max_comments // 15 + 1))):
                        rows = work.locator(self.COMMENT_ROWS)
                        for i in range(min(await rows.count(), max_comments)):
                            if cancelled() or len(result) >= limit or matched_count >= target_limit or len(seen_comments) >= max_comments:
                                break
                            row = rows.nth(i)
                            link = row.locator(self.COMMENT_AUTHOR).first
                            if not await link.count():
                                continue
                            profile_url = await link.get_attribute('href')
                            if profile_url:
                                profile_url = urljoin(work.url, profile_url)
                            try:
                                douyin_url(profile_url, 'profile')
                            except ValueError:
                                continue
                            ident = profile_id(profile_url)
                            text_el = row.locator(self.COMMENT_TEXT)
                            if not await text_el.count():
                                # Scoped row text preserves evidence but does not claim author metadata is comment text.
                                await self._emit(emit, type='warning', name='评论原文解析', status='failed', reason='无法定位评论原文，跳过该条。')
                                continue
                            text = await text_el.first.evaluate(text_with_emoji_script())
                            if not text:
                                continue
                            tooltip = row.locator('[id^="tooltip_"]').first
                            native_comment_id = await row.get_attribute('data-id') or ((await tooltip.get_attribute('id')).removeprefix('tooltip_') if await tooltip.count() else None)
                            source_id = native_comment_id or stable_id(work_url, ident, text)
                            if source_id in seen_comments:
                                continue
                            seen_comments.add(source_id)
                            source = {'id': source_id, 'type': '作品评论', 'title': title, 'url': work_url,
                                      'platformId': urlsplit(work_url).path.rsplit('/', 1)[-1], 'text': text,
                                      'nickname': (await link.inner_text()).strip(), 'discoveredAt': now(), 'demo': False,
                                      'evidencePath': await self._shot(work, 'comment-source', row),
                                      'commentId': native_comment_id, 'commentText': text,
                                      'commentAuthorId': ident, 'channel': 'video_comment'}
                            if ident in result:
                                if not any(s['id'] == source_id for s in result[ident]['sources']):
                                    result[ident]['sources'].append(source)
                                continue
                            profile = await self._page(profile_url)
                            try:
                                customer = await self._identity(profile, source)
                                if customer and customer['platformId'] == ident and customer['nickname'] == source['nickname']:
                                    result[ident] = customer
                                    verdict = await self._emit(emit, type='candidate', name='解析评论者公开主页', status='completed', customer=customer)
                                    if verdict is True or isinstance(verdict, dict) and verdict.get('matched'):
                                        matched_count += 1
                            finally:
                                await profile.close()
                        if cancelled() or len(result) >= limit or matched_count >= target_limit or len(seen_comments) >= max_comments:
                            break
                        if await rows.count():
                            await rows.last.scroll_into_view_if_needed()
                            await work.mouse.wheel(0, 650)
                            await work.wait_for_timeout(900)
                finally:
                    await work.close()
            await self._emit(emit, type='step', name='读取评论与公开主页', status='completed', text=f'取得 {len(result)} 位公开评论者')
            return list(result.values())
        finally:
            await page.close()

    async def send(self, customer, text, channel, before_submit=None):
        text = (text or '').strip()
        if not text or len(text) > 500:
            raise ValueError('消息必须为 1–500 个字符。')
        if channel not in ('dm', 'live_mention', 'video_comment'):
            raise ValueError('无效的触达渠道。')
        if not (await self.status()).get('connected'):
            return {'status': 'failed', 'text': text, 'at': now(), 'channel': channel, 'reason': '登录状态未确认，没有发送。'}
        if channel == 'dm':
            return await self._dm(customer, text, before_submit=before_submit)
        if channel == 'live_mention':
            return await self._mention(customer, text)
        return await self._reply_comment(customer, text)

    def _receipt(self, status, text, channel, reason, evidence=None):
        return {'status': status, 'text': text, 'at': now(), 'channel': channel, 'reason': reason,
                'evidencePath': evidence, 'confirmationLevel': 'visible_page' if status == 'success' else 'unconfirmed'}

    async def _verify_dm_identity(self, page, customer, expected_id):
        # Nicknames may be stale or differ in IM (emoji/nonbreaking spaces).
        # Bind the visible editor's own header to a stable public profile ID.
        if not expected_id:
            return False
        box = page.locator('[contenteditable=true].messageEditorinputArea:visible')
        if await box.count() != 1:
            return False
        # The native header is a sibling of componentsRightPanelwrapper,
        # inside the same page root/dialog as the visible editor.
        panel = box.locator('xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," StackLayoutpagespageRoot ")][1]')
        if not await panel.count():
            panel = box.locator('xpath=ancestor::*[@data-e2e="im-dialog"][1]')
        if await panel.count() != 1:
            return False
        header = panel.locator('.StackLayoutStackChatHeaderuser:visible')
        if await header.count() != 1:
            return False
        title = header.locator('.StackLayoutStackChatHeadertitle:visible')
        if await title.count() != 1:
            return False
        title_text = (await title.inner_text()).strip()
        if not title_text:
            return False
        links = header.locator('a[href*="/user/"]:visible')
        if await links.count():
            hrefs = [urljoin(page.url, await links.nth(i).get_attribute('href') or '') for i in range(await links.count())]
            try:
                for href in hrefs:
                    douyin_url(href, 'profile')
            except ValueError:
                return False
            return {profile_id(href) for href in hrefs} == {expected_id}
        avatar = header.locator('[data-apm-action="个人页卡片"]:visible')
        if await avatar.count() != 1:
            return False
        # Compare the same visible collection before/after: hidden pre-existing
        # profile links must neither establish identity nor mask a native card.
        visible_links = 'a[href*="/user/"]:visible'
        counts_before = await page.locator(visible_links).evaluate_all('(es)=>es.map(e=>e.href)')
        original_url = page.url
        original_pages = set(page.context.pages)
        opened = []
        def remember(popup):
            opened.append(popup)
        page.context.on('page', remember)
        verified = False
        try:
            await avatar.click()
            for _ in range(50):
                for popup in opened:
                    if popup.is_closed() or '/user/' not in popup.url:
                        continue
                    try:
                        douyin_url(popup.url, 'profile')
                    except ValueError:
                        return False
                    verified = profile_id(popup.url) == expected_id
                    return verified
                # Native avatars sometimes navigate the same tab. Restore it
                # before returning; no text may be entered on the profile page.
                if page.url != original_url and '/user/' in page.url:
                    try:
                        douyin_url(page.url, 'profile')
                        verified = profile_id(page.url) == expected_id
                    except ValueError:
                        verified = False
                    await page.go_back(wait_until='domcontentloaded', timeout=10000)
                    if page.url != original_url:
                        return False
                    try:
                        await box.wait_for(state='visible', timeout=5000)
                    except Exception:
                        return False
                    return verified and await header.count() == 1 and (await title.inner_text()).strip() == title_text
                after = await page.locator(visible_links).evaluate_all('(es)=>es.map(e=>e.href)')
                added = [href for href in set(after) if after.count(href) > counts_before.count(href)]
                if added:
                    try:
                        for href in added:
                            douyin_url(href, 'profile')
                    except ValueError:
                        return False
                    verified = {profile_id(href) for href in added} == {expected_id}
                    if verified:
                        # Focus the editor to dismiss a native profile card;
                        # Escape can close the entire conversation on Douyin.
                        await box.click()
                    return verified
                await page.wait_for_timeout(100)
            return False
        except Exception:
            return False
        finally:
            page.context.remove_listener('page', remember)
            for popup in opened:
                if popup not in original_pages and not popup.is_closed():
                    await popup.close()
            if not page.is_closed():
                await page.bring_to_front()

    async def _dm(self, customer, text, before_submit=None):
        page = await self._page(douyin_url(customer.get('profileUrl', ''), 'profile'))
        attempted = False
        try:
            body = await self._guard(page)
            if '私密账号' in body:
                return self._receipt('failed', text, 'dm', '隐私账号已跳过，没有发送。')
            button = page.get_by_text('私信', exact=True)
            if not await button.count():
                return self._receipt('failed', text, 'dm', '该主页未提供私信入口。')
            expected_id = customer.get('platformId') or profile_id(customer.get('profileUrl', ''))
            if profile_id(page.url) != expected_id:
                return self._receipt('failed', text, 'dm', '当前主页平台标识与目标不一致，未发送。')
            # The profile control paints before the IM handlers finish mounting.
            # Allow hydration, then click once: clicking a second time can close
            # the very conversation that is still opening.
            await page.wait_for_timeout(2500)
            # Always reselect through the verified source profile, even if an old editor exists.
            await button.last.click()
            box = page.locator('[contenteditable=true].messageEditorinputArea:visible')
            try:
                await box.wait_for(state='visible', timeout=15000)
            except Exception:
                pass
            if not await box.count():
                return self._receipt('failed', text, 'dm', '未打开该用户的私信输入框。', await self._shot(page, 'dm-no-editor'))
            panel = box.locator('xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," componentsRightPanelwrapper ")][1]')
            if not await panel.count():
                panel = box.locator('xpath=ancestor::*[@data-e2e="im-dialog"][1]')
            if not await panel.count():
                return self._receipt('failed', text, 'dm', '无法定位独立私信会话面板，未发送。')
            if not await self._verify_dm_identity(page, customer, expected_id):
                return self._receipt('failed', text, 'dm', '无法核对会话标题及公开主页平台标识，未发送。', await self._shot(page, 'dm-identity'))
            from .inbox_adapter import read_message_rows
            snapshot = await read_message_rows(panel, expected_id)
            # The editor and identity can be ready before the native message
            # list/system notice. Do not confuse this transition with a loaded
            # empty thread, and never submit until the reader confirms it.
            for _ in range(12):
                if snapshot.get('complete'):
                    break
                await page.wait_for_timeout(500)
                snapshot = await read_message_rows(panel, expected_id)
            if not snapshot.get('complete'):
                return self._receipt('failed', text, 'dm', '发送前消息窗口尚未核实，未提交消息。', await self._shot(page, 'dm-unverified', panel))
            before = sum(m['direction'] == 'outbound' and m.get('text') == text for m in snapshot['messages'])
            # Only newly appearing visible status notices count as failure. Old
            # notices or the peer's quoted message text must not override this send.
            failure_script = r"""panel => {
                const counts = {};
                const content = '.MessageItemTextbubbleTextContent, [data-e2e="message-content"], [data-message-content], .messageItemcontent, .message-content, [class*="messageTextContent"]';
                for (const el of panel.querySelectorAll('*')) {
                    if (!el.getClientRects().length || getComputedStyle(el).visibility === 'hidden' || el.closest(content)) continue;
                    const value = el.innerText?.trim() || '';
                    if (!value || value.length > 100 || !/发送失败|无法发送|对方设置|消息发送频繁/.test(value)) continue;
                    if (Array.from(el.children).some(child => /发送失败|无法发送|对方设置|消息发送频繁/.test(child.innerText || ''))) continue;
                    counts[value] = (counts[value] || 0) + 1;
                }
                return counts;
            }"""
            failures_before = await panel.evaluate(failure_script)
            await box.fill(text)
            if before_submit is not None and not before_submit():
                await box.fill('')
                return self._receipt('failed', text, 'dm', '会话已更新、已接管或监听已关闭，提交前已取消，没有发送。')
            attempted = True
            # Placeholder disappears after editing; use stable contenteditable class.
            await box.press('Enter')
            for _ in range(10):
                await page.wait_for_timeout(600)
                snapshot = await read_message_rows(panel, expected_id)
                outgoing = sum(m['direction'] == 'outbound' and m.get('text') == text for m in snapshot['messages'])
                failures_after = await panel.evaluate(failure_script)
                if any(count > failures_before.get(notice, 0) for notice, count in failures_after.items()):
                    return self._receipt('failed', text, 'dm', '平台显示本次消息发送受限或失败。', await self._shot(page, 'dm-failed', panel))
                if snapshot.get('complete') and outgoing > before and not (await box.inner_text()).replace('\u200b', '').strip():
                    shot = await self._shot(page, 'dm', panel)
                    return self._receipt('success', text, 'dm', '目标会话中出现完整消息；仅确认页面显示已发送，未确认送达或已读。', shot)
            return self._receipt('unknown', text, 'dm', '已提交但没有取得明确页面确认，不自动重发。', await self._shot(page, 'dm-unknown', panel))
        except Exception:
            return self._receipt('unknown' if attempted else 'failed', text, 'dm', '发送后确认中断，不自动重发。' if attempted else '私信页面结构或状态发生变化，没有提交消息。')
        finally:
            await page.close()

    async def _mention(self, customer, text):
        source = next((s for s in reversed(customer.get('sources', [])) if s.get('roomUrl') or s.get('type') == '直播弹幕'), None)
        if not source:
            return self._receipt('failed', text, 'live_mention', '缺少来源直播弹幕，无法回复。')
        room = douyin_url(source.get('roomUrl') or source['url'], 'live')
        page = self._live_pages.get(room)
        if not page or page.is_closed():
            page = await self._page(room)
            self._live_pages[room] = page
        attempted = False
        try:
            await page.wait_for_timeout(2500)
            rows = page.locator(self.LIVE_ROWS)
            target_row = None
            for i in range(await rows.count()):
                row = rows.nth(i)
                name = row.locator(self.LIVE_NAME)
                content = row.locator(self.LIVE_TEXT)
                if await name.count() and await content.count() and (await name.inner_text()).strip().rstrip('：:') == source.get('nickname', customer.get('nickname')) and await content.evaluate(text_with_emoji_script()) == source['text']:
                    target_row = row
                    break
            if target_row is None:
                return self._receipt('failed', text, 'live_mention', '来源弹幕已离开可见列表，无法安全定位原发言者；未发送。')
            await target_row.locator(self.LIVE_NAME).click()
            card = page.locator(self.LIVE_CARD)
            await card.wait_for(state='visible')
            # Resolve card avatar to stable profile ID before mentioning (nicknames are not identities).
            context = self._context
            before_pages = set(context.pages)
            await card.locator('.avatar').click()
            opened = []
            for _ in range(20):
                opened = [p for p in context.pages if p not in before_pages and '/user/' in p.url]
                if opened:
                    break
                await page.wait_for_timeout(200)
            if not opened:
                return self._receipt('failed', text, 'live_mention', '无法核对发言者主页，未发送。')
            ident = profile_id(opened[-1].url)
            await opened[-1].close()
            if ident != customer.get('platformId'):
                return self._receipt('failed', text, 'live_mention', '原发言者身份与目标平台标识不一致，未发送。')
            if not await card.is_visible():
                await target_row.locator(self.LIVE_NAME).click()
            await card.locator('.mention').click()
            box = page.locator('[contenteditable=true]')
            mention = (await box.inner_text()).replace('\u200b', '').strip()
            if not mention.startswith('@'):
                return self._receipt('failed', text, 'live_mention', '未取得原生 @ 引用，未发送。')
            await box.press('Control+End')
            await box.press_sequentially(' ' + text, delay=15)
            attempted = True
            await box.press('Enter')
            for _ in range(15):
                await page.wait_for_timeout(700)
                matches = page.locator(self.LIVE_ROWS).filter(has_text=text)
                if await matches.count() and not (await box.inner_text()).replace('\u200b', '').strip():
                    visible = await matches.last.inner_text()
                    if mention in visible and self._own_name and visible.startswith(self._own_name + '：'):
                        return self._receipt('success', mention + ' ' + text, 'live_mention', '聊天区出现完整原生 @ 回复；未确认对方收到通知或阅读。', await self._shot(page, 'live-reply', matches.last))
            return self._receipt('unknown', text, 'live_mention', '提交后未取得完整弹幕确认，不自动重发。', await self._shot(page, 'live-reply-unknown'))
        except Exception:
            return self._receipt('unknown' if attempted else 'failed', text, 'live_mention', '弹幕状态变化，结果待确认；不自动重发。' if attempted else '无法定位原发言者，没有提交消息。')
        finally:
            pass  # Preserve the observed live room, including its native source context.

    async def _reply_comment(self, customer, text):
        source = next((s for s in reversed(customer.get('sources', [])) if s.get('type') == '作品评论'), None)
        if not source:
            return self._receipt('failed', text, 'video_comment', '缺少来源作品评论，无法回复。')
        page = await self._page(douyin_url(source['url']))
        attempted = False
        try:
            button = page.locator('[data-e2e="comment-icon"], [data-e2e="feed-comment-icon"]')
            if not await page.locator(self.COMMENT_ROWS).count():
                for n in range(await button.count()):
                    if await button.nth(n).is_visible():
                        await button.nth(n).click()
                        break
            await page.wait_for_timeout(1800)
            target = None
            rows = page.locator(self.COMMENT_ROWS)
            for i in range(await rows.count()):
                row = rows.nth(i)
                link = row.locator(self.COMMENT_AUTHOR).first
                content = row.locator(self.COMMENT_TEXT).first
                if await link.count() and await content.count():
                    href = await link.get_attribute('href')
                    if profile_id(href) == customer.get('platformId') and await content.evaluate(text_with_emoji_script()) == source['text']:
                        target = row
                        break
            if target is None:
                return self._receipt('failed', text, 'video_comment', '未找到与原文及平台标识同时匹配的评论，未发送。')
            reply = target.get_by_text('回复', exact=True)
            if not await reply.count():
                return self._receipt('failed', text, 'video_comment', '该评论没有可用回复入口。')
            await reply.first.click()
            box = page.locator('[contenteditable=true][data-e2e="comment-input"], [data-e2e="comment-input"] [contenteditable=true], [contenteditable=true][data-placeholder*="回复"], .public-DraftEditor-content[contenteditable=true]')
            if not await box.count():
                return self._receipt('failed', text, 'video_comment', '无法定位定向回复输入框，未发送。')
            reply_context = await box.first.get_attribute('data-placeholder') or await box.first.get_attribute('placeholder') or ''
            described_by = await box.first.get_attribute('aria-describedby')
            if not reply_context and described_by and re.fullmatch(r'[A-Za-z0-9_-]+', described_by):
                placeholder = page.locator('#' + described_by)
                if await placeholder.count():
                    reply_context = await placeholder.inner_text()
            if source.get('nickname'):
                target_label = r'\s*回复\s*@?\s*' + re.escape(source['nickname']) + r'\s*[:：]?\s*'
                # An explicit target that disagrees is definitive; unrelated page text
                # must never override it (the editor's parent may be the entire body).
                if reply_context:
                    if not re.fullmatch(target_label, reply_context):
                        return self._receipt('failed', text, 'video_comment', '无法核对输入框正在回复指定用户，未发送。')
                else:
                    parent = box.first.locator('xpath=..')
                    tag = await parent.evaluate('(el)=>el.tagName')
                    nearby = await parent.inner_text()
                    if tag in ('BODY', 'HTML') or len(nearby) > 500 or not any(re.fullmatch(target_label, line) for line in nearby.splitlines()):
                        return self._receipt('failed', text, 'video_comment', '无法核对输入框正在回复指定用户，未发送。')
            before = await rows.filter(has_text=text).count()
            await box.first.fill(text)
            attempted = True
            await box.first.press('Enter')
            for _ in range(12):
                await page.wait_for_timeout(700)
                matches = page.locator(self.COMMENT_ROWS).filter(has_text=text)
                owned = matches.filter(has=page.locator('a[href*="/user/"]', has_text=self._own_name)) if self._own_name else None
                if owned is not None and await owned.count() and await matches.count() > before and not (await box.first.inner_text()).replace('\u200b', '').strip():
                    return self._receipt('success', text, 'video_comment', '评论区出现新回复文本；仅确认页面显示，未确认已读。', await self._shot(page, 'comment-reply', matches.last))
            return self._receipt('unknown', text, 'video_comment', '已提交但没有取得明确回复记录，不自动重发。', await self._shot(page, 'comment-reply-unknown'))
        except Exception:
            return self._receipt('unknown' if attempted else 'failed', text, 'video_comment', '评论回复状态未确认，不自动重发。' if attempted else '评论回复页面不可用，没有提交消息。')
        finally:
            await page.close()
