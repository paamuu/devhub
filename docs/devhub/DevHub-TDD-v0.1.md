# DevHub 技术设计文档（TDD）

-   文档版本：0.1
-   状态：已纳入 M0 评审决策，待原型与技术验证
-   对应 PRD：DevHub PRD 0.1
-   技术基线：Electron + LitElement + TypeScript + Vite + SQLite + Git CLI / simple-git
-   架构原则：Local-First、分层、适配器、最小权限
-   首发平台：Windows

------------------------------------------------------------------------

## 1. 文档目的

本文档描述 DevHub 的技术架构、进程边界、前端组织方式、IPC
契约、数据模型、模板复制、预览进程、Git 集成、错误处理和测试策略。

当前阶段只完成技术设计，不创建 Electron 工程，不编写应用代码。

## 2. 技术选型

  领域       技术方案                         说明
  ---------- -------------------------------- -----------------------
  桌面容器   Electron                         主进程管理系统能力
  UI         LitElement                       Web Components 组件化
  语言       TypeScript                       前后端共享类型
  构建       Vite                             Renderer 开发和构建
  数据库     SQLite                           本地持久化
  ORM        Drizzle ORM（候选）              类型化查询和迁移
  数据校验   Zod                              IPC 输入和配置校验
  路由       Vaadin Router / 自定义（待定）   Renderer 页面路由
  Context    @lit/context                     依赖和应用级状态注入
  异步状态   @lit/task（可选）                组件异步任务
  Git        Git CLI + simple-git             Git 操作封装
  子进程     child_process / execa            命令和预览进程
  日志       Pino                             主进程结构化日志
  打包       electron-builder                 桌面安装包

选型约束：

-   LitElement 负责 Renderer，不引入 Vue/React。
-   不使用 Pinia；状态采用 Lit Reactive Properties、Reactive Controllers
    和必要的 Context。
-   simple-git 是 Git CLI 的调用封装，不是 Git 数据源的替代品。
-   SQLite 是本地元数据数据库，不存储项目源码文件。
-   具体依赖版本在工程初始化时按当时稳定版本锁定，并提交 lockfile。

## 3. 总体架构

``` mermaid
flowchart TB
    subgraph Renderer["Renderer Process"]
        APP["app-shell"]
        ROUTER["Router / Pages"]
        COMPONENTS["Lit Components"]
        CONTROLLERS["Reactive Controllers"]
        CLIENT["Typed API Client"]
        APP --> ROUTER
        ROUTER --> COMPONENTS
        COMPONENTS --> CONTROLLERS
        COMPONENTS --> CLIENT
    end

    PRELOAD["Preload / contextBridge"]
    IPC["Validated IPC Boundary"]

    subgraph Main["Electron Main Process"]
        APP_SERVICE["Application Services"]
        TEMPLATE["Template Service"]
        PROJECT["Project Service"]
        PREVIEW["Preview Manager"]
        GIT["Git Service"]
        SETTINGS["Settings / Backup"]
        DB["SQLite Repositories"]
        FS["File System Adapter"]
        PROCESS["Process Adapter"]
        GITCLI["Git CLI Adapter"]
        APP_SERVICE --> TEMPLATE
        APP_SERVICE --> PROJECT
        APP_SERVICE --> PREVIEW
        APP_SERVICE --> GIT
        APP_SERVICE --> SETTINGS
        TEMPLATE --> FS
        PROJECT --> FS
        TEMPLATE --> DB
        PROJECT --> DB
        SETTINGS --> DB
        PREVIEW --> PROCESS
        GIT --> GITCLI
    end

    CLIENT --> PRELOAD --> IPC --> APP_SERVICE
```

### 3.1 分层职责

**Renderer**

-   LitElement 页面和 UI 组件。
-   用户交互、表单验证和视图状态。
-   通过 Typed API Client 请求主进程。
-   不直接访问文件系统、SQLite、Git CLI 或 Node.js 子进程。

**Preload**

-   使用 `contextBridge` 暴露受限 API。
-   只允许调用明确列出的 IPC 通道。
-   对事件订阅返回可取消的 unsubscribe 函数。
-   不暴露 `ipcRenderer`、`require` 或通用命令执行入口。

**Main**

-   应用生命周期和窗口管理。
-   IPC 请求验证和授权。
-   领域服务。
-   数据库、文件系统、Git 和子进程适配器。
-   日志和错误处理。

**Infrastructure**

-   SQLite Repository。
-   FileSystem Adapter。
-   Git Adapter。
-   Process Adapter。
-   外部浏览器和 IDE Launcher。

### 3.2 依赖方向

-   Renderer 只依赖共享 DTO 和 API Client。
-   Domain Service 不直接依赖 Electron IPC。
-   Domain Service 通过接口依赖文件系统、Git、进程等端口。
-   Adapter 实现具体系统调用。
-   数据库 Repository 不承载复杂业务流程。
-   Main 持有应用状态和系统权限。复制、扫描和 Git 调用异步执行。通过目标 Windows 安装包验证大目录操作、同步 SQLite 查询及迁移对响应的影响，必要时将耗时数据库任务移出 Main 事件循环。

## 4. 推荐工程目录

``` text
devhub/
├── electron/
│   ├── main/
│   │   ├── index.ts
│   │   ├── app/
│   │   ├── ipc/
│   │   │   ├── register-handlers.ts
│   │   │   ├── validators/
│   │   │   └── handlers/
│   │   ├── domain/
│   │   │   ├── template/
│   │   │   ├── project/
│   │   │   ├── preview/
│   │   │   └── git/
│   │   ├── services/
│   │   ├── adapters/
│   │   │   ├── filesystem/
│   │   │   ├── process/
│   │   │   ├── git/
│   │   │   └── shell/
│   │   ├── database/
│   │   │   ├── schema/
│   │   │   ├── migrations/
│   │   │   └── repositories/
│   │   └── logging/
│   │
│   └── preload/
│       ├── index.ts
│       └── api/
│
├── src/
│   ├── app/
│   │   ├── app-shell.ts
│   │   ├── app-router.ts
│   │   └── app-context.ts
│   ├── pages/
│   │   ├── dashboard-page.ts
│   │   ├── templates-page.ts
│   │   ├── projects-page.ts
│   │   ├── project-detail-page.ts
│   │   └── settings-page.ts
│   ├── components/
│   │   ├── common/
│   │   ├── template/
│   │   ├── project/
│   │   ├── preview/
│   │   └── git/
│   ├── controllers/
│   ├── services/
│   │   └── api-client.ts
│   ├── styles/
│   ├── types/
│   └── main.ts
│
├── shared/
│   ├── contracts/
│   ├── dto/
│   ├── schemas/
│   └── constants/
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
│
├── package.json
├── vite.config.ts
└── tsconfig.json
```

目录是逻辑建议。实际初始化时可按依赖规模调整，但
Renderer、Preload、Main、Shared 的安全边界必须保留。

## 5. Renderer：LitElement 设计

### 5.1 组件组织

-   Page：路由页面，负责组合组件和页面级流程。
-   Component：可复用 UI 单元，例如
    `template-card`、`project-row`、`preview-log-viewer`。
-   Reactive
    Controller：封装可复用的状态和生命周期逻辑，例如项目列表加载、预览订阅、Git
    状态刷新。
-   Context：提供只读应用服务或轻量依赖，不作为任意全局状态容器。
-   API Client：统一封装 Preload 暴露的接口。

### 5.2 状态管理原则

不引入 Vue、React 或 Pinia 状态体系。

建议分层：

1.  **组件局部状态**：使用 Lit 的 `@state()`。
2.  **组件输入**：使用
    `@property()`，对象属性使用属性绑定而非字符串属性。
3.  **可复用异步状态**：使用 Reactive Controller；必要时评估
    `@lit/task`。
4.  **跨组件依赖**：使用 `@lit/context` 提供 API
    Client、主题和应用设置。
5.  **服务端/主进程状态**：通过 IPC 请求或事件订阅获得，不在 Renderer
    自行推断。

避免把所有项目、模板、日志都长期保存在一个全局对象中。列表按需加载，日志使用有界缓存。

应用级 Controller 持有 Dashboard 与项目详情共同使用的会话摘要。日志 Controller 按 `sessionId` 订阅，连接时接收快照并按序号合并后续事件，断开时退订。路由参数变化后丢弃旧请求结果。关键页面原型验证键盘导航、可见焦点、对话框关闭后的焦点返回、长路径与暂停日志滚动。

### 5.3 组件事件

-   组件向上层发出语义化 `CustomEvent`。
-   事件名采用 kebab-case，例如
    `template-open`、`project-create-request`。
-   跨进程事件必须经过 Preload API，不直接把 DOM Event 传给 IPC。
-   组件不直接调用 Git 或文件系统实现。

### 5.4 样式体系

建立 CSS Custom Properties 作为主题 Token：

-   颜色：canvas、surface、text、muted、border、accent、danger、success。
-   间距：统一 spacing scale。
-   圆角：少量有层级的 radius token。
-   字体：UI 字体和等宽字体分离。
-   焦点：统一 focus ring。
-   状态：hover、active、disabled、loading、error。

遵循 Anthropic `frontend-design`
的设计理念，先完成视觉方向和关键页面设计，再抽象组件。初始 Developer
Workbench 方向以专业、克制、清晰、高信息可读性为原则。具体颜色和字体属于
PRD 中的初始提案，必须经 UI 原型验证。

## 6. Preload 与 IPC 设计

### 6.1 安全配置

BrowserWindow 建议配置：

-   `contextIsolation: true`
-   `nodeIntegration: false`
-   `sandbox: true`，验证沙箱 Preload 在 Windows 安装包中可用。
-   使用受限 Preload。
-   不启用远程模块。
-   不向 Renderer 暴露任意文件系统 API 或通用 `execute(command)`。

IPC Handler 必须校验：

-   sender 是否为预期应用窗口的可信主 frame。开发态与打包态分别配置可信来源，限制导航和新窗口。
-   输入 DTO 是否通过 Zod schema。
-   路径是否符合对应操作的授权范围。
-   请求是否允许在当前应用状态下执行。
-   删除目录、启动或重启项目、修改 Git Remote 和恢复备份须由 Main 校验确认与实际参数一致。记录路径或启动配置发生变化后重新确认。目录选择通过 Main 的系统对话框完成。

### 6.2 API 契约建议

Preload API 采用领域分组：

``` ts
interface DevHubAPI {
  template: {
    list(query?: TemplateQuery): Promise<Result<TemplateDTO[]>>;
    get(id: string): Promise<Result<TemplateDTO>>;
    import(input: ImportTemplateDTO): Promise<Result<TemplateDTO>>;
    create(input: CreateTemplateDTO): Promise<Result<TemplateDTO>>;
    update(input: UpdateTemplateDTO): Promise<Result<TemplateDTO>>;
    removeRecord(id: string): Promise<Result<void>>;
    deleteDirectory(input: ConfirmedEntityDirectoryDTO): Promise<Result<void>>;
    relink(input: RelinkTemplateDTO): Promise<Result<TemplateDTO>>;
  };

  project: {
    list(query?: ProjectQuery): Promise<Result<ProjectDTO[]>>;
    get(id: string): Promise<Result<ProjectDTO>>;
    import(input: ImportProjectDTO): Promise<Result<ProjectDTO>>;
    createFromTemplate(input: CreateProjectFromTemplateDTO): Promise<Result<OperationHandleDTO>>;
    update(input: UpdateProjectDTO): Promise<Result<ProjectDTO>>;
    removeRecord(id: string): Promise<Result<void>>;
    deleteDirectory(input: ConfirmedEntityDirectoryDTO): Promise<Result<void>>;
    relink(input: RelinkProjectDTO): Promise<Result<ProjectDTO>>;
    setArchived(input: SetProjectArchivedDTO): Promise<Result<ProjectDTO>>;
    openFolder(id: string): Promise<Result<void>>;
    openInIDE(id: string): Promise<Result<void>>;
  };

  preview: {
    getConfig(projectId: string): Promise<Result<PreviewConfigDTO>>;
    saveConfig(input: SavePreviewConfigDTO): Promise<Result<PreviewConfigDTO>>;
    start(input: ConfirmedPreviewStartDTO): Promise<Result<PreviewSessionDTO>>;
    stop(sessionId: string): Promise<Result<void>>;
    restart(input: ConfirmedPreviewRestartDTO): Promise<Result<PreviewSessionDTO>>;
    getStatus(projectId: string): Promise<Result<PreviewStatusDTO>>;
    listSessions(): Promise<Result<PreviewSessionDTO[]>>;
    openPreview(projectId: string): Promise<Result<void>>;
    getLogs(sessionId: string): Promise<Result<PreviewLogSnapshotDTO>>;
    onLog(sessionId: string, callback: (event: PreviewLogEvent) => void): () => void;
    onStatus(callback: (event: PreviewStatusEvent) => void): () => void;
  };

  git: {
    inspect(projectId: string): Promise<Result<GitSummaryDTO>>;
    addRemote(input: AddRemoteDTO): Promise<Result<void>>;
    updateRemote(input: UpdateRemoteDTO): Promise<Result<void>>;
    removeRemote(input: RemoveRemoteDTO): Promise<Result<void>>;
    getStatus(projectId: string): Promise<Result<GitStatusDTO>>;
    openRemote(input: OpenRemoteDTO): Promise<Result<void>>;
  };

  operations: {
    listRecoverable(): Promise<Result<OperationStatusDTO[]>>;
    get(operationId: string): Promise<Result<OperationStatusDTO>>;
    cancel(operationId: string): Promise<Result<void>>;
    resumeProjectRegistration(operationId: string): Promise<Result<ProjectDTO>>;
    onUpdate(operationId: string, callback: (event: OperationEventDTO) => void): () => void;
  };

  dialogs: {
    selectDirectory(input: SelectDirectoryDTO): Promise<Result<DirectorySelectionDTO>>;
  };

  environment: {
    get(projectId: string): Promise<Result<ProjectEnvironmentDTO>>;
    save(input: SaveProjectEnvironmentDTO): Promise<Result<void>>;
    setSecret(input: WriteProjectSecretDTO): Promise<Result<void>>;
    removeSecret(input: RemoveProjectSecretDTO): Promise<Result<void>>;
  };

  settings: {
    get(): Promise<Result<AppSettingsDTO>>;
    update(input: UpdateAppSettingsDTO): Promise<Result<AppSettingsDTO>>;
    backup(): Promise<Result<BackupResultDTO>>;
    restore(input: ConfirmedRestoreBackupDTO): Promise<Result<void>>;
  };
}
```

以上是逻辑 API 草案，不是最终实现代码。实际 DTO 应使用统一 ID
类型、明确可选字段，并由 `shared/contracts` 维护。

`deleteDirectory` 将目录移入系统回收站并保留登记记录。`removeRecord` 只移除登记记录。环境变量读取 DTO 返回普通值、密钥引用及配置状态。密钥写入接口为单向输入，返回值与错误详情均禁止回显密钥。Remote 修改与打开接口需要明确原 Remote 名称或目标 Remote 名称。

### 6.3 Result 与错误模型

建议所有 IPC 请求返回统一结构：

``` ts
type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: AppErrorDTO };

interface AppErrorDTO {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  retryable?: boolean;
}
```

错误码示例：

-   `VALIDATION_ERROR`
-   `NOT_FOUND`
-   `PATH_NOT_ACCESSIBLE`
-   `PATH_ALREADY_REGISTERED`
-   `TARGET_EXISTS`
-   `PERMISSION_DENIED`
-   `GIT_NOT_INSTALLED`
-   `GIT_OPERATION_FAILED`
-   `PREVIEW_START_FAILED`
-   `PORT_IN_USE`
-   `PROCESS_NOT_FOUND`
-   `DATABASE_ERROR`
-   `OPERATION_CANCELLED`

不要把完整异常对象、堆栈或敏感环境变量返回 Renderer。

### 6.4 长任务与取消

文件复制、目录扫描和 Git 操作可能耗时。建议使用 task ID 模式：

1.  Renderer 调用 start operation。
2.  Main 返回 operation ID。
3.  Main 通过事件推送进度。
4.  Renderer 可请求取消。
5.  Main 保存终态。`operations.get` 可在路由变化或窗口重载后查询。项目创建的成功结果包含 `ProjectDTO`，失败结果可包含经确认的残留目录与恢复选项。

V1.0
可先对模板复制和长时间预览任务实现必要进度，不需要一开始构建通用工作流引擎。

任务状态至少区分排队、运行、成功、失败和已取消。事件使用操作 ID 和递增序号，终态查询可补偿事件漏收。项目创建在最终目录落位前可取消。已落位任务进入登记或恢复流程。

## 7. 领域模型与数据库

### 7.1 ID 和时间

-   主键建议使用 UUID 字符串，便于未来导入/导出和数据迁移。
-   时间统一存 UTC ISO 字符串。
-   路径保存规范化后的绝对路径；展示时可按平台格式化。

### 7.2 核心表

#### templates

  字段                  类型        说明
  --------------------- ----------- --------------------------------------
  id                    TEXT PK     UUID
  name                  TEXT        名称
  description           TEXT        描述
  project_type          TEXT        web、mini-program、backend、other 等
  tech_stack_json       TEXT        技术栈列表
  local_path            TEXT        模板绝对路径
  source_type           TEXT        local / git
  source_url            TEXT NULL   来源仓库 URL
  preview_config_json   TEXT NULL   默认预览配置
  created_at            TEXT        创建时间
  updated_at            TEXT        更新时间
  last_checked_at       TEXT NULL   最近检查时间
  last_used_at          TEXT NULL   最近成功创建项目的时间

#### projects

  字段                  类型           说明
  --------------------- -------------- ----------------
  id                    TEXT PK        UUID
  template_id           TEXT NULL FK   来源模板
  template_name_snapshot TEXT NULL     创建时的来源模板名称
  name                  TEXT           项目名称
  description           TEXT           描述
  project_type          TEXT           项目类型
  local_path            TEXT           项目绝对路径
  preview_config_json   TEXT NULL      项目级预览配置
  ide_config_json       TEXT NULL      项目级 IDE 配置，NULL 时使用全局设置
  archived_at           TEXT NULL      归档时间
  created_at            TEXT           创建时间
  updated_at            TEXT           更新时间
  last_opened_at        TEXT NULL      最近打开时间
  last_checked_at       TEXT NULL      最近检查时间

#### tags

  字段         类型          说明
  ------------ ------------- ----------
  id           TEXT PK       UUID
  name         TEXT UNIQUE   标签名
  created_at   TEXT          创建时间

#### template_tags

-   `template_id` FK
-   `tag_id` FK
-   联合唯一约束 `(template_id, tag_id)`

#### project_tags

-   `project_id` FK
-   `tag_id` FK
-   联合唯一约束 `(project_id, tag_id)`

#### app_settings

  字段         类型      说明
  ------------ --------- ----------
  key          TEXT PK   配置键
  value_json   TEXT      JSON 值
  updated_at   TEXT      更新时间

#### schema_migrations

记录已应用的迁移版本、执行时间和校验信息（实现方式由
ORM/迁移工具确定）。

### 7.3 索引和约束

-   `templates.name`、`projects.name` 可建立普通索引。
-   `projects.template_id` 建立索引。
-   标签关联表建立双向查询索引。
-   数据库连接启用外键约束。主键、关联键和实体名称、路径、类型、创建及更新时间使用 `NOT NULL`。实体删除时级联清理标签关联。删除模板时对项目使用 `ON DELETE SET NULL`，保留来源名称快照。
-   两类实体共享规范路径登记约束。服务层解析实际路径并按 Windows 文件系统规则计算路径键，在同一写事务中占用数据库唯一键，再更新实体与路径登记。保留失效路径的登记键直到重关联或删除记录，避免并发重复登记。
-   预览配置与设置 JSON 按固定 schema 校验并随数据库版本迁移。环境配置文件独立带格式版本。时间字段统一为 UTC ISO 字符串。

### 7.4 预览配置模型

``` ts
interface PreviewConfig {
  adapter: 'web-command';
  command: string;
  args: string[];
  cwd: string;             // 相对项目目录，默认 "."
  port?: number;
  readyCheck?:
    | { type: 'http'; url: string; timeoutMs: number }
    | { type: 'tcp'; port: number; timeoutMs: number };
  previewUrl?: string;
}
```

安全要求：

-   `cwd` 解析实际路径后必须位于项目根目录内，首发限制为项目内目录。
-   不把命令字符串与用户输入拼接后交给 shell。
-   优先使用 executable + args 数组调用。
-   自定义环境变量由 §7.6 所定义的本地配置按项目 ID 管理，预览配置只描述命令及就绪策略。
-   运行配置执行前展示给用户。

### 7.5 数据库迁移

-   每次应用升级执行有序迁移。
-   迁移前对数据库文件创建安全备份。
-   迁移失败时保留原始数据库并报告错误。
-   禁止无版本控制地直接修改生产 schema。

### 7.6 用户数据目录与密钥

Main 按系统用户主目录解析 `~/.devhub/`，Windows 对应 `%USERPROFILE%\.devhub\`。目录及数据文件仅向当前用户账户开放。首次启动创建目录和 SQLite 数据库，发现已有数据时先校验再复用。

| 路径 | 内容 |
| --- | --- |
| `~/.devhub/devhub.sqlite` | SQLite 业务元数据与普通应用设置。 |
| `~/.devhub/env.json` | 按项目 ID 存放非秘密环境变量和密钥引用。写入使用同目录临时文件并原子替换。 |
| `~/.devhub/secrets.enc` | 按项目和密钥引用索引的加密数据，解密能力由操作系统当前用户的凭据机制保护。 |

Main 在确认的预览启动前解析项目变量和密钥引用，缺失密钥时返回可显示错误。密钥仅传给目标预览进程。项目记录删除后按项目 ID 清理其变量及密钥，失败时记录待清理状态并安全重试。密钥保护机制不可用时阻止保存和解析密钥，保留已有密文。禁止将密钥值写入 SQLite、普通配置、日志、事件或备份。Git 凭据继续由系统 Git 凭据机制管理。

## 8. 文件系统与模板复制

### 8.1 FileSystem Adapter

建议抽象：

``` ts
interface FileSystemPort {
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat>;
  realpath(path: string): Promise<string>;
  list(path: string): Promise<FileEntry[]>;
  copyDirectory(options: CopyDirectoryOptions): Promise<CopyResult>;
  removeDirectory(path: string): Promise<void>;
  ensureDirectory(path: string): Promise<void>;
}
```

### 8.2 导入模板

-   检查路径存在、可读和是否为目录。
-   计算规范化路径。
-   检查是否已登记。
-   只读取必要的项目特征文件用于识别。
-   不默认扫描或上传源码内容。
-   用户确认后写入数据库。

### 8.3 创建项目复制策略

推荐采用安全的分阶段操作：

1.  校验模板路径。
2.  校验目标父目录和最终路径。
3.  检查目标路径不存在。
4.  创建同一目标文件系统下的临时目录。
5.  按排除规则复制。
6.  校验复制结果。
7.  验证复制结果未包含任何 `.git` 文件或目录，按用户选择在临时目录执行 `git init`。
8.  记录操作 ID、临时目录、目标路径和任务阶段。用同文件系统且不覆盖已存在目标的方式将临时目录落位。
9.  在同一数据库事务内写入项目记录并更新模板使用时间。按操作 ID 重试时复用已有结果。

落位前失败或取消只清理经验证属于本次操作的临时目录。落位后写库失败时保留已落位目录，重新启动后根据持久化操作状态和路径归属提供继续登记或保留目录的选择。无法确认目录归属时，仅显示路径与错误。目标路径被其他操作占用时返回 `TARGET_EXISTS`，不覆盖已有目录。

### 8.4 排除规则

默认排除：

-   `.git`
-   `node_modules`
-   `dist`
-   `build`
-   `coverage`
-   `.cache`
-   `.turbo`
-   `.env`
-   `.env.*`，但保留 `.env.example`、`.env.sample`、`.env.template`

排除逻辑必须按路径段匹配，避免把 `my-dist-assets`
等无关名称误排除。所有层级均排除 `.git` 文件和目录，跳过符号链接和 Windows junction。首发使用固定排除项。应用数据目录、复制暂存目录及目标路径均不得进入复制范围。

### 8.5 删除策略

-   数据库记录删除和目录删除是两个独立动作。
-   删除前显示规范化绝对路径。
-   检查目标目录是否在允许范围内，拒绝危险根路径和用户目录根目录。
-   不跟随符号链接递归删除其目标。
-   对目录删除提供二次确认。
-   确认时绑定实体及规范化绝对路径，执行前重新校验路径身份。涉及应用数据目录、其他已登记实体的同址、父目录或子目录时拒绝。活动预览须先停止，删除记录、删除目录和重关联均检查该约束。
-   目录操作使用系统回收站。操作失败时保留原记录和错误状态。移入回收站成功后保留记录并刷新为路径失效，用户可另行移除记录。
-   文件操作应有明确结果和失败原因。

## 9. Preview Adapter 与 Process Manager

### 9.1 设计目标

预览管理必须兼容多种项目运行方式，同时避免把 Vue、React、Next
或小程序工具链写死在项目业务逻辑中。

### 9.2 适配器接口

``` ts
interface PreviewAdapter {
  id: string;
  detect(projectPath: string): Promise<DetectionResult>;
  buildLaunchPlan(context: PreviewStartContext): Promise<PreviewLaunchPlan>;
}
```

Adapter 负责项目识别、生成命令描述与就绪策略。Process Manager 负责启动、持有会话、日志和清理进程树。

### 9.3 第一版适配器

-   `WebCommandAdapter`：执行用户配置的命令，例如
    `pnpm dev -- --host 127.0.0.1`。
通用命令适配器同时覆盖用户自定义 executable 和 args。静态服务和小程序等专用适配器留作后续扩展。

### 9.4 Process Manager

职责：

-   启动子进程并分配 session ID。
-   记录 PID、命令、工作目录、启动时间和运行状态。
-   捕获 stdout、stderr。
-   维护有界日志缓存并写入滚动日志文件。
-   处理退出码和异常退出。
-   停止进程树。
-   每项目只允许一个活动会话，不同项目可并行运行。按项目串行处理启动、停止及重启，重启先等待原进程树退出。退出应用前清理进程，Windows 主窗口关闭走同一退出流程。
-   崩溃后仅在能验证进程归属时清理残留进程树。历史 PID 不作为终止依据。验证 Windows 安装包中命令发现、`.cmd` 启动路径及所属进程树的终止行为。

### 9.5 跨平台停止策略

-   Windows 首发验证进程树归属和回收方式，验收覆盖父进程退出后子进程仍存活的情况。后续平台再验证对应进程组策略。
-   所有终止动作必须只针对 DevHub
    管理的进程，不根据端口号直接杀死未知进程。
-   在目标平台上进行真实集成测试。

### 9.6 运行状态机

``` mermaid
stateDiagram-v2
    [*] --> Stopped
    Stopped --> Starting: start
    Starting --> Running: process started
    Starting --> Failed: spawn failed
    Starting --> Stopping: stop
    Running --> Stopping: stop
    Running --> Failed: unexpected exit
    Running --> Stopping: readiness timeout
    Stopping --> Stopped: process tree exited
    Stopping --> Failed: cleanup failed or readiness timed out
    Failed --> Stopping: cleanup retry
    Failed --> Starting: retry after cleanup confirmed
    Failed --> Stopped: reset after cleanup confirmed
```

`Running` 表示进程运行。独立的就绪字段区分未配置、检测中、已就绪与检测失败。就绪超时后清理本会话进程树并保留失败原因。失败时若仍有进程，保留活动会话控制权，确认回收后才能重新启动。事件携带 `sessionId` 和序号，旧会话事件不得覆盖新会话状态。

### 9.7 日志策略

-   stdout 和 stderr 合并为带时间戳和 stream 类型的日志事件。
-   UI 只保留最近 N 条日志（具体 N 值通过性能测试决定）。
-   日志文件按大小或日期轮转。
-   日志按会话和序号读取，写盘和推送前脱敏。过滤已注入密钥的已知值，处理流块边界，并限制单条记录、内存和磁盘大小。
-   长时间运行时避免无限制向 DOM
    追加节点；日志视图需要有界缓存，必要时虚拟滚动。

### 9.8 就绪检测与端口

M3 实现约定（2026-11-17）：Windows 每个预览使用独立 Job Object，先以挂起状态创建启动桥接进程，加入 Job 后再恢复。Job 设置 `KILL_ON_JOB_CLOSE`。Main 的控制管道断开、启动桥接进程退出或显式停止时关闭 Job，回收其全部后代。重启等待旧宿主关闭。C# 辅助程序由系统 .NET Framework 4 编译器构建，作为独立资源随应用打包。用户命令经 `cross-spawn` 执行以支持 `.cmd` 与含空格参数。

运行 IPC 使用 `runtime:request` 的 Zod 判别联合及 `preview:session` 事件。会话包含 ID、项目 ID、单调递增 revision 和日志 sequence。Renderer 的 ReactiveController 校验 revision、丢弃旧快照并在断开时退订。日志通过 Main 的有界快照发送，最多每 100ms 推送一次日志变化。每会话保留 500 条日志，单条最多 4096 个 UTF-16 代码单元，最多保留 20 个已结束的项目会话。磁盘使用 Pino JSONL，包含 projectId/sessionId/sequence，位于 userData/logs，最多 3 个 1 MiB 文件，写入排队上限 1 MiB。

HTTP 检查仅访问配置的本机地址，2xx 为成功，不跟随重定向。TCP 检查使用 `127.0.0.1`。启动前探测配置及就绪检测使用的端口，超时后停止本次进程树并保留失败原因。未配置就绪检查时仅显示「进程已启动」。

-   使用显式配置的回环地址 HTTP/TCP 检测。HTTP 以 2xx 为成功且不跟随重定向，TCP 以连接成功为准，二者均受统一超时限制。启动前端口检查用于诊断，实际状态仍由子进程和就绪检测决定。
-   不能仅凭"子进程仍存在"就判定预览可用。
-   检测超时后展示日志和失败状态。
-   端口冲突时提示用户，不自动终止占用端口的其他程序。

## 10. Git Service

### 10.1 实现方式

通过 Git CLI 执行操作，可用 simple-git 封装常见命令。Git CLI
是最终事实来源。

### 10.2 服务接口

``` ts
interface GitPort {
  inspectRepository(path: string): Promise<GitRepositoryInfo>;
  getRemotes(path: string): Promise<GitRemote[]>;
  addRemote(path: string, name: string, url: string): Promise<void>;
  updateRemote(path: string, input: GitRemoteUpdate): Promise<void>;
  removeRemote(path: string, name: string): Promise<void>;
  getCurrentBranch(path: string): Promise<GitBranchState>;
  getStatus(path: string): Promise<GitStatus>;
}
```

### 10.3 命令执行安全

-   不使用 `shell: true` 拼接命令。
-   使用 executable 与参数数组。
-   Git 工作目录必须是登记项目目录或经用户确认的目录。
-   用 Git CLI 确认实际工作树根。若登记路径属于上级工作树，提示用户登记该根目录；在原登记路径拒绝 Remote 写入。模板创建中的 `git init` 只操作本次创建的临时目录。
-   Remote URL 需校验格式；错误信息中避免回显凭据。
-   Git 命令有超时和取消策略。
-   Remote 写操作需确认并按工作树串行执行，执行后重新读取结果。首发支持 GitHub.com 的 HTTPS 与 Git SSH 地址映射到浏览器，按用户指定的 Remote 打开。
-   不在 SQLite 保存明文凭据。

### 10.4 Git 状态

建议使用 `git status --porcelain=v2 --branch` 获取机器可读状态，再转换为
DTO。分支、Remote 和提交信息按需查询，不把过期缓存作为权威状态。

### 10.5 GitHub 集成边界

M4 实现记录（2026-11-17）：Main 的 GitService 使用 simple-git 调用系统 Git，沙箱 API 为 `git:request` 的 Zod 判别联合，包含 tools、inspect、add、update、remove、open 和 cancel。调用仅接受登记项目 ID，不接受 Renderer 指定的任意目录或任意 Git 命令。每次读取查询 Git CLI，SQLite schema 维持 5。

通过 `rev-parse` 读取工作树根、git directory 和 common directory，支持 `.git` 文件形式的 linked worktree。Remote 写入按规范化 common directory 串行处理。请求携带由仓库身份和 Remote 配置计算的 revision，原生确认前后重新读取并核对，目录或 Remote 已变化时要求刷新。已在执行的 Git 命令取消后等待其关闭，再释放目录占用。

Remote DTO 展示 Git 配置中的 Fetch 与 Push 地址，Push 未单独配置时明确标识沿用 Fetch。修改只针对第一条 URL，并保留其余值。多值时使用转义并锚定的旧地址匹配，重复首地址或敏感旧地址不进入命令参数，提示外部整理。配置中的不安全地址统一隐藏，原始 Git 错误不跨 IPC 返回。添加或修改接受无凭据的 HTTPS 与 Git SSH URL；浏览器映射仅支持 GitHub.com。

命令采用参数数组与受控环境，禁用 status 的 fsmonitor 外部钩子。每条命令最多 10 秒、stdout 与 stderr 合计最多 2 MiB，超时、取消或输出超限通过 AbortSignal 终止命令。`status --porcelain=v2 --branch -z` 解析 NUL 分隔路径，保留重命名与冲突状态，Renderer 最多展示 200 条并标记截断。普通未跟踪目录可聚合为一个条目；不递归展开子模块内部未提交变化。窗口重新获得焦点或用户点击重新检测时刷新，页面离开时取消请求并丢弃旧响应。

命令格式依据 [git-status](https://git-scm.com/docs/git-status)、[git-remote](https://git-scm.com/docs/git-remote) 与 [git-rev-parse](https://git-scm.com/docs/git-rev-parse) 官方文档，Windows 临时仓库和打包产物验证结果见实施计划。

V1.0 交付 Git Remote 管理、GitHub 仓库跳转、当前分支与基础状态。Commit / Pull / Push、提交历史和 Enterprise 跳转留作后续范围；交付远程写能力前再定义认证交互、冲突和取消语义。

后续如需仓库创建、PR、Issues 或 GitHub 元数据，再单独接入 GitHub
CLI/API。

## 11. IDE 与外部应用打开

-   通过配置的 IDE 命令或可执行文件打开项目路径。
-   不把 IDE 安装路径写死。
-   首次配置时允许用户选择可执行文件。
-   命令和路径使用参数数组传递。
-   打开失败时提示检查配置，并提供复制路径入口。
-   默认支持用户手动配置 VS Code、WebStorm 等 IDE。

首发手动选择 IDE 并配置命令。项目级设置优先于全局设置。Windows 安装包验证含空格的路径和参数传递。

## 12. 日志、错误和可观测性

### 12.1 日志分层

-   应用日志：启动、关闭、数据库迁移、设置变更。
-   业务日志：模板导入、项目创建、路径重关联。
-   预览日志：独立按项目/会话管理。
-   Git 日志：操作类型、耗时和结果，不记录凭据。

### 12.2 日志原则

-   Pino 输出结构化日志。
-   日志目录位于 Electron `app.getPath('userData')` 下。
-   日志文件轮转并限制总占用空间。
-   对路径、Remote URL 和环境变量进行必要脱敏。
-   不记录项目源码内容。

### 12.3 错误处理

错误分为：

-   用户输入错误。
-   文件系统错误。
-   数据库错误。
-   Git 错误。
-   进程启动/停止错误。
-   IPC/应用内部错误。

Renderer 只接收稳定错误码和可展示消息。详细堆栈只写入本地日志。

## 13. 安全设计

1.  `contextIsolation` 开启。
2.  `nodeIntegration` 关闭。
3.  Preload 只暴露最小 API。
4.  IPC 校验 sender 和 DTO。
5.  Renderer 不提供任意 shell 执行能力。
6.  命令执行采用参数数组，避免 shell 注入。
7.  文件路径规范化，限制删除和复制边界。
8.  项目脚本视为用户代码，首次运行展示命令和工作目录。
9.  默认不复制 `.env`。
10. GitHub 凭据交给系统凭据管理或 Git 工具，不写入 DevHub DB。
11. 外部 URL 使用 Electron 安全方式打开，并限制协议为 `https:`、`http:`
    或明确允许的本地预览地址。
12. 不加载未经信任的远程页面到应用主窗口。

## 14. 数据备份与恢复

### 14.1 备份范围

V1.0 默认备份：

-   SQLite 数据库。
-   普通应用设置和非秘密环境变量。环境配置可以保留密钥引用。

默认不备份：

-   模板和项目源码。
-   node_modules 和构建产物。
-   Git 对象数据库。
-   加密密钥数据、系统凭据、运行授权记录与预览日志。

### 14.2 备份流程

1.  暂停或协调数据库写入。
2.  使用 SQLite 安全备份机制生成一致性快照。
3.  写入带版本信息的备份包。
4.  校验文件完整性。
5.  显示备份位置和时间。

### 14.3 恢复流程

1.  验证备份格式、版本与完整性，复制到临时位置并迁移，校验 SQLite 和环境配置兼容性。
2.  提示将覆盖的元数据范围，用户确认后阻止并发写入，停止活动预览，并创建当前数据一致性备份。
3.  在维护状态下切换 SQLite 与非秘密环境配置。记录恢复阶段，任一文件切换失败或恢复中断时能回到原数据。
4.  重新检查路径。已有密钥仅在项目 ID 和密钥引用匹配时可用，缺失密钥提示重新配置。下次运行时重新确认。

### 14.4 M5 实现记录（2026-11-18）

- `BackupStore` 使用 Electron 内置 `node:sqlite` 的在线备份 API。导出文件扩展名为 `.devhub-backup`，格式版本为 1，包含应用版本、schema 版本、时间以及分别带 SHA-256 的 SQLite / 环境配置载荷。整个文件限制为 64 MiB，不打包源码与密钥密文。
- `MaintenanceGate` 协调目录、创建、预览和 Git IPC，等待已进入的请求结束，并拒绝维护期间的新请求。存在活动项目创建任务时拒绝备份或恢复。快照中清空 `creation_operations`，不恢复历史任务及其路径授权。
- `backup:request` 仅接受 `export`、`prepare`、`restore(token)`、`status`。文件路径由 Main 原生对话框取得；Renderer 仅持有有效期 30 分钟的暂存令牌。Settings 中的 `devhub-backup-settings` 展示范围、失效路径数量和密钥引用数量，最终覆盖由 Main 原生对话框确认。
- 暂存目录位于 `~/.devhub/.restore-stage-<uuid>/`。恢复前校验格式、哈希、SQLite 完整性与外键、已知表结构范围及记录字段，在暂存副本中执行既有迁移，正式切换前再次校验暂存文件摘要。
- 自动回退包写入 `~/.devhub/backups/before-restore-*.devhub-backup`。`restore-transaction/` 保存原数据库、原环境配置和 `prepared / switching / committed` 阶段日志；停止预览与其他服务并关闭数据库后，通过同目录临时文件、同步落盘和重命名切换两份文件。
- 启动时先处理恢复日志，再打开数据库。`switching` 阶段恢复原数据库与环境配置；已提交阶段保留新数据。日志或回滚文件校验失败时停止打开数据服务并保留现场。进程中断回退已测试；突然断电的物理磁盘持久性尚未做硬件故障验证。
- 完成切换后重启应用，重新读取路径与密钥引用；不会恢复预览会话或命令确认。密钥仍通过现有用户级 safeStorage 解析，缺失引用继续展示为未配置，普通启动清理规则保持不变。
- M5 未新增数据库迁移，当前 schema 为 5。安装与验证结果及正式发布门槛见 `DevHub-Release-Checklist.md`。

## 15. 测试策略

### 15.1 单元测试

重点测试：

-   路径规范化和边界判断。
-   排除规则。
-   模板与项目领域规则。
-   DTO 和 Zod schema。
-   预览状态机。
-   Git 输出解析。
-   错误映射。

### 15.2 集成测试

使用临时目录和临时 Git 仓库测试：

-   模板导入。
-   从模板复制并排除文件。
-   `.git` 隔离。
-   新项目初始化。
-   数据库 CRUD 和迁移。
-   Git Remote 添加/读取。
-   预览进程启动、日志和停止。
-   路径失效与重关联。

### 15.3 E2E 测试

覆盖主要用户流程：

-   导入模板并创建项目。
-   重启应用后数据恢复。
-   启动一个本地 Web 项目并打开预览。
-   停止预览并确认进程退出。
-   关联一个本地测试 Git 仓库。
-   删除记录但保留实际目录。

### 15.4 平台测试

至少在实际目标平台验证：

-   文件路径和权限。
-   进程树停止。
-   Git 可执行文件查找。
-   IDE 打开。
-   安装包和应用数据目录。
-   应用退出时的进程清理。

首发验收在 Windows 实际安装包上执行。故障场景应覆盖目录落位后写库失败、并发目的路径、备份恢复中断、密钥不可用、预览退出和进程树回收。

## 16. 打包、更新和运行环境

-   Electron Builder 负责打包。
-   Renderer 资源随应用分发。
-   SQLite 数据库、自定义环境变量和加密密钥文件位于 `~/.devhub/`，详见 §7.6。
-   数据库和用户项目不得因卸载应用而被默认删除。
-   安装包升级时执行数据库迁移。
-   Git、Node.js、pnpm 等外部工具可能不存在，需要检测并提示安装或配置。
-   不默认将 Node.js 运行时打包进应用；是否内置运行时作为后续产品决策。

M5 已提供 `npm run installer:win`，生成 Windows x64、当前用户安装的 NSIS 安装器，支持选择安装目录，卸载保留用户数据，不自动启动应用。当前产物为未签名测试候选包。同版本覆盖安装已验证，跨应用版本升级仍需后续真实旧版安装器验证；历史 schema 迁移由现有集成测试覆盖。

## 17. 实施里程碑

### M0：设计评审

-   PRD/TDD 评审。
-   目标操作系统为 Windows。确认实际 yuanx checkout 和 DevHub 工程落地位置。
-   确认 UI 原型。
-   冻结核心数据模型和 IPC 契约。

### M1：工程骨架

-   初始化 Electron + Vite + LitElement + TypeScript。
-   建立 Main、Preload、Renderer、Shared 边界。
-   配置 lint、format、typecheck 和测试。
-   建立安全 BrowserWindow 配置。
-   建立 SQLite 和迁移框架。

### M2：模板与项目

-   Template Repository/Service。
-   Project Repository/Service。
-   模板导入、项目导入。
-   模板 CRUD、项目 CRUD。
-   模板复制和 Git 隔离。
-   基础页面和路径重关联。

### M3：预览管理

-   Preview Config。
-   WebCommandAdapter。
-   ProcessManager。
-   日志事件和有界缓存。
-   端口/就绪检测。
-   IDE 和浏览器打开。

### M4：Git 集成

-   Git CLI 检测。
-   Git Adapter。
-   Remote 管理。
-   当前分支、基础工作区状态和 GitHub 仓库跳转。

### M5：质量与发布

-   备份恢复。
-   E2E 和 Windows 安装包测试。
-   安装包。
-   错误提示和日志脱敏。
-   UI 视觉复核和性能优化。

## 18. 技术验证与选型

| 项目 | 验证依据 |
| --- | --- |
| SQLite 驱动 | 已采用 Electron 内置 `node:sqlite`；Windows 安装版已通过加载、重开、在线快照及恢复验证。 |
| ORM | 已采用原生 SQL 和显式版本迁移，继续使用既有集成测试验证兼容性。 |
| 路由与组件库 | 用关键页面原型验证 Vaadin Router 或轻量自定义路由，以及 Lit 自建组件或 Web Components 库。 |
| 默认主题与主题数量 | 通过 Developer Workbench 原型确认。 |
| 子进程与密钥保护 | 在 Windows 安装包验证 child_process / execa、`.cmd` 工具和进程树回收，以及当前用户凭据保护。 |
| 最低工具版本 | 锁定 Electron 与依赖版本后，验证并记录首发支持的 Git、Node.js 和包管理器版本。 |

## 19. 技术验收基线

进入工程初始化前，至少满足：

-   PRD 的 V1.0 范围已确认。
-   Main、Preload、Renderer 的权限边界明确。
-   Template 与 Project 的领域模型明确。
-   项目创建时 `.git` 和敏感文件的处理规则明确。
-   Preview Adapter 和 Process Manager 的职责明确。
-   Git 凭据不由 DevHub 明文管理。
-   数据库迁移和备份策略明确。
-   首发 Windows 测试矩阵和工程落地位置明确。
-   UI 视觉方向已形成可评审的关键页面原型。

达到以上条件后，才进入 Electron 项目初始化。
