# DJI 无线素材导入插件（`dji-wireless-import`）选型、架构与验收报告

## 1. 开源项目对比与选型结论

| 项目 | GitHub 地址 | 协议 / 语言 | Windows 兼容性 | 真实能力核实 | 选型结论 |
| --- | --- | --- | --- | --- | --- |
| **OsmoOffload** | `intermittech/OsmoOffload` | **MIT** / Python 3.13 + `bleak` | 原生 Windows 10/11（WinRT BLE + `netsh wlan` + `CREATE_NO_WINDOW`） | 已核实：BLE 配对唤醒、WPA2 Wi-Fi 加入与恢复、UDP 9004/10004 Datalink、HTTP `/v2` Range 断点下载、hash 校验 | **核心协议与 Windows 侧车蓝本** |
| **osmosis** | `KonradIT/osmosis` | **MIT** / Kotlin (Android) | 协议文档通用 | 提供完整 `MEDIA_PROTOCOL.md`：BLE GATT `fff4`/`fff5` 握手与 MTU 500、DUML 帧格式、各机型端口与句柄规律 | **底层协议规范权威参考** |
| **Osmotic** | `smithplus/Osmotic` | **Other (NOASSERTION)** / Swift | 仅 macOS（SwiftUI + CoreBluetooth） | 仅适配 macOS，且许可证为自定义 `Other` | **排除**（不兼容 Windows 且商用合规不明确） |
| **osmo-client-windows** | `luisreysan/osmo-client-windows` | 仓库返回 `301 Moved Permanently` | 未知 | 无法直接获取稳定源码与维护状态 | **排除** |

**综合选型**：基于 **MIT 协议** 的 `OsmoOffload` 与 `KonradIT/osmosis` `MEDIA_PROTOCOL.md`，采用 **TypeScript 插件内核 + Node 流式 HTTP 断点下载 + Python `bleak` Windows 侧车** 的混合架构。

## 2. 插件架构与八大解耦模块

插件标识为 `dji-wireless-import`，通过 `src/main/plugins/manager.ts`（`PluginManager`）以最小侵入方式接入 Vectrail，支持独立启用/禁用与异常隔离（插件异常不会影响主剪辑程序）：

1. **设备发现与型号解析**（`src/main/plugins/dji-wireless-import/models.ts`、`plugins/dji-wireless-import/dji_sidecar.py`）
2. **蓝牙配对与鉴权**（`dji_sidecar.py` 实现 `fff4`/`fff5` 订阅、`01 00` arming、`0x07/0x45` 配对与 `0x07/0x46` 确认）
3. **Wi-Fi 连接与双网卡检测**（`src/main/plugins/dji-wireless-import/wifiManager.ts` + `dji_sidecar.py` 的 `netsh wlan` 无弹窗调用及 Windows 定位服务关闭时的 DHCP 回退）
4. **DJI DUML 协议编解码**（`src/main/plugins/dji-wireless-import/duml.ts`：CRC8/CRC16、`DumlFrameParser`、CompositePack Manifest 重组）
5. **远程媒体索引**（`duml.ts` `decodeManifestBuffer` + `service.ts` 查重标记）
6. **流式断点下载队列**（`src/main/plugins/dji-wireless-import/downloadQueue.ts`：并发上限 1–2、`.part` 临时文件、`Range: bytes=` 续传、实时速度与 ETA）
7. **完整性校验与历史去重**（`src/main/plugins/dji-wireless-import/integrity.ts`：流式 SHA-256 与字节长度校验、原子重命名、`history.json`）
8. **Vectrail 媒体库导入**（`src/main/plugins/dji-wireless-import/libraryImporter.ts`：调用 `ProjectStore.importFiles` 原片无损导入）

## 3. 第三方依赖与许可证清单

- **主程序新增依赖**：无新增 npm 第三方运行时依赖（HTTP 下载与 SHA-256 校验直接使用 Node.js 内置 `http`、`crypto`、`fs`、`child_process`）。
- **Windows 侧车可选运行时**：Python 3.10+ 与 `bleak>=3.0`（MIT License，用于 Windows WinRT 蓝牙 LE 扫描与 GATT 通信）。
- **协议参考来源**：`intermittech/OsmoOffload`（MIT License）、`KonradIT/osmosis`（MIT License）。

## 4. 支持设备型号与兼容性矩阵

| 机型 | Model ID | BLE 本地名前缀 | Datalink UDP | TCP-7001 Poke | Wi-Fi | 协议支持状态 |
| --- | --- | --- | --- | --- | --- | --- |
| Osmo Pocket 4 Pro | `0x0022` (ProdType `218`) | `OsmoPocket4P` | `9004` | 是 | WPA2 | 已协议适配（待实机确认） |
| Osmo Pocket 4 | `0x0021` | `OsmoPocket4` | `9004` | 是 | WPA2 | 已协议适配（待实机确认） |
| Osmo Pocket 3 | `0x0020` | `OsmoPocket3` | `9004` | 是 | WPA2 | 已协议适配（待实机确认） |
| Osmo Action 6 | `0x0018` | `OsmoAction6` | `9004` | 是 | WPA2 | 已协议适配（待实机确认） |
| Osmo Action 5 Pro | `0x0015` | `OsmoAction5Pro` | `9004` | 是 | WPA2 | 已协议适配（待实机确认） |
| Xtra Edge Pro | `0x0015` | `XtraEdgePro` | `10004` | 否 | WPA2 | 已协议适配（待实机确认） |
| Osmo Action 4 / 3 / 2 / 1 | `0x0014`/`12`/`10`/`06` | `OsmoAction*` | `9004` | 是 | WPA2 | 4 已文档确认；1-3 为回退适配 |
| Osmo Nano | `0x0019` | `OsmoNano` | `9004` | 是 | WPA2 | 单机身存储适配（待实机确认） |
| Osmo 360 | `0x0017` | `Osmo360` | `9004` | 是 | **WPA3** | **已知限制**：上游确认其热点与 `fff7` 暂不可用 |

## 5. Windows 双网卡与安装使用说明

- **环境前提**：Windows 10/11 需具备蓝牙 LE 与支持 5 GHz 的无线网卡；若要扫描真实相机，需本机 Python 安装 `bleak`（`pip install bleak`）。
- **网络共存说明**：相机热点本身无互联网接入。若电脑同时插有网线（以太网），Windows 会保持外网不断；若为单无线网卡笔记本，连入相机热点期间会暂时断外网，断开相机后插件可自动恢复原 Wi-Fi。
- **内置模拟验证**：点击媒体库右上角 Wi-Fi 图标（或空状态「从 DJI 相机导入」）打开导入弹窗，支持点击「模拟相机测试」直接验证浏览、筛选、断点续传、校验与入库全流程。

## 6. 测试与验证状态（明确区分模拟测试与实机测试）

- **自动化模拟测试（已通过，非实机硬件）**：
  - DUML CRC8/CRC16、流式帧重组、`0x00/0x27` Manifest 解析、经典与 Pocket 4 Pro 新版广播格式解析。
  - `MockDjiCameraServer` 模拟相机：HTTP `/v2` 下载、`.part` `Range 206` 断点续传、SHA-256 校验、重复导入去重、自动入库 `ProjectStore`、插件禁用故障隔离。
- **最小化实机验证清单（需真机执行）**：
  1. 本机执行 `pip install bleak` 并打开 Windows 蓝牙、定位权限。
  2. 开机 DJI Osmo Pocket 3/4/Action 4/5/6，点击「扫描附近 DJI 相机」确认可识别正确型号。
  3. 首次连接时在相机屏幕点击确认授权，核对自动连入相机 Wi-Fi 后是否拉出完整媒体列表。
  4. 勾选 1 个 1GB+ 大视频与 1 张照片下载，确认速度、ETA、校验及自动进入时间轴素材库，并在断开后恢复原 Wi-Fi。

## 7. 已知问题与后续优化

- `dji_sidecar.py` 当前面向 P0 核心列表与下载链路，尚未内置远程缩略图拉取（P1）与独立打包嵌入式 Python runtime（当前复用系统 Python 3.12 + `bleak`）。
- `Osmo 360` 因 WPA3 与 AP 上游限制暂标记为不支持。
