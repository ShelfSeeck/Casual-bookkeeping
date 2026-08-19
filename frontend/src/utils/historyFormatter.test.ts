import { describe, expect, it } from 'vitest'
import {
  formatFieldValue,
  getFieldLabel,
  formatRelativeHistoryTime,
  extractHistoryDiffs,
  buildHistoryItemViewModel,
} from './historyFormatter'

describe('historyFormatter', () => {
  it('translates database field keys to friendly Chinese labels', () => {
    expect(getFieldLabel('unit_price_cents')).toBe('单价')
    expect(getFieldLabel('unitPriceCents')).toBe('单价')
    expect(getFieldLabel('quantity')).toBe('数量')
    expect(getFieldLabel('is_completed')).toBe('工单状态')
    expect(getFieldLabel('isCompleted')).toBe('工单状态')
    expect(getFieldLabel('service_item')).toBe('服务小类')
    expect(getFieldLabel('subcategoryName')).toBe('服务小类')
    expect(getFieldLabel('service_category')).toBe('服务大类')
    expect(getFieldLabel('customer_id')).toBe('客户')
    expect(getFieldLabel('work_order_date')).toBe('工单日期')
  })

  it('formats field values human-readably', () => {
    // 单价
    expect(formatFieldValue('unit_price_cents', 1500)).toBe('¥15.00')
    expect(formatFieldValue('unitPriceCents', null)).toBe('未定价')
    expect(formatFieldValue('unit_price_cents', 0)).toBe('未定价')

    // 状态
    expect(formatFieldValue('is_completed', true)).toBe('已完成')
    expect(formatFieldValue('is_completed', 1)).toBe('已完成')
    expect(formatFieldValue('is_completed', false)).toBe('未完成')
    expect(formatFieldValue('is_completed', 0)).toBe('未完成')

    // 数量
    expect(formatFieldValue('quantity', 12, { unit: '件' })).toBe('12 件')
    expect(formatFieldValue('quantity', 5)).toBe('5')

    // 普通文本
    expect(formatFieldValue('service_item', '羽绒服')).toBe('羽绒服')
  })

  it('formats history timestamp with natural relative terms', () => {
    const fixedNow = new Date('2026-08-20T15:30:00Z')
    // 同一天
    expect(formatRelativeHistoryTime('2026-08-20T10:15:00Z', fixedNow)).toMatch(/今天 \d{2}:\d{2}/)
    // 昨天
    expect(formatRelativeHistoryTime('2026-08-19T08:00:00Z', fixedNow)).toMatch(/昨天 \d{2}:\d{2}/)
  })

  it('extracts diffs from pull-shaped change objects (before_json and after_json)', () => {
    const change = {
      entity_type: 'work_order',
      entity_sync_id: 'wo_1',
      before_json: JSON.stringify({
        quantity: 10,
        unit: '件',
        unit_price_cents: null,
        is_completed: 0,
        service_item: '羽绒服',
      }),
      after_json: JSON.stringify({
        quantity: 15,
        unit: '件',
        unit_price_cents: 1250,
        is_completed: 0,
        service_item: '羽绒服',
      }),
      changed_fields_json: JSON.stringify(['quantity', 'unit_price_cents']),
    }

    const diffs = extractHistoryDiffs(change)
    expect(diffs).toHaveLength(2)
    expect(diffs[0]).toMatchObject({
      fieldKey: 'quantity',
      fieldLabel: '数量',
      beforeText: '10 件',
      afterText: '15 件',
    })
    expect(diffs[1]).toMatchObject({
      fieldKey: 'unit_price_cents',
      fieldLabel: '单价',
      beforeText: '未定价',
      afterText: '¥12.50',
    })
  })

  it('extracts diffs from local outbox patch objects', () => {
    const change = {
      baseSnapshot: {
        quantity: 8,
        unit: '套',
        unitPriceCents: 2000,
      },
      patch: {
        quantity: 10,
      },
    }

    const diffs = extractHistoryDiffs(change)
    expect(diffs).toHaveLength(1)
    expect(diffs[0]).toMatchObject({
      fieldKey: 'quantity',
      fieldLabel: '数量',
      beforeText: '8 套',
      afterText: '10 套',
    })
  })

  it('builds full view model for history item', () => {
    const vm = buildHistoryItemViewModel({
      operationId: 'op_123',
      operationType: 'update_work_order',
      actorType: 'ai',
      deviceId: 'dev_other',
      createdAt: '2026-08-20T12:00:00Z',
      changesJson: JSON.stringify({
        changes: [
          {
            before_json: JSON.stringify({ is_completed: 0, unit: '件' }),
            after_json: JSON.stringify({ is_completed: 1, unit: '件' }),
            changed_fields_json: JSON.stringify(['is_completed']),
          },
        ],
      }),
      currentDeviceId: 'dev_local',
      canRevert: true,
      isReverted: false,
    })

    expect(vm.actorLabel).toBe('AI 助手')
    expect(vm.deviceLabel).toBe('其他设备')
    expect(vm.iconType).toBe('complete')
    expect(vm.summary).toBe('标记为已完成')
    expect(vm.diffs).toHaveLength(1)
    expect(vm.diffs[0].fieldLabel).toBe('工单状态')
    expect(vm.diffs[0].beforeText).toBe('未完成')
    expect(vm.diffs[0].afterText).toBe('已完成')
  })
})
