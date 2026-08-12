import Dexie, { type EntityTable } from 'dexie'
import { CbDatabase } from './schema'

// meta 库：全局、不随账户变，存放设备级数据（device_id + 活跃账户身份 account_phone）。
export interface MetaDatabase extends Dexie {
  device: EntityTable<DeviceRecord, 'key'>
  account: EntityTable<AccountRecord, 'key'>
}

export const metaDb = new Dexie('cb-meta') as MetaDatabase

metaDb.version(1).stores({
  device: 'key',
  account: 'key',
})

export interface DeviceRecord {
  key: string
  value: string
}

export interface AccountRecord {
  key: string
  value: string
}

// 业务库：每账户独立库 db_<phone>（auth-structure.md §2.9），切账户 = 换库。
const businessDbs = new Map<string, CbDatabase>()

export function businessDbName(accountPhone: string): string {
  return `db_${accountPhone}`
}

export function createBusinessDb(accountPhone: string): CbDatabase {
  const name = businessDbName(accountPhone)
  const cached = businessDbs.get(name)
  if (cached) return cached
  const db = new CbDatabase(name)
  businessDbs.set(name, db)
  return db
}

export async function closeBusinessDb(accountPhone: string): Promise<void> {
  const name = businessDbName(accountPhone)
  const db = businessDbs.get(name)
  if (db) {
    await db.close()
    businessDbs.delete(name)
  }
}

export function currentBusinessDb(accountPhone: string | null): CbDatabase | null {
  return accountPhone ? createBusinessDb(accountPhone) : null
}
