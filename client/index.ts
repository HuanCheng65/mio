import { Context } from '@koishijs/client'
import Page from './page.vue'

export default (ctx: Context) => {
  ctx.page({
    name: '澪记忆管理',
    path: '/mio-memory',
    icon: 'activity:brain',
    component: Page,
  })
}
