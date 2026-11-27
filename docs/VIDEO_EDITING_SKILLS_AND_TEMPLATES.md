# Vectrail 视频剪辑能力评估、行业 Skills 调研与 16/32 技能拼接模板方案

## 1. 当前 Vectrail 能不能「剪辑好」？（客观能力诊断）

基于对 `src/shared/localMagic.ts`、`src/shared/autoPlanner.ts`、`src/main/mcp/tools.ts`、`src/main/engine/analyzer.ts` 与 `src/main/engine/exporter.ts` 的直接代码审查：

- **已经具备的强项底座**：
  - **实时合成与导出管线**：WebGL2 实时预览 + FFmpeg 无损/重编码导出 + 45 个 MCP 时间轴工具（片段放置/裁剪/分割/字幕/调色/音画分离/缩放动效/抽帧查看 `get_frame`）。
  - **基础规则自动剪辑**：`autoPlanner.ts` 已能基于清晰度、曝光、色彩、人脸、运动惩罚与音乐 BPM 节拍对齐自动拼接蒙太奇。
- **目前无法稳定「剪辑好」的 4 个关键缺口**：
  1. **缺少结构化叙事模板**：此前仅有 `Modals.tsx` 中的 9 条单句提示词（`IDEAS_*`），没有「钩子开场 → 铺垫 → B-Roll 覆盖 → 高潮 → 收尾」的节奏骨架。
  2. **口播语义精剪链路未闭环**：虽然内置 Whisper 转写，但缺少自动「去长静音气口 + 删口癖水词 + 跳切处轻推景别遮瑕」的端到端默认策略。
  3. **缺少成片质检闭环（Verify Loop）**：`localMagic` 执行后不会像 `ffmpeg-skill` 那样自动核验黑帧、轨道空隙、响度（-14 LUFS）与竖屏安全区。
  4. **原子剪辑技能未模块化**：无法将「探针 → 口播精剪 → 踩点 → B-Roll → 字幕 → QA」像积木一样按场景组合成可复用配方。

## 2. 全网（GitHub / 微信公众号 / X）视频剪辑 Skills 与模板调研总结

### A. GitHub 开源生态（原子工具 + 配方化工作流）
1. **`kajisho5/ffmpeg-skill`（42 个原子工具）**
   - 核心思想：**`probe → edit (lossless first) → check → verify`**。把裁剪、合并、横竖屏重构、去静音、响度归一化（`-14 LUFS`）、B-Roll、多机位切机、画质抽帧检查拆成 42 个可组合 CLI/MCP 工具，并用 `render.py --template` 固化多步骤配方。
2. **`JuneYaooo/capsule-cinema` & `awesome-ai-media-skills-cn`**
   - 核心思想：**「视频配方（Capsule）」分离结构与单次素材**。配方保存栏目结构、分镜规则、质检合同与返工经验，支持单镜头局部返工与发布前 QA 阻断门。
3. **`vargHQ/awesome-ai-video-agents`（933 Cards）& `code2video-templates`**
   - 核心思想：将视频工作流拆为 Finder / Generator / Motion / Captions / Voice / Delivery 卡片，通过 JSON/React/HyperFrames 代码化模板实现确定性复用。
4. **`clonn/awesome-agent-video-skills`（184 个仓库索引）**
   - 收录了 `OpenMontage`、`hyperframes`、`video-shotcraft`（分镜配方卡）、`FireRed-OpenStoryline`（对话式规划 + 风格技能复用）、`chengfeng-videocut-skills` 等代表项目。
5. **`affaan-m/ECC` (`video-editing`) & `huangserva/servasyy_skills`（14 模块）**
   - 强调把 AI 剪辑拆成独立 `SKILL.md` 模块（脚本、配音、字幕、Remotion 包装、FFmpeg 处理），按任务动态拼接。

### B. 微信公众号与中文创作者社区
- **口播粗剪流（`videocut-skills` / `chengfeng-videocut-skills`）**：聚焦「转写 → 识别气口/口误/重复句 → 生成可审片段 → 一键粗剪 → 校对字幕与重点字动画」，切中知识博主与带货口播 80% 耗时痛点。
- **剪映草稿自动化流（`jianying-editor-skill` / `capcut-mate` / `capcut-agent`）**：通过自然语言或 MCP 自动搭时间轴、批插转场、贴纸、BGM 与花字模板。

### C. X（Twitter）热门实践
- **`video-use`（@browser_use 团队）**：让 Coding Agent 直接「看懂/读懂」原始视频素材并完成长视频切分、去废话与成片输出。
- **多风格同源复刻（6 风格模板法）**：同一段口播/素材可一键切换「杂志感 / 冲击大字 / 极简知识 / 新闻快报 / 电影感 / 开箱评测」6 套视觉与节奏配方。

## 3. 16 核心 / 32 全量模块化剪辑 Skills 拼接架构

已在 Vectrail `src/shared/editingTemplates.ts` 落地 **16 个核心技能 + 16 个进阶/质检技能 = 32 技能库**，覆盖 6 大阶段：

| 阶段 | 核心 16 技能（Core 16） | 进阶 16 技能（Pro 32 扩展） |
| --- | --- | --- |
| **1. 探针与筛选** | `#1` 素材探针与色彩识别、`#2` 画面质量与景别评分、`#3` 重复与废片剔除 | `#17` 大疆 D-Log M / HLG 还原、`#18` 景别与运镜多样性配比 |
| **2. 音频与口播** | `#4` 逐词 ASR 转写、`#5` 气口静音裁剪、`#6` 口癖水词精剪、`#7` -14 LUFS 响度均衡、`#8` BGM 避让 | `#19` 高能金句切片提取 |
| **3. 结构与节奏** | `#9` BPM 节拍踩点、`#10` 前 3 秒黄金钩子、`#11` J-Cut / L-Cut 错位 | `#20` 多机位切机、`#21` 语义 B-Roll 覆盖、`#22` 曲线变速/延时、`#23` 四拍叙事弧线 |
| **4. 构图与动效** | `#12` 多画幅智能重构图、`#13` 跳切轻推与 Ken Burns | `#24` 地平线防抖稳像、`#25` 画中画双屏对照、`#26` 定格放大与重点标注 |
| **5. 调色与包装** | `#14` 统一影调与曝光匹配、`#15` 动态高亮字幕 | `#27` 章节与冲击大字卡、`#28` 克制型叠化/黑场转场、`#29` 转场音效点缀 |
| **6. 质检与交付** | `#16` 成片抽帧与交付自检 | `#30` 抖音/Reels 安全区避让、`#31` 黑场空隙巡检、`#32` 一稿多端派生 |

## 4. 已内置的 6 套可拼接剪辑模板（已在 Magic 工作台上线）

1. **DJI 旅拍高光踩点 Vlog**（12 Skills · 16:9）：`#1 → #2 → #3 → #18 → #9 → #10 → #22 → #14 → #28 → #27 → #8 → #31`
2. **口播精剪与节奏强化**（14 Skills · 9:16）：`#1 → #4 → #5 → #6 → #10 → #11 → #21 → #13 → #12 → #7 → #8 → #15 → #30 → #16`
3. **爆款 9:16 强钩子快剪**（11 Skills · 9:16）：`#1 → #2 → #10 → #9 → #12 → #13 → #14 → #27 → #7 → #30 → #31`
4. **开箱评测四拍模板**（16 Skills 全核心链路 · 16:9）：涵盖探针、口播裁剪、四拍叙事、B-Roll 覆盖、定格标注、统一影调与 QA
5. **播客访谈金句切片**（10 Skills · 9:16）：金句提取 + 静音精简 + 竖屏重构 + 响度均衡 + 避让字幕
6. **电影感舒缓叙事短片**（10 Skills · 16:9）：长镜头呼吸感 + 景别错落 + 克制叠化 + 胶片冲印影调
