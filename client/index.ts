import { Context } from '@koishijs/client'
import Page from './page.vue'

export default (ctx: Context) => {
  ctx.page({
    name: '澪统一控制台',
    path: '/mio',
    icon: 'material-symbols:dashboard-outline-rounded',
    component: Page,
  })
}
