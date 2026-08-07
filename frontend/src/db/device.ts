import { metaDb } from './db'

// device_id：设备级标识，存 meta 库（不随账户变），重新安装 PWA 才变。
// 格式：dev- + uuid4().hex[:12]（见 auth-structure.md §2.7）。

const DEVICE_KEY = 'device_id'

export async function getOrCreateDeviceId(): Promise<string> {
  const existing = await metaDb.device.get(DEVICE_KEY)
  if (existing) return existing.value
  const id = newId()
  await metaDb.device.put({ key: DEVICE_KEY, value: id })
  return id
}

function newId(): string {
  const rand = crypto.randomUUID().replace(/-/g, '')
  return `dev-${rand.slice(0, 12)}`
}
