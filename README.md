# BackupHub

通过 USB（ADB 协议）连接安卓手机，将短信、通话记录、通讯录、照片、视频备份到本地的 Tauri + Rust 桌面应用。支持多设备、多时间点备份管理，采用现代化卡片式界面。

## 功能

- **设备连接**：自动检测 USB 连接的安卓设备，获取型号/序列号/制造商，实时轮询连接状态，未授权时给出友好提示。
- **短信/通话/通讯录备份**
  - 短信：对方号码、内容、时间戳、类型（发送/接收）、已读状态，覆盖 SMS 与 MMS。
  - 通话记录：号码、类型（呼入/呼出/未接/拒接）、时长、时间。
  - 通讯录：姓名、多个号码、邮箱、备注。
  - 备份过程实时显示进度，后台线程不卡 UI。
- **照片/视频备份**
  - 文件系统 `find` + `stat` 全盘扫描（覆盖 MediaStore 不索引的 `Android/data` 等目录）。
  - 按设备原目录分类列出，勾选要备份的目录，`adb pull` 整目录拉取。
  - 流式进度（adb stderr 百分比实时推送，仅百分比变化时发事件不刷屏）。
- **统一备份目录结构**：
  ```
  <备份根>/<设备名>/<yyyyMMdd_HH_mm_ss>/<COMM|PHOTO|VIDEO>/
  ```
  - `COMM`：短信/通话/通讯录（meta.json + sms.json + calls.json + contacts.json）
  - `PHOTO`/`VIDEO`：按设备原目录结构存放
  - 备份根可在设置中自定义，默认 exe 同级 `Back_File`（不可写回退 AppData）。
  - 索引（index.json/devices.json）也在备份根内，整个目录可整体搬走。
- **数据浏览**：
  - 短信以会话视图展示（按号码分组，类微信气泡，上滑加载更早/跳最早最新）。
  - 通话用图标区分类型，通讯录以姓名+号码卡片展示。
  - 支持关键词搜索、分页。
- **设备管理**：卡片展示所有备份过的设备，点击进入该设备备份历史。
- **导入**：可将外部 JSON 备份文件夹导入到当前备份库（自动重新索引）。

## 技术栈

- 前端：TypeScript + Vite（无框架，原生 SPA）
- 后端：Rust + Tauri 2
- 设备通信：ADB（`adb shell` 执行 `find`/`stat`/`content query`/`getprop`/`pull`）

## 前置要求

- [Node.js](https://nodejs.org/) 18+ 与 npm
- [Rust](https://www.rust-lang.org/) 工具链
- [ADB](https://developer.android.com/studio/releases/platform-tools)（需在 PATH，或在应用「设置」中手动指定 `adb.exe` 路径）
- 安卓手机已开启「USB 调试」并用数据线连接

## 运行

```bash
npm install
npm run tauri dev      # 开发模式
npm run tauri build    # 打包发布
```

## 说明

- 短信/通话/通讯录通过 `adb shell content query` 读取内容提供者；照片/视频通过 `find` + `stat` 全盘扫描。
- 备份数据默认存在 exe 同级 `Back_File/` 下，可在设置中改为任意目录。
- 部分厂商 ROM 可能限制 shell 访问某些 content provider，应用会以友好提示降级。

## 推荐 IDE

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
