# Vercel 部署

状态：部署配置已准备，生产构建通过；等待 Vercel 登录及部署范围确认，尚未生成线上地址。

`vercel.json` 固定使用 Vite、`npm run build` 和 `dist` 输出，包含单页应用路由。`.vercelignore` 采用源码允许列表，仅上传前端源码、公开资源、构建文件和未连接提示接口；不上传执行服务、本地数据、浏览器资料、证据、密钥、测试或调试脚本。

当前部署配置是网页托管入口。`/api/*` 返回 JSON 503，明确执行服务尚未连接，不返回假客户或假执行结果。此前端可以展示工作台，但无法执行抖音任务。这不是完整云端可用部署。

登录后运行 `vercel --prod --yes` 完成正式发布，检查线上首页、静态资源、单页路由及 `/api/health` 的明确未连接提示。CLI 必须使用用户完成授权的账号；若账号存在多个团队，应根据账号实际权限选择项目归属。

完整运行需额外的常驻执行主机，保存浏览器会话和数据库，运行后台观察。当前本地 FastAPI 没有公网账号认证，不可直接以隧道将它公开。云端执行服务需要先实现账号认证、会话隔离、权限校验和稳定的 HTTPS 接入，再将 Vercel 同源 API 网关连接它。证据图片也必须走相同授权边界，不能只保护控制接口。

Vercel Functions 存在请求执行期限，文件系统持久化行为也不同于本机，不能直接承载当前长时间可见浏览器与本地 SQLite 方案。

- [Vite on Vercel](https://vercel.com/docs/frameworks/frontend/vite)
- [函数限制](https://vercel.com/docs/functions/limitations)
- [运行时文件系统](https://vercel.com/docs/functions/runtimes)
