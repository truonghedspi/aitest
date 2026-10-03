import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { chatPage } from './plugins/chat-page.tsx'
import { knowledgePage } from './plugins/knowledge-page.tsx'
import { managerPages } from './plugins/manager-pages.tsx'
import { planPanel } from './plugins/plan-panel.tsx'
import { plansPage } from './plugins/plans-page.tsx'
import { runsPage } from './plugins/runs-page.tsx'
import { contextPage } from './plugins/context-page.tsx'
import { openItems } from './plugins/open-items.tsx'
import { toolViews } from './plugins/tool-views.tsx'
import { slots, type ClientPlugin } from './slots.ts'
import './styles.css'

/** Danh sách plugin phía client. Thêm thẻ tool hoặc bảng mới bằng cách thêm plugin vào đây. */
const plugins: ClientPlugin[] = [chatPage, plansPage, runsPage, knowledgePage, contextPage, openItems, managerPages, toolViews, planPanel]
for (const plugin of plugins) plugin(slots)

createRoot(document.getElementById('root')!).render(<App />)
