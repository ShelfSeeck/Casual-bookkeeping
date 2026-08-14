<script setup lang="ts">
import { onMounted, ref } from 'vue'
import LoginView from './components/LoginView.vue'
import { ApiClient } from './services/apiClient'
import { AuthStore } from './services/authStore'

const store = ref<AuthStore | null>(null)

onMounted(async () => {
  const api = new ApiClient({
    onSessionInvalid: () => {
      store.value?.onSessionInvalid()
    },
  })
  const auth = new AuthStore(api, {
    onLoginSuccess: () => {},
    onSessionInvalid: () => {},
  })
  store.value = auth
  await auth.init()
})
</script>

<template>
  <LoginView v-if="store" :store="store" />
</template>
