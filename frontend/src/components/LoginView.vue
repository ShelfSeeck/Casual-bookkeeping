<script setup lang="ts">
import { ref } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import type { AuthStore } from '../services/authStore'

// 只依赖登录能力；App 用 shallowRef 传入原始 AuthStore 实例，避免深度代理。
const props = defineProps<{ store: Pick<AuthStore, 'login'> }>()

const phone = ref('')
const password = ref('')
const loading = ref(false)

async function onSubmit() {
  if (!phone.value.trim() || !password.value) {
    showFailToast('请输入手机号和密码')
    return
  }
  loading.value = true
  try {
    await props.store.login(phone.value.trim(), password.value)
    showSuccessToast('登录成功')
  } catch (e) {
    showFailToast((e as Error).message === 'invalid_credentials' ? '手机号或密码错误' : '登录失败，请检查网络')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-page">
    <div class="brand">
      <h1 class="brand-title">软记</h1>
      <p class="brand-sub">casual-bookkeeping</p>
    </div>
    <van-form @submit="onSubmit">
      <van-cell-group inset>
        <van-field
          v-model="phone"
          name="phone"
          type="tel"
          maxlength="11"
          label="手机号"
          placeholder="请输入手机号"
        />
        <van-field
          v-model="password"
          name="password"
          type="password"
          label="密码"
          placeholder="请输入密码"
        />
      </van-cell-group>
      <div class="submit-wrap">
        <van-button round block type="primary" native-type="submit" :loading="loading">
          登录
        </van-button>
      </div>
    </van-form>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 40px;
  padding: 0 16px;
}
.brand {
  text-align: center;
}
.brand-title {
  font-family: var(--cb-font-serif);
  font-size: 38px;
  font-weight: 700;
  letter-spacing: 0.12em;
  margin: 0 0 8px;
  color: var(--cb-text-main);
}
.brand-sub {
  color: var(--cb-text-muted);
  font-size: 14px;
  letter-spacing: 0.05em;
  margin: 0;
  text-transform: lowercase;
}
.submit-wrap {
  padding: 24px 16px 0;
}
</style>
