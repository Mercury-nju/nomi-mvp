"""Read-only, selected-customer DM observations through the visible Douyin UI.

The caller owns the browser lock. No endpoint interception or hidden IM API is used.
`complete` describes an unambiguous visible window, never an entire chat history.
Unknown layouts/directions fail closed instead of turning arbitrary panel text into
an inbound message. Row selectors require validation when Douyin changes its UI.
"""
from __future__ import annotations

from .adapter import douyin_url, profile_id, now


class InboxAdapter:
    def __init__(self, adapter):
        self.adapter = adapter

    async def read_thread(self, customer):
        result = {'identityVerified': False, 'messages': [], 'complete': False,
                  'windowOnly': True, 'observedAt': now(), 'reason': None}
        page = None
        try:
            if not (await self.adapter.status()).get('connected'):
                result['reason'] = '尚未确认抖音登录，未读取私信。'
                return result
            url = douyin_url(customer.get('profileUrl', ''), 'profile')
            expected_id = customer.get('platformId') or profile_id(url)
            if not expected_id or profile_id(url) != expected_id:
                result['reason'] = '客户主页与平台身份不一致，未读取私信。'
                return result
            page = await self.adapter._page(url)
            # Public profile controls can precede hydration of their IM action.
            await page.wait_for_timeout(2500)
            body = await self.adapter._guard(page)
            if '私密账号' in body:
                result['reason'] = '隐私账号已跳过。'
                return result
            if profile_id(page.url) != expected_id:
                result['reason'] = '当前主页身份与目标不一致，未读取私信。'
                return result
            button = page.get_by_text('私信', exact=True)
            if not await button.count():
                result['reason'] = '该主页没有可见私信入口。'
                return result
            await button.last.click()
            editor = page.locator('[contenteditable=true].messageEditorinputArea:visible')
            try:
                # A second click can toggle a still-loading IM panel closed.
                await editor.wait_for(state='visible', timeout=15000)
            except Exception:
                pass
            if not await editor.count():
                result['evidencePath'] = await self.adapter._shot(page, 'inbox-unopened')
                result['reason'] = '未打开私信会话，页面结构可能变化。'
                return result
            panel = editor.locator('xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," componentsRightPanelwrapper ")][1]')
            if not await panel.count():
                panel = editor.locator('xpath=ancestor::*[@data-e2e="im-dialog"][1]')
            if not await panel.count() or not await self.adapter._verify_dm_identity(page, customer, expected_id):
                result['reason'] = '无法核对独立会话与对端稳定身份，未读取消息。'
                return result
            result['identityVerified'] = True
            snapshot = await self.read_visible_window(panel, expected_id)
            # An editor can mount before its message list is initialized.
            # Wait for a recognized stable window, never infer an empty history.
            for _ in range(12):
                if snapshot.get('complete'):
                    break
                await page.wait_for_timeout(500)
                snapshot = await self.read_visible_window(panel, expected_id)
            if snapshot['complete'] and not snapshot['messages']:
                # Empty native windows require a second observation, rather than
                # treating a transient IM mount/loading frame as a baseline.
                await page.wait_for_timeout(500)
                snapshot = await self.read_visible_window(panel, expected_id)
            result['evidencePath'] = await self.adapter._shot(page, 'inbox', panel)
            result.update(snapshot)
            result['observedAt'] = now()
            return result
        except Exception as error:
            # Do not return raw Playwright exception text: it may contain entire DOM or
            # private message contents. The caller displays the scoped generic reason.
            result['reason'] = ('私信读取中断：验证页、登录失效或页面结构变化；未生成回复。'
                                if not isinstance(error, ValueError) else str(error))
            return result
        finally:
            if page:
                await page.close()

    @staticmethod
    async def read_visible_window(panel, expected_id):
        return await panel.evaluate(_READ_WINDOW, {'expectedId': expected_id})


async def read_message_rows(panel, expected_id):
    """Shared sender/receiver parser; returns {messages, complete, reason, windowOnly}."""
    return await InboxAdapter.read_visible_window(panel, expected_id)


_READ_WINDOW = r"""(panel, config) => {
  const visible = el => !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const rowSelector = '.messageMessageBoxmessageBox, [data-message-id], [data-msg-id], [data-e2e="im-message"], [data-e2e="message-item"], .messageItem, [class*="messageItemwrapper"], [class*="messageItemWrapper"], [class*="message-item-wrapper"]';
  // Prefer the outer message row; bubble nodes can repeat the same platform ID.
  const candidates = Array.from(panel.querySelectorAll(rowSelector)).filter(visible);
  let rows = candidates.filter(el => !candidates.some(other => other !== el && other.contains(el)));
  // Observed 2026-10-27: native message list is column-reverse, index 0 newest.
  const nativeList = panel.querySelector('.messageMessageListlist');
  if (nativeList && getComputedStyle(nativeList).flexDirection === 'column-reverse') rows.reverse();
  // Explicit system notices (including send restrictions) are not peer messages.
  const systemRows = rows.filter(row => row.classList.contains('messageMessageBoxisFullRowCenterMessage'));
  rows = rows.filter(row => !row.classList.contains('messageMessageBoxisFullRowCenterMessage'));
  const text = el => {
    const walk = node => node.nodeType === Node.TEXT_NODE ? node.textContent :
      node.nodeType === Node.ELEMENT_NODE ? (node.tagName === 'IMG' ? (node.alt || '') :
      Array.from(node.childNodes).map(walk).join('')) : '';
    return walk(el).trim();
  };
  const messages = [];
  let ambiguous = 0;
  let unsupported = 0;
  const knownDirections = new Map([['inbound','inbound'], ['received','inbound'], ['incoming','inbound'],
    ['outbound','outbound'], ['sent','outbound'], ['outgoing','outbound']]);
  for (const row of rows.slice(-200)) {
    const evidence = new Set();
    const explicit = knownDirections.get((row.getAttribute('data-direction') || '').toLowerCase());
    if (explicit) evidence.add(explicit);
    const self = row.getAttribute('data-is-self');
    if (self === 'true') evidence.add('outbound');
    if (self === 'false') evidence.add('inbound');
    const nativeBox = row.querySelector('.messageMessageBoxcontentBox');
    if (row.classList.contains('messageMessageBoxmessageBox') && nativeBox) {
      evidence.add(nativeBox.classList.contains('messageMessageBoxisFromMe') ? 'outbound' : 'inbound');
      // Two native markers must agree; layout changes fail closed.
      const nativeBubble = row.querySelector('.MessageBoxContentcolumnBox');
      if (nativeBubble) evidence.add(nativeBubble.classList.contains('MessageBoxContentisFromMe') ? 'outbound' : 'inbound');
    }
    // A peer avatar link is stronger than bubble alignment or a guessed color.
    const author = row.querySelector('[data-e2e="message-avatar"] a[href*="/user/"], a[data-e2e="message-avatar"][href*="/user/"], .message-avatar a[href*="/user/"]');
    if (author) {
      const match = (author.getAttribute('href') || '').match(/\/user\/([^/?#]+)/);
      if (match && match[1] === config.expectedId) evidence.add('inbound');
      if (match && match[1] === 'self') evidence.add('outbound');
    }
    if (evidence.size !== 1) { ambiguous++; continue; }
    const content = row.querySelector('.MessageItemTextbubbleTextContent, [data-e2e="message-content"], [data-message-content], .messageItemcontent, .message-content, [class*="messageTextContent"]');
    const media = row.querySelector('video, audio, [data-message-type="image"], [data-message-type="video"], [data-message-type="audio"], [class*="MessageItemImage"], [class*="MessageItemVideo"], [class*="MessageItemAudio"]');
    let type = row.getAttribute('data-message-type') || 'text';
    if (media) type = media.tagName === 'VIDEO' || /MessageItemVideo/.test(media.className) ? 'video' : media.tagName === 'AUDIO' || /MessageItemAudio/.test(media.className) ? 'audio' : (media.getAttribute('data-message-type') || 'image');
    // Never flatten the whole row: it contains author, clock, actions and status.
    if (!content && type === 'text') { unsupported++; continue; }
    const value = content ? text(content) : '';
    if (type === 'text' && !value) { unsupported++; continue; }
    const message = {direction: Array.from(evidence)[0], text: value, type};
    const id = row.getAttribute('data-message-id') || row.getAttribute('data-msg-id');
    if (id) message.platformMessageId = id;
    const time = row.querySelector('time[datetime]');
    const at = row.getAttribute('data-create-time') || (time && time.getAttribute('datetime'));
    if (at) message.platformAt = at;
    messages.push(message);
  }
  const loading = Array.from(panel.querySelectorAll('[aria-busy="true"], [role="progressbar"], .semi-spin-spinning, [data-e2e="im-loading"], .messageMessageListloading')).some(visible);
  const loadError = nativeList && /加载失败|网络错误|重新加载/.test(nativeList.innerText);
  // Observed live 2026-10-27: a newly opened peer thread renders the native
  // initialized message list with this exact system-only restriction notice.
  // This is evidence of an empty *rendered window*, not proof of all history.
  const nativeEmpty = nativeList && visible(nativeList) && rows.length === 0 && systemRows.length > 0 &&
    systemRows.every(row => {
      const notice = row.querySelector('.SystemNormalSystemtext');
      return notice && notice.innerText.includes('对方回复或关注你之前，只能发送一条文字消息');
    }) && Array.from(panel.querySelectorAll('[contenteditable="true"].messageEditorinputArea')).some(visible);
  const empty = !loading && !loadError && (nativeEmpty || Array.from(panel.querySelectorAll('[data-e2e="im-empty"], .chat-empty')).some(visible));
  const complete = !loading && !loadError && !ambiguous && !unsupported && rows.length <= 200 && (rows.length > 0 || empty);
  return {messages, complete, windowOnly: true,
    reason: complete ? '已读取身份明确的可见会话窗口，不代表完整历史。' :
      loading ? '会话仍在加载，等待稳定窗口后再处理。' :
      loadError ? '会话显示加载失败，暂停自动处理。' :
      ambiguous ? '消息方向不明确或互相冲突，暂停自动处理。' :
      unsupported ? '部分消息内容结构无法识别，暂停自动处理。' :
      rows.length > 200 ? '可见消息超过本次读取上限，暂停自动处理。' :
      '未识别到消息结构或明确空会话状态，暂停自动处理。'};
}"""
