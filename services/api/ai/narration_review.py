"""
AI 辅助层（V1.5）
- 客观中性检测 + 改写推荐（detect_subjective_rewrite / check_objectivity）
- 用词一致性检测（check_consistency，按 events）
- 时长预估（estimate_duration，纯本地，统计中文字符）
- 前后衔接检查（check_continuity）

模型选择以精度优先：
- 客观中性改写：qwen-max（推理强）
- 一致性 / 衔接：qwen-plus（精度优先）
- 通过百炼 dashscope SDK 统一调用，兼容 OpenAI 接口规范换模型

所有 dashscope 调用均 try/except，无 API Key 时优雅降级返回 mock 数据。
"""
import os
import re
import json
import logging

logger = logging.getLogger(__name__)

# 默认模型（精度优先，可按实测切换）
DEFAULT_MODEL = os.getenv('AI_MODEL', 'qwen-max')
REVIEW_MODEL = os.getenv('AI_REVIEW_MODEL', 'qwen-plus')  # 一致性 / 衔接用
DASHSCOPE_API_KEY = os.getenv('DASHSCOPE_API_KEY', '')


def _count_chinese_chars(text):
    """统计中文字符数（CJK 表意文字），不含标点、空格、内联标签"""
    clean = re.sub(r'\{.*?\}', '', text or '')
    clean = clean.replace('\\N', '').replace('\\n', '')
    count = 0
    for ch in clean:
        cp = ord(ch)
        if (0x4E00 <= cp <= 0x9FFF          # CJK Unified Ideographs
                or 0x3400 <= cp <= 0x4DBF    # CJK Extension A
                or 0xF900 <= cp <= 0xFAFF    # CJK Compatibility Ideographs
                or 0x20000 <= cp <= 0x2A6DF  # CJK Extension B
                or 0x2A700 <= cp <= 0x2B73F  # CJK Extension C
                or 0x2B740 <= cp <= 0x2B81F  # CJK Extension D
        ):
            count += 1
    return count


def _event_id(event, index):
    """取事件的稳定 ID（优先 id 字段，否则用序号）"""
    if isinstance(event, dict):
        eid = event.get('id') or event.get('event_id')
        if eid:
            return str(eid)
    return str(index + 1)


def _event_text(event):
    if isinstance(event, dict):
        return str(event.get('text', ''))
    if isinstance(event, (list, tuple)) and len(event) > 3:
        return str(event[3])
    return str(event)


# ============ 客观中性改写（detect_subjective_rewrite，严格格式）============

SUBJECTIVE_REWRITE_PROMPT = """你是口述影像客观性审校专家。

【任务】识别以下口述稿文本中的主观评价词，并给出一版客观化改写。

【口述影像行业规范】
- 只描述可见的客观事实，不评价美丑、好坏、善恶
- 禁止：形容词性主观评价（美丽的、可怕的、可惜、竟然、不幸地）
- 禁止：价值判断词（应该、必须、显然）
- 允许：中性描述词（红色、快速、缓慢、左侧）

【约束】
1. 保持原意与描述完整性
2. 改写后字数与原文偏差 ≤ 10%
3. 保留所有 {{...}} 内联标签原样不动
4. 若无主观内容，rewritten 字段返回空字符串

【原文】
{text}

【输出严格 JSON，不要任何额外文字或解释】
{{
  "original": "原句",
  "subjective_spans": [{{"start": 起始字符索引, "end": 结束字符索引, "word": "主观词"}}],
  "rewritten": "改写句",
  "char_count": {{"original": 原字数, "rewritten": 改写字数}}
}}

说明：start/end 为字符在 original 中的索引（从 0 开始，end 为不包含该位置的索引）；
若没有主观内容，subjective_spans 为空数组、rewritten 为空字符串。
"""


async def detect_subjective_rewrite(text: str, model: str = DEFAULT_MODEL) -> dict:
    """
    识别主观评价词 → 客观化改写（严格 JSON 格式）。

    :return: {
        original, subjective_spans:[{start, end, word}],
        rewritten, char_count:{original, rewritten}
    }
    无 API Key / 调用失败 → rewritten 为空字符串、spans 为空，结构保持完整。
    """
    base = {
        'original': text,
        'subjective_spans': [],
        'rewritten': '',
        'char_count': {'original': len(text), 'rewritten': 0},
    }

    if not DASHSCOPE_API_KEY:
        logger.warning("DASHSCOPE_API_KEY 未配置，detect_subjective_rewrite 返回空改写")
        return {**base, 'model': 'none', 'error': 'API key not configured'}

    try:
        import dashscope
        dashscope.api_key = DASHSCOPE_API_KEY

        response = dashscope.Generation.call(
            model=model,
            prompt=SUBJECTIVE_REWRITE_PROMPT.format(text=text),
            response_format={'type': 'json_object'},
            result_format='message',
        )

        if response.status_code != 200:
            logger.error(f"detect_subjective_rewrite 调用失败: {getattr(response, 'code', '?')} - {getattr(response, 'message', '?')}")
            return {**base, 'model': model, 'error': getattr(response, 'message', 'AI call failed')}

        content = response.output.choices[0].message.content
        result = json.loads(content)

        original = result.get('original', text)
        rewritten = result.get('rewritten', '') or ''
        spans = result.get('subjective_spans', []) or []

        # 规范化 + 重算字数，保证准确
        spans_norm = []
        for s in spans:
            if not isinstance(s, dict):
                continue
            spans_norm.append({
                'start': s.get('start', 0),
                'end': s.get('end', 0),
                'word': s.get('word', ''),
            })

        return {
            'original': original,
            'subjective_spans': spans_norm,
            'rewritten': rewritten,
            'char_count': {
                'original': len(original),
                'rewritten': len(rewritten),
            },
            'model': model,
        }
    except Exception as e:
        logger.error(f"detect_subjective_rewrite 异常: {e}")
        return {**base, 'model': model, 'error': str(e)}


# ============ 兼容旧入口：check_objectivity（保持 /api/ai/objectivity 可用）============

SUBJECTIVE_PROMPT = """你是口述影像客观性审校专家。请检查以下口述稿文本是否包含主观评价词，并给出一版客观化改写。

【口述影像行业规范】
- 只描述可见的客观事实，不评价美丑、好坏、善恶
- 禁止：形容词性主观评价（美丽的、可怕的、可惜、竟然、不幸地）
- 禁止：价值判断词（应该、必须、显然）
- 允许：中性描述词（红色、快速、缓慢、左侧）

【任务】
1. 识别原文中的主观词/主观表述，标记位置和原因
2. 给出一版改写推荐：
   - 保持原意与描述完整性
   - 字数与原文偏差 ≤ 10%（关键约束，因字数影响口述时长）
   - 保留所有 {{...}} 内联标签原样不动
3. 输出 JSON 格式

【原文】
{text}

【输出 JSON 格式】
{{
  "subjective_words": [
    {{"word": "主观词", "position": 起始字符位置, "reason": "判定原因", "suggestion": "客观替代"}}
  ],
  "rewritten_text": "改写后的完整文本（含原始标签）",
  "original_count": 原字数,
  "rewritten_count": 改写字数,
  "deviation_pct": 字数偏差百分比
}}"""


async def check_objectivity(text: str, model: str = DEFAULT_MODEL) -> dict:
    """
    客观中性检测 + 改写推荐（旧接口，供 /api/ai/objectivity 使用）
    :return: {subjective_words, rewritten_text, original_count, rewritten_count, deviation_pct}
    """
    if not DASHSCOPE_API_KEY:
        logger.warning("DASHSCOPE_API_KEY 未配置，返回空结果")
        return {
            'subjective_words': [],
            'rewritten_text': text,
            'original_count': len(text),
            'rewritten_count': len(text),
            'deviation_pct': 0,
            'model': 'none',
            'error': 'API key not configured',
        }

    try:
        import dashscope
        dashscope.api_key = DASHSCOPE_API_KEY

        response = dashscope.Generation.call(
            model=model,
            prompt=SUBJECTIVE_PROMPT.format(text=text),
            response_format={'type': 'json_object'},
            result_format='message',
        )

        if response.status_code != 200:
            logger.error(f"AI 调用失败: {response.code} - {response.message}")
            return {'error': response.message, 'model': model}

        content = response.output.choices[0].message.content
        result = json.loads(content)
        result['model'] = model
        return result
    except Exception as e:
        logger.error(f"客观中性检测异常: {e}")
        return {'error': str(e), 'model': model}


# ============ 用词一致性检测（按 events）============

CONSISTENCY_EVENTS_PROMPT = """你是口述影像术语一致性审校专家。请检查以下多条口述稿事件中，是否存在指代同一人物/物体但描述用词不统一的情况（例如"男子"与"男性"混用、"老人"与"老爷爷"混用）。

【检查维度】
1. 人物称呼：同一角色前后用词是否一致
2. 物体/场景：同一对象前后用词是否一致
3. 专业术语：同一概念前后表述是否一致

【事件列表】
{events}

【输出严格 JSON，不要任何额外文字】
{{
  "inconsistencies": [
    {{
      "word_a": "用词A",
      "word_b": "用词B",
      "occurrences": [{{"event_id": "事件ID", "text": "该事件文本"}}],
      "suggestion": "建议统一为哪个用词"
    }}
  ]
}}

若无不一致，inconsistencies 返回空数组。occurrences 中应列出涉及的两个用词各自出现的所有事件。
"""


async def check_consistency(events: list, model: str = REVIEW_MODEL) -> dict:
    """
    跨事件用词一致性检测。

    :param events: 事件列表（每个含 text 字段，可选 id）
    :return: {inconsistencies: [{word_a, word_b, occurrences:[{event_id, text}], suggestion}]}
    无 API Key 时返回 {inconsistencies: []}
    """
    if not DASHSCOPE_API_KEY:
        logger.warning("DASHSCOPE_API_KEY 未配置，check_consistency 返回空结果")
        return {'inconsistencies': []}

    try:
        import dashscope
        dashscope.api_key = DASHSCOPE_API_KEY

        lines = []
        for i, ev in enumerate(events):
            eid = _event_id(ev, i)
            txt = _event_text(ev)
            lines.append(f"[{eid}] {txt}")
        events_text = '\n'.join(lines)

        response = dashscope.Generation.call(
            model=model,
            prompt=CONSISTENCY_EVENTS_PROMPT.format(events=events_text),
            response_format={'type': 'json_object'},
            result_format='message',
        )

        if response.status_code != 200:
            logger.error(f"check_consistency 调用失败: {getattr(response, 'code', '?')} - {getattr(response, 'message', '?')}")
            return {'inconsistencies': [], 'error': getattr(response, 'message', 'AI call failed'), 'model': model}

        result = json.loads(response.output.choices[0].message.content)
        result.setdefault('inconsistencies', [])
        result['model'] = model
        return result
    except Exception as e:
        logger.error(f"用词一致性检测异常: {e}")
        return {'inconsistencies': [], 'error': str(e), 'model': model}


# ============ 前后衔接检查（check_continuity）============

CONTINUITY_PROMPT = """你是口述影像前后衔接审校专家。请检查以下按时间顺序排列的口述稿事件，相邻条目之间是否存在衔接生硬、指代模糊等问题。

【检查维度】
1. 衔接生硬：相邻两条内容跳跃过大、缺乏过渡
2. 指代模糊：后一条中的"他/她/它"等指代在前一条中找不到明确对象
3. 重复啰嗦：相邻两条信息重复

【事件列表（按时间顺序）】
{events}

【输出严格 JSON，不要任何额外文字】
{{
  "issues": [
    {{
      "event_id_a": "前一条事件ID",
      "event_id_b": "后一条事件ID",
      "issue_type": "衔接生硬|指代模糊|重复啰嗦|其他",
      "description": "问题描述",
      "suggestion": "修改建议"
    }}
  ]
}}

若无问题，issues 返回空数组。
"""


async def check_continuity(events: list, model: str = REVIEW_MODEL) -> dict:
    """
    相邻事件前后衔接检查。

    :param events: 事件列表（带 start/end/text，可选 id）
    :return: {issues: [{event_id_a, event_id_b, issue_type, description, suggestion}]}
    无 API Key 时返回 {issues: []}
    """
    if not DASHSCOPE_API_KEY:
        logger.warning("DASHSCOPE_API_KEY 未配置，check_continuity 返回空结果")
        return {'issues': []}

    try:
        import dashscope
        dashscope.api_key = DASHSCOPE_API_KEY

        lines = []
        for i, ev in enumerate(events):
            eid = _event_id(ev, i)
            txt = _event_text(ev)
            start = ev.get('start', '') if isinstance(ev, dict) else ''
            end = ev.get('end', '') if isinstance(ev, dict) else ''
            lines.append(f"[{eid}] ({start}-{end}) {txt}")
        events_text = '\n'.join(lines)

        response = dashscope.Generation.call(
            model=model,
            prompt=CONTINUITY_PROMPT.format(events=events_text),
            response_format={'type': 'json_object'},
            result_format='message',
        )

        if response.status_code != 200:
            logger.error(f"check_continuity 调用失败: {getattr(response, 'code', '?')} - {getattr(response, 'message', '?')}")
            return {'issues': [], 'error': getattr(response, 'message', 'AI call failed'), 'model': model}

        result = json.loads(response.output.choices[0].message.content)
        result.setdefault('issues', [])
        result['model'] = model
        return result
    except Exception as e:
        logger.error(f"前后衔接检查异常: {e}")
        return {'issues': [], 'error': str(e), 'model': model}


# ============ 时长预估（纯本地）============

def estimate_duration(text: str, speed: float = 3.5) -> dict:
    """
    根据中文字数预估口述耗时（纯本地计算，不调 AI）。

    :param text: 口述文本（含可能的内联标签）
    :param speed: 语速（字/秒，默认 3.5）
    :return: {char_count, estimated_duration, speed}
    """
    char_count = _count_chinese_chars(text)
    if speed and speed > 0:
        estimated = char_count / speed
    else:
        estimated = 0.0
    return {
        'char_count': char_count,
        'estimated_duration': round(estimated, 3),
        'speed': speed,
    }


def check_duration_fit(text: str, segment_duration: float, speed: float = 3.5) -> dict:
    """
    检查口述文本时长是否匹配空白段（兼容旧 /api/ai/duration-fit 入口）。
    :return: {estimated, actual, fit, over_by, under_by, char_count, speed}
    """
    est = estimate_duration(text, speed)
    estimated = est['estimated_duration']
    return {
        'estimated': round(estimated, 2),
        'actual': round(segment_duration, 2),
        'fit': abs(estimated - segment_duration) < 1.0,
        'over_by': round(max(0, estimated - segment_duration), 2),
        'under_by': round(max(0, segment_duration - estimated), 2),
        'char_count': est['char_count'],
        'speed': est['speed'],
    }
