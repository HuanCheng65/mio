import { Context } from '@koishijs/client'
import Page from './page.vue'

export default (ctx: Context) => {
  ctx.page({
    name: '澪控制台',
    path: '/mio',
    icon: 'activity:brain',
    component: Page,
  })
}
