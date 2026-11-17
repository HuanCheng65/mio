import { Context, icons } from '@koishijs/client'
import Page from './page.vue'
import MioIcon from './icons/mio.vue'

icons.register('activity:mio', MioIcon)

export default (ctx: Context) => {
  ctx.page({
    name: '澪统一控制台',
    path: '/mio',
    icon: 'activity:mio',
    component: Page,
  })
}
