# Sales Personal Agent — MVP Prototype

A desktop-first, Chinese-language interactive prototype based on `销售个人智能体_MVP_PRD_V1.0.docx`. Built with React, TypeScript, Vite, React Router, and Lucide icons.

## Run locally

Use Node.js 20.19+ or 22.12+.

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. The default port is 5173; Vite selects another available port if necessary.

```sh
npm run build    # Type-check and create dist/
npm run preview  # Serve the production build locally
npm test         # Run domain and conversation-parser tests
```

## Demo scenarios

Reset the demo before a scenario when you need the original allocations. All names, execution records, limits, and package details are demonstration data.

1. **Create a task with an allocation conflict.** Select `杭州医美顾问小林` (A1) in Chat. Enter `再创建玻尿酸潜客任务，每天私信 20 人`. Complete the requirement fields, confirm the plan, and authorize its simulated outreach. A1 already reserves 50/50. In the conflict card, change `热玛吉潜客挖掘` from 30 to 20 and `超声炮潜客挖掘` from 20 to 10; keep the new task at 20. Confirm once. All allocations update together, and the new task starts with zero results.
2. **Create a find-only task.** Repeat the A1 conflict flow and choose `仅创建找客任务`. The new task reserves zero contacts per day and produces no fabricated outreach results.
3. **Adjust, pause, and resume a task.** In Real-time Work (`实时工作`), open `热玛吉潜客挖掘` (T1) and choose `调整任务`. Change the daily contact plan to 10 in the associated conversation and confirm the before/after card. Return to the task, pause it, then resume it. Historical results remain intact; paused tasks retain their allocation.
4. **Recover a disconnected account.** In Douyin Accounts (`抖音账号`), find `本地装修小陈` (A3), choose `重新登录`, acknowledge the simulation, and confirm. The account reconnects, previously enabled tasks recover, and historical records remain unchanged. No missed messages are sent retroactively. Connected accounts also support sign-out with explicit confirmation.
5. **Use account-specific knowledge.** In Knowledge (`知识库`), select A1, edit the `热玛吉` product description or communication style, and save. Return to A1 Chat to see the saved context used by subsequent suggestions and message previews. Switch to A2 and verify that its knowledge and conversations remain separate. Previously sent records and task settings do not change.

## State and reset

- The prototype stores its shared state in this browser origin's `localStorage`, using the key `sales-agent-demo-v1`.
- Each Douyin account has separate conversations, knowledge, and tasks. Work and Results can also show all accounts.
- Refreshing preserves changes. Separate browser profiles, private sessions, and different local ports have independent storage.
- To restore the five tasks and three accounts from the PRD, open `/?reset=demo` on the same origin. This removes the saved state and reloads the baseline. The reset query is removed afterward.
- Reset is a development/demo mechanism, not a main navigation item.

## Boundaries

No real Douyin login, private messages, AI model, external API, product authentication, or payment service is connected. Connection and recharge dialogs are explicitly simulated. The product sign-out/re-entry flow only controls this local demo session. No secrets or API keys are required.

Natural-language interpretation uses a deterministic Chinese rule parser, not an LLM. It recognizes selected business topics, saved product names, common cities, contact counts, and **daily** execution times. Other recurrence rules and arbitrary requests may need manual correction in the confirmation form. The prototype does not run a background scheduler or generate live customer results; execution history is seeded demonstration data. Results use customer discovery cohorts, while today's contact counts use actual seeded contact-event dates.

Formal pricing, platform safety limits, production authentication, backend scheduling, integrations, and deployment are outside this delivery. Production hosting must serve `index.html` for client-side routes such as `/chat` and `/work/T1`.
