# Sales Personal Agent Prototype

This prototype implements the approved MVP PRD dated 2026-10-23. The application uses React, TypeScript, Vite, and a shared localStorage-backed store. No external messages, real authentication, or payment transactions occur.

The five primary routes are /chat, /work, /results, /douyin-accounts, and /knowledge. The secondary product account page is /me. All account-scoped conversations, knowledge, and tasks use stable account identifiers. Task creation and quota redistribution are one validated store transaction. Paused and disconnected tasks retain allocated quota.

Results use explicit synthetic customer identities and discovery cohorts. Task creation produces zero execution results. Reconnection preserves history without backfilling sends. The visual direction is a restrained blue and warm-gray desktop workspace with a narrow fixed navigation rail, an open conversational canvas, and compact structured confirmation cards.

Verification covers domain invariants, the production build, and browser interactions for the five PRD demonstration scenarios. Developer reset is available at /?reset=demo, outside primary navigation.
