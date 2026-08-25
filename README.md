# BackupHub

通过 USB（ADB 协议）连接安卓手机，将短信、通话记录、通讯录备份到本地的 Tauri + Rust 桌面应用。支持多设备、多时间点快照管理与数据导出，采用现代化卡片式界面。

## 功能

- **设备连接**：自动检测 USB 连接的安卓设备，获取型号 / 序列号 / 制造商，实时轮询连接状态，未授权时给出友好提示。
- **数据备份**
  - 短信：对方号码、内容、时间戳、类型（发送 / 接收）、已读状态，覆盖 SMS 与 MMS。
  - 通话记录：号码、类型（呼入 / 呼出 / 未接 / 拒接）、时长、时间。
  - 通讯录：姓名、多个号码、邮箱、备注。
  - 新建备份自动填充当前设备信息，可自定义设备名称与备份备注，过程实时显示进度。
- **数据管理**：每备份生成独立快照（含时间、设备信息、各类统计），按设备筛选历史，支持删除快照与导出 CSV / JSON。
- **数据浏览**：短信以对话气泡展示，通话用图标区分类型，通讯录以姓名 + 号码卡片展示，支持关键词搜索、时间筛选与分页。
- **设备管理**：卡片展示所有备份过的设备，显示型号、自定义名称、最近备份时间、总备份次数，点击进入历史页。

## 技术栈

- 前端：TypeScript + Vite（无框架，原生 SPA）
- 后端：Rust + Tauri 2
- 设备通信：ADB（`adb shell content query` 查询内容提供者）

## 前置要求

- [Node.js](https://nodejs.org/) 18+ 与 npm
- [Rust](https://www.rust-lang.org/) 工具链
- [ADB](https://developer.android.com/studio/releases/platform-tools)（需在 PATH，或在应用「设置」中手动指定 `adb.exe` 路径）
- 安卓手机已开启「USB 调试」并用数据线连接

## 运行

```bash
npm install        # 安装前端依赖
npm run tauri dev  # 开发模式启动
npm run tauri build # 打包发布
```

## 说明

- 数据通过 `adb shell content query` 读取 `content://sms`、`content://call_log/calls`、`content://com.android.contacts/data`，部分厂商 ROM 可能限制 shell 访问，应用会以友好提示降级，不会崩溃。
- 备份数据保存在系统应用数据目录的 `BackupHub/` 下。

## 推荐 IDE

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
