<script setup lang="ts">
import { ref } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import type { AuthStorePublic } from '../services/authStore'

const props = defineProps<{ store: AuthStorePublic }>()

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
      <h1>Casual-bookkeeping</h1>
      <p>衣物处理厂移动端记账</p>
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
.brand h1 {
  font-size: 28px;
  margin: 0 0 8px;
}
.brand p {
  color: var(--cb-text-muted);
  margin: 0;
}
.submit-wrap {
  padding: 24px 16px 0;
}
</style>
