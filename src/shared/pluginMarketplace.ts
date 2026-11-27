export type PluginMarketplaceCategory =
  | 'all'
  | 'device_import'
  | 'editing_templates'
  | 'ai_avatar'
  | 'audio_voice'
  | 'workflow';

export type PluginMarketplaceStatus = 'installed' | 'built_in' | 'coming_soon';

export type MarketplaceActionType = 'open_dji' | 'open_templates' | 'roadmap';

export interface MarketplaceCategoryTab {
  id: PluginMarketplaceCategory;
  label: string;
  labelZh: string;
}

export interface MarketplacePluginEntry {
  id: string;
  runtimePluginId?: string;
  category: Exclude<PluginMarketplaceCategory, 'all'>;
  status: PluginMarketplaceStatus;
  version: string;
  author: string;
  name: string;
  nameZh: string;
  tagline: string;
  taglineZh: string;
  description: string;
  descriptionZh: string;
  capabilities: string[];
  capabilitiesZh: string[];
  tags: string[];
  actionType: MarketplaceActionType;
}

export const MARKETPLACE_CATEGORIES: MarketplaceCategoryTab[] = [
  { id: 'all', label: 'All', labelZh: '全部' },
  { id: 'device_import', label: 'Device Import', labelZh: '设备导入' },
  { id: 'editing_templates', label: 'Templates', labelZh: '剪辑模板' },
  { id: 'ai_avatar', label: 'Digital Human', labelZh: '数字人口播' },
  { id: 'audio_voice', label: 'Voice & Audio', labelZh: '配音音频' },
  { id: 'workflow', label: 'Automation', labelZh: '自动化流' },
];

export const PLUGIN_MARKETPLACE_CATALOG: MarketplacePluginEntry[] = [
  {
    id: 'dji-wireless-import',
    runtimePluginId: 'dji-wireless-import',
    category: 'device_import',
    status: 'installed',
    version: '1.1.0',
    author: 'Vectrail Official',
    name: 'DJI Wireless Import',
    nameZh: 'DJI 无线素材导入',
    tagline: 'BLE wake + direct camera Wi-Fi offload & auto-import',
    taglineZh: '蓝牙配对唤醒 + 相机 Wi-Fi 高速原片直传与自动入库',
    description:
      'Supports Osmo Pocket 3 / 4 / 4 Pro, Osmo Action 4-6, Osmo Nano and Xtra Edge Pro with resumable HTTP Range transfers, SHA-256 checksums, and direct 192.168.2.1 Wi-Fi mode.',
    descriptionZh:
      '支持 Osmo Pocket 3 / 4 / 4 Pro、Action 4-6、Nano 与 Xtra Edge Pro；支持 HTTP 断点续传、SHA-256 校验及 192.168.2.1 免蓝牙直连模式。',
    capabilities: [
      'BLE wake & pairing + direct Wi-Fi fallback',
      'HTTP Range resume & SHA-256 integrity verification',
      'Simulated mock camera for offline testing',
    ],
    capabilitiesZh: [
      '蓝牙唤醒配对 + 已连热点免蓝牙直连兜底',
      '大文件断点续传与 SHA-256 完整性校验',
      '内置模拟相机，无实机也能测试入库链路',
    ],
    tags: ['BLE', 'Wi-Fi', 'Osmo', 'SHA-256'],
    actionType: 'open_dji',
  },
  {
    id: 'editing-templates-engine',
    category: 'editing_templates',
    status: 'built_in',
    version: '1.1.0',
    author: 'Vectrail Official',
    name: '16/32 Editing Skills & Templates',
    nameZh: '16/32 剪辑技能与模板引擎',
    tagline: 'Composable 32-skill editing recipes inside Magic Studio',
    taglineZh: '内置 16 核心 / 32 全量剪辑技能与 6 套可拼接成片模板',
    description:
      'Combines probe, dead-air trim, beat sync, J/L-cut, B-roll coverage, zoom punch-ins, and pre-delivery QA checks into one-click Magic Studio recipes.',
    descriptionZh:
      '将探针、气口裁剪、BPM 踩点、J/L-Cut、B-Roll 覆盖、跳切轻推与成片自检组合为一键配方，支持直接装配进 Magic 工作台。',
    capabilities: [
      '16 Core + 16 Pro composable editing skills',
      '6 vertical presets (Vlog / Talking Head / 9:16 / Unboxing)',
      'Works with Local, Cloud AI, Codex & Claude backends',
    ],
    capabilitiesZh: [
      '16 核心 + 16 进阶模块化剪辑技能自由拼接',
      '覆盖旅拍 Vlog、口播精剪、9:16 强钩子、开箱评测等 6 套模板',
      '兼容本地规则与云端/Codex/Claude 智能执行',
    ],
    tags: ['16/32 Skills', 'Vlog', '口播', '9:16'],
    actionType: 'open_templates',
  },
  {
    id: 'apple-ios-import',
    category: 'device_import',
    status: 'coming_soon',
    version: 'Roadmap',
    author: 'Vectrail Ecosystem',
    name: 'iPhone / iPad Direct Import',
    nameZh: 'iPhone / iPad 高速素材导入',
    tagline: 'USB cable & local Wi-Fi import for HEVC, ProRes & Apple Log clips',
    taglineZh: '支持 USB 有线与局域网无线导入 HEVC、Apple Log 与 ProRes 原片',
    description:
      'Import original iPhone camera roll videos, Live Photos, and spatial/Apple Log footage directly into Vectrail without iCloud compression or explorer bottlenecks.',
    descriptionZh:
      '绕过 Windows 资源管理器 MTP 断连与 iCloud 压缩限制，高速同步 iPhone 相机胶卷原片、Apple Log 与多机位素材到工程素材库。',
    capabilities: [
      'USB Apple Mobile Device & local Wi-Fi companion transfer',
      'Apple Log / HDR tone-mapping metadata recognition',
      'Incremental import by shoot date & album',
    ],
    capabilitiesZh: [
      'USB 直连与局域网扫码高速传片',
      '自动识别 Apple Log / HDR 色彩空间并匹配还原节点',
      '按拍摄日期/相册增量去重导入',
    ],
    tags: ['iPhone', 'USB', 'Apple Log', 'ProRes'],
    actionType: 'roadmap',
  },
  {
    id: 'digital-human-avatar',
    category: 'ai_avatar',
    status: 'coming_soon',
    version: 'Roadmap',
    author: 'Vectrail Ecosystem',
    name: 'Digital Human Talking-Head Studio',
    nameZh: '数字人口播与画中画工作流',
    tagline: 'Script-to-avatar presenter clips with auto B-Roll & captions',
    taglineZh: '输入文稿或音频自动生成数字人口播画面，并联动 B-Roll 混剪',
    description:
      'Generate consistent talking-head presenter segments on transparent or virtual studio backgrounds, then automatically interleave B-roll and dynamic highlight subtitles.',
    descriptionZh:
      '支持本地/云端数字人形象驱动、绿幕与透明背景口播合成，生成后直接落轨并与 B-Roll 画面、高亮字幕联动排版。',
    capabilities: [
      'Lip-synced talking-head track generation',
      'Auto picture-in-picture & corner presenter layout',
      'Synced word-level caption styling',
    ],
    capabilitiesZh: [
      '文本/语音驱动口型同步的数字人口播片段生成',
      '一键切换全屏口播与角标画中画版式',
      '自动对齐逐词高亮字幕与章节大字卡',
    ],
    tags: ['数字人', '口播', 'Avatar', 'PiP'],
    actionType: 'roadmap',
  },
  {
    id: 'voice-clone-dubbing',
    category: 'audio_voice',
    status: 'coming_soon',
    version: 'Roadmap',
    author: 'Vectrail Ecosystem',
    name: 'AI Voiceover & Multi-Language Dubbing',
    nameZh: 'AI 音色克隆与多语种配音',
    tagline: 'Clone narrator voice, translate scripts, and auto-duck BGM',
    taglineZh: '声音复刻配音、多语种口播译制与 -14 LUFS 自动避让混音',
    description:
      'Create natural voiceovers from scripts or translate existing speech tracks while preserving speaker timbre and timeline pacing.',
    descriptionZh:
      '根据脚本生成拟真旁白或将原片口播译制为多国语言，自动匹配原有时间轴节奏并联动音乐避让。',
    capabilities: [
      'Short-sample voice cloning & emotion control',
      'Multi-language dubbing synced to subtitle cues',
      'Broadcast -14 LUFS loudness normalization',
    ],
    capabilitiesZh: [
      '短样本音色克隆与语速情绪调节',
      '按字幕时间轴精准对齐的多语种译制配音',
      '自动完成人声压缩与背景音乐避让',
    ],
    tags: ['TTS', '音色克隆', '多语种', 'LUFS'],
    actionType: 'roadmap',
  },
  {
    id: 'podcast-batch-pipeline',
    category: 'workflow',
    status: 'coming_soon',
    version: 'Roadmap',
    author: 'Vectrail Ecosystem',
    name: 'Watch-Folder Batch Rough-Cut',
    nameZh: '监听文件夹批量粗剪流水线',
    tagline: 'Auto-ingest new footage, trim silences & export 16:9 + 9:16',
    taglineZh: '自动监听导入新素材，一键完成去气口、套模板与横竖双端派生',
    description:
      'Drop raw shoots into a watched folder to automatically run ASR transcription, dead-air removal, template assembly, and multi-aspect exports.',
    descriptionZh:
      '将拍摄素材拖入监听目录后自动触发转写、废片剔除、模板套剪与 16:9 / 9:16 多端并行导出。',
    capabilities: [
      'Folder watcher with preset template binding',
      'Batch 16:9 & 9:16 smart reframe export',
      'Pre-export black-frame & audio clipping QA gate',
    ],
    capabilitiesZh: [
      '监听目录自动绑定指定 16/32 剪辑模板',
      '一次生成横屏与竖屏安全区双版本成片',
      '导出前自动拦截黑场、轨道空隙与音频削波',
    ],
    tags: ['Batch', 'Watch Folder', '16:9 + 9:16'],
    actionType: 'roadmap',
  },
];

export function filterMarketplacePlugins(
  catalog: MarketplacePluginEntry[],
  category: PluginMarketplaceCategory,
  query: string
): MarketplacePluginEntry[] {
  const q = query.trim().toLowerCase();
  return catalog.filter((item) => {
    if (category !== 'all' && item.category !== category) return false;
    if (!q) return true;
    const haystack = [
      item.id,
      item.name,
      item.nameZh,
      item.tagline,
      item.taglineZh,
      item.description,
      item.descriptionZh,
      ...item.tags,
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}
