import { defineNuxtPlugin } from '#imports'
import { VueFlow } from '@vue-flow/core'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import { Background } from '@vue-flow/background'

export default defineNuxtPlugin((nuxtApp) => {
  // Register Vue Flow components globally for client-only usage
  nuxtApp.vueApp.component('VueFlow', VueFlow)
  nuxtApp.vueApp.component('Controls', Controls)
  nuxtApp.vueApp.component('MiniMap', MiniMap)
  nuxtApp.vueApp.component('Background', Background)
}) as any
