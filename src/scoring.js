import { t } from './messages.js';

/**
 * 难度打分器（v0.3.0）。
 *
 * 存在的理由：router 之前只会按「路径 / 模型名前缀 / 某个 body 字段 / 请求体字节数」
 * 分桶，这些全是**显式信号**——用户必须先知道规则怎么写才能命中。可现实里最常见的
 * 诉求是「这题难不难换个更贵的模型」，而这个信息恰恰不在请求的显式字段里。
 *
 * 两个刻意的设计取舍：
 *
 * 1. **判定用可数的形态特征，不用 token 数。** 估 token 要引分词器，既违背零依赖，
 *    又会给出一个不准的数字；这里数的是「消息轮数 / 代码块 / diff 行数 / 工具个数」，
 *    每个都是确定的整数，阈值调起来踏实。
 * 2. **打分器是树内具名的注册表**，和 transformers.js 同一个取舍：配置里只能写名字，
 *    **刻意不支持从任意路径 require 插件**——那会让「零依赖 + 只听回环」的安全面失效。
 *
 * 已知局限（必须写进文档，别把它吹成「语义难度」）：
 * 它衡量的是**请求形态复杂度**，不是语义难度。「帮我重构整个项目」只有 200 字但
 * 语义很难，会被打成 easy；把 50KB 日志粘进来问「哪报错了」形态很复杂但其实简单。
 *
 * 本模块是纯函数，不碰网络、不打日志，便于单测与 doctor 复用。
 */

/** 内置打分器名。配置里可以只用其中一部分。 */
export const BUILTIN_SCORERS = ['builtin-complexity'];

/**
 * 默认权重，合计正好 100 分。
 * 每个信号先算出一个 0~1 的「比例」，再乘权重——这样调权重不会破坏总分上限，
 * 也不会出现「某个信号突然占了 60 分」把其他信号全挤掉。
 */
export const DEFAULT_WEIGHTS = {
  bytes: 22, // 请求体大小：越长通常越费脑
  turns: 12, // 消息轮数：多轮对话往往要维持上下文
  codeBlocks: 15, // 代码块数量：写代码的活比闲聊重
  diffLines: 13, // diff 行数：改代码的活通常要更重的模型
  tools: 8, // 工具定义个数：工具多意味着要遵守的约束多
  system: 8, // system 提示长度：长系统提示意味着更复杂的规则集
  files: 8, // 涉及的文件数：多文件任务比单文件难
  reasoning: 8, // 客户端明确要推理
  maxTokens: 6, // 客户端要的输出预算
};

/** 默认难度档位。分数 <= maxScore 落进该档。 */
export const DEFAULT_BANDS = [
  { name: 'easy', maxScore: 30 },
  { name: 'medium', maxScore: 60 },
  { name: 'hard', maxScore: 100 },
];

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** 把上限值换算成 0~1 的比例。 */
function ratioAtMost(value, ceiling) {
  if (!Number.isFinite(value) || !Number.isFinite(ceiling) || ceiling <= 0) return 0;
  return clamp01(value / ceiling);
}

// ---------------------------------------------------------------- 信号提取

/**
 * 从请求体里抽出各协议的「消息数组」。
 * chat 与 messages 用 body.messages，responses 用 body.input。
 */
function collectTurns(body) {
  if (!isPlainObject(body)) return 0;
  if (Array.isArray(body.messages)) return body.messages.length;
  if (Array.isArray(body.input)) return body.input.length;
  return 0;
}

/** 把请求体里所有文本拼起来——统计代码块、diff 行、文件路径都要用。 */
function collectText(body) {
  if (!isPlainObject(body)) return '';
  const parts = [];

  const pushContent = (content) => {
    if (typeof content === 'string') {
      parts.push(content);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (typeof item === 'string') parts.push(item);
      else if (isPlainObject(item)) {
        if (typeof item.text === 'string') parts.push(item.text);
        else if (typeof item.content === 'string') parts.push(item.content);
        else if (Array.isArray(item.content)) pushContent(item.content);
      }
    }
  };

  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) pushContent(message?.content);

  const input = Array.isArray(body.input) ? body.input : [];
  for (const item of input) {
    if (typeof item === 'string') parts.push(item);
    else if (isPlainObject(item)) pushContent(item.content);
  }

  if (typeof body.system === 'string') parts.push(body.system);
  else if (Array.isArray(body.system)) pushContent(body.system);
  if (typeof body.instructions === 'string') parts.push(body.instructions);

  return parts.join('\n');
}

/** 工具定义个数。三种协议的工具都在 body.tools，只是形状不同。 */
function collectToolCount(body) {
  if (!isPlainObject(body)) return 0;
  if (!Array.isArray(body.tools)) return 0;
  return body.tools.length;
}

/** system 提示的长度（字符数）。三种协议位置不同。 */
function collectSystemLength(body) {
  if (!isPlainObject(body)) return 0;
  if (typeof body.instructions === 'string') return body.instructions.length;
  if (typeof body.system === 'string') return body.system.length;
  if (Array.isArray(body.system)) return collectText({ messages: [{ content: body.system }] }).length;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let total = 0;
  for (const message of messages) {
    if (message?.role === 'system' || message?.role === 'developer') {
      total += collectText({ messages: [message] }).length;
    }
  }
  return total;
}

/** 客户端要的输出预算。chat / messages / responses / gemini 各有一个名字。 */
function collectMaxTokens(body) {
  if (!isPlainObject(body)) return null;
  const candidates = [
    body.max_tokens,
    body.max_completion_tokens,
    body.max_output_tokens,
    body.generationConfig?.maxOutputTokens,
  ];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * 客户端是否明确要推理。要了就是难活。
 * 返回 0~1 的比例：明确要推理给满值，弱信号（thinking 存在但没开）给一半。
 */
function collectReasoning(body) {
  if (!isPlainObject(body)) return 0;
  const budget = body.thinking?.budget_tokens ?? body.generationConfig?.thinkingConfig?.thinkingBudget;
  if (typeof budget === 'number' && budget > 0) return budget >= 8192 ? 1 : 0.5;
  if (typeof body.reasoning_effort === 'string') return body.reasoning_effort === 'high' ? 1 : 0.5;
  if (typeof body.reasoning?.effort === 'string') return body.reasoning.effort === 'high' ? 1 : 0.5;
  if (body.thinking || body.reasoning) return 0.5;
  return 0;
}

/** 代码块个数。数 "```" 的出现次数，除以 2 向上取整。 */
function countCodeBlocks(text) {
  if (!text) return 0;
  const fences = text.match(/```/g);
  if (!fences) return 0;
  return Math.ceil(fences.length / 2);
}

/** diff 行数。排除 "+++" / "---" 这种文件头。 */
function countDiffLines(text) {
  if (!text) return 0;
  const matches = text.match(/^[+-](?![-+])/gm);
  return matches ? matches.length : 0;
}

/** 出现的文件路径个数（去重后计数）。 */
const FILE_PATTERN =
  /(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,8}\b|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|h|cc|cpp|cs|swift|kt|kts|scala|sh|bash|zsh|sql|md|json|ya?ml|toml|ini|html|css|scss|vue|svelte)\b/g;

function countFiles(text) {
  if (!text) return 0;
  const matches = text.match(FILE_PATTERN);
  if (!matches) return 0;
  return new Set(matches.map((value) => value.toLowerCase())).size;
}

// ---------------------------------------------------------------- 打分器注册表

/**
 * 每个打分器声明 score(request, { options }) → { score, signals }。
 * score 已经是 0~100 的加权分；signals 是明细，给 doctor 与日志看。
 */
const REGISTRY = {
  'builtin-complexity': {
    describe: () => t('scorer.builtinComplexity'),
    score(request, { options = {} } = {}) {
      const weights = { ...DEFAULT_WEIGHTS, ...(isPlainObject(options.weights) ? options.weights : {}) };
      const body = isPlainObject(request.body) ? request.body : {};
      const text = collectText(body);
      const byteLength = Number.isFinite(request.byteLength) ? request.byteLength : 0;

      const ratios = {
        // 字节数走对数刻度：1KB 不该和 32KB 一样重，64KB 封顶。
        // 512 字节以下一律 0 分——那点字连「复杂」都谈不上。
        bytes: byteLength >= 512 ? clamp01(Math.log2(byteLength + 1) / 16) : 0,
        // 一轮对话不算复杂：从第二轮开始才加分
        turns: ratioAtMost(collectTurns(body) - 1, 9),
        codeBlocks: ratioAtMost(countCodeBlocks(text), 8),
        diffLines: ratioAtMost(countDiffLines(text), 200),
        tools: ratioAtMost(collectToolCount(body), 20),
        system: ratioAtMost(collectSystemLength(body), 8000),
        files: ratioAtMost(countFiles(text), 10),
        reasoning: collectReasoning(body),
        maxTokens: ratioAtMost((collectMaxTokens(body) || 0) - 1000, 7000),
      };

      const signals = {};
      let total = 0;
      for (const [name, weight] of Object.entries(weights)) {
        const ratio = ratios[name] ?? 0;
        const points = Math.round((Number(weight) || 0) * ratio);
        signals[name] = points;
        total += points;
      }
      return { score: Math.max(0, Math.min(100, total)), signals };
    },
  },
};

/** 注册表里所有打分器名（保持定义顺序，便于 doctor 稳定输出）。 */
export function listScorers() {
  return Object.keys(REGISTRY);
}

/** 按名字取一条打分器定义，未注册返回 null。 */
export function getScorer(name) {
  return Object.prototype.hasOwnProperty.call(REGISTRY, name) ? REGISTRY[name] : null;
}

/** 名字是否已注册。配置校验用它，避免把拼写错误留到运行时。 */
export function isScorer(name) {
  return getScorer(name) !== null;
}

/** 描述表，供 doctor 与文档复用（随语言变化，所以是函数）。 */
export function describeScorers() {
  return listScorers().map((name) => ({
    name,
    description: REGISTRY[name].describe(),
  }));
}

// ---------------------------------------------------------------- 档位

/**
 * 归一化档位列表：按 maxScore 升序排，非法项丢掉。
 * 没有配档位就用内置的三档。
 */
export function normalizeBands(bands) {
  if (!Array.isArray(bands) || !bands.length) {
    return DEFAULT_BANDS.map((band) => ({ ...band }));
  }
  const cleaned = bands
    .filter((band) => isPlainObject(band) && typeof band.name === 'string' && band.name)
    .map((band) => ({ name: band.name, maxScore: Number.isFinite(Number(band.maxScore)) ? Number(band.maxScore) : 0 }))
    .sort((a, b) => a.maxScore - b.maxScore);
  return cleaned.length ? cleaned : DEFAULT_BANDS.map((band) => ({ ...band }));
}

/** 分数落进哪个档位。超出最高档就落最高档。 */
export function bandFor(score, bands) {
  const list = normalizeBands(bands);
  const value = Number.isFinite(Number(score)) ? Number(score) : 0;
  for (const band of list) {
    if (value <= band.maxScore) return band.name;
  }
  return list[list.length - 1].name;
}

/**
 * 给一个请求打分（只算分，不定档）。
 *
 * 两种调用形式：
 *   scoreRequest(request, { enabled: ['builtin-complexity'], options: { 'builtin-complexity': {...} } })
 *   scoreRequest(request, { weights: {...} })   // 便捷形式：只跑内置打分器并覆盖权重
 *
 * 多个打分器叠加：分数相加后统一裁到 0~100，signals 合并（后一个覆盖前一个的同名项）。
 * 一个打分器都没配时返回 null——router 据此知道「本次没有难度信号」，
 * 于是 difficulty 规则不会命中任何请求（与「零条件规则不命中」的既有语义一致）。
 */
export function scoreRequest(request = {}, options = {}) {
  const names = Array.isArray(options.enabled)
    ? options.enabled
    : ['builtin-complexity'];
  if (!names.length) return null;

  const weights = options.options && typeof options.options === 'object' ? options.options : {};
  // 便捷形式：直接覆盖内置打分器的权重
  const perScorer = options.weights
    ? { [names[0]]: { weights: options.weights } }
    : weights;

  let total = 0;
  const signals = {};
  const applied = [];
  for (const name of names) {
    const scorer = getScorer(name);
    if (!scorer) continue;
    const result = scorer.score(request, { options: perScorer[name] || {} }) || {};
    total += Number(result.score) || 0;
    applied.push(name);
    Object.assign(signals, isPlainObject(result.signals) ? result.signals : {});
  }
  if (!applied.length) return null;

  const score = Math.max(0, Math.min(100, Math.round(total)));
  return { score, signals, scorers: applied };
}

/**
 * 给一个请求打分并定档。
 *
 * 多个打分器可以叠加：分数相加后统一裁到 0~100，signals 合并（后一个覆盖前一个的同名项）。
 * 一个打分器都没配时返回 null——router 据此知道「本次没有难度信号」，
 * 于是 difficulty 规则不会命中任何请求（与「零条件规则不命中」的既有语义一致）。
 */
export function resolveDifficulty(request = {}, routerConfig = {}) {
  const scorers = routerConfig.scorers || {};
  const names = Array.isArray(scorers.enabled) ? scorers.enabled : [];
  if (!names.length) return null;

  const bands = normalizeBands(routerConfig.bands);
  const result = scoreRequest(request, { enabled: names, options: scorers.options });
  if (!result) return null;

  return {
    score: result.score,
    band: bandFor(result.score, bands),
    signals: result.signals,
    scorers: result.scorers,
  };
}
