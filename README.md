# DevHub

基于 Electron、LitElement、TypeScript、Vite 和 SQLite 的 Local-First 开发工作台。

支持模板和项目管理、从模板创建项目、本地 Web 预览、环境变量及密钥配置、Git Remote 管理和数据备份恢复。数据库、环境变量和密钥保存在用户目录 `~/.devhub/`。

## 开发与验证

当前面向 Windows，构建需要 Node.js 22.22 或更新版本，以及系统 .NET Framework 4 的 C# 编译器。预览使用用户安装的 Node.js、npm 等工具，Git 功能使用系统 Git。

```powershell
npm ci
npm test
npm run typecheck
npm run build
npm start
```

```powershell
npm run installer:win
npm run smoke -- release/win-unpacked/DevHub.exe
```

安装候选包输出到 `release/`。当前候选包未签名，正式发布前的剩余事项见发布验收记录。

## 项目文档

- [产品需求](docs/devhub/DevHub-PRD-v0.1.md)
- [技术设计](docs/devhub/DevHub-TDD-v0.1.md)
- [实施计划与阶段验收](docs/devhub/DevHub-Implementation-Plan.md)
- [发布验收记录](docs/devhub/DevHub-Release-Checklist.md)

Git 仅管理源码、测试、构建配置和文档；依赖目录、构建输出和安装产物由 `.gitignore` 排除。
