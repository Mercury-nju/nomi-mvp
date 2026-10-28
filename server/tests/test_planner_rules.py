import asyncio
from server.planner import plan_request, assess, draft_message


def test_rule_plan_understands_observation_duration_and_does_not_grant_contact(monkeypatch):
    monkeypatch.delenv('NOMI_LLM_API_KEY', raising=False)
    async def run():
        result = await plan_request('观察直播间 https://live.douyin.com/123 2分钟，地区不限，找3人，先不私信', {})
        plan = result['plan']
        assert plan['sourceType'] == 'live_chat'
        assert plan['observeSeconds'] == 120
        assert plan['region'] == '不限'
        assert plan['limit'] == 3
        assert plan['mode'] == 'find' and not plan['authorized']
    asyncio.run(run())


def test_operational_words_do_not_hide_explicit_sales_evidence_but_extra_conditions_do(monkeypatch):
    monkeypatch.delenv('NOMI_LLM_API_KEY', raising=False)
    async def run():
        customer = {'sources': [{'text': '我是杭州销售，想获客，但是不知道如何找客户'}]}
        plan = {'target': '帮我从抖音作品评论里找10个杭州想要做获客的销售，只找人先不私信', 'region': '杭州', 'signals': '获客'}
        assert (await assess(customer, plan))['status'] == 'matched'
        plan['target'] = '杭州有三年经验的汽车销售想获客'
        assert (await assess(customer, plan))['status'] == 'uncertain'
        draft = await draft_message(customer, {'identity': '业务顾问', 'service': '需求咨询'})
        assert '杭州销售' in draft['text']
        assert draft['provider'] == 'rules'
    asyncio.run(run())


def test_renovation_buyer_questions_use_titles_only_for_subject(monkeypatch):
    monkeypatch.delenv('NOMI_LLM_API_KEY', raising=False)
    plan = {'target': '杭州本地咨询装修报价的人', 'region': '杭州', 'signals': '报价、多少钱、价格、预算、怎么收费、费用'}
    cases = [
        ('120平大楷要多少米装修的', '浙江·杭州'),
        ('杭州临平山北，120平30w预算', '浙江·杭州'),
        ('跃层128方左右，旧房翻新全改。半包、全包大概费用多少？', '浙江·杭州'),
        ('我在临平129平，多少钱能装的下来，普通一点就可以了。', ''),
        ('我是90的准备下个月装大概多少钱老板', '浙江·杭州'),
        ('老房子全包120平什么价格', '浙江·杭州'),
        ('杭州70方多少钱', ''),
        ('套内48，半包下来多少钱', '浙江·杭州'),
    ]
    async def run():
        for text, profile in cases:
            result = await assess({'profileText': profile, 'sources': [{'text': text, 'title': '杭州120平装修报价'}]}, plan)
            assert result['status'] == 'matched', (text, result)
    asyncio.run(run())


def test_renovation_context_does_not_invent_buyer_intent_or_location(monkeypatch):
    monkeypatch.delenv('NOMI_LLM_API_KEY', raising=False)
    plan = {'target': '杭州本地咨询装修报价的人', 'region': '杭州', 'signals': '报价、多少钱、价格、预算、怎么收费、费用'}
    cases = [
        ('加上门窗了吗', '浙江·杭州', '杭州装修报价', 'uncertain'),
        ('您好，100平方指的是建筑面积还是套内？？', '浙江·杭州', '杭州装修报价', 'uncertain'),
        ('贵了，人家8万全包了', '浙江·杭州', '杭州装修报价', 'uncertain'),
        ('欢迎咨询，120平装修多少钱都可以找我', '浙江·杭州', '杭州装修报价', 'uncertain'),
        ('120平多少钱', '江苏·盐城', '杭州装修报价', 'uncertain'),
        ('120平多少钱', 'IP属地：杭州', '杭州装修报价', 'uncertain'),
        ('120平多少钱', '昵称：临平装修\nIP属地：浙江', '杭州装修报价', 'uncertain'),
        ('多少钱', '浙江·杭州', '电脑报价', 'uncertain'),
        ('不需要装修，多少钱也不考虑', '浙江·杭州', '杭州装修报价', 'excluded'),
    ]
    async def run():
        for text, profile, title, status in cases:
            result = await assess({'profileText': profile, 'sources': [{'text': text, 'title': title}]}, plan)
            assert result['status'] == status, (text, result)
        extra = {**plan, 'target': '杭州本地咨询别墅装修报价的人'}
        result = await assess({'profileText': '浙江·杭州', 'sources': [{'text': '120平多少钱', 'title': '杭州装修报价'}]}, extra)
        assert result['status'] == 'uncertain', result
        # An unrelated source's title cannot supply this comment's subject.
        result = await assess({'profileText': '浙江·杭州', 'sources': [{'text': '多少钱', 'title': '电脑报价'}, {'text': '赞', 'title': '杭州装修报价'}]}, plan)
        assert result['status'] == 'uncertain', result
    asyncio.run(run())
