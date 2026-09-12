/**
 * 内置模型别名映射表。
 *
 * 存在的理由：文档一直教客户端把模型名写成 `proxy-` 前缀（Trae 之类会按模型 ID
 * 决定走不走自定义通道），但默认配置里的 `model.map` 曾经是空的 —— 于是
 * `proxy-deepseek` 被剥成 `deepseek` 后**原样发给上游**，换回来一句「模型不存在」。
 * 客户端和文档都没错，错在中间少了一张表。
 *
 * 使用约定：
 *   - 表里的键是**别名**，值是上游真实模型 ID。
 *   - 客户端填真实 ID 时永远原样透传，不查表。
 *   - 别名同时支持「带前缀」和「不带前缀」两种写法：
 *       "deepseek" → deepseek-flash， "proxy-deepseek" → deepseek-flash。
 *   - 这是**发布时的快照**，不是活的模型目录。上游调整模型名是常态，
 *     表现就是别名命中不了 → 代理会打一条 warn 告诉你该补哪一条。
 *   - 想改：配置文件里写 `model.map` 会与本表**逐键深合并**（同键覆盖、异键保留），
 *     删不掉内置项；只想覆盖某一条就用 `--model-map deepseek=新的ID`。
 */
export const DEFAULT_MODEL_MAP = {
  // ── /zen/go/v1/chat/completions（OpenAI 兼容，绝大多数客户端走这条）──
  glm: 'glm-5.3',
  'glm-flash': 'glm-5.3-flash',
  'glm-5.2': 'glm-5.2',
  'glm-5.1': 'glm-5.1',
  kimi: 'kimi-k3',
  'kimi-code': 'kimi-k2.7-code',
  'kimi-k2.6': 'kimi-k2.6',
  deepseek: 'deepseek-flash',
  'deepseek-pro': 'deepseek-v4-pro',
  'deepseek-v4-flash': 'deepseek-v4-flash',
  'deepseek-vision': 'deepseek-v4-flash-vision-exp',
  longcat: 'longcat-2.0',
  mimo: 'mimo-v2.5',
  'mimo-pro': 'mimo-v2.5-pro',
  hy3: 'hy3',
  hy4: 'hy4-preview',

  // ── /zen/go/v1/responses（OpenAI Responses API）──
  // 走这个端点的客户端必须能发 Responses 格式的请求体，否则上游会拒绝。
  grok: 'grok-4.6',
  'gpt-luna': 'gpt-5.6-luna',
  'muse-1.3': 'muse-spark-1.3-contributor',
  'muse-1.2': 'muse-spark-1.2-contributor',

  // ── /zen/go/v1/messages（Anthropic Messages API）──
  // 需要客户端能发 Anthropic 格式的请求体。v0.2.2 的协议转换落地前，
  // 只支持 OpenAI 格式的客户端用不了这些模型（本代理目前不做协议转换）。
  minimax: 'minimax-m3',
  'minimax-2.7': 'minimax-m2.7',
  'minimax-2.5': 'minimax-m2.5',
  'qwen-max': 'qwen3.8-max',
  'qwen-flash': 'qwen3.8-flash',
  'qwen3.7-max': 'qwen3.7-max',
  'qwen-plus': 'qwen3.6-plus',
};

/** 内置表覆盖的别名个数，供文档与诊断输出引用。 */
export const DEFAULT_MODEL_MAP_SIZE = Object.keys(DEFAULT_MODEL_MAP).length;
